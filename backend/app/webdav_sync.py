"""Local WebDAV sync service for v0.11.0.

Scope is deliberately limited to what v0.11.0 promises:

- configuration and credential handling,
- connection testing,
- manual upload with a preflight + explicit confirmation + conflict detection,
- manual download that never writes the local database.

There is no automatic sync, no scheduled upload, no timestamped remote backup
and no new merge algorithm. Downloaded packages are handed back to the caller so
the existing JSON import preview and merge flow stays in charge of user data.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, AsyncIterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .data_portability import (
    APP_ID,
    ENTITY_ORDER,
    SUPPORTED_SCHEMA_VERSIONS,
    DataPackageError,
    export_package,
    validate_package,
)
from .webdav_client import (
    DEFAULT_REMOTE_DIRECTORY,
    DEFAULT_REMOTE_FILENAME,
    ERROR_MESSAGES,
    RemoteFileInfo,
    WebDavClient,
    WebDavError,
    WebDavTarget,
    build_target,
)

#: Maximum size of a remote package we are willing to download into memory.
MAX_PACKAGE_BYTES = 64 * 1024 * 1024
MAX_ERROR_LENGTH = 300

#: Session-only passwords live here. Remembered passwords live in the local
#: WebDavConfig row, which is outside the portable data package.
_SESSION_PASSWORDS: dict[str, str] = {}
#: Configs whose password is intentionally session-only (remember_password off).
_SESSION_ONLY: set[str] = set()

#: Cooperative guard: one upload/download/test at a time inside this process.
_BUSY = False


class SyncBusyError(WebDavError):
    def __init__(self) -> None:
        super().__init__("SYNC_BUSY")


@asynccontextmanager
async def sync_guard() -> AsyncIterator[None]:
    """Reject concurrent remote operations with ``SYNC_BUSY``."""
    global _BUSY
    if _BUSY:
        raise SyncBusyError()
    _BUSY = True
    try:
        yield
    finally:
        _BUSY = False


def is_busy() -> bool:
    return _BUSY


def reset_session_secrets() -> None:
    """Test helper: drop every in-memory password."""
    _SESSION_PASSWORDS.clear()
    _SESSION_ONLY.clear()


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------


async def get_or_create_config(db: AsyncSession) -> models.WebDavConfig:
    result = await db.execute(select(models.WebDavConfig).order_by(models.WebDavConfig.id.asc()).limit(1))
    config = result.scalar_one_or_none()
    if config is not None:
        return config
    config = models.WebDavConfig(
        remote_directory=DEFAULT_REMOTE_DIRECTORY,
        remote_filename=DEFAULT_REMOTE_FILENAME,
    )
    db.add(config)
    await db.commit()
    await db.refresh(config)
    return config


def has_session_password(config: models.WebDavConfig) -> bool:
    return bool(_SESSION_PASSWORDS.get(config.uuid) or (config.remember_password and config.password))


def is_configured(config: models.WebDavConfig) -> bool:
    return bool(
        config.base_url
        and config.username
        and config.remote_directory
        and config.remote_filename
        and has_session_password(config)
    )


def config_payload(config: models.WebDavConfig) -> dict[str, Any]:
    """Secret-free configuration for the API and the UI."""
    return {
        "base_url": config.base_url,
        "username": config.username,
        "remote_directory": config.remote_directory,
        "remote_filename": config.remote_filename,
        "remember_password": bool(config.remember_password),
        "allow_insecure_http": bool(config.allow_insecure_http),
        "has_password": has_session_password(config),
        "last_sync_at": _iso(config.last_sync_at),
        "last_success_at": _iso(config.last_success_at),
        "last_download_at": _iso(config.last_download_at),
        "last_error": config.last_error or "",
        "last_error_code": config.last_error_code or "",
    }


async def save_config(db: AsyncSession, payload: Any) -> dict[str, Any]:
    """Persist non-secret config and seed the in-memory password."""
    config = await get_or_create_config(db)
    allow_insecure = payload.allow_insecure_http
    if allow_insecure is None:
        allow_insecure = bool(config.allow_insecure_http)
    password = payload.password or ""
    # Validate exactly like an operation would, so a bad path cannot be stored.
    build_target(
        base_url=payload.base_url if payload.base_url is not None else config.base_url,
        username=payload.username if payload.username is not None else config.username,
        password=password or _SESSION_PASSWORDS.get(config.uuid, "") or (config.password if config.remember_password else ""),
        remote_directory=payload.remote_directory or config.remote_directory or DEFAULT_REMOTE_DIRECTORY,
        remote_filename=payload.remote_filename or config.remote_filename or DEFAULT_REMOTE_FILENAME,
        allow_insecure_http=bool(allow_insecure),
    )

    if payload.base_url is not None:
        config.base_url = payload.base_url.strip()
    if payload.username is not None:
        config.username = payload.username.strip()
    if payload.remote_directory:
        config.remote_directory = payload.remote_directory.strip()
    if payload.remote_filename:
        config.remote_filename = payload.remote_filename.strip()
    config.remember_password = bool(payload.remember_password)
    config.allow_insecure_http = bool(allow_insecure)

    if password:
        _SESSION_PASSWORDS[config.uuid] = password
        if config.remember_password:
            config.password = password
            _SESSION_ONLY.discard(config.uuid)
        else:
            config.password = ""
            _SESSION_ONLY.add(config.uuid)
    elif not config.remember_password:
        # remember_password=false keeps no password in the local database.
        config.password = ""
        _SESSION_PASSWORDS.pop(config.uuid, None)
        _SESSION_ONLY.discard(config.uuid)
    elif config.password:
        _SESSION_PASSWORDS[config.uuid] = config.password
        _SESSION_ONLY.discard(config.uuid)
    else:
        raise WebDavError("SYNC_PASSWORD_REQUIRED")

    await db.commit()
    await db.refresh(config)
    return config_payload(config)


def forget_password(config: models.WebDavConfig) -> None:
    config.password = ""
    config.remember_password = False
    _SESSION_PASSWORDS.pop(config.uuid, None)
    _SESSION_ONLY.discard(config.uuid)


# --------------------------------------------------------------------------
# targets
# --------------------------------------------------------------------------


def _require_password(config: models.WebDavConfig) -> str:
    password = _SESSION_PASSWORDS.get(config.uuid) or (config.password if config.remember_password else "")
    if not password:
        raise WebDavError("SYNC_PASSWORD_REQUIRED")
    return password


def _target(config: models.WebDavConfig, password: str) -> WebDavTarget:
    return build_target(
        base_url=config.base_url,
        username=config.username,
        password=password,
        remote_directory=config.remote_directory or DEFAULT_REMOTE_DIRECTORY,
        remote_filename=config.remote_filename or DEFAULT_REMOTE_FILENAME,
        allow_insecure_http=bool(config.allow_insecure_http),
    )


def _draft_target(config: models.WebDavConfig, draft: Any) -> WebDavTarget:
    """Build a target from an unsaved draft, falling back to saved values."""
    allow_insecure = getattr(draft, "allow_insecure_http", None)
    if allow_insecure is None:
        allow_insecure = bool(config.allow_insecure_http)
    password = getattr(draft, "password", None) or _SESSION_PASSWORDS.get(config.uuid, "") or (config.password if config.remember_password else "")
    if not password:
        raise WebDavError("SYNC_PASSWORD_REQUIRED")
    return build_target(
        base_url=getattr(draft, "base_url", None) or config.base_url,
        username=getattr(draft, "username", None) or config.username,
        password=password,
        remote_directory=getattr(draft, "remote_directory", None) or config.remote_directory or DEFAULT_REMOTE_DIRECTORY,
        remote_filename=getattr(draft, "remote_filename", None) or config.remote_filename or DEFAULT_REMOTE_FILENAME,
        allow_insecure_http=bool(allow_insecure),
    )


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _now() -> datetime:
    return models.beijing_now()


def summarize_package(package: Any) -> dict[str, Any]:
    entities = package.get("entities") if isinstance(package, dict) else None
    counts: dict[str, int] = {}
    if isinstance(entities, dict):
        for name in ENTITY_ORDER:
            items = entities.get(name)
            counts[name] = len(items) if isinstance(items, list) else 0
    return {
        "schema_version": package.get("schema_version") if isinstance(package, dict) else None,
        "exported_at": package.get("exported_at") if isinstance(package, dict) else None,
        "entity_counts": counts,
        "total": sum(counts.values()),
    }


def validate_remote_package(raw: Any) -> dict[str, Any]:
    """Validate a downloaded package with stable WebDAV error codes."""
    if not isinstance(raw, dict) or raw.get("app") != APP_ID:
        raise WebDavError("WEBDAV_INVALID_PACKAGE")
    if raw.get("schema_version") not in SUPPORTED_SCHEMA_VERSIONS:
        raise WebDavError("WEBDAV_UNSUPPORTED_SCHEMA")
    try:
        return validate_package(raw)
    except DataPackageError as exc:
        raise WebDavError("WEBDAV_INVALID_PACKAGE", str(exc)[:MAX_ERROR_LENGTH]) from None


def _document_package(raw: dict[str, Any]) -> dict[str, Any]:
    """A credential-free description of a remote package for the UI."""
    try:
        package = validate_remote_package(raw)
    except WebDavError as exc:
        return {"summary": summarize_package(raw), "error": exc.message, "error_code": exc.code}
    return {"summary": summarize_package(package), "error": None, "error_code": None}


async def _record_success(db: AsyncSession, config: models.WebDavConfig, info: RemoteFileInfo, *, download: bool) -> None:
    now = _now()
    config.last_sync_at = now
    config.last_success_at = now
    if download:
        config.last_download_at = now
    config.last_status = "success"
    config.last_error = ""
    config.last_error_code = ""
    if info.etag is not None:
        config.last_remote_etag = info.etag
    if info.last_modified is not None:
        config.last_remote_modified_at = info.last_modified
    await db.commit()


async def _record_failure(db: AsyncSession, config: models.WebDavConfig, error: WebDavError) -> None:
    config.last_sync_at = _now()
    config.last_status = "failed"
    config.last_error = error.message[:MAX_ERROR_LENGTH]
    config.last_error_code = error.code
    await db.commit()


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------


async def test_connection(db: AsyncSession, draft: Any) -> dict[str, Any]:
    config = await get_or_create_config(db)
    target = _draft_target(config, draft)
    client = WebDavClient()
    async with sync_guard():
        try:
            result = await asyncio.to_thread(client.test_connection, target)
        except WebDavError as error:
            await _record_failure(db, config, error)
            return {
                "ok": False,
                "code": error.code,
                "message": error.message,
                "checks": {
                    "reachable": False,
                    "authenticated": False,
                    "directory_exists": False,
                    "directory_writable": False,
                },
                "unknown": [],
                "notes": [],
                "protocol": None,
                "directory_created": False,
            }
        await db.commit()
        return result


async def preflight_upload(db: AsyncSession) -> dict[str, Any]:
    config = await get_or_create_config(db)
    target = _target(config, _require_password(config))
    client = WebDavClient()
    package = await export_package(db)
    local = summarize_package(package)
    async with sync_guard():
        try:
            info = await asyncio.to_thread(client.stat, target)
            remote: dict[str, Any] = {
                **info.to_payload(),
                "exported_at": None,
                "schema_version": None,
                "entity_counts": {},
                "package_error": None,
            }
            if info.exists:
                if info.content_length is not None and info.content_length > MAX_PACKAGE_BYTES:
                    remote["package_error"] = "远端文件过大，已跳过信息读取"
                else:
                    body, downloaded = await asyncio.to_thread(client.download, target)
                    info = downloaded
                    remote.update(info.to_payload())
                    try:
                        raw = json.loads(body.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        remote["package_error"] = ERROR_MESSAGES["WEBDAV_INVALID_PACKAGE"]
                    else:
                        described = _document_package(raw)
                        remote.update(
                            {
                                "exported_at": described["summary"]["exported_at"],
                                "schema_version": described["summary"]["schema_version"],
                                "entity_counts": described["summary"]["entity_counts"],
                                "package_error": described["error"],
                            }
                        )
        except WebDavError as error:
            await _record_failure(db, config, error)
            raise
    return {"local": local, "remote": remote}


async def upload_latest(
    db: AsyncSession,
    *,
    confirmed: bool,
    expected_remote_etag: str | None,
    expected_remote_exists: bool | None = None,
) -> dict[str, Any]:
    if not confirmed:
        raise WebDavError("SYNC_CONFIRMATION_REQUIRED")
    config = await get_or_create_config(db)
    target = _target(config, _require_password(config))
    client = WebDavClient()
    package = await export_package(db)
    payload = json.dumps(package, ensure_ascii=False, indent=2).encode("utf-8")
    async with sync_guard():
        try:
            created = await asyncio.to_thread(client.ensure_directory, target)
            current = await asyncio.to_thread(client.stat, target)
            if expected_remote_exists is None:
                raise WebDavError("WEBDAV_CONFLICT")
            if current.exists:
                if expected_remote_exists is False or expected_remote_etag is None:
                    raise WebDavError("WEBDAV_CONFLICT")
                if current.etag is None or current.etag != expected_remote_etag:
                    raise WebDavError("WEBDAV_CONFLICT")
            elif expected_remote_exists or expected_remote_etag is not None:
                raise WebDavError("WEBDAV_CONFLICT")
            info = await asyncio.to_thread(
                client.upload,
                target,
                payload,
                expected_etag=expected_remote_etag if current.exists else None,
                create_only=not current.exists,
            )
        except WebDavError as error:
            await _record_failure(db, config, error)
            raise
        await _record_success(db, config, info, download=False)
    return {
        "ok": True,
        "path": info.path,
        "etag": info.etag,
        "last_modified": info.last_modified,
        "content_length": info.content_length or len(payload),
        "uploaded_at": _iso(config.last_success_at),
        "exported_at": package.get("exported_at"),
        "schema_version": package.get("schema_version"),
        "directory_created": created,
    }


async def download_latest(db: AsyncSession) -> dict[str, Any]:
    config = await get_or_create_config(db)
    target = _target(config, _require_password(config))
    client = WebDavClient()
    async with sync_guard():
        try:
            body, info = await asyncio.to_thread(client.download, target)
            if len(body) > MAX_PACKAGE_BYTES:
                raise WebDavError("WEBDAV_INVALID_PACKAGE", "远端文件过大，已拒绝下载")
            try:
                raw = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise WebDavError("WEBDAV_INVALID_PACKAGE") from None
            package = validate_remote_package(raw)
        except WebDavError as error:
            await _record_failure(db, config, error)
            raise
        await _record_success(db, config, info, download=True)
    return {
        "remote": {
            "path": info.path,
            "etag": info.etag,
            "last_modified": info.last_modified,
            "content_length": info.content_length or len(body),
        },
        "package": package,
        "summary": summarize_package(package),
        "downloaded_at": _iso(config.last_download_at),
    }


async def get_status(db: AsyncSession) -> dict[str, Any]:
    config = await get_or_create_config(db)
    target: WebDavTarget | None = None
    try:
        target = build_target(
            base_url=config.base_url,
            username=config.username or "unset",
            remote_directory=config.remote_directory or DEFAULT_REMOTE_DIRECTORY,
            remote_filename=config.remote_filename or DEFAULT_REMOTE_FILENAME,
            allow_insecure_http=True,
        )
    except WebDavError:
        target = None
    return {
        "configured": is_configured(config),
        "has_password": has_session_password(config),
        "busy": is_busy(),
        "remote_path": target.display_path if target else "",
        "last_sync_at": _iso(config.last_sync_at),
        "last_success_at": _iso(config.last_success_at),
        "last_download_at": _iso(config.last_download_at),
        "last_error": config.last_error or "",
        "last_error_code": config.last_error_code or "",
        "last_remote_etag": config.last_remote_etag,
        "last_remote_modified_at": config.last_remote_modified_at,
        "allow_insecure_http": bool(config.allow_insecure_http),
        "remember_password": bool(config.remember_password),
    }
