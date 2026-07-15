import enum
from datetime import datetime, date
from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
)
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
    linked_todo_ids = Column(JSON, default=list, nullable=False)
    location = Column(String(300), nullable=True)
    notes = Column(Text, default="", nullable=False)
    is_planned = Column(Boolean, default=True, nullable=False)
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


class ZjuCredential(Base):
    __tablename__ = "zju_credentials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), default="", nullable=False)
    password = Column(Text, default="", nullable=False)
    pintia_cookie = Column(Text, default="", nullable=False)
    save_password = Column(Boolean, default=False, nullable=False)
    save_pintia_cookie = Column(Boolean, default=False, nullable=False)
    default_reminder_days = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)


class ZjuCalendarCache(Base):
    __tablename__ = "zju_calendar_caches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    academic_year = Column(String(20), nullable=False)
    semester = Column(Integer, nullable=False)
    calendar = Column(JSON, default=dict, nullable=False)
    fetched_at = Column(DateTime, default=datetime.now, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)


class ZjuGradeSnapshot(Base):
    __tablename__ = "zju_grade_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(50), default="zju_zdbk_grade", nullable=False)
    fetched_at = Column(DateTime, default=datetime.now, nullable=False)
    summary_json = Column(JSON, default=dict, nullable=False)
    payload_json = Column(JSON, default=dict, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

class ImportBatch(Base):
    __tablename__ = "import_batches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(50), nullable=False)
    status = Column(String(50), default="completed", nullable=False)
    summary = Column(JSON, default=dict, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)


class ExternalItem(Base):
    __tablename__ = "external_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    source = Column(String(50), nullable=False)
    external_id = Column(String(300), nullable=False)
    entity_type = Column(String(50), nullable=False)
    local_entity_id = Column(Integer, nullable=False)
    import_batch_id = Column(Integer, ForeignKey("import_batches.id"), nullable=True)
    payload = Column(JSON, default=dict, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)
