from datetime import date, datetime
from typing import Any, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .models import DDLType, ScheduleNature, TodoStatus


# ============ Todo ============

class TodoCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    ddl_type: DDLType = DDLType.none
    ddl_date: Optional[datetime] = None
    reminder_days: Optional[int] = Field(None, ge=0)
    category: str = "任务"
    status: TodoStatus = TodoStatus.not_focusing
    waiting_reply_person: Optional[str] = Field(None, max_length=100)
    notes: str = ""

    @model_validator(mode="after")
    def normalize_todo_defaults(self):
        if self.ddl_type == DDLType.none:
            self.ddl_date = None
            self.reminder_days = None
            if not self.category or self.category == "任务":
                self.category = "计划箱"
        elif not self.category or self.category == "计划箱":
            self.category = "任务"
        if self.status != TodoStatus.waiting_reply:
            self.waiting_reply_person = None
        return self

    @field_validator("ddl_date")
    @classmethod
    def check_ddl_date(cls, v, info):
        ddl_type = info.data.get("ddl_type")
        if ddl_type in (DDLType.hard, DDLType.soft) and v is None:
            raise ValueError("选择了硬性或弹性 DDL 时必须指定 ddl 日期")
        return v

    @field_validator("reminder_days")
    @classmethod
    def check_reminder_days(cls, v, info):
        ddl_type = info.data.get("ddl_type")
        if ddl_type in (DDLType.hard, DDLType.soft) and v is None:
            raise ValueError("选择了硬性或弹性 DDL 时必须指定提醒日期")
        return v


class TodoUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    ddl_type: Optional[DDLType] = None
    ddl_date: Optional[datetime] = None
    reminder_days: Optional[int] = Field(None, ge=0)
    category: Optional[str] = None
    status: Optional[TodoStatus] = None
    waiting_reply_person: Optional[str] = Field(None, max_length=100)
    notes: Optional[str] = None
    is_completed: Optional[bool] = None
    completed_at: Optional[datetime] = None

    @model_validator(mode="after")
    def normalize_todo_update(self):
        if self.ddl_type == DDLType.none:
            self.ddl_date = None
            self.reminder_days = None
            if self.category in (None, "", "任务"):
                self.category = "计划箱"
        elif self.ddl_type in (DDLType.hard, DDLType.soft):
            if self.category in (None, "", "计划箱"):
                self.category = "任务"
        if self.status is not None and self.status != TodoStatus.waiting_reply:
            self.waiting_reply_person = None
        return self


class TodoOut(BaseModel):
    id: int
    name: str
    ddl_type: DDLType
    ddl_date: Optional[datetime] = None
    reminder_days: Optional[int] = None
    category: str
    status: TodoStatus
    waiting_reply_person: Optional[str] = None
    notes: str
    is_completed: bool
    completed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    is_hard_ddl_near: bool = False
    is_soft_ddl_near: bool = False

    class Config:
        from_attributes = True


# ============ Schedule ============

class ScheduleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    start_time: datetime
    end_time: datetime
    category: str = "普通日程"
    nature: ScheduleNature = ScheduleNature.no_other_task
    relax_suggestion: Optional[str] = Field(None, max_length=500)
    linked_todo_ids: List[int] = Field(default_factory=list, max_length=2)
    location: Optional[str] = Field(None, max_length=300)
    notes: str = ""
    is_planned: bool = True

    @field_validator("end_time")
    @classmethod
    def check_end_after_start(cls, v, info):
        start = info.data.get("start_time")
        if start and v <= start:
            raise ValueError("结束时间必须在开始时间之后")
        return v


class ScheduleUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    category: Optional[str] = None
    nature: Optional[ScheduleNature] = None
    relax_suggestion: Optional[str] = None
    linked_todo_ids: Optional[List[int]] = Field(None, max_length=2)
    location: Optional[str] = None
    notes: Optional[str] = None
    is_planned: Optional[bool] = None


class ScheduleOut(BaseModel):
    id: int
    name: str
    start_time: datetime
    end_time: datetime
    category: str
    nature: ScheduleNature
    relax_suggestion: Optional[str] = None
    linked_todo_ids: List[int] = []
    location: Optional[str] = None
    notes: str
    is_planned: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============ DailyLog ============

class DailyLogCreate(BaseModel):
    log_date: date
    completed_todo_ids: List[int] = Field(default_factory=list)
    log_text: str = ""


class DailyLogUpdate(BaseModel):
    completed_todo_ids: Optional[List[int]] = None
    log_text: Optional[str] = None


class DailyLogOut(BaseModel):
    id: int
    log_date: date
    completed_todo_ids: List[int] = []
    log_text: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============ LogTemplate ============

class LogTemplateCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    content: str = ""


class LogTemplateUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    content: Optional[str] = None


class LogTemplateOut(BaseModel):
    id: int
    name: str
    content: str
    created_at: datetime

    class Config:
        from_attributes = True


# ============ ZJU Todo Import ============

class ZjuCredentialIn(BaseModel):
    username: str = ""
    password: str = ""
    pintia_cookie: str = ""
    save_password: bool = False
    save_pintia_cookie: bool = False
    default_reminder_days: int = Field(1, ge=0, le=60)


class ZjuCredentialOut(BaseModel):
    username: str = ""
    has_password: bool = False
    has_pintia_cookie: bool = False
    save_password: bool = False
    save_pintia_cookie: bool = False
    default_reminder_days: int = 1


class ExternalTodoPreview(BaseModel):
    source: str
    external_id: str
    title: str
    course_name: str = ""
    ddl_at: Optional[datetime] = None
    type: str = ""
    url: str = ""
    raw: dict[str, Any] = Field(default_factory=dict)
    action: str = "create"
    reason: str = "可导入"
    imported_todo_id: Optional[int] = None


class ZjuPreviewRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    pintia_cookie: Optional[str] = None
    include_pintia: bool = True
    save_credentials: bool = False
    save_password: bool = False
    save_pintia_cookie: bool = False
    default_reminder_days: int = Field(1, ge=0, le=60)


class ZjuPreviewOut(BaseModel):
    items: List[ExternalTodoPreview] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)
    saved_credentials: bool = False


class ZjuImportRequest(BaseModel):
    items: List[ExternalTodoPreview] = Field(default_factory=list)
    reminder_days: int = Field(1, ge=0, le=60)


class ZjuImportOut(BaseModel):
    batch_id: int
    created_count: int
    skipped_count: int
    todo_ids: List[int] = Field(default_factory=list)


class ZjuUndoOut(BaseModel):
    batch_id: Optional[int] = None
    deleted_count: int = 0
    skipped_count: int = 0


# ============ ZJU Schedule Import ============

class ZjuCalendarFetchRequest(BaseModel):
    academic_year: str = Field(..., min_length=4, max_length=20)
    semester: int = Field(..., ge=1, le=2)


class ZjuCalendarCacheOut(BaseModel):
    academic_year: str
    semester: int
    has_cache: bool = False
    fetched_at: Optional[datetime] = None
    calendar: dict[str, Any] = Field(default_factory=dict)


class ExternalSchedulePreview(BaseModel):
    source: str
    external_id: str
    course_name: str
    teacher: str = ""
    location: str = ""
    start_time: datetime
    end_time: datetime
    weekday: int
    week: int
    sections: str = ""
    action: str = "create"
    reason: str = "可导入"
    imported_schedule_id: Optional[int] = None
    raw: dict[str, Any] = Field(default_factory=dict)


class ZjuSchedulePreviewRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    academic_year: str = Field(..., min_length=4, max_length=20)
    semester: int = Field(..., ge=1, le=2)


class ZjuSchedulePreviewOut(BaseModel):
    items: List[ExternalSchedulePreview] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)
    calendar_fetched_at: Optional[datetime] = None


class ZjuScheduleImportRequest(BaseModel):
    items: List[ExternalSchedulePreview] = Field(default_factory=list)


class ZjuScheduleImportOut(BaseModel):
    batch_id: int
    created_count: int
    skipped_count: int
    schedule_ids: List[int] = Field(default_factory=list)
