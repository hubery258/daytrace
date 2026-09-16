"""v0.11.0 WebDAV manual sync tests.

The protocol tests run against an in-process fake WebDAV server so the real
``urllib`` transport, Basic Auth, PROPFIND/MKCOL/PUT/GET/HEAD and ETag conflict
handling are exercised without any network dependency.
"""

import base64
import hashlib
import json
import socket
import ssl
import threading
import unittest
import urllib.parse
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import models, schemas, webdav_sync
from app.data_portability import export_package
from app.database import Base
from app.routers import sync_webdav
from app.webdav_client import (
    ERROR_MESSAGES,
    WebDavClient,
    WebDavError,
    _transport_error,
    build_target,
)

FAKE_USERNAME = "alice"
FAKE_PASSWORD = "app-password-never-log"
FAKE_ROOT = "/dav"


class FakeWebDavState:
    """In-memory WebDAV state for the fake server."""

    def __init__(self, root: str = FAKE_ROOT) -> None:
        self.root = root
        self.files: dict[str, bytes] = {}
        self.directories: set[str] = {root}
        self.require_auth = True
        self.propfind_supported = True
        self.write_forbidden = False
        self.quota_exceeded = False
        self.requests: list[tuple[str, str]] = []
        self.uploaded: list[tuple[str, bytes]] = []

    def directory_exists(self, path: str) -> bool:
        if path in self.directories:
            return True
        return any(candidate.startswith(path.rstrip("/") + "/") for candidate in self.directories)

    def parent_of(self, path: str) -> str:
        parent = path.rsplit("/", 1)[0]
        return parent or "/"

    def store(self, path: str, body: bytes) -> str:
        self.files[path] = body
        self.uploaded.append((path, body))
        return etag_for(body)


def etag_for(body: bytes) -> str:
    return '"' + hashlib.md5(body).hexdigest()[:16] + '"'


class FakeWebDavHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        return

    @property
    def state(self) -> FakeWebDavState:
        return self.server.state  # type: ignore[attr-defined]

    # -- helpers -----------------------------------------------------------

    def request_path(self) -> str:
        return urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)

    def authorized(self) -> bool:
        state = self.state
        if not state.require_auth:
            return True
        expected = base64.b64encode(f"{FAKE_USERNAME}:{FAKE_PASSWORD}".encode()).decode()
        return self.headers.get("Authorization", "") == f"Basic {expected}"

    def body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def respond(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        if status == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="fake"')
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def reject_unauthorized(self) -> bool:
        if self.authorized():
            return False
        self.respond(401)
        return True

    def propfind_xml(self, path: str, is_collection: bool) -> bytes:
        state = self.state
        if is_collection:
            props = "<d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Mon, 15 Sep 2026 08:00:00 GMT</d:getlastmodified>"
        else:
            body = state.files.get(path, b"")
            props = (
                "<d:resourcetype/>"
                f"<d:getcontentlength>{len(body)}</d:getcontentlength>"
                "<d:getlastmodified>Mon, 15 Sep 2026 09:00:00 GMT</d:getlastmodified>"
                f"<d:getetag>{etag_for(body)}</d:getetag>"
            )
        return (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:multistatus xmlns:d="DAV:"><d:response>'
            f"<d:href>{urllib.parse.quote(path)}</d:href>"
            f"<d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
            "</d:response></d:multistatus>"
        ).encode()

    # -- methods -----------------------------------------------------------

    def do_PROPFIND(self) -> None:
        self.body()  # drain the request body so keep-alive stays usable
        self.state.requests.append(("PROPFIND", self.request_path()))
        if self.reject_unauthorized():
            return
        path = self.request_path()
        if not self.state.propfind_supported:
            self.respond(405)
            return
        if path in self.state.files:
            self.respond(207, self.propfind_xml(path, False), {"Content-Type": "application/xml"})
            return
        if self.state.directory_exists(path):
            self.respond(207, self.propfind_xml(path, True), {"Content-Type": "application/xml"})
            return
        self.respond(404)

    def do_MKCOL(self) -> None:
        self.body()
        self.state.requests.append(("MKCOL", self.request_path()))
        if self.reject_unauthorized():
            return
        path = self.request_path().rstrip("/")
        if self.state.write_forbidden:
            self.respond(403)
            return
        if self.state.directory_exists(path) or path in self.state.files:
            self.respond(405)
            return
        if not self.state.directory_exists(self.state.parent_of(path)):
            self.respond(409)
            return
        self.state.directories.add(path)
        self.respond(201)

    def do_PUT(self) -> None:
        body = self.body()
        self.state.requests.append(("PUT", self.request_path()))
        if self.reject_unauthorized():
            return
        path = self.request_path()
        if self.state.write_forbidden:
            self.respond(403)
            return
        if self.state.quota_exceeded:
            self.respond(507)
            return
        if not self.state.directory_exists(self.state.parent_of(path)):
            self.respond(409)
            return
        if_match = self.headers.get("If-Match")
        current = self.state.files.get(path)
        if if_match is not None and (current is None or etag_for(current) != if_match):
            self.respond(412)
            return
        etag = self.state.store(path, body)
        self.respond(201 if current is None else 204, b"", {
            "ETag": etag,
            "Last-Modified": "Mon, 15 Sep 2026 10:00:00 GMT",
            "Content-Type": "application/json",
        })

    def do_DELETE(self) -> None:
        self.state.requests.append(("DELETE", self.request_path()))
        if self.reject_unauthorized():
            return
        path = self.request_path()
        if path in self.state.files:
            del self.state.files[path]
            self.respond(204)
            return
        if path in self.state.directories:
            self.state.directories.discard(path)
            self.respond(204)
            return
        self.respond(404)

    def do_GET(self) -> None:
        self.state.requests.append(("GET", self.request_path()))
        if self.reject_unauthorized():
            return
        path = self.request_path()
        if path not in self.state.files:
            self.respond(404)
            return
        body = self.state.files[path]
        self.respond(200, body, {
            "ETag": etag_for(body),
            "Last-Modified": "Mon, 15 Sep 2026 09:00:00 GMT",
            "Content-Type": "application/json",
        })

    def do_HEAD(self) -> None:
        self.state.requests.append(("HEAD", self.request_path()))
        if self.reject_unauthorized():
            return
        path = self.request_path()
        if path not in self.state.files:
            self.respond(404)
            return
        body = self.state.files[path]
        self.respond(200, body, {
            "ETag": etag_for(body),
            "Last-Modified": "Mon, 15 Sep 2026 09:00:00 GMT",
            "Content-Type": "application/json",
        })


class FakeWebDavServer:
    def __init__(self) -> None:
        self.state = FakeWebDavState()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeWebDavHandler)
        self.httpd.daemon_threads = True
        self.httpd.state = self.state  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://127.0.0.1:{port}{FAKE_ROOT}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def allow_insecure_target(password: str = FAKE_PASSWORD, **overrides):
    values = {
        "base_url": "",
        "username": FAKE_USERNAME,
        "password": password,
        "remote_directory": "daytrace",
        "remote_filename": "daytrace-latest.json",
        "allow_insecure_http": True,
    }
    values.update(overrides)
    return build_target(**values)


class WebDavProtocolTests(unittest.TestCase):
    """Protocol behaviour against the in-process fake WebDAV server."""

    def setUp(self) -> None:
        self.server = FakeWebDavServer()
        self.addCleanup(self.server.close)
        self.client = WebDavClient()
        self.target = allow_insecure_target(base_url=self.server.base_url)

    def test_test_connection_creates_missing_directory_and_probes_write(self):
        result = self.client.test_connection(self.target)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["checks"], {
            "reachable": True,
            "authenticated": True,
            "directory_exists": True,
            "directory_writable": True,
        })
        self.assertTrue(result["directory_created"])
        # The write probe must not be left behind.
        self.assertNotIn(FAKE_ROOT + "/daytrace/.daytrace-write-probe.json", self.server.state.files)

    def test_test_connection_wrong_password_reports_auth_failed(self):
        target = allow_insecure_target(password="wrong", base_url=self.server.base_url)
        result = self.client.test_connection(target)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "WEBDAV_AUTH_FAILED")
        self.assertTrue(result["checks"]["reachable"])
        self.assertFalse(result["checks"]["authenticated"])

    def test_test_connection_readonly_directory_reports_not_writable(self):
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        self.server.state.write_forbidden = True
        result = self.client.test_connection(self.target)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "WEBDAV_FORBIDDEN")
        self.assertTrue(result["checks"]["directory_exists"])
        self.assertFalse(result["checks"]["directory_writable"])

    def test_test_connection_degrades_to_head_without_propfind(self):
        self.server.state.propfind_supported = False
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        self.server.state.files[FAKE_ROOT + "/daytrace/daytrace-latest.json"] = b"{}"
        result = self.client.test_connection(self.target)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["protocol"], "head")
        self.assertTrue(result["checks"]["authenticated"])
        self.assertIn("directory_writable", result["unknown"])

    def test_stat_reports_existing_and_missing_files(self):
        info = self.client.stat(self.target)
        self.assertFalse(info.exists)
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        body = json.dumps({"app": "riji"}).encode()
        self.server.state.store(FAKE_ROOT + "/daytrace/daytrace-latest.json", body)
        info = self.client.stat(self.target)
        self.assertTrue(info.exists)
        self.assertEqual(info.etag, etag_for(body))
        self.assertEqual(info.content_length, len(body))
        self.assertIsNotNone(info.last_modified)

    def test_upload_download_roundtrip_and_if_match_conflict(self):
        self.client.ensure_directory(self.target)
        payload = json.dumps({"app": "riji", "value": 1}).encode()
        info = self.client.upload(self.target, payload, expected_etag=None)
        self.assertTrue(info.exists)
        body, downloaded = self.client.download(self.target)
        self.assertEqual(body, payload)
        self.assertEqual(downloaded.etag, info.etag)

        # A stale expected ETag must conflict instead of silently overwriting.
        with self.assertRaises(WebDavError) as captured:
            self.client.upload(self.target, b'{"app":"riji","value":2}', expected_etag='"stale"')
        self.assertEqual(captured.exception.code, "WEBDAV_CONFLICT")
        self.assertEqual(captured.exception.response_status, 412)
        self.assertEqual(self.server.state.files[FAKE_ROOT + "/daytrace/daytrace-latest.json"], payload)

    def test_nested_directory_is_created_progressively(self):
        target = allow_insecure_target(base_url=self.server.base_url, remote_directory="daytrace/nested")
        self.assertTrue(self.client.ensure_directory(target))
        self.assertIn(FAKE_ROOT + "/daytrace/nested", self.server.state.directories)

    def test_quota_and_forbidden_map_to_documented_codes(self):
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        self.server.state.quota_exceeded = True
        with self.assertRaises(WebDavError) as captured:
            self.client.upload(self.target, b"{}")
        self.assertEqual(captured.exception.code, "WEBDAV_QUOTA_EXCEEDED")
        self.assertEqual(captured.exception.http_status, 507)

        self.server.state.quota_exceeded = False
        self.server.state.write_forbidden = True
        with self.assertRaises(WebDavError) as captured:
            self.client.upload(self.target, b"{}")
        self.assertEqual(captured.exception.code, "WEBDAV_FORBIDDEN")

    def test_get_missing_file_reports_not_found(self):
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        with self.assertRaises(WebDavError) as captured:
            self.client.download(self.target)
        self.assertEqual(captured.exception.code, "WEBDAV_NOT_FOUND")

    def test_unknown_host_reports_network_error(self):
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        port = closed.getsockname()[1]
        closed.close()
        unreachable = build_target(
            base_url=f"http://127.0.0.1:{port}/dav",
            username=FAKE_USERNAME,
            password=FAKE_PASSWORD,
            allow_insecure_http=True,
        )
        result = WebDavClient().test_connection(unreachable)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "WEBDAV_NETWORK_ERROR")
        self.assertFalse(result["checks"]["reachable"])


class WebDavValidationTests(unittest.TestCase):
    def test_http_requires_explicit_confirmation(self):
        with self.assertRaises(WebDavError) as captured:
            build_target(base_url="http://dav.example.com/remote.php/dav", username="alice")
        self.assertEqual(captured.exception.code, "WEBDAV_INSECURE_HTTP")
        self.assertEqual(captured.exception.http_status, 400)
        self.assertTrue(build_target(
            base_url="http://dav.example.com/remote.php/dav",
            username="alice",
            allow_insecure_http=True,
        ).base_url.endswith("/remote.php/dav"))

    def test_url_and_remote_path_validation(self):
        invalid_urls = ["", "not-a-url", "ftp://dav.example.com", "https://", "https://user:pass@dav.example.com"]
        for raw in invalid_urls:
            with self.assertRaises(WebDavError) as captured:
                build_target(base_url=raw, username="alice")
            self.assertEqual(captured.exception.code, "WEBDAV_URL_INVALID", raw)
        with self.assertRaises(WebDavError):
            build_target(base_url="https://dav.example.com", username="alice", remote_directory="../etc")
        with self.assertRaises(WebDavError):
            build_target(base_url="https://dav.example.com", username="alice", remote_filename="nested/file.json")
        with self.assertRaises(WebDavError):
            build_target(base_url="https://dav.example.com", username="alice", remote_filename="..")
        with self.assertRaises(WebDavError):
            build_target(base_url="https://dav.example.com", username="")
        with self.assertRaises(WebDavError):
            build_target(base_url="https://dav.example.com", username="alice", remote_directory="back\\slash")

    def test_target_paths_are_quoted_and_stable(self):
        target = build_target(
            base_url="https://dav.example.com/remote.php/dav/files/alice/",
            username="alice",
            remote_directory="daytrace",
            remote_filename="daytrace-latest.json",
        )
        self.assertEqual(target.base_url, "https://dav.example.com/remote.php/dav/files/alice")
        self.assertEqual(target.directory_url, "https://dav.example.com/remote.php/dav/files/alice/daytrace")
        self.assertEqual(target.file_url, "https://dav.example.com/remote.php/dav/files/alice/daytrace/daytrace-latest.json")
        self.assertEqual(target.display_path, "/remote.php/dav/files/alice/daytrace/daytrace-latest.json")

    def test_transport_errors_map_to_tls_and_network_codes(self):
        self.assertEqual(_transport_error(ssl.SSLError("bad cert")).code, "WEBDAV_TLS_ERROR")
        self.assertEqual(_transport_error(socket.timeout()).code, "WEBDAV_NETWORK_ERROR")
        self.assertEqual(_transport_error(OSError("boom")).code, "WEBDAV_NETWORK_ERROR")
        self.assertIn("WEBDAV_TLS_ERROR", ERROR_MESSAGES)

    def test_error_payloads_never_contain_credentials(self):
        target = build_target(
            base_url="https://dav.example.com",
            username="alice",
            password=FAKE_PASSWORD,
            allow_insecure_http=True,
        )
        self.assertNotIn(FAKE_PASSWORD, repr(target))
        error = WebDavError("WEBDAV_AUTH_FAILED")
        self.assertNotIn(FAKE_PASSWORD, json.dumps(error.to_payload(), ensure_ascii=False))


class WebDavServiceTests(unittest.IsolatedAsyncioTestCase):
    """Service-level tests for config, preflight, upload, download and status."""

    async def asyncSetUp(self):
        webdav_sync.reset_session_secrets()
        self.server = FakeWebDavServer()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.db = self.sessions()

    async def asyncTearDown(self):
        await self.db.close()
        await self.engine.dispose()
        self.server.close()
        webdav_sync.reset_session_secrets()

    async def seed_local_data(self):
        project = models.Project(name="项目")
        self.db.add(project)
        await self.db.flush()
        self.db.add(models.Todo(name="待办", project_id=project.id))
        category = models.TimeBlockCategory(name="学习", color="#347f88")
        self.db.add(category)
        await self.db.flush()
        self.db.add(models.TimeBlock(
            block_date=date(2026, 9, 16), start_minute=0, end_minute=30,
            granularity=30, category_id=category.id, notes="专注",
        ))
        self.db.add(models.ZjuCredential(username="zju", password="zju-secret-never-upload", save_password=True))
        await self.db.commit()

    async def save_config(self, *, remember_password=True, password=FAKE_PASSWORD, **overrides):
        payload = schemas.WebDavConfigIn(
            base_url=self.server.base_url,
            username=FAKE_USERNAME,
            password=password,
            remember_password=remember_password,
            remote_directory="daytrace",
            remote_filename="daytrace-latest.json",
            allow_insecure_http=True,
        )
        for key, value in overrides.items():
            setattr(payload, key, value)
        return await webdav_sync.save_config(self.db, payload)

    async def test_config_payload_never_exposes_the_password(self):
        payload = await self.save_config()
        self.assertNotIn("password", payload)
        self.assertTrue(payload["has_password"])
        self.assertTrue(payload["remember_password"])
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn(FAKE_PASSWORD, serialized)

    async def test_remember_password_off_forgets_the_secret(self):
        await self.save_config(remember_password=True)
        self.assertTrue(webdav_sync.has_session_password(await webdav_sync.get_or_create_config(self.db)))
        await self.save_config(remember_password=False, password="")
        self.assertFalse(webdav_sync.has_session_password(await webdav_sync.get_or_create_config(self.db)))
        with self.assertRaises(WebDavError) as captured:
            await webdav_sync.preflight_upload(self.db)
        self.assertEqual(captured.exception.code, "SYNC_PASSWORD_REQUIRED")

    async def test_remember_password_on_without_any_secret_is_rejected(self):
        await self.save_config(remember_password=True)
        webdav_sync.reset_session_secrets()
        with self.assertRaises(WebDavError) as captured:
            await self.save_config(remember_password=True, password="")
        self.assertEqual(captured.exception.code, "SYNC_PASSWORD_REQUIRED")

    async def test_empty_password_keeps_the_cached_secret(self):
        await self.save_config(remember_password=True)
        payload = await self.save_config(remember_password=True, password="")
        self.assertTrue(payload["has_password"])
        self.assertTrue(payload["remember_password"])

    async def test_non_ascii_remote_directory_round_trips(self):
        payload = await self.save_config(remote_directory="日迹同步")
        self.assertEqual(payload["remote_directory"], "日迹同步")

    async def test_preflight_reports_local_and_remote_state(self):
        await self.seed_local_data()
        await self.save_config()
        empty = await webdav_sync.preflight_upload(self.db)
        self.assertFalse(empty["remote"]["exists"])
        self.assertEqual(empty["local"]["schema_version"], "0.10.0")
        self.assertEqual(empty["local"]["entity_counts"]["todos"], 1)

        await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=None)
        filled = await webdav_sync.preflight_upload(self.db)
        self.assertTrue(filled["remote"]["exists"])
        self.assertEqual(filled["remote"]["schema_version"], "0.10.0")
        self.assertIsNotNone(filled["remote"]["exported_at"])
        self.assertIsNotNone(filled["remote"]["etag"])
        self.assertIsNotNone(filled["remote"]["last_modified"])
        self.assertGreater(filled["remote"]["content_length"], 0)
        self.assertEqual(filled["remote"]["entity_counts"]["todos"], 1)

    async def test_preflight_reports_unreadable_remote_package_without_failing(self):
        await self.save_config()
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        self.server.state.store(FAKE_ROOT + "/daytrace/daytrace-latest.json", b"not json")
        result = await webdav_sync.preflight_upload(self.db)
        self.assertTrue(result["remote"]["exists"])
        self.assertEqual(result["remote"]["package_error"], ERROR_MESSAGES["WEBDAV_INVALID_PACKAGE"])

    async def test_upload_requires_confirmation_and_records_status(self):
        await self.save_config()
        with self.assertRaises(WebDavError) as captured:
            await webdav_sync.upload_latest(self.db, confirmed=False, expected_remote_etag=None)
        self.assertEqual(captured.exception.code, "SYNC_CONFIRMATION_REQUIRED")

        result = await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=None)
        self.assertTrue(result["ok"])
        self.assertTrue(result["path"].endswith("/daytrace/daytrace-latest.json"))
        self.assertIsNotNone(result["etag"])
        status = await webdav_sync.get_status(self.db)
        self.assertTrue(status["configured"])
        self.assertFalse(status["busy"])
        self.assertEqual(status["last_error"], "")
        self.assertIsNotNone(status["last_success_at"])
        self.assertEqual(status["last_remote_etag"], result["etag"])

    async def test_upload_content_excludes_secrets(self):
        await self.seed_local_data()
        await self.save_config()
        await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=None)
        body = self.server.state.files[FAKE_ROOT + "/daytrace/daytrace-latest.json"].decode()
        self.assertNotIn("zju-secret-never-upload", body)
        self.assertNotIn(FAKE_PASSWORD, body)
        self.assertNotIn("pintia", body.lower())
        package = json.loads(body)
        self.assertEqual(package["app"], "riji")
        self.assertNotIn("zju_credentials", package["entities"])

    async def test_upload_conflicts_when_remote_changed_after_preflight(self):
        await self.save_config()
        preflight = await webdav_sync.preflight_upload(self.db)
        self.assertFalse(preflight["remote"]["exists"])
        # Another device creates the file between preflight and upload.
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        self.server.state.store(FAKE_ROOT + "/daytrace/daytrace-latest.json", b'{"app":"riji"}')
        with self.assertRaises(WebDavError) as captured:
            await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=None)
        self.assertEqual(captured.exception.code, "WEBDAV_CONFLICT")
        self.assertEqual(self.server.state.files[FAKE_ROOT + "/daytrace/daytrace-latest.json"], b'{"app":"riji"}')
        self.assertEqual((await webdav_sync.get_status(self.db))["last_error_code"], "WEBDAV_CONFLICT")

    async def test_upload_conflicts_on_changed_etag(self):
        await self.save_config()
        await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=None)
        stale = (await webdav_sync.get_status(self.db))["last_remote_etag"]
        path = FAKE_ROOT + "/daytrace/daytrace-latest.json"
        self.server.state.store(path, b'{"app":"riji","changed":true}')
        with self.assertRaises(WebDavError) as captured:
            await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=stale)
        self.assertEqual(captured.exception.code, "WEBDAV_CONFLICT")
        self.assertEqual(self.server.state.files[path], b'{"app":"riji","changed":true}')

    async def export_other_device_package(self, todo_names):
        """Build a valid package from an independent database."""
        engine = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as other_db:
            for name in todo_names:
                other_db.add(models.Todo(name=name))
            await other_db.commit()
            package = await export_package(other_db)
        await engine.dispose()
        return package

    async def test_download_returns_package_without_touching_local_data(self):
        await self.seed_local_data()
        await self.save_config()
        uploaded = await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=None)

        remote_package = await self.export_other_device_package(["远端待办 A", "远端待办 B"])
        self.server.state.store(
            FAKE_ROOT + "/daytrace/daytrace-latest.json",
            json.dumps(remote_package, ensure_ascii=False).encode(),
        )
        local_before = list((await self.db.execute(select(models.Todo))).scalars())

        result = await webdav_sync.download_latest(self.db)
        self.assertEqual(result["package"]["app"], "riji")
        self.assertEqual(result["summary"]["entity_counts"]["todos"], 2)
        self.assertTrue(result["remote"]["path"].endswith("daytrace-latest.json"))
        self.assertIsNotNone(result["remote"]["etag"])
        self.assertIsNotNone(result["downloaded_at"])
        self.assertNotEqual(result["remote"]["etag"], uploaded["etag"])
        local_after = list((await self.db.execute(select(models.Todo))).scalars())
        self.assertEqual([item.name for item in local_after], [item.name for item in local_before])
        self.assertEqual([item.name for item in local_after], ["待办"])

    async def test_download_rejects_invalid_and_unsupported_packages(self):
        await self.save_config()
        path = FAKE_ROOT + "/daytrace/daytrace-latest.json"
        self.server.state.directories.add(FAKE_ROOT + "/daytrace")
        for body, expected in (
            (b"not json", "WEBDAV_INVALID_PACKAGE"),
            (b'{"app":"other","schema_version":"0.10.0","entities":{}}', "WEBDAV_INVALID_PACKAGE"),
            (b'{"app":"riji","schema_version":"9.9.9","entities":{}}', "WEBDAV_UNSUPPORTED_SCHEMA"),
            (b'{"app":"riji","schema_version":"0.10.0"}', "WEBDAV_INVALID_PACKAGE"),
        ):
            self.server.state.store(path, body)
            with self.assertRaises(WebDavError) as captured:
                await webdav_sync.download_latest(self.db)
            self.assertEqual(captured.exception.code, expected, body)

    async def test_router_error_payload_uses_stable_code_and_status(self):
        await self.save_config()
        with self.assertRaises(HTTPException) as captured:
            await sync_webdav.upload(schemas.WebDavUploadRequest(confirmed=False), self.db)
        self.assertEqual(captured.exception.status_code, 400)
        self.assertEqual(captured.exception.detail["code"], "SYNC_CONFIRMATION_REQUIRED")
        self.assertEqual(captured.exception.detail["message"], ERROR_MESSAGES["SYNC_CONFIRMATION_REQUIRED"])

    async def test_router_config_response_hides_password(self):
        await self.save_config()
        payload = await sync_webdav.read_config(self.db)
        self.assertNotIn("password", payload)
        self.assertTrue(payload["has_password"])

    async def test_concurrent_operation_reports_busy(self):
        await self.save_config()
        async with webdav_sync.sync_guard():
            self.assertTrue(webdav_sync.is_busy())
            with self.assertRaises(WebDavError) as captured:
                await webdav_sync.preflight_upload(self.db)
            self.assertEqual(captured.exception.code, "SYNC_BUSY")
            with self.assertRaises(HTTPException) as http_captured:
                await sync_webdav.test(schemas.WebDavTestRequest(), self.db)
            self.assertEqual(http_captured.exception.status_code, 409)
        self.assertFalse(webdav_sync.is_busy())

    async def test_insecure_http_url_is_rejected_by_config_save(self):
        with self.assertRaises(WebDavError) as captured:
            await webdav_sync.save_config(self.db, schemas.WebDavConfigIn(
                base_url="http://dav.example.com",
                username="alice",
                password=FAKE_PASSWORD,
                remember_password=True,
            ))
        self.assertEqual(captured.exception.code, "WEBDAV_INSECURE_HTTP")

    async def test_test_connection_accepts_unsaved_draft(self):
        result = await webdav_sync.test_connection(self.db, schemas.WebDavTestRequest(
            base_url=self.server.base_url,
            username=FAKE_USERNAME,
            password=FAKE_PASSWORD,
            remote_directory="daytrace",
            remote_filename="daytrace-latest.json",
            allow_insecure_http=True,
        ))
        self.assertTrue(result["ok"], result)
        config = await webdav_sync.get_or_create_config(self.db)
        self.assertEqual(config.base_url, "")
        self.assertFalse(webdav_sync.has_session_password(config))

    async def test_status_reports_unconfigured_state(self):
        status = await webdav_sync.get_status(self.db)
        self.assertFalse(status["configured"])
        self.assertFalse(status["has_password"])
        self.assertEqual(status["last_error"], "")

    async def test_export_package_used_for_upload_matches_export_endpoint(self):
        await self.seed_local_data()
        await self.save_config()
        expected = await export_package(self.db)
        await webdav_sync.upload_latest(self.db, confirmed=True, expected_remote_etag=None)
        uploaded = json.loads(self.server.state.files[FAKE_ROOT + "/daytrace/daytrace-latest.json"])
        self.assertEqual(uploaded["entities"].keys(), expected["entities"].keys())
        self.assertEqual(len(uploaded["entities"]["todos"]), len(expected["entities"]["todos"]))
        self.assertEqual(uploaded["app"], expected["app"])


if __name__ == "__main__":
    unittest.main()
