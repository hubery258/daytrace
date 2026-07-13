import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from typing import Any, Optional


class ZjuClientError(Exception):
    pass


@dataclass
class ExternalTodo:
    source: str
    external_id: str
    title: str
    course_name: str = ""
    ddl_at: Optional[datetime] = None
    type: str = ""
    url: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _json_loads(data: bytes) -> Any:
    return json.loads(data.decode("utf-8"))


def _legacy_tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    try:
        context.set_ciphers("DEFAULT@SECLEVEL=1")
    except ssl.SSLError:
        pass
    return context


def _password_rsa_hex(password: str, exponent: str, modulus: str) -> str:
    value = 0
    for char in password:
        value = value * 256 + ord(char)
    encrypted = pow(value, int(exponent, 16), int(modulus, 16))
    return f"{encrypted:0{len(modulus)}x}"


class ZjuCoursesClient:
    def __init__(self, username: str, password: str, timeout: int = 12):
        self.username = username.strip()
        self.password = password
        self.timeout = timeout
        self.cookie_jar = CookieJar()
        self.ssl_context = _legacy_tls_context()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar),
            urllib.request.HTTPSHandler(context=self.ssl_context),
        )
        self.no_redirect_opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar),
            urllib.request.HTTPSHandler(context=self.ssl_context),
            _NoRedirectHandler(),
        )
        self.user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36 Edg/142.0"
        )

    def _make_request(
        self,
        url: str,
        method: str = "GET",
        data: Optional[dict[str, Any] | str | bytes] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> urllib.request.Request:
        body = None
        request_headers = {
            "User-Agent": self.user_agent,
        }
        if headers:
            request_headers.update(headers)
        if isinstance(data, dict):
            body = urllib.parse.urlencode(data).encode("utf-8")
            request_headers.setdefault(
                "Content-Type", "application/x-www-form-urlencoded; charset=utf-8"
            )
        elif isinstance(data, str):
            body = data.encode("utf-8")
        elif isinstance(data, bytes):
            body = data
        return urllib.request.Request(url, data=body, headers=request_headers, method=method)

    def _open(
        self,
        url: str,
        method: str = "GET",
        data: Optional[dict[str, Any] | str | bytes] = None,
        headers: Optional[dict[str, str]] = None,
        follow_redirects: bool = True,
    ):
        req = self._make_request(url, method=method, data=data, headers=headers)
        opener = self.opener if follow_redirects else self.no_redirect_opener
        try:
            return opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            if not follow_redirects and 300 <= exc.code < 400:
                return exc
            detail = exc.read().decode("utf-8", errors="ignore")
            raise ZjuClientError(f"Request failed ({exc.code}): {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise ZjuClientError(f"Network connection failed: {exc.reason}") from exc

    def _request(
        self,
        url: str,
        method: str = "GET",
        data: Optional[dict[str, Any] | str | bytes] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> bytes:
        resp = self._open(url, method=method, data=data, headers=headers)
        try:
            return resp.read()
        finally:
            resp.close()

    def _redirect_location(self, url: str, resp) -> str:
        location = resp.headers.get("Location")
        if not location:
            raise ZjuClientError(f"Login redirect failed: {url} did not return Location")
        return urllib.parse.urljoin(url, location)

    def _cas_login_service(self, service_url: str) -> str:
        login_url = "https://zjuam.zju.edu.cn/cas/login?service=" + urllib.parse.quote(service_url, safe="")
        login_html = self._request(login_url).decode("utf-8", errors="ignore")
        execution = re.search(r'name="execution" value="([^"]+)"', login_html)
        if not execution:
            raise ZjuClientError("Unable to read CAS execution value")

        pubkey = _json_loads(self._request("https://zjuam.zju.edu.cn/cas/v2/getPubKey"))
        modulus = pubkey.get("modulus")
        exponent = pubkey.get("exponent")
        if not modulus or not exponent:
            raise ZjuClientError("Unable to read CAS RSA public key")

        try:
            password_enc = _password_rsa_hex(self.password, exponent, modulus)
        except ValueError as exc:
            raise ZjuClientError("Password encryption failed") from exc

        resp = self._open(
            login_url,
            method="POST",
            data={
                "username": self.username,
                "password": password_enc,
                "execution": execution.group(1),
                "_eventId": "submit",
                "authcode": "",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            follow_redirects=False,
        )
        try:
            if resp.status == 302:
                return self._redirect_location(login_url, resp)
            detail = resp.read().decode("utf-8", errors="ignore")
            message = re.search(r'<span id="msg">([^<]+)</span>', detail)
            if message:
                raise ZjuClientError(f"CAS login failed: {message.group(1)}")
            raise ZjuClientError(f"CAS login failed with status {resp.status}")
        finally:
            resp.close()

    def login(self) -> None:
        if not self.username or not self.password:
            raise ZjuClientError("Please enter ZJU username and password")

        url = "https://courses.zju.edu.cn/user/index"
        while urllib.parse.urlparse(url).hostname != "zjuam.zju.edu.cn":
            resp = self._open(url, follow_redirects=False)
            try:
                if not (300 <= resp.status < 400):
                    break
                url = self._redirect_location(url, resp)
            finally:
                resp.close()

        if urllib.parse.urlparse(url).hostname != "zjuam.zju.edu.cn":
            return

        service = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("service", [""])[0]
        if not service:
            raise ZjuClientError("Courses login failed: CAS redirect has no service parameter")

        url = self._cas_login_service(service)
        for _ in range(12):
            resp = self._open(url, follow_redirects=False)
            try:
                body = resp.read().decode("utf-8", errors="ignore")
                if resp.status == 200 and 'meta http-equiv="refresh"' in body:
                    match = re.search(r'meta http-equiv="refresh" content="0;URL=([^"]+)"', body)
                    if not match:
                        raise ZjuClientError("Courses login failed: cannot parse meta refresh")
                    url = urllib.parse.urljoin(url, match.group(1))
                    continue
                if 300 <= resp.status < 400:
                    url = self._redirect_location(url, resp)
                    continue
                if resp.status in (200, 204):
                    return
                raise ZjuClientError(f"Courses login failed with status {resp.status}")
            finally:
                resp.close()
        raise ZjuClientError("Courses login failed: too many redirects")

    def fetch_json(self, url: str, method: str = "GET", body: Optional[dict[str, Any]] = None) -> Any:
        data = None
        headers = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers = {"Content-Type": "application/json"}
        headers = {"Accept": "application/json, text/plain, */*", **(headers or {})}
        return _json_loads(self._request(url, method=method, data=data, headers=headers))

    def get_reliable_todos(self) -> list[ExternalTodo]:
        semesters_data = self.fetch_json(
            "https://courses.zju.edu.cn/api/my-semesters?fields=id,name,sort,is_active,code"
        )
        active_semester_ids = []
        for semester in semesters_data.get("semesters", []):
            if semester.get("is_active"):
                sid = semester.get("id")
                active_semester_ids.extend([sid, sid + 1, sid + 2])
        active_semester_ids = list(dict.fromkeys(v for v in active_semester_ids if v is not None))

        params = urllib.parse.urlencode(
            {
                "page": "1",
                "page_size": "1000",
                "sort": "all",
                "normal": '{"version":7,"apiVersion":"1.1.0"}',
                "conditions": json.dumps(
                    {
                        "role": [],
                        "semester_id": active_semester_ids,
                        "academic_year_id": [],
                        "status": ["ongoing", "notStarted"],
                        "course_type": [],
                        "effectiveness": [],
                        "published": [],
                        "display_studio_list": False,
                    },
                    ensure_ascii=False,
                ),
                "fields": "id,name,course_code",
            }
        )
        courses_data = self.fetch_json(f"https://courses.zju.edu.cn/api/my-courses?{params}")
        courses = list({course.get("id"): course for course in courses_data.get("courses", [])}.values())

        now = datetime.now()
        todos: list[ExternalTodo] = []

        for course in courses:
            course_id = course.get("id")
            course_name = course.get("name") or ""
            if course_id is None:
                continue
            try:
                activities = self.fetch_json(f"https://courses.zju.edu.cn/api/courses/{course_id}/activities").get("activities", [])
            except Exception:
                activities = []
            try:
                exams = self.fetch_json(f"https://courses.zju.edu.cn/api/courses/{course_id}/exams").get("exams", [])
            except Exception:
                exams = []
            try:
                homework_status = self.fetch_json(
                    f"https://courses.zju.edu.cn/api/course/{course_id}/homework/submission-status?no-intercept=true"
                ).get("homework_activities", [])
            except Exception:
                homework_status = []
            try:
                submitted_exams = self.fetch_json(
                    f"https://courses.zju.edu.cn/api/courses/{course_id}/submitted-exams?no-intercept=true"
                ).get("exam_ids", [])
            except Exception:
                submitted_exams = []
            try:
                classrooms = self.fetch_json(
                    f"https://courses.zju.edu.cn/api/courses/{course_id}/classroom-list"
                ).get("classrooms", [])
            except Exception:
                classrooms = []

            submitted_homework_ids = {
                item.get("id") for item in homework_status if item.get("status_code") == "submitted"
            }
            submitted_exam_ids = set(submitted_exams or [])

            for activity in activities or []:
                end_time = _parse_datetime(activity.get("end_time"))
                start_time = _parse_datetime(activity.get("start_time"))
                if not activity.get("published") or not end_time or end_time <= now:
                    continue
                if start_time and start_time > now:
                    continue
                if activity.get("type") == "homework" and activity.get("id") in submitted_homework_ids:
                    continue
                if activity.get("completion_criterion_key") == "score":
                    try:
                        if float(activity.get("score_percentage") or 0) >= 1:
                            continue
                    except (TypeError, ValueError):
                        pass

                activity_id = activity.get("id")
                todos.append(
                    ExternalTodo(
                        source="zju_courses",
                        external_id=f"courses.zju:{activity.get('type') or 'activity'}:{activity_id}",
                        title=activity.get("title") or "Untitled ZJU task",
                        course_name=course_name,
                        ddl_at=end_time,
                        type=activity.get("type") or "activity",
                        url=f"https://courses.zju.edu.cn/course/{course_id}/learning-activity#/{activity_id}",
                        raw={"course_id": course_id, "activity": activity},
                    )
                )

            for exam in exams or []:
                end_time = _parse_datetime(exam.get("end_time"))
                start_time = _parse_datetime(exam.get("start_time"))
                if not exam.get("published") or not end_time or end_time <= now:
                    continue
                if start_time and start_time > now:
                    continue
                if exam.get("id") in submitted_exam_ids:
                    continue

                exam_id = exam.get("id")
                todos.append(
                    ExternalTodo(
                        source="zju_courses",
                        external_id=f"courses.zju:quiz:{exam_id}",
                        title=exam.get("title") or "Untitled quiz",
                        course_name=course_name,
                        ddl_at=end_time,
                        type="quiz",
                        url=f"https://courses.zju.edu.cn/course/{course_id}/learning-activity#/{exam_id}",
                        raw={"course_id": course_id, "exam": exam},
                    )
                )

            for classroom in classrooms or []:
                end_time = _parse_datetime(classroom.get("end_at"))
                start_time = _parse_datetime(classroom.get("start_at"))
                if classroom.get("status") != "start":
                    continue
                if start_time and start_time > now:
                    continue
                if end_time and end_time <= now:
                    continue

                classroom_id = classroom.get("id")
                todos.append(
                    ExternalTodo(
                        source="zju_courses",
                        external_id=f"courses.zju:interaction:{classroom_id}",
                        title=classroom.get("title") or "Untitled interaction",
                        course_name=course_name,
                        ddl_at=end_time,
                        type="interaction",
                        url=f"https://courses.zju.edu.cn/course/{course_id}/content#/",
                        raw={"course_id": course_id, "classroom": classroom},
                    )
                )

        return sorted(todos, key=lambda item: item.ddl_at or datetime.max)


def fetch_pintia_todos(cookie: str, timeout: int = 12) -> list[ExternalTodo]:
    cookie = cookie.strip()
    if not cookie:
        return []

    yesterday = datetime.now(timezone.utc)
    yesterday = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
    filter_value = json.dumps({"endAtAfter": yesterday.isoformat().replace("+00:00", "Z")})
    params = urllib.parse.urlencode(
        {
            "filter": filter_value,
            "limit": "100",
            "order_by": "END_AT",
            "asc": "true",
        }
    )
    request = urllib.request.Request(
        f"https://pintia.cn/api/problem-sets?{params}",
        headers={
            "Accept": "application/json;charset=UTF-8",
            "Accept-Language": "zh-CN",
            "Cookie": cookie,
            "Referer": "https://pintia.cn/problem-sets/dashboard",
            "User-Agent": "Mozilla/5.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=_legacy_tls_context()) as resp:
            data = _json_loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise ZjuClientError(f"Pintia request failed ({exc.code}): {detail[:200]}") from exc
    except urllib.error.URLError as exc:
        raise ZjuClientError(f"Pintia network connection failed: {exc.reason}") from exc

    now = datetime.now()
    output: list[ExternalTodo] = []
    for item in data.get("problemSets", []):
        end_at = _parse_datetime(item.get("endAt"))
        if not end_at or end_at <= now:
            continue
        problem_set_id = item.get("id")
        output.append(
            ExternalTodo(
                source="pintia",
                external_id=f"pintia:problem-set:{problem_set_id}",
                title=item.get("name") or "Untitled Pintia problem set",
                course_name=item.get("organizationName") or item.get("ownerNickname") or "Pintia",
                ddl_at=end_at,
                type="problem_set",
                url=f"https://pintia.cn/problem-sets/{problem_set_id}/exam/problems",
                raw=item,
            )
        )
    return sorted(output, key=lambda item: item.ddl_at or datetime.max)
