"""WebDAV protocol access for the v0.11.0 manual sync.

Only the standard library is used, so the local FastAPI backend, the Docker
backend and the Electron sidecar keep a small dependency surface and the
Android client (which does not run Python) has a behaviour reference.

Security invariants:

- Credentials live in :class:`WebDavTarget` with ``repr=False``; they are never
  logged, never placed into error messages and never written into the data
  package.
- Plain HTTP is rejected unless the caller explicitly allowed it after a
  warning; HTTPS certificate verification stays on.
- Cross-origin and TLS-downgrade redirects are refused so credentials cannot
  leak to another host.
"""

from __future__ import annotations

import base64
import socket
import ssl
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass, field
from typing import Callable, Mapping

APP_ID = "riji"
DEFAULT_REMOTE_DIRECTORY = "daytrace"
DEFAULT_REMOTE_FILENAME = "daytrace-latest.json"
PROBE_FILENAME = ".daytrace-write-probe.json"
USER_AGENT = "daytrace/0.11.0 (+local-webdav-sync)"
DEFAULT_TIMEOUT_SECONDS = 30.0
XML_NAMESPACE = "DAV:"
PROPFIND_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<d:propfind xmlns:d="DAV:"><d:prop>'
    "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/>"
    "</d:prop></d:propfind>"
).encode("utf-8")

#: User-facing Chinese text. Every value must stay free of credentials.
ERROR_MESSAGES: dict[str, str] = {
    "WEBDAV_URL_INVALID": "服务器地址格式不正确",
    "WEBDAV_INSECURE_HTTP": "当前服务器地址未使用 HTTPS，需要先确认安全风险",
    "WEBDAV_NETWORK_ERROR": "无法连接 WebDAV 服务器，请检查地址和网络",
    "WEBDAV_TLS_ERROR": "服务器证书校验失败",
    "WEBDAV_AUTH_FAILED": "用户名或应用密码错误",
    "WEBDAV_FORBIDDEN": "没有访问或写入权限",
    "WEBDAV_NOT_FOUND": "远端文件或目录不存在",
    "WEBDAV_METHOD_NOT_ALLOWED": "当前服务器不支持所需 WebDAV 操作",
    "WEBDAV_CONFLICT": "远端文件已被其他设备修改，请重新读取后再上传",
    "WEBDAV_QUOTA_EXCEEDED": "远端空间不足",
    "WEBDAV_INVALID_PACKAGE": "远端文件不是有效的日迹数据包",
    "WEBDAV_UNSUPPORTED_SCHEMA": "数据包 schema_version 不受支持",
    "SYNC_BUSY": "当前正在同步，请稍后重试",
    "SYNC_PASSWORD_REQUIRED": "请先填写 WebDAV 密码",
    "SYNC_CONFIRMATION_REQUIRED": "需要用户确认后才能上传",
}

#: HTTP status this local backend returns for each protocol error code.
ERROR_HTTP_STATUS: dict[str, int] = {
    "WEBDAV_URL_INVALID": 400,
    "WEBDAV_INSECURE_HTTP": 400,
    "SYNC_PASSWORD_REQUIRED": 400,
    "SYNC_CONFIRMATION_REQUIRED": 400,
    "WEBDAV_AUTH_FAILED": 401,
    "WEBDAV_FORBIDDEN": 403,
    "WEBDAV_NOT_FOUND": 404,
    "WEBDAV_METHOD_NOT_ALLOWED": 405,
    "WEBDAV_CONFLICT": 409,
    "SYNC_BUSY": 409,
    "WEBDAV_INVALID_PACKAGE": 422,
    "WEBDAV_UNSUPPORTED_SCHEMA": 422,
    "WEBDAV_TLS_ERROR": 502,
    "WEBDAV_NETWORK_ERROR": 502,
    "WEBDAV_QUOTA_EXCEEDED": 507,
}

_STATUS_ERROR_CODES: dict[int, str] = {
    401: "WEBDAV_AUTH_FAILED",
    403: "WEBDAV_FORBIDDEN",
    404: "WEBDAV_NOT_FOUND",
    405: "WEBDAV_METHOD_NOT_ALLOWED",
    409: "WEBDAV_CONFLICT",
    412: "WEBDAV_CONFLICT",
    423: "WEBDAV_CONFLICT",
    507: "WEBDAV_QUOTA_EXCEEDED",
}


class WebDavError(Exception):
    """A WebDAV failure with a stable code and a credential-free message."""

    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        response_status: int | None = None,
        detail: str | None = None,
    ) -> None:
        super().__init__(message or ERROR_MESSAGES.get(code, "WebDAV 操作失败"))
        self.code = code
        self.message = message or ERROR_MESSAGES.get(code, "WebDAV 操作失败")
        self.response_status = response_status
        self.detail = detail

    @property
    def http_status(self) -> int:
        return ERROR_HTTP_STATUS.get(self.code, 502)

    def to_payload(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True)
class WebDavResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes = b""

    @property
    def etag(self) -> str | None:
        return _header(self.headers, "etag")

    @property
    def last_modified(self) -> str | None:
        return _header(self.headers, "last-modified")

    @property
    def content_length(self) -> int | None:
        raw = _header(self.headers, "content-length")
        if raw is None:
            return None
        try:
            return int(raw.strip())
        except ValueError:
            return None

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


@dataclass(frozen=True)
class RemoteFileInfo:
    exists: bool
    path: str
    etag: str | None = None
    last_modified: str | None = None
    content_length: int | None = None
    protocol: str = "propfind"

    def to_payload(self) -> dict[str, object]:
        return {
            "exists": self.exists,
            "path": self.path,
            "etag": self.etag,
            "last_modified": self.last_modified,
            "content_length": self.content_length,
        }


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def _effective_port(parsed: urllib.parse.SplitResult) -> int:
    if parsed.port:
        return parsed.port
    return 443 if parsed.scheme.lower() == "https" else 80


def normalize_base_url(raw: str) -> str:
    """Return a canonical ``scheme://host[:port]/path`` base URL."""
    value = (raw or "").strip()
    if not value or len(value) > 2048:
        raise WebDavError("WEBDAV_URL_INVALID")
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        raise WebDavError("WEBDAV_URL_INVALID") from None
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise WebDavError("WEBDAV_URL_INVALID")
    if parsed.username or parsed.password:
        raise WebDavError("WEBDAV_URL_INVALID", "服务器地址不能包含用户名或密码", detail="url-userinfo")
    if parsed.query or parsed.fragment:
        raise WebDavError("WEBDAV_URL_INVALID", "服务器地址不能包含查询参数或锚点", detail="url-query")
    if any(character.isspace() or ord(character) < 32 for character in value):
        raise WebDavError("WEBDAV_URL_INVALID")
    path = parsed.path or "/"
    normalized = f"{parsed.scheme.lower()}://{parsed.netloc}{path}"
    return normalized[:-1] if normalized.endswith("/") and len(path) > 1 else normalized


def _validate_directory(raw: str) -> str:
    value = (raw or "").strip()
    if not value or len(value) > 300:
        raise WebDavError("WEBDAV_URL_INVALID", "远程目录不合法", detail="remote-directory")
    if "\\" in value or any(ord(character) < 32 for character in value):
        raise WebDavError("WEBDAV_URL_INVALID", "远程目录不允许反斜杠或控制字符", detail="remote-directory")
    segments = [segment for segment in value.split("/") if segment != ""]
    if not segments:
        raise WebDavError("WEBDAV_URL_INVALID", "远程目录不合法", detail="remote-directory")
    for segment in segments:
        if segment in (".", ".."):
            raise WebDavError("WEBDAV_URL_INVALID", "远程目录不允许 . 或 ..", detail="remote-directory")
    return "/".join(segments)


def _validate_filename(raw: str) -> str:
    value = (raw or "").strip()
    if not value or len(value) > 200:
        raise WebDavError("WEBDAV_URL_INVALID", "远程文件名不合法", detail="remote-filename")
    if any(character in value for character in ("/", "\\")) or value in (".", ".."):
        raise WebDavError("WEBDAV_URL_INVALID", "远程文件名不能包含路径分隔符", detail="remote-filename")
    if any(ord(character) < 32 for character in value):
        raise WebDavError("WEBDAV_URL_INVALID", "远程文件名不允许控制字符", detail="remote-filename")
    return value


@dataclass(frozen=True)
class WebDavTarget:
    """A fully validated WebDAV location plus its credentials."""

    base_url: str
    username: str
    password: str = field(default="", repr=False)
    remote_directory: str = DEFAULT_REMOTE_DIRECTORY
    remote_filename: str = DEFAULT_REMOTE_FILENAME
    allow_insecure_http: bool = False

    @property
    def directory_url(self) -> str:
        quoted = "/".join(urllib.parse.quote(segment, safe="") for segment in self.remote_directory.split("/"))
        return f"{self.base_url}/{quoted}"

    @property
    def file_url(self) -> str:
        return f"{self.directory_url}/{urllib.parse.quote(self.remote_filename, safe='')}"

    @property
    def probe_url(self) -> str:
        return f"{self.directory_url}/{urllib.parse.quote(PROBE_FILENAME, safe='')}"

    @property
    def display_path(self) -> str:
        parsed = urllib.parse.urlsplit(self.file_url)
        return parsed.path


def build_target(
    *,
    base_url: str,
    username: str,
    password: str = "",
    remote_directory: str = DEFAULT_REMOTE_DIRECTORY,
    remote_filename: str = DEFAULT_REMOTE_FILENAME,
    allow_insecure_http: bool = False,
) -> WebDavTarget:
    """Validate user input and build a target, raising :class:`WebDavError`."""
    normalized = normalize_base_url(base_url)
    user = (username or "").strip()
    if not user or len(user) > 200:
        raise WebDavError("WEBDAV_URL_INVALID", "用户名不能为空", detail="username")
    directory = _validate_directory(remote_directory or DEFAULT_REMOTE_DIRECTORY)
    filename = _validate_filename(remote_filename or DEFAULT_REMOTE_FILENAME)
    if normalized.startswith("http://") and not allow_insecure_http:
        raise WebDavError("WEBDAV_INSECURE_HTTP")
    return WebDavTarget(
        base_url=normalized,
        username=user,
        password=password or "",
        remote_directory=directory,
        remote_filename=filename,
        allow_insecure_http=bool(allow_insecure_http),
    )


def _transport_error(reason: object) -> WebDavError:
    if isinstance(reason, ssl.SSLError):
        return WebDavError("WEBDAV_TLS_ERROR")
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return WebDavError("WEBDAV_NETWORK_ERROR", "连接 WebDAV 服务器超时", detail="timeout")
    if isinstance(reason, ValueError):
        return WebDavError("WEBDAV_URL_INVALID")
    return WebDavError("WEBDAV_NETWORK_ERROR")


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects only within the same origin and never downgrade to HTTP."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 - stdlib signature
        source = urllib.parse.urlsplit(req.full_url)
        try:
            target = urllib.parse.urlsplit(newurl)
        except ValueError:
            return None
        same_origin = (
            target.scheme.lower() == source.scheme.lower()
            and (target.hostname or "").lower() == (source.hostname or "").lower()
            and _effective_port(target) == _effective_port(source)
        )
        if not same_origin:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class UrllibTransport:
    """Default transport built on :mod:`urllib.request`."""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT_SECONDS, ssl_context: ssl.SSLContext | None = None) -> None:
        self.timeout = timeout
        self.ssl_context = ssl_context if ssl_context is not None else ssl.create_default_context()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self.ssl_context),
            _SameOriginRedirectHandler(),
        )

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        timeout: float | None = None,
    ) -> WebDavResponse:
        request = urllib.request.Request(url, data=body, method=method.upper())
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with self.opener.open(request, timeout=timeout or self.timeout) as response:
                return WebDavResponse(
                    status=int(response.status),
                    headers={key.lower(): value for key, value in response.headers.items()},
                    body=response.read(),
                )
        except urllib.error.HTTPError as error:
            try:
                payload = error.read()
            except Exception:  # pragma: no cover - defensive, error streams vary
                payload = b""
            return WebDavResponse(
                status=int(error.code),
                headers={key.lower(): value for key, value in (error.headers or {}).items()},
                body=payload,
            )
        except urllib.error.URLError as error:
            raise _transport_error(error.reason) from None
        except (ssl.SSLError, socket.timeout, TimeoutError) as error:
            raise _transport_error(error) from None
        except ValueError:
            raise WebDavError("WEBDAV_URL_INVALID") from None
        except OSError:
            raise WebDavError("WEBDAV_NETWORK_ERROR") from None


Transport = Callable[..., WebDavResponse]


class WebDavClient:
    """Thin WebDAV client. Tests inject a fake transport instead of a server."""

    def __init__(self, transport: UrllibTransport | None = None, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self.transport = transport or UrllibTransport(timeout=timeout)
        self.timeout = timeout

    # -- low level ---------------------------------------------------------

    def raw(
        self,
        target: WebDavTarget,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
    ) -> WebDavResponse:
        if url.startswith("http://") and not target.allow_insecure_http:
            raise WebDavError("WEBDAV_INSECURE_HTTP")
        request_headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
        if target.username or target.password:
            token = base64.b64encode(f"{target.username}:{target.password}".encode("utf-8")).decode("ascii")
            request_headers["Authorization"] = f"Basic {token}"
        request_headers.update(headers or {})
        return self.transport.request(method, url, headers=request_headers, body=body, timeout=self.timeout)

    def propfind(self, target: WebDavTarget, url: str, depth: int = 0) -> WebDavResponse:
        return self.raw(
            target,
            "PROPFIND",
            url,
            headers={"Depth": str(depth), "Content-Type": "application/xml; charset=utf-8"},
            body=PROPFIND_BODY,
        )

    def mkcol(self, target: WebDavTarget, url: str) -> WebDavResponse:
        return self.raw(target, "MKCOL", url, body=b"")

    def get(self, target: WebDavTarget, url: str | None = None) -> WebDavResponse:
        return self.raw(target, "GET", url or target.file_url)

    def head(self, target: WebDavTarget, url: str | None = None) -> WebDavResponse:
        return self.raw(target, "HEAD", url or target.file_url)

    def put(
        self,
        target: WebDavTarget,
        payload: bytes,
        *,
        url: str | None = None,
        content_type: str = "application/json; charset=utf-8",
        if_match: str | None = None,
    ) -> WebDavResponse:
        headers = {"Content-Type": content_type}
        if if_match:
            headers["If-Match"] = if_match
        return self.raw(target, "PUT", url or target.file_url, headers=headers, body=payload)

    def delete(self, target: WebDavTarget, url: str) -> WebDavResponse:
        return self.raw(target, "DELETE", url)

    # -- protocol operations ----------------------------------------------

    def ensure_directory(self, target: WebDavTarget) -> bool:
        """Make sure the remote directory exists; returns True when created."""
        response = self.propfind(target, target.directory_url, depth=0)
        if response.status in (200, 207):
            return False
        if response.status == 404:
            self._mkcol_progressive(target)
            return True
        raise error_for_status(response.status)

    def _mkcol_progressive(self, target: WebDavTarget) -> None:
        parsed = urllib.parse.urlsplit(target.directory_url)
        prefix = f"{parsed.scheme}://{parsed.netloc}"
        segments = [segment for segment in parsed.path.split("/") if segment]
        current = prefix
        for index, segment in enumerate(segments):
            current = f"{current}/{urllib.parse.quote(segment, safe='')}"
            if index < len(segments) - 1:
                # Parent collections inside the base URL are expected to exist.
                check = self.propfind(target, current, depth=0)
                if check.status in (200, 207):
                    continue
                if check.status != 404:
                    raise error_for_status(check.status)
            response = self.mkcol(target, current)
            if response.status in (200, 201, 204, 405):
                # 405 means the collection already exists.
                continue
            if response.status == 409:
                raise WebDavError("WEBDAV_CONFLICT", "远端父目录不存在或目录状态冲突")
            raise error_for_status(response.status)

    def stat(self, target: WebDavTarget) -> RemoteFileInfo:
        """Return the remote file metadata, treating a missing file as exists=False."""
        response = self.propfind(target, target.file_url, depth=0)
        if response.status in (200, 207):
            entry = _parse_propfind(response.text)
            if entry is None or not entry.exists:
                return RemoteFileInfo(exists=False, path=target.display_path)
            return RemoteFileInfo(
                exists=True,
                path=target.display_path,
                etag=entry.etag,
                last_modified=entry.last_modified,
                content_length=entry.content_length,
                protocol="propfind",
            )
        if response.status in (405, 501):
            return self._stat_via_head(target)
        if response.status == 404:
            return RemoteFileInfo(exists=False, path=target.display_path)
        raise error_for_status(response.status)

    def _stat_via_head(self, target: WebDavTarget) -> RemoteFileInfo:
        response = self.head(target)
        if response.status in (200, 204):
            return RemoteFileInfo(
                exists=True,
                path=target.display_path,
                etag=response.etag,
                last_modified=response.last_modified,
                content_length=response.content_length,
                protocol="head",
            )
        if response.status in (404, 405, 501):
            return RemoteFileInfo(exists=False, path=target.display_path, protocol="head")
        raise error_for_status(response.status)

    def test_connection(self, target: WebDavTarget) -> dict[str, object]:
        """Probe reachability, authentication, directory existence and writability."""
        checks = {
            "reachable": False,
            "authenticated": False,
            "directory_exists": False,
            "directory_writable": False,
        }
        notes: list[str] = []
        unknown: list[str] = []
        protocol = "propfind"

        try:
            response = self.propfind(target, target.directory_url, depth=0)
        except WebDavError as error:
            return _test_failure(error.code, checks, notes, unknown, protocol)

        checks["reachable"] = True
        if response.status in (401, 403):
            return _test_failure(error_for_status(response.status).code, checks, notes, unknown, protocol)
        directory_created = False
        if response.status == 404:
            try:
                self._mkcol_progressive(target)
                directory_created = True
            except WebDavError as error:
                notes.append("远程目录不存在，且自动创建失败；请手动创建该目录。")
                return _test_failure(error.code, checks, notes, unknown, protocol)
        elif response.status in (405, 501):
            protocol = "head"
            notes.append("当前服务器不支持 PROPFIND，已降级为文件探测，目录存在性未能确认。")
            checks["authenticated"] = True
            head = self.head(target)
            if head.status in (401, 403):
                checks["authenticated"] = False
                return _test_failure(error_for_status(head.status).code, checks, notes, unknown, protocol)
            if head.status in (200, 204):
                checks["directory_exists"] = True
            else:
                unknown.append("directory_exists")
            unknown.append("directory_writable")
            checks["directory_writable"] = False
            return {
                "ok": True,
                "code": None,
                "message": "服务器可达且认证成功；该服务器不支持 PROPFIND，未能确认目录状态。",
                "checks": checks,
                "unknown": unknown,
                "protocol": protocol,
                "directory_created": False,
                "notes": notes,
            }
        elif response.status not in (200, 207):
            return _test_failure(error_for_status(response.status).code, checks, notes, unknown, protocol)

        checks["authenticated"] = True
        checks["directory_exists"] = True
        if directory_created:
            notes.append("远程目录原本不存在，已自动创建。")

        probe = self.put(target, b'{"probe":true}', url=target.probe_url)
        if probe.status in (200, 201, 204):
            checks["directory_writable"] = True
            self.delete(target, target.probe_url)
            message = "连接成功，目录可写。" if not directory_created else "连接成功，目录已创建且可写。"
            return {
                "ok": True,
                "code": None,
                "message": message,
                "checks": checks,
                "unknown": unknown,
                "protocol": protocol,
                "directory_created": directory_created,
                "notes": notes,
            }
        if probe.status in (403, 507, 409):
            notes.append("目标目录没有写入权限。")
            error = error_for_status(probe.status)
            return _test_failure(error.code, checks, notes, unknown, protocol)
        try:
            raise error_for_status(probe.status)
        except WebDavError as error:
            return _test_failure(error.code, checks, notes, unknown, protocol)

    def download(self, target: WebDavTarget) -> tuple[bytes, RemoteFileInfo]:
        response = self.get(target)
        if response.status in (401, 403, 404, 405, 409, 507) or response.status >= 500:
            raise error_for_status(response.status)
        if response.status not in (200, 203, 206):
            raise error_for_status(response.status)
        info = RemoteFileInfo(
            exists=True,
            path=target.display_path,
            etag=response.etag,
            last_modified=response.last_modified,
            content_length=response.content_length or len(response.body),
            protocol="get",
        )
        return response.body, info

    def upload(self, target: WebDavTarget, payload: bytes, *, expected_etag: str | None = None) -> RemoteFileInfo:
        """PUT the payload. The caller ensures the collection exists first."""
        response = self.put(target, payload, if_match=expected_etag)
        if response.status in (412, 423):
            raise error_for_status(response.status)
        if response.status not in (200, 201, 204):
            raise error_for_status(response.status)
        etag = response.etag
        last_modified = response.last_modified
        content_length = response.content_length
        if etag is None or last_modified is None:
            info = self.stat(target)
            etag = etag or info.etag
            last_modified = last_modified or info.last_modified
            content_length = content_length or info.content_length
        return RemoteFileInfo(
            exists=True,
            path=target.display_path,
            etag=etag,
            last_modified=last_modified,
            # A PUT response usually reports Content-Length: 0 for its empty body.
            content_length=content_length or len(payload),
            protocol="put",
        )


def error_for_status(status: int, *, fallback: str = "WEBDAV_NETWORK_ERROR") -> WebDavError:
    code = _STATUS_ERROR_CODES.get(status, fallback)
    return WebDavError(code, response_status=status, detail=f"remote-status-{status}")


def _test_failure(
    code: str,
    checks: dict[str, bool],
    notes: list[str],
    unknown: list[str],
    protocol: str,
) -> dict[str, object]:
    return {
        "ok": False,
        "code": code,
        "message": ERROR_MESSAGES.get(code, "WebDAV 连接测试失败"),
        "checks": checks,
        "unknown": unknown,
        "protocol": protocol,
        "directory_created": False,
        "notes": notes,
    }


def _localname(tag: object) -> str:
    return str(tag).rsplit("}", 1)[-1].lower()


@dataclass(frozen=True)
class _PropfindEntry:
    exists: bool
    etag: str | None = None
    last_modified: str | None = None
    content_length: int | None = None
    is_collection: bool = False


def _parse_propfind(text: str) -> _PropfindEntry | None:
    """Extract metadata for the requested resource from a PROPFIND response."""
    if not text.strip():
        return None
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return None

    candidates: list[tuple[bool, ElementTree.Element]] = []
    for response in root.iter():
        if _localname(response.tag) != "response":
            continue
        href = ""
        statuses: list[str] = []
        for child in response.iter():
            name = _localname(child.tag)
            if name == "href" and not href:
                href = (child.text or "").strip()
            elif name == "status":
                statuses.append((child.text or "").strip())
        missing = any("404" in status for status in statuses)
        candidates.append((href.endswith("/") or missing, response))
    if not candidates:
        return None
    # Prefer a non-collection, non-missing response (Depth: 0 usually yields one).
    candidates.sort(key=lambda item: item[0])
    _, selected = candidates[0]

    statuses = [
        (child.text or "").strip()
        for child in selected.iter()
        if _localname(child.tag) == "status"
    ]
    if statuses and all("404" in status for status in statuses):
        return _PropfindEntry(exists=False)

    result = _PropfindEntry(exists=True)
    for element in selected.iter():
        name = _localname(element.tag)
        if name == "getetag":
            value = (element.text or "").strip()
            result = _replace_entry(result, etag=value or None)
        elif name == "getlastmodified":
            value = (element.text or "").strip()
            result = _replace_entry(result, last_modified=value or None)
        elif name == "getcontentlength":
            try:
                result = _replace_entry(result, content_length=int((element.text or "").strip()))
            except ValueError:
                pass
        elif name == "collection":
            result = _replace_entry(result, is_collection=True)
    return result


def _replace_entry(entry: _PropfindEntry, **changes: object) -> _PropfindEntry:
    values = {
        "exists": entry.exists,
        "etag": entry.etag,
        "last_modified": entry.last_modified,
        "content_length": entry.content_length,
        "is_collection": entry.is_collection,
    }
    values.update(changes)
    return _PropfindEntry(**values)  # type: ignore[arg-type]
