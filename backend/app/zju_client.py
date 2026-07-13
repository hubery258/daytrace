import json
import re
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


class ZjuCoursesClient:
    def __init__(self, username: str, password: str, timeout: int = 12):
        self.username = username.strip()
        self.password = password
        self.timeout = timeout
        self.cookie_jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar)
        )
        self.user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
        )

    def _request(
        self,
        url: str,
        method: str = "GET",
        data: Optional[dict[str, Any] | str | bytes] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> bytes:
        body = None
        request_headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json, text/plain, */*",
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

        req = urllib.request.Request(url, data=body, headers=request_headers, method=method)
        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise ZjuClientError(f"请求失败 ({exc.code}): {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise ZjuClientError(f"网络连接失败: {exc.reason}") from exc

    def login(self) -> None:
        if not self.username or not self.password:
            raise ZjuClientError("请填写 ZJU 学号和密码")

        login_html = self._request("https://zjuam.zju.edu.cn/cas/login").decode(
            "utf-8", errors="ignore"
        )
        execution = re.search(r'name="execution" value="(.*?)"', login_html)
        if not execution:
            raise ZjuClientError("无法获取统一身份认证 execution")

        pubkey = _json_loads(self._request("https://zjuam.zju.edu.cn/cas/v2/getPubKey"))
        modulus = pubkey.get("modulus")
        exponent = pubkey.get("exponent")
        if not modulus or not exponent:
            raise ZjuClientError("无法获取统一身份认证 RSA 公钥")

        try:
            password_int = int(self.password.encode("utf-8").hex(), 16)
            encrypted = pow(password_int, int(exponent, 16), int(modulus, 16))
            password_enc = f"{encrypted:0128x}"
        except ValueError as exc:
            raise ZjuClientError("密码加密失败") from exc

        self._request(
            "https://zjuam.zju.edu.cn/cas/login",
            method="POST",
            data={
                "username": self.username,
                "password": password_enc,
                "execution": execution.group(1),
                "_eventId": "submit",
                "rememberMe": "true",
            },
        )

        if not any(cookie.name == "iPlanetDirectoryPro" for cookie in self.cookie_jar):
            raise ZjuClientError("统一身份认证登录失败，请检查学号或密码")

        self._request("https://courses.zju.edu.cn/user/index")
        if not any(cookie.name == "session" and "courses.zju.edu.cn" in cookie.domain for cookie in self.cookie_jar):
            raise ZjuClientError("学在浙大登录失败，未获取 session")

    def fetch_json(self, url: str, method: str = "GET", body: Optional[dict[str, Any]] = None) -> Any:
        data = None
        headers = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers = {"Content-Type": "application/json"}
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
                        title=activity.get("title") or "未命名学在浙大任务",
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
                        title=exam.get("title") or "未命名测验",
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
                        title=classroom.get("title") or "未命名互动任务",
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
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            data = _json_loads(resp.read())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise ZjuClientError(f"Pintia 请求失败 ({exc.code}): {detail[:200]}") from exc
    except urllib.error.URLError as exc:
        raise ZjuClientError(f"Pintia 网络连接失败: {exc.reason}") from exc

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
                title=item.get("name") or "未命名 Pintia 题集",
                course_name=item.get("organizationName") or item.get("ownerNickname") or "Pintia",
                ddl_at=end_at,
                type="problem_set",
                url=f"https://pintia.cn/problem-sets/{problem_set_id}/exam/problems",
                raw=item,
            )
        )
    return sorted(output, key=lambda item: item.ddl_at or datetime.max)
