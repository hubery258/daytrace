from datetime import date, datetime
from typing import Any, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from .models import (
    DDLType,
    ProjectStatus,
    RecurrenceEntityType,
    RecurrenceFrequency,
    RecurrenceRuleStatus,
    ScheduleNature,
    TimerStatus,
    TodoStatus,
)


# ============ Project ============

class ProjectBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = ""
    status: ProjectStatus = ProjectStatus.active
    ddl_date: Optional[date] = None
    color: Optional[str] = Field(None, max_length=32)


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    status: Optional[ProjectStatus] = None
    ddl_date: Optional[date] = None
    color: Optional[str] = Field(None, max_length=32)


class ProjectOut(BaseModel):
    id: int
    uuid: str
    name: str
    description: str
    status: ProjectStatus
    ddl_date: Optional[date] = None
    color: Optional[str] = None
    completed_at: Optional[datetime] = None
    archived_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    todo_count: int = 0
    completed_todo_count: int = 0
    progress: Optional[float] = None
    next_todo: Optional["TodoOut"] = None
    recent_schedules: List["ScheduleOut"] = Field(default_factory=list)

    class Config:
        from_attributes = True


class ProjectOverview(BaseModel):
    project: ProjectOut
    todos: List["TodoOut"] = Field(default_factory=list)
    schedules: List["ScheduleOut"] = Field(default_factory=list)
    progress: Optional[float] = None
    todo_count: int = 0
    completed_todo_count: int = 0
    next_todo: Optional["TodoOut"] = None
    recent_schedules: List["ScheduleOut"] = Field(default_factory=list)

# ============ Todo ============

class TodoCreate(BaseModel):
    project_id: Optional[int] = None
    position: Optional[int] = Field(None, ge=0)
    name: str = Field(..., min_length=1, max_length=200)
    ddl_type: DDLType = DDLType.none
    ddl_date: Optional[datetime] = None
    reminder_days: Optional[int] = Field(None, ge=0)
    category: str = "浠诲姟"
    status: TodoStatus = TodoStatus.not_focusing
    waiting_reply_person: Optional[str] = Field(None, max_length=100)
    notes: str = ""

    @model_validator(mode="after")
    def normalize_todo_defaults(self):
        if self.ddl_type == DDLType.none:
            self.ddl_date = None
            self.reminder_days = None
            if not self.category or self.category == "浠诲姟":
                self.category = "计划箱"
        elif not self.category or self.category == "计划箱":
            self.category = "浠诲姟"
        if self.status != TodoStatus.waiting_reply:
            self.waiting_reply_person = None
        return self

    @field_validator("ddl_date")
    @classmethod
    def check_ddl_date(cls, v, info):
        ddl_type = info.data.get("ddl_type")
        if ddl_type in (DDLType.hard, DDLType.soft) and v is None:
            raise ValueError("ddl_date is required for hard or soft DDL")
        return v

    @field_validator("reminder_days")
    @classmethod
    def check_reminder_days(cls, v, info):
        ddl_type = info.data.get("ddl_type")
        if ddl_type in (DDLType.hard, DDLType.soft) and v is None:
            raise ValueError("ddl_date is required for hard or soft DDL")
        return v


class TodoUpdate(BaseModel):
    project_id: Optional[int] = None
    position: Optional[int] = Field(None, ge=0)
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
            if self.category in (None, "", "任务"):
                self.category = "浠诲姟"
        if self.status is not None and self.status != TodoStatus.waiting_reply:
            self.waiting_reply_person = None
        return self


class TodoCompleteRequest(BaseModel):
    log_date: date


class TodoOut(BaseModel):
    id: int
    uuid: str
    project_id: Optional[int] = None
    position: Optional[int] = None
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
    recurrence_rule_id: Optional[int] = None
    recurrence_date: Optional[date] = None
    is_recurrence_exception: bool = False
    created_at: datetime
    updated_at: datetime
    is_hard_ddl_near: bool = False
    is_soft_ddl_near: bool = False

    class Config:
        from_attributes = True


# ============ Schedule ============

class ScheduleCreate(BaseModel):
    project_id: Optional[int] = None
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
            raise ValueError("end_time must be after start_time")
        return v


class ScheduleUpdate(BaseModel):
    project_id: Optional[int] = None
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
    uuid: str
    project_id: Optional[int] = None
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
    recurrence_rule_id: Optional[int] = None
    recurrence_date: Optional[date] = None
    is_recurrence_exception: bool = False
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True



# ============ Actual time blocks ============

class TimeBlockCategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    color: str = Field(..., pattern=r"^#[0-9a-fA-F]{6}$")


class TimeBlockCategoryOut(TimeBlockCategoryCreate):
    id: int
    uuid: str

    class Config:
        from_attributes = True


class TimeBlockItem(BaseModel):
    start_minute: int = Field(..., ge=0, lt=1440)
    end_minute: int = Field(..., gt=0, le=1440)
    granularity: int
    category_id: int
    notes: str = ""
    linked_todo_id: Optional[int] = None
    manual_project_id: Optional[int] = None
    source: str = "manual"
    source_timer_id: Optional[int] = None
    coverage_seconds: Optional[int] = None

    @model_validator(mode="after")
    def validate_block(self):
        if self.granularity not in (15, 30):
            raise ValueError("粒度必须为 15 或 30 分钟")
        if self.end_minute - self.start_minute != self.granularity or self.start_minute % self.granularity:
            raise ValueError("时间块必须与粒度对齐")
        if self.source not in ("manual", "timer"):
            raise ValueError("来源必须为 manual 或 timer")
        if self.linked_todo_id is not None:
            self.manual_project_id = None
        return self


class TimeBlockReplace(BaseModel):
    block_date: date
    start_minute: int = Field(..., ge=0, lt=1440)
    end_minute: int = Field(..., gt=0, le=1440)
    blocks: List[TimeBlockItem] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_range(self):
        if self.end_minute <= self.start_minute or self.start_minute % 15 or self.end_minute % 15:
            raise ValueError("时间范围必须按 15 分钟对齐")
        ordered = sorted(self.blocks, key=lambda block: block.start_minute)
        previous = self.start_minute
        for block in ordered:
            if block.start_minute < self.start_minute or block.end_minute > self.end_minute or block.start_minute < previous:
                raise ValueError("时间块超出选择范围或互相重叠")
            previous = block.end_minute
        return self


class TimeBlockOut(TimeBlockItem):
    id: int
    uuid: str
    block_date: date
    project_id: Optional[int] = None
    created_at: datetime
    updated_at: datetime


# ============ Recurrence ============

class RecurrenceRuleBase(BaseModel):
    entity_type: RecurrenceEntityType
    template_json: dict[str, Any] = Field(default_factory=dict)
    frequency: RecurrenceFrequency
    start_date: date
    end_date: Optional[date] = None
    weekdays: Optional[List[int]] = None
    month_day: Optional[int] = Field(None, ge=1, le=31)
    project_id: Optional[int] = None
    status: RecurrenceRuleStatus = RecurrenceRuleStatus.active

    @model_validator(mode="after")
    def validate_rule_shape(self):
        if self.end_date and self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        if self.frequency == RecurrenceFrequency.weekly:
            if not self.weekdays:
                raise ValueError("weekly recurrence requires weekdays")
            invalid = [day for day in self.weekdays if day < 1 or day > 7]
            if invalid:
                raise ValueError("weekdays must use 1-7, where Monday is 1")
            self.weekdays = sorted(set(self.weekdays))
        else:
            self.weekdays = None
        if self.frequency == RecurrenceFrequency.monthly:
            if self.month_day is None:
                raise ValueError("monthly recurrence requires month_day")
        else:
            self.month_day = None
        if self.entity_type == RecurrenceEntityType.schedule:
            self.template_json["is_planned"] = True
        return self


class RecurrenceRuleCreate(RecurrenceRuleBase):
    pass


class RecurrenceRuleUpdate(BaseModel):
    template_json: Optional[dict[str, Any]] = None
    frequency: Optional[RecurrenceFrequency] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    weekdays: Optional[List[int]] = None
    month_day: Optional[int] = Field(None, ge=1, le=31)
    project_id: Optional[int] = None
    status: Optional[RecurrenceRuleStatus] = None


class RecurrenceRuleOut(RecurrenceRuleBase):
    id: int
    uuid: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class RecurrenceGenerateRequest(BaseModel):
    entity_type: Optional[RecurrenceEntityType] = None
    date_from: date
    date_to: date

    @model_validator(mode="after")
    def validate_window(self):
        if self.date_to < self.date_from:
            raise ValueError("date_to must be on or after date_from")
        return self


class RecurrenceGenerateOut(BaseModel):
    created_todo_ids: List[int] = Field(default_factory=list)
    created_schedule_ids: List[int] = Field(default_factory=list)
# ============ Timer ============

class TimerStart(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    project_id: Optional[int] = None
    linked_todo_id: Optional[int] = None
    notes: str = ""


class TimerUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    project_id: Optional[int] = None
    linked_todo_id: Optional[int] = None
    notes: Optional[str] = None


class TimerOut(BaseModel):
    id: int
    uuid: str
    name: str
    status: TimerStatus
    project_id: Optional[int] = None
    linked_todo_id: Optional[int] = None
    started_at: datetime
    last_resumed_at: Optional[datetime] = None
    paused_at: Optional[datetime] = None
    paused_seconds: int = 0
    active_intervals: List[List[str]] = Field(default_factory=list)
    ended_at: Optional[datetime] = None
    created_schedule_id: Optional[int] = None
    notes: str
    created_at: datetime
    updated_at: datetime
    elapsed_seconds: int = 0

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
    uuid: str
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
    uuid: str
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
# ============ ZJU Grades ============

class ZjuGradeItem(BaseModel):
    source: str = "zju_zdbk_grade"
    external_id: str
    course_id: str = ""
    course_code: str = ""
    course_name: str = ""
    credit: float = 0
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
    raw: dict[str, Any] = Field(default_factory=dict)


class ZjuGradeSummary(BaseModel):
    strategy: str = "scholarship"
    course_count: int = 0
    gpa_course_count: int = 0
    total_credit: float = 0
    earned_credit: float = 0
    gpa_credit: float = 0
    gpa_five: Optional[float] = None
    gpa_four: Optional[float] = None
    gpa_four_legacy: Optional[float] = None
    average_hundred: Optional[float] = None
    major_gpa_five: Optional[float] = None
    major_gpa_four: Optional[float] = None
    major_gpa_four_legacy: Optional[float] = None
    major_average_hundred: Optional[float] = None


class ZjuGradeFetchRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    include_major: bool = True
    strategy: str = "scholarship"


class ZjuGradeOut(BaseModel):
    items: List[ZjuGradeItem] = Field(default_factory=list)
    major_items: List[ZjuGradeItem] = Field(default_factory=list)
    summary: ZjuGradeSummary = Field(default_factory=ZjuGradeSummary)
    fetched_at: Optional[datetime] = None
    has_cache: bool = False
    from_cache: bool = False
    errors: List[str] = Field(default_factory=list)
