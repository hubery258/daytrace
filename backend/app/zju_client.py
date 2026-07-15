import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import hashlib
from html import unescape
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
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

    def _read_cas_execution(self, login_url: str) -> tuple[str, str]:
        resp = self._open(login_url, follow_redirects=False)
        try:
            if 300 <= resp.status < 400:
                return "", self._redirect_location(login_url, resp)
            login_html = resp.read().decode("utf-8", errors="ignore")
        finally:
            resp.close()

        execution = re.search(
            r'name=["\']execution["\'][^>]*value=["\']([^"\']+)["\']',
            login_html,
            flags=re.I,
        ) or re.search(
            r'value=["\']([^"\']+)["\'][^>]*name=["\']execution["\']',
            login_html,
            flags=re.I,
        )
        if not execution:
            raise ZjuClientError("Unable to read CAS execution value")
        return execution.group(1), ""

    def _cas_login_base(self) -> None:
        login_url = "https://zjuam.zju.edu.cn/cas/login"
        execution, redirect_url = self._read_cas_execution(login_url)
        if redirect_url:
            return

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
                "execution": execution,
                "_eventId": "submit",
                "authcode": "",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            follow_redirects=False,
        )
        try:
            if resp.status in (200, 204, 302):
                detail = resp.read().decode("utf-8", errors="ignore") if resp.status == 200 else ""
                message = re.search(r'<span id="msg">([^<]+)</span>', detail)
                if message:
                    raise ZjuClientError(f"CAS login failed: {message.group(1)}")
                return
            raise ZjuClientError(f"CAS login failed with status {resp.status}")
        finally:
            resp.close()
    def _cas_login_service(self, service_url: str) -> str:
        login_url = "https://zjuam.zju.edu.cn/cas/login?service=" + urllib.parse.quote(service_url, safe="")
        execution_value, redirect_url = self._read_cas_execution(login_url)
        if redirect_url:
            return redirect_url

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
                "execution": execution_value,
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



@dataclass
class ExternalSchedule:
    source: str
    external_id: str
    course_name: str
    teacher: str = ""
    location: str = ""
    start_time: datetime = field(default_factory=datetime.now)
    end_time: datetime = field(default_factory=datetime.now)
    weekday: int = 1
    week: int = 1
    sections: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExternalGrade:
    source: str
    external_id: str
    course_id: str = ""
    course_code: str = ""
    course_name: str = ""
    credit: float = 0.0
    original_score: str = ""
    hundred_point: Optional[float] = None
    five_point: Optional[float] = None
    four_point: Optional[float] = None
    four_point_legacy: Optional[float] = None
    gpa_included: bool = False
    credit_included: bool = False
    major: bool = False
    academic_year: str = ""
    semester: str = ""
    course_nature: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


DEFAULT_SESSION_TIME = [
    [],
    ["08:00", "08:45"],
    ["08:50", "09:35"],
    ["09:50", "10:35"],
    ["10:40", "11:25"],
    ["11:30", "12:15"],
    ["13:15", "14:00"],
    ["14:05", "14:50"],
    ["14:55", "15:40"],
    ["15:55", "16:40"],
    ["16:45", "17:30"],
    ["18:30", "19:15"],
    ["19:20", "20:05"],
    ["20:10", "20:55"],
    ["21:00", "21:45"],
    ["21:50", "22:35"],
    ["22:40", "23:25"],
]


def _strip_html(value: Any) -> str:
    text = unescape(str(value or ""))
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return text.replace("\r", "\n").strip()


def _parse_calendar_date(value: str) -> date:
    return datetime.strptime(value, "%Y%m%d").date()


def _calendar_key(day: date) -> str:
    return day.strftime("%Y%m%d")


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _parse_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _round_or_none(value: Optional[float], digits: int = 3) -> Optional[float]:
    if value is None:
        return None
    return round(value, digits)


def _normalize_course_name(value: str) -> str:
    text = str(value or "").strip()
    text = text.replace("（", "(").replace("）", ")")
    return re.sub(r"\s+", "", text).lower()


_GRADE_HUNDRED_MAP = {
    "A+": 95.0,
    "A": 92.0,
    "A-": 88.0,
    "B+": 85.0,
    "B": 82.0,
    "B-": 78.0,
    "C+": 75.0,
    "C": 72.0,
    "C-": 68.0,
    "D": 62.0,
    "F": 0.0,
    "优秀": 95.0,
    "良好": 85.0,
    "中等": 75.0,
    "及格": 65.0,
    "不及格": 0.0,
    "合格": 75.0,
    "不合格": 0.0,
}

_GRADE_FIVE_MAP = {
    "A+": 5.0,
    "A": 4.8,
    "A-": 4.5,
    "B+": 4.2,
    "B": 3.8,
    "B-": 3.5,
    "C+": 3.2,
    "C": 2.8,
    "C-": 2.5,
    "D": 1.5,
    "F": 0.0,
    "优秀": 5.0,
    "良好": 4.0,
    "中等": 3.0,
    "及格": 1.5,
    "不及格": 0.0,
}

_NON_GPA_SCORES = {"", "合格", "不合格", "弃修", "待录", "缓考", "无效", "缺考", "免修", "通过", "未通过"}
_NON_CREDIT_SCORES = {"", "不合格", "弃修", "待录", "缓考", "无效", "缺考", "未通过", "F"}


def _score_to_hundred(original_score: str) -> Optional[float]:
    text = str(original_score or "").strip()
    numeric = _parse_float(text)
    if numeric is not None:
        return numeric
    return _GRADE_HUNDRED_MAP.get(text.upper(), _GRADE_HUNDRED_MAP.get(text))


def _score_to_five(original_score: str, hundred_point: Optional[float]) -> Optional[float]:
    text = str(original_score or "").strip()
    mapped = _GRADE_FIVE_MAP.get(text.upper(), _GRADE_FIVE_MAP.get(text))
    if mapped is not None:
        return mapped
    if hundred_point is None:
        return None
    if hundred_point >= 95:
        return 5.0
    if hundred_point >= 90:
        return 4.8
    if hundred_point >= 85:
        return 4.5
    if hundred_point >= 80:
        return 4.0
    if hundred_point >= 75:
        return 3.5
    if hundred_point >= 70:
        return 3.0
    if hundred_point >= 65:
        return 2.5
    if hundred_point >= 60:
        return 1.5
    return 0.0


def _five_to_four(five_point: Optional[float]) -> Optional[float]:
    if five_point is None:
        return None
    return min(4.3, max(0.0, five_point - 0.7))


def _five_to_legacy_four(five_point: Optional[float]) -> Optional[float]:
    if five_point is None:
        return None
    return min(4.0, max(0.0, five_point - 1.0))


def _parse_zdbk_course_id(course_id: str) -> tuple[str, str, str]:
    text = str(course_id or "").strip()
    match = re.match(r"^\((\d{4}-\d{4})-([^)]*)\)-([^-]+)", text)
    if match:
        return match.group(1), match.group(2), match.group(3).strip()
    match = re.search(r"\)-([^-]+)", text)
    if match:
        return "", "", match.group(1).strip()
    return "", "", ""


def _grade_course_group_key(grade: ExternalGrade) -> str:
    if grade.course_code:
        return grade.course_code.strip().lower()
    _, _, parsed_code = _parse_zdbk_course_id(grade.course_id)
    if parsed_code:
        return parsed_code.lower()
    return _normalize_course_name(grade.course_name)


def _grade_term_key(grade: ExternalGrade) -> tuple[str, str, str]:
    return (grade.academic_year or "", grade.semester or "", grade.external_id or "")


def normalize_grade_strategy(strategy: str) -> str:
    value = (strategy or "scholarship").strip().lower()
    if value not in {"scholarship", "abroad", "all_attempts"}:
        return "scholarship"
    return value


def select_grades_by_strategy(grades: list[ExternalGrade], strategy: str) -> list[ExternalGrade]:
    normalized = normalize_grade_strategy(strategy)
    valid = [grade for grade in grades if grade.gpa_included or grade.credit_included]
    if normalized == "all_attempts":
        return valid

    grouped: dict[str, list[ExternalGrade]] = {}
    for grade in valid:
        grouped.setdefault(_grade_course_group_key(grade), []).append(grade)

    selected: list[ExternalGrade] = []
    for group in grouped.values():
        if normalized == "abroad":
            selected.append(
                sorted(
                    group,
                    key=lambda grade: (
                        grade.hundred_point if grade.hundred_point is not None else -1,
                        grade.five_point if grade.five_point is not None else -1,
                        _grade_term_key(grade),
                    ),
                )[-1]
            )
        else:
            selected.append(sorted(group, key=_grade_term_key)[0])
    return sorted(selected, key=_grade_term_key)


def calculate_grade_summary(
    grades: list[ExternalGrade],
    strategy: str = "scholarship",
    major_grades: Optional[list[ExternalGrade]] = None,
) -> dict[str, Any]:
    normalized = normalize_grade_strategy(strategy)
    selected = select_grades_by_strategy(grades, normalized)
    all_counted = [grade for grade in grades if grade.gpa_included or grade.credit_included]
    all_credit_items = [grade for grade in grades if grade.credit_included and grade.credit > 0]
    gpa_items = [grade for grade in selected if grade.gpa_included and grade.credit > 0]

    def weighted(items: list[ExternalGrade], attr: str) -> Optional[float]:
        usable = [grade for grade in items if getattr(grade, attr) is not None and grade.credit > 0]
        total_credit = sum(grade.credit for grade in usable)
        if total_credit <= 0:
            return None
        return sum((getattr(grade, attr) or 0) * grade.credit for grade in usable) / total_credit

    major_selected = select_grades_by_strategy(major_grades or [], normalized)
    major_gpa_items = [grade for grade in major_selected if grade.gpa_included and grade.credit > 0]

    return {
        "strategy": normalized,
        "course_count": len(selected),
        "gpa_course_count": len(gpa_items),
        "total_credit": round(sum(grade.credit for grade in all_counted), 3),
        "earned_credit": round(sum(grade.credit for grade in all_credit_items), 3),
        "gpa_credit": round(sum(grade.credit for grade in gpa_items), 3),
        "gpa_five": _round_or_none(weighted(gpa_items, "five_point")),
        "gpa_four": _round_or_none(weighted(gpa_items, "four_point")),
        "gpa_four_legacy": _round_or_none(weighted(gpa_items, "four_point_legacy")),
        "average_hundred": _round_or_none(weighted(gpa_items, "hundred_point")),
        "major_gpa_five": _round_or_none(weighted(major_gpa_items, "five_point")),
        "major_gpa_four": _round_or_none(weighted(major_gpa_items, "four_point")),
        "major_gpa_four_legacy": _round_or_none(weighted(major_gpa_items, "four_point_legacy")),
        "major_average_hundred": _round_or_none(weighted(major_gpa_items, "hundred_point")),
    }


def _semester_to_zdbk_xqm(semester: int) -> str:
    return "3" if semester == 1 else "12"


def _extract_zdbk_course_parts(item: dict[str, Any]) -> tuple[str, str, str]:
    candidates = [item.get("kcb"), item.get("kcmc"), item.get("cdmc")]
    text = "\n".join(_strip_html(v) for v in candidates if v)
    parts = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    name = item.get("kcmc") or (parts[0] if parts else "未命名课程")
    teacher = item.get("xm") or ""
    location = item.get("cdmc") or item.get("jxdd") or ""
    for part in parts[1:]:
        if not teacher and not re.search(r"校区|教室|楼|室|线上", part):
            teacher = part
            continue
        if not location and re.search(r"校区|教室|楼|室|线上", part):
            location = part
    return str(name).strip(), str(teacher).strip(), str(location).strip()


def _parse_week_numbers(item: dict[str, Any], fallback_max_week: int) -> list[int]:
    text = " ".join(str(item.get(key) or "") for key in ("zcd", "qsjsz", "kcb"))
    weeks: set[int] = set()
    for start, end in re.findall(r"(\d+)\s*-\s*(\d+)\s*周", text):
        weeks.update(range(int(start), int(end) + 1))
    for single in re.findall(r"(?<![-\d])(\d+)\s*周", text):
        weeks.add(int(single))
    if not weeks:
        weeks.update(range(1, fallback_max_week + 1))
    dsz = str(item.get("dsz") or "")
    if dsz == "1":
        weeks = {w for w in weeks if w % 2 == 1}
    elif dsz == "0":
        weeks = {w for w in weeks if w % 2 == 0}
    return sorted(w for w in weeks if 1 <= w <= fallback_max_week)




def _zdbk_half_flags(item: dict[str, Any]) -> tuple[bool, bool, bool]:
    semester_text = str(item.get("xxq") or item.get("xq") or "")
    first_half = any(value in semester_text for value in ("秋", "春"))
    second_half = any(value in semester_text for value in ("冬", "夏"))
    return first_half, second_half, bool(semester_text.strip())


def _matches_selected_zdbk_semester(item: dict[str, Any], semester: int) -> bool:
    first_half, second_half, has_marker = _zdbk_half_flags(item)
    if not has_marker or not (first_half or second_half):
        return True
    semester_text = str(item.get("xxq") or item.get("xq") or "")
    if semester == 1:
        return any(value in semester_text for value in ("秋", "冬")) and not any(value in semester_text for value in ("春", "夏"))
    return any(value in semester_text for value in ("春", "夏")) and not any(value in semester_text for value in ("秋", "冬"))


def _zdbk_half_indexes(item: dict[str, Any]) -> list[int]:
    first_half, second_half, has_marker = _zdbk_half_flags(item)
    if not has_marker or not (first_half or second_half):
        return [0, 1]
    halves: list[int] = []
    if first_half:
        halves.append(0)
    if second_half:
        halves.append(1)
    return halves


def _build_half_weekday_dates(start: date, end: date) -> list[list[list[date]]]:
    dates: list[list[list[date]]] = [[[] for _ in range(8)], [[] for _ in range(8)]]
    odd_even_week = 0
    current = start
    while current <= end:
        dates[odd_even_week][current.isoweekday()].append(current)
        if current.isoweekday() == 7:
            odd_even_week = 1 - odd_even_week
        current += timedelta(days=1)
    return dates

def _course_key(item: dict[str, Any], course_name: str, teacher: str, location: str) -> str:
    for key in ("jxb_id", "jxbid", "kch", "kch_id", "xkkh"):
        value = item.get(key)
        if value:
            return str(value)
    raw = json.dumps(item, ensure_ascii=False, sort_keys=True)
    digest = hashlib.sha1(f"{course_name}|{teacher}|{location}|{raw}".encode("utf-8")).hexdigest()[:12]
    return digest


def _extract_zdbk_query_items(raw: bytes | str) -> list[dict[str, Any]]:
    text = raw.decode("utf-8", errors="ignore") if isinstance(raw, bytes) else raw
    stripped = text.strip()
    if not stripped or stripped == "null":
        return []
    if any(marker in stripped for marker in ("login_ssologin", "cas/login", "统一身份认证")):
        raise ZjuClientError("ZDBK session expired, please retry login")
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r'"items"\s*:\s*(\[.*?\])\s*,\s*"limit"', stripped, flags=re.S)
        if not match:
            raise ZjuClientError("ZDBK grade response format is invalid")
        try:
            data = {"items": json.loads(match.group(1))}
        except json.JSONDecodeError as exc:
            raise ZjuClientError("ZDBK grade items cannot be parsed") from exc
    if isinstance(data, dict):
        items = data.get("items") or data.get("rows") or []
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
    raise ZjuClientError("ZDBK grade response format is invalid")


def _normalize_zdbk_grade_item(item: dict[str, Any], major: bool = False) -> ExternalGrade:
    course_id = str(item.get("xkkh") or item.get("jxb_id") or item.get("jxbid") or "").strip()
    parsed_year, parsed_semester, parsed_course_code = _parse_zdbk_course_id(course_id)
    course_code = str(item.get("kch") or item.get("kch_id") or item.get("kcdm") or parsed_course_code or "").strip()
    course_name = str(item.get("kcmc") or item.get("kcmc_zw") or "未命名课程").strip()
    credit = _parse_float(item.get("xf")) or 0.0
    original_score = str(item.get("cj") or item.get("bfzcj") or item.get("zcj") or "").strip()
    hundred_point = _score_to_hundred(original_score)
    five_point = _parse_float(item.get("jd"))
    if five_point is None:
        five_point = _score_to_five(original_score, hundred_point)
    four_point = _five_to_four(five_point)
    four_point_legacy = _five_to_legacy_four(five_point)
    academic_year = str(item.get("xnmmc") or item.get("xnm") or item.get("xn") or parsed_year or "").strip()
    semester = str(item.get("xqmmc") or item.get("xqm") or item.get("xq") or parsed_semester or "").strip()
    course_nature = str(item.get("kcxzmc") or item.get("kclbmc") or item.get("kcsxmc") or "").strip()
    external_seed = course_id or course_code or f"{academic_year}:{semester}:{course_name}:{original_score}"
    external_id = f"zdbk:{hashlib.sha1(external_seed.encode('utf-8')).hexdigest()[:16]}"
    score_key = original_score.upper()
    gpa_included = bool(credit > 0 and five_point is not None and score_key not in _NON_GPA_SCORES)
    credit_included = bool(credit > 0 and score_key not in _NON_CREDIT_SCORES and (five_point is None or five_point > 0 or original_score == "合格"))
    return ExternalGrade(
        source="zju_zdbk_grade",
        external_id=external_id,
        course_id=course_id,
        course_code=course_code,
        course_name=course_name,
        credit=credit,
        original_score=original_score,
        hundred_point=hundred_point,
        five_point=five_point,
        four_point=four_point,
        four_point_legacy=four_point_legacy,
        gpa_included=gpa_included,
        credit_included=credit_included,
        major=major,
        academic_year=academic_year,
        semester=semester,
        course_nature=course_nature,
        raw=item,
    )


def fetch_celechron_calendar(academic_year: str, semester: int, timeout: int = 12) -> dict[str, Any]:
    start_year = academic_year.split("-")[0].strip()
    try:
        year = int(start_year)
    except ValueError as exc:
        raise ZjuClientError("Invalid academic year") from exc
    url = f"http://calendar.celechron.top/{year}-{year + 1}-{semester}.json"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            data = _json_loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ZjuClientError(f"暂时没有 {academic_year} {('秋冬' if semester == 1 else '春夏')} 学期的校历数据") from exc
        raise ZjuClientError(f"Calendar request failed ({exc.code})") from exc
    except urllib.error.URLError as exc:
        raise ZjuClientError(f"Calendar network connection failed: {exc.reason}") from exc
    if not isinstance(data, dict) or "startEnd" not in data:
        raise ZjuClientError("Calendar data format is invalid")
    return data


class ZjuZdbkClient(ZjuCoursesClient):
    service_url = "https://zdbk.zju.edu.cn/jwglxt/xtgl/login_ssologin.html"

    def _has_zdbk_cookies(self) -> bool:
        names = {cookie.name for cookie in self.cookie_jar}
        return "JSESSIONID" in names and "route" in names
    def _discover_zdbk_service(self) -> str:
        resp = self._open(self.service_url, follow_redirects=False)
        try:
            if 300 <= resp.status < 400:
                location = self._redirect_location(self.service_url, resp)
                parsed = urllib.parse.urlparse(location)
                if parsed.hostname == "zjuam.zju.edu.cn":
                    service = urllib.parse.parse_qs(parsed.query).get("service", [""])[0]
                    if service:
                        return service
                return location
            body = resp.read().decode("utf-8", errors="ignore")
            match = re.search(r'https://zjuam\.zju\.edu\.cn/cas/login\?service=([^"\'<>\s]+)', body)
            if match:
                return urllib.parse.unquote(match.group(1))
            return self.service_url
        finally:
            resp.close()
    def login_zdbk(self) -> None:
        if not self.username or not self.password:
            raise ZjuClientError("Please enter ZJU username and password")

        try:
            ticket_url = self._cas_login_service(self.service_url)
        except ZjuClientError as exc:
            if "Unable to read CAS execution value" not in str(exc):
                raise
            self._cas_login_base()
            ticket_url = self._cas_login_service(self.service_url)

        resp = self._open(ticket_url, follow_redirects=False)
        try:
            if 300 <= resp.status < 400:
                next_url = self._redirect_location(ticket_url, resp)
                resp.close()
                resp = self._open(next_url, follow_redirects=False)
            resp.read()
        finally:
            resp.close()

        if not self._has_zdbk_cookies():
            raise ZjuClientError("ZDBK login failed: missing JSESSIONID/route")

    def _request_zdbk_grade_items(self, url: str) -> list[dict[str, Any]]:
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Connection": "close",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html",
        }

        def read_once() -> str:
            resp = self._open(url, method="POST", headers=headers, follow_redirects=False)
            try:
                if 300 <= resp.status < 400:
                    raise ZjuClientError("ZDBK session expired, please retry login")
                return resp.read().decode("utf-8", errors="ignore")
            finally:
                resp.close()

        try:
            response_text = read_once()
            return _extract_zdbk_query_items(response_text)
        except ZjuClientError as exc:
            if "session expired" in str(exc) or "(901)" in str(exc):
                self.login_zdbk()
                return _extract_zdbk_query_items(read_once())
            raise

    def get_undergraduate_grades(self) -> list[ExternalGrade]:
        items = self._request_zdbk_grade_items(
            "https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html?doType=query&queryModel.showCount=5000"
        )
        return [_normalize_zdbk_grade_item(item, major=False) for item in items]

    def get_undergraduate_major_grades(self) -> list[ExternalGrade]:
        items = self._request_zdbk_grade_items(
            "https://zdbk.zju.edu.cn/jwglxt/zycjtj/xszgkc_cxXsZgkcIndex.html?doType=query&queryModel.showCount=5000"
        )
        return [_normalize_zdbk_grade_item(item, major=True) for item in items]
    def get_undergraduate_timetable(self, academic_year: str, semester: int) -> list[dict[str, Any]]:
        xnm = academic_year.split("-")[0].strip()
        data = {
            "xnm": xnm,
            "xqm": _semester_to_zdbk_xqm(semester),
            "kzlx": "ck",
        }
        try:
            raw = self._request(
                "https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html",
                method="POST",
                data=data,
                headers={
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": "https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html",
                },
            )
        except ZjuClientError as exc:
            if "(901)" in str(exc):
                self.login_zdbk()
                raw = self._request(
                    "https://zdbk.zju.edu.cn/jwglxt/kbcx/xskbcx_cxXsKb.html",
                    method="POST",
                    data=data,
                    headers={
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": "https://zdbk.zju.edu.cn/jwglxt/xtgl/index_initMenu.html",
                    },
                )
            else:
                raise
        data = _json_loads(raw)
        if isinstance(data, dict):
            return data.get("kbList") or []
        raise ZjuClientError("ZDBK timetable response format is invalid")


def expand_zdbk_timetable(
    items: list[dict[str, Any]],
    calendar: dict[str, Any],
    academic_year: str,
    semester: int,
) -> list[ExternalSchedule]:
    start_end = calendar.get("startEnd") or []
    if len(start_end) < 4:
        raise ZjuClientError("Cached calendar missing startEnd")
    session_time = calendar.get("sessionTime") or DEFAULT_SESSION_TIME
    if len(session_time) < 2:
        session_time = DEFAULT_SESSION_TIME

    half_ranges = [
        (_parse_calendar_date(start_end[0]), _parse_calendar_date(start_end[1])),
        (_parse_calendar_date(start_end[2]), _parse_calendar_date(start_end[3])),
    ]
    half_dates = [_build_half_weekday_dates(start, end) for start, end in half_ranges]
    blocked = set((calendar.get("holiday") or {}).keys()) | set((calendar.get("dummy") or {}).keys())
    exchange = calendar.get("exchange") or {}
    exchange_by_original = {key[8:16]: key[0:8] for key in exchange.keys() if len(key) >= 16}

    output: list[ExternalSchedule] = []
    for item in items:
        if not _matches_selected_zdbk_semester(item, semester):
            continue

        weekday = _parse_int(item.get("xqj"), 0)
        section_start = _parse_int(item.get("djj"), 0)
        section_count = _parse_int(item.get("skcd"), 1)
        if weekday < 1 or weekday > 7 or section_start < 1:
            continue
        section_end = section_start + max(section_count, 1) - 1
        if section_start >= len(session_time) or section_end >= len(session_time):
            continue

        dsz = str(item.get("dsz") or "")
        odd_even_indexes: list[int] = []
        if dsz != "1":
            odd_even_indexes.append(0)
        if dsz != "0":
            odd_even_indexes.append(1)

        course_name, teacher, location = _extract_zdbk_course_parts(item)
        key = _course_key(item, course_name, teacher, location)
        start_clock = session_time[section_start][0]
        end_clock = session_time[section_end][1]

        for half_index in _zdbk_half_indexes(item):
            for odd_even_index in odd_even_indexes:
                for occurrence_index, scheduled_date in enumerate(half_dates[half_index][odd_even_index][weekday], start=1):
                    date_key = _calendar_key(scheduled_date)
                    if date_key in blocked:
                        continue
                    actual_key = exchange_by_original.get(date_key, date_key)
                    if actual_key in blocked:
                        continue
                    actual_date = _parse_calendar_date(actual_key)
                    start_time = datetime.fromisoformat(f"{actual_date.isoformat()}T{start_clock}:00")
                    end_time = datetime.fromisoformat(f"{actual_date.isoformat()}T{end_clock}:00")
                    week_label = half_index * 8 + (occurrence_index - 1) * 2 + odd_even_index + 1
                    external_id = (
                        f"zdbk:{academic_year}:{semester}:{key}:half{half_index}:"
                        f"week{week_label}:day{weekday}:section{section_start}"
                    )
                    output.append(
                        ExternalSchedule(
                            source="zju_zdbk",
                            external_id=external_id,
                            course_name=course_name,
                            teacher=teacher,
                            location=location,
                            start_time=start_time,
                            end_time=end_time,
                            weekday=weekday,
                            week=week_label,
                            sections=f"{section_start}-{section_end}",
                            raw={"academic_year": academic_year, "semester": semester, "half_index": half_index, "item": item},
                        )
                    )
    return sorted(output, key=lambda item: (item.start_time, item.course_name))
