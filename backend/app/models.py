import enum
from datetime import datetime, date
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Date, Boolean,
    Enum as SAEnum, JSON, ForeignKey,
)
from sqlalchemy.orm import relationship
from .database import Base


class DDLType(str, enum.Enum):
    hard = "hard"
    soft = "soft"
    none = "none"


class TodoStatus(str, enum.Enum):
    waiting_reply = "waiting_reply"
    focusing = "focusing"
    not_focusing = "not_focusing"


class ScheduleNature(str, enum.Enum):
    no_other_task = "no_other_task"
    relax = "relax"
    free_arrange = "free_arrange"


class Todo(Base):
    __tablename__ = "todos"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    ddl_type = Column(SAEnum(DDLType), default=DDLType.none, nullable=False)
    ddl_date = Column(DateTime, nullable=True)
    reminder_days = Column(Integer, nullable=True)
    category = Column(String(100), default="任务", nullable=False)
    status = Column(SAEnum(TodoStatus), default=TodoStatus.not_focusing, nullable=False)
    waiting_reply_person = Column(String(100), nullable=True)
    notes = Column(Text, default="", nullable=False)
    is_completed = Column(Boolean, default=False, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    @property
    def is_hard_ddl_near(self) -> bool:
        if self.ddl_type != DDLType.hard or not self.ddl_date or not self.reminder_days:
            return False
        now = datetime.now()
        return (self.ddl_date - now).days <= self.reminder_days

    @property
    def is_soft_ddl_near(self) -> bool:
        if self.ddl_type != DDLType.soft or not self.ddl_date or not self.reminder_days:
            return False
        now = datetime.now()
        return (self.ddl_date - now).days <= self.reminder_days


class Schedule(Base):
    __tablename__ = "schedules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    start_time = Column(DateTime, nullable=False)
    end_time = Column(DateTime, nullable=False)
    category = Column(String(100), default="普通日程", nullable=False)
    nature = Column(SAEnum(ScheduleNature), default=ScheduleNature.no_other_task, nullable=False)
    relax_suggestion = Column(String(500), nullable=True)
    linked_todo_ids = Column(JSON, default=list, nullable=False)  # list[int], max 2
    location = Column(String(300), nullable=True)
    notes = Column(Text, default="", nullable=False)
    is_planned = Column(Boolean, default=True, nullable=False)  # True=计划日程, False=实际记录
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)


class DailyLog(Base):
    __tablename__ = "daily_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    log_date = Column(Date, unique=True, nullable=False)
    completed_todo_ids = Column(JSON, default=list, nullable=False)
    log_text = Column(Text, default="", nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)


class LogTemplate(Base):
    __tablename__ = "log_templates"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    content = Column(Text, default="", nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
