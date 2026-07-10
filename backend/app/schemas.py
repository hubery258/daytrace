from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional, List
from datetime import datetime, date
from .models import DDLType, TodoStatus, ScheduleNature


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
            raise ValueError("选择了硬性或弹性DDL时必须指定ddl日期")
        return v

    @field_validator("reminder_days")
    @classmethod
    def check_reminder_days(cls, v, info):
        ddl_type = info.data.get("ddl_type")
        if ddl_type in (DDLType.hard, DDLType.soft) and v is None:
            raise ValueError("选择了硬性或弹性DDL时必须指定提醒日期")
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
