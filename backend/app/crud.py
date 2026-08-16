import asyncio
from datetime import datetime, date, timedelta, timezone
from typing import Optional, List
from sqlalchemy import select, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession
from . import models, schemas


def beijing_now() -> datetime:
    return datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None)


_daily_log_lock = asyncio.Lock()


def _next_todo(todos: List[models.Todo]) -> Optional[models.Todo]:
    incomplete = [todo for todo in todos if not todo.is_completed]
    return min(
        incomplete,
        key=lambda todo: (
            todo.ddl_date is None,
            todo.ddl_date or datetime.max,
            todo.created_at or datetime.max,
            todo.id or 0,
        ),
        default=None,
    )


# ============ Project CRUD ============

async def _attach_project_overview_fields(db: AsyncSession, project: models.Project) -> models.Project:
    todos = await get_todos(db, project_id=project.id)
    schedules = await get_schedules(db, project_id=project.id)
    todo_count = len(todos)
    completed_todo_count = len([t for t in todos if t.is_completed])
    project.todo_count = todo_count
    project.completed_todo_count = completed_todo_count
    project.progress = (completed_todo_count / todo_count) if todo_count else None
    project.next_todo = _next_todo(todos)
    project.recent_schedules = schedules[:3]
    return project


async def create_project(db: AsyncSession, data: schemas.ProjectCreate) -> models.Project:
    now = datetime.now()
    values = data.model_dump()
    if values.get("status") == models.ProjectStatus.completed:
        values["completed_at"] = now
    if values.get("status") == models.ProjectStatus.archived:
        values["archived_at"] = now
    project = models.Project(**values)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return await _attach_project_overview_fields(db, project)


async def get_project(db: AsyncSession, project_id: int) -> Optional[models.Project]:
    result = await db.execute(select(models.Project).where(models.Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        return None
    return await _attach_project_overview_fields(db, project)


async def get_projects(
    db: AsyncSession,
    status: Optional[models.ProjectStatus] = None,
    include_hidden: bool = False,
) -> List[models.Project]:
    stmt = select(models.Project)
    if status:
        stmt = stmt.where(models.Project.status == status)
    elif not include_hidden:
        stmt = stmt.where(models.Project.status.notin_([models.ProjectStatus.archived, models.ProjectStatus.canceled]))
    stmt = stmt.order_by(models.Project.updated_at.desc())
    result = await db.execute(stmt)
    projects = list(result.scalars().all())
    return [await _attach_project_overview_fields(db, project) for project in projects]


async def update_project(db: AsyncSession, project_id: int, data: schemas.ProjectUpdate) -> Optional[models.Project]:
    result = await db.execute(select(models.Project).where(models.Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        return None
    update_data = data.model_dump(exclude_unset=True)
    new_status = update_data.get("status")
    if new_status == models.ProjectStatus.completed and not project.completed_at:
        update_data["completed_at"] = datetime.now()
    elif new_status and new_status != models.ProjectStatus.completed:
        update_data["completed_at"] = None
    if new_status == models.ProjectStatus.archived and not project.archived_at:
        update_data["archived_at"] = datetime.now()
    elif new_status and new_status != models.ProjectStatus.archived:
        update_data["archived_at"] = None
    for key, value in update_data.items():
        setattr(project, key, value)
    project.updated_at = datetime.now()
    await db.commit()
    await db.refresh(project)
    return await _attach_project_overview_fields(db, project)


async def delete_project(db: AsyncSession, project_id: int) -> bool:
    result = await db.execute(select(models.Project).where(models.Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        return False
    await db.execute(update(models.Todo).where(models.Todo.project_id == project_id).values(project_id=None))
    await db.execute(update(models.Schedule).where(models.Schedule.project_id == project_id).values(project_id=None))
    await db.delete(project)
    await db.commit()
    return True


async def get_project_overview(db: AsyncSession, project_id: int) -> Optional[dict]:
    project = await get_project(db, project_id)
    if not project:
        return None
    todos = await get_todos(db, project_id=project_id)
    schedules = await get_schedules(db, project_id=project_id)
    todo_count = len(todos)
    completed_todo_count = len([t for t in todos if t.is_completed])
    progress = (completed_todo_count / todo_count) if todo_count else None
    next_todo = _next_todo(todos)
    recent_schedules = schedules[:3]
    project.todo_count = todo_count
    project.completed_todo_count = completed_todo_count
    project.progress = progress
    project.next_todo = next_todo
    project.recent_schedules = recent_schedules
    return {
        "project": project,
        "todos": todos,
        "schedules": schedules,
        "progress": progress,
        "todo_count": todo_count,
        "completed_todo_count": completed_todo_count,
        "next_todo": next_todo,
        "recent_schedules": recent_schedules,
    }

# ============ Todo CRUD ============

async def create_todo(db: AsyncSession, data: schemas.TodoCreate) -> models.Todo:
    todo = models.Todo(**data.model_dump())
    db.add(todo)
    await db.commit()
    await db.refresh(todo)
    return todo


async def get_todo(db: AsyncSession, todo_id: int) -> Optional[models.Todo]:
    result = await db.execute(select(models.Todo).where(models.Todo.id == todo_id))
    return result.scalar_one_or_none()


async def get_todos(
    db: AsyncSession,
    category: Optional[str] = None,
    status: Optional[models.TodoStatus] = None,
    is_completed: Optional[bool] = None,
    project_id: Optional[int] = None,
) -> List[models.Todo]:
    stmt = select(models.Todo)
    if category:
        stmt = stmt.where(models.Todo.category == category)
    if status:
        stmt = stmt.where(models.Todo.status == status)
    if is_completed is not None:
        stmt = stmt.where(models.Todo.is_completed == is_completed)
    if project_id is not None:
        stmt = stmt.where(models.Todo.project_id == project_id)
    stmt = stmt.order_by(models.Todo.created_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_focusing_todos(db: AsyncSession) -> List[models.Todo]:
    result = await db.execute(
        select(models.Todo).where(
            models.Todo.status == models.TodoStatus.focusing,
            models.Todo.is_completed == False,
        )
    )
    return list(result.scalars().all())


async def get_waiting_reply_todos(db: AsyncSession) -> List[models.Todo]:
    result = await db.execute(
        select(models.Todo).where(
            models.Todo.status == models.TodoStatus.waiting_reply,
            models.Todo.is_completed == False,
        )
    )
    return list(result.scalars().all())


async def get_ddl_near_todos(db: AsyncSession) -> List[models.Todo]:
    """Get all incomplete todos and compute ddl_near in Python."""
    result = await db.execute(
        select(models.Todo).where(models.Todo.is_completed == False)
    )
    todos = list(result.scalars().all())
    return [t for t in todos if t.is_hard_ddl_near or t.is_soft_ddl_near]


async def update_todo(db: AsyncSession, todo_id: int, data: schemas.TodoUpdate) -> Optional[models.Todo]:
    todo = await get_todo(db, todo_id)
    if not todo:
        return None
    update_data = data.model_dump(exclude_unset=True)
    if "is_completed" in update_data:
        update_data["completed_at"] = beijing_now() if update_data["is_completed"] else None
    edited_fields = set(update_data) - {"is_completed", "completed_at"}
    if todo.recurrence_rule_id and edited_fields:
        update_data["is_recurrence_exception"] = True
    for key, value in update_data.items():
        setattr(todo, key, value)
    await db.commit()
    await db.refresh(todo)
    return todo


async def complete_todo_and_log(
    db: AsyncSession,
    todo_id: int,
    log_date: date,
) -> Optional[models.Todo]:
    """Complete a todo and add it to the selected daily log in one transaction."""
    async with _daily_log_lock:
        todo = await get_todo(db, todo_id)
        if not todo:
            return None

        if not todo.is_completed:
            todo.is_completed = True
            todo.completed_at = beijing_now()

        log = await get_daily_log_by_date(db, log_date)
        if log:
            completed_ids = list(log.completed_todo_ids or [])
            if todo.id not in completed_ids:
                completed_ids.append(todo.id)
                log.completed_todo_ids = completed_ids
            log.updated_at = beijing_now()
        else:
            db.add(models.DailyLog(
                log_date=log_date,
                completed_todo_ids=[todo.id],
                log_text="",
            ))

        try:
            await db.commit()
        except Exception:
            await db.rollback()
            raise
        await db.refresh(todo)
        return todo

async def delete_todo(db: AsyncSession, todo_id: int) -> bool:
    todo = await get_todo(db, todo_id)
    if not todo:
        return False
    if todo.recurrence_rule_id and todo.recurrence_date:
        db.add(models.RecurrenceException(
            recurrence_rule_id=todo.recurrence_rule_id,
            entity_type=models.RecurrenceEntityType.todo,
            recurrence_date=todo.recurrence_date,
        ))
    await db.delete(todo)
    await db.commit()
    return True

# ============ Schedule CRUD ============

async def create_schedule(db: AsyncSession, data: schemas.ScheduleCreate) -> models.Schedule:
    schedule = models.Schedule(**data.model_dump())
    db.add(schedule)
    await db.commit()
    await db.refresh(schedule)
    return schedule


async def get_schedule(db: AsyncSession, schedule_id: int) -> Optional[models.Schedule]:
    result = await db.execute(select(models.Schedule).where(models.Schedule.id == schedule_id))
    return result.scalar_one_or_none()


async def get_schedules(
    db: AsyncSession,
    is_planned: Optional[bool] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    project_id: Optional[int] = None,
) -> List[models.Schedule]:
    stmt = select(models.Schedule)
    if is_planned is not None:
        stmt = stmt.where(models.Schedule.is_planned == is_planned)
    if date_from:
        stmt = stmt.where(models.Schedule.end_time > date_from)
    if date_to:
        stmt = stmt.where(models.Schedule.start_time < date_to)
    if project_id is not None:
        stmt = stmt.where(models.Schedule.project_id == project_id)
    stmt = stmt.order_by(models.Schedule.start_time.asc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_overlapping_schedules(
    db: AsyncSession,
    *,
    start_time: datetime,
    end_time: datetime,
    is_planned: bool,
    exclude_id: Optional[int] = None,
) -> List[models.Schedule]:
    stmt = select(models.Schedule).where(
        models.Schedule.is_planned == is_planned,
        models.Schedule.start_time < end_time,
        models.Schedule.end_time > start_time,
    )
    if exclude_id is not None:
        stmt = stmt.where(models.Schedule.id != exclude_id)
    stmt = stmt.order_by(models.Schedule.start_time.asc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_current_schedule(db: AsyncSession) -> Optional[models.Schedule]:
    """Get the schedule that is currently active (start <= now <= end)."""
    now = beijing_now()
    result = await db.execute(
        select(models.Schedule).where(
            models.Schedule.start_time <= now,
            models.Schedule.end_time > now,
        ).order_by(models.Schedule.start_time.asc()).limit(1)
    )
    return result.scalar_one_or_none()


async def update_schedule(db: AsyncSession, schedule_id: int, data: schemas.ScheduleUpdate) -> Optional[models.Schedule]:
    schedule = await get_schedule(db, schedule_id)
    if not schedule:
        return None
    update_data = data.model_dump(exclude_unset=True)
    if schedule.recurrence_rule_id and update_data:
        update_data["is_recurrence_exception"] = True
    for key, value in update_data.items():
        setattr(schedule, key, value)
    await db.commit()
    await db.refresh(schedule)
    return schedule

async def delete_schedule(db: AsyncSession, schedule_id: int) -> bool:
    schedule = await get_schedule(db, schedule_id)
    if not schedule:
        return False
    if schedule.recurrence_rule_id and schedule.recurrence_date:
        db.add(models.RecurrenceException(
            recurrence_rule_id=schedule.recurrence_rule_id,
            entity_type=models.RecurrenceEntityType.schedule,
            recurrence_date=schedule.recurrence_date,
        ))
    await db.delete(schedule)
    await db.commit()
    return True

# ============ Timer CRUD ============

ACTIVE_TIMER_STATUSES = (models.TimerStatus.running, models.TimerStatus.paused)


async def get_current_timer(db: AsyncSession) -> Optional[models.TimerSession]:
    result = await db.execute(
        select(models.TimerSession)
        .where(models.TimerSession.status.in_(ACTIVE_TIMER_STATUSES))
        .order_by(models.TimerSession.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def get_timer(db: AsyncSession, timer_id: int) -> Optional[models.TimerSession]:
    result = await db.execute(select(models.TimerSession).where(models.TimerSession.id == timer_id))
    return result.scalar_one_or_none()


async def start_timer(db: AsyncSession, data: schemas.TimerStart) -> models.TimerSession:
    now = beijing_now()
    timer = models.TimerSession(
        **data.model_dump(),
        status=models.TimerStatus.running,
        started_at=now,
        last_resumed_at=now,
        paused_seconds=0,
    )
    db.add(timer)
    await db.commit()
    await db.refresh(timer)
    return timer


async def update_timer_details(db: AsyncSession, timer: models.TimerSession, data: schemas.TimerUpdate) -> models.TimerSession:
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(timer, key, value)
    timer.updated_at = beijing_now()
    await db.commit()
    await db.refresh(timer)
    return timer


async def pause_timer(db: AsyncSession, timer: models.TimerSession) -> models.TimerSession:
    timer.status = models.TimerStatus.paused
    timer.paused_at = beijing_now()
    timer.updated_at = timer.paused_at
    await db.commit()
    await db.refresh(timer)
    return timer


async def resume_timer(db: AsyncSession, timer: models.TimerSession) -> models.TimerSession:
    now = beijing_now()
    if timer.paused_at:
        timer.paused_seconds = (timer.paused_seconds or 0) + max(0, int((now - timer.paused_at).total_seconds()))
    timer.status = models.TimerStatus.running
    timer.last_resumed_at = now
    timer.paused_at = None
    timer.updated_at = now
    await db.commit()
    await db.refresh(timer)
    return timer


async def finish_timer(db: AsyncSession, timer: models.TimerSession) -> models.TimerSession:
    now = beijing_now()
    if timer.status == models.TimerStatus.paused and timer.paused_at:
        timer.paused_seconds = (timer.paused_seconds or 0) + max(0, int((now - timer.paused_at).total_seconds()))
        timer.paused_at = None
    timer.status = models.TimerStatus.completed
    timer.ended_at = now
    timer.updated_at = now
    await db.commit()
    await db.refresh(timer)
    return timer


async def cancel_timer(db: AsyncSession, timer: models.TimerSession) -> models.TimerSession:
    now = beijing_now()
    if timer.status == models.TimerStatus.paused and timer.paused_at:
        timer.paused_seconds = (timer.paused_seconds or 0) + max(0, int((now - timer.paused_at).total_seconds()))
    timer.status = models.TimerStatus.canceled
    timer.ended_at = now
    timer.paused_at = None
    timer.updated_at = now
    await db.commit()
    await db.refresh(timer)
    return timer


async def attach_timer_schedule(db: AsyncSession, timer: models.TimerSession, schedule_id: int) -> models.TimerSession:
    timer.created_schedule_id = schedule_id
    timer.updated_at = beijing_now()
    await db.commit()
    await db.refresh(timer)
    return timer


async def get_recent_timers(db: AsyncSession, limit: int = 10) -> List[models.TimerSession]:
    result = await db.execute(
        select(models.TimerSession)
        .where(models.TimerSession.status.in_([models.TimerStatus.completed, models.TimerStatus.canceled]))
        .order_by(models.TimerSession.updated_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


# ============ DailyLog CRUD ============

async def upsert_daily_log(db: AsyncSession, data: schemas.DailyLogCreate) -> models.DailyLog:
    async with _daily_log_lock:
        existing = await get_daily_log_by_date(db, data.log_date)
        if existing:
            existing.completed_todo_ids = list(dict.fromkeys([
                *(existing.completed_todo_ids or []),
                *data.completed_todo_ids,
            ]))
            existing.log_text = data.log_text
            existing.updated_at = beijing_now()
            await db.commit()
            await db.refresh(existing)
            return existing
        log = models.DailyLog(**data.model_dump())
        db.add(log)
        await db.commit()
        await db.refresh(log)
        return log


async def get_daily_log_by_date(db: AsyncSession, log_date: date) -> Optional[models.DailyLog]:
    result = await db.execute(
        select(models.DailyLog).where(models.DailyLog.log_date == log_date)
    )
    return result.scalar_one_or_none()


async def get_daily_logs(
    db: AsyncSession,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
) -> List[models.DailyLog]:
    stmt = select(models.DailyLog)
    if date_from:
        stmt = stmt.where(models.DailyLog.log_date >= date_from)
    if date_to:
        stmt = stmt.where(models.DailyLog.log_date <= date_to)
    stmt = stmt.order_by(models.DailyLog.log_date.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


# ============ LogTemplate CRUD ============

async def create_log_template(db: AsyncSession, data: schemas.LogTemplateCreate) -> models.LogTemplate:
    template = models.LogTemplate(**data.model_dump())
    db.add(template)
    await db.commit()
    await db.refresh(template)
    return template


async def get_log_templates(db: AsyncSession) -> List[models.LogTemplate]:
    result = await db.execute(
        select(models.LogTemplate).order_by(models.LogTemplate.created_at.desc())
    )
    return list(result.scalars().all())


async def update_log_template(db: AsyncSession, template_id: int, data: schemas.LogTemplateUpdate) -> Optional[models.LogTemplate]:
    result = await db.execute(
        select(models.LogTemplate).where(models.LogTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        return None
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(template, key, value)
    await db.commit()
    await db.refresh(template)
    return template


async def delete_log_template(db: AsyncSession, template_id: int) -> bool:
    result = await db.execute(
        select(models.LogTemplate).where(models.LogTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if not template:
        return False
    await db.delete(template)
    await db.commit()
    return True

# ============ Recurrence CRUD ============

async def create_recurrence_rule(db: AsyncSession, data: schemas.RecurrenceRuleCreate) -> models.RecurrenceRule:
    values = data.model_dump()
    rule = models.RecurrenceRule(**values)
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return rule


async def get_recurrence_rule(db: AsyncSession, rule_id: int) -> Optional[models.RecurrenceRule]:
    result = await db.execute(select(models.RecurrenceRule).where(models.RecurrenceRule.id == rule_id))
    return result.scalar_one_or_none()


async def get_recurrence_rules(
    db: AsyncSession,
    entity_type: Optional[models.RecurrenceEntityType] = None,
    include_archived: bool = False,
) -> List[models.RecurrenceRule]:
    stmt = select(models.RecurrenceRule)
    if entity_type:
        stmt = stmt.where(models.RecurrenceRule.entity_type == entity_type)
    if not include_archived:
        stmt = stmt.where(models.RecurrenceRule.status != models.RecurrenceRuleStatus.archived)
    stmt = stmt.order_by(models.RecurrenceRule.created_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def update_recurrence_rule(db: AsyncSession, rule_id: int, data: schemas.RecurrenceRuleUpdate) -> Optional[models.RecurrenceRule]:
    rule = await get_recurrence_rule(db, rule_id)
    if not rule:
        return None
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(rule, key, value)
    rule.updated_at = datetime.now()
    await db.commit()
    await db.refresh(rule)
    return rule


async def delete_recurrence_rule(db: AsyncSession, rule_id: int, delete_future_instances: bool = False) -> bool:
    rule = await get_recurrence_rule(db, rule_id)
    if not rule:
        return False
    rule.status = models.RecurrenceRuleStatus.archived
    rule.updated_at = datetime.now()
    if delete_future_instances:
        today = beijing_now().date()
        if rule.entity_type == models.RecurrenceEntityType.todo:
            result = await db.execute(select(models.Todo).where(
                models.Todo.recurrence_rule_id == rule_id,
                models.Todo.recurrence_date >= today,
                models.Todo.is_completed == False,
            ))
            for todo in result.scalars().all():
                await db.delete(todo)
        else:
            start = datetime.combine(today, datetime.min.time())
            result = await db.execute(select(models.Schedule).where(
                models.Schedule.recurrence_rule_id == rule_id,
                models.Schedule.start_time >= start,
            ))
            for schedule in result.scalars().all():
                await db.delete(schedule)
    await db.commit()
    return True


def _iter_dates(date_from: date, date_to: date) -> List[date]:
    days = []
    cursor = date_from
    while cursor <= date_to:
        days.append(cursor)
        cursor += timedelta(days=1)
    return days


def _rule_matches(rule: models.RecurrenceRule, day: date) -> bool:
    if day < rule.start_date:
        return False
    if rule.end_date and day > rule.end_date:
        return False
    if rule.frequency == models.RecurrenceFrequency.daily:
        return True
    if rule.frequency == models.RecurrenceFrequency.weekly:
        return day.isoweekday() in (rule.weekdays or [])
    if rule.frequency == models.RecurrenceFrequency.monthly:
        return day.day == rule.month_day
    return False


async def _has_recurrence_instance(db: AsyncSession, rule: models.RecurrenceRule, day: date) -> bool:
    model = models.Todo if rule.entity_type == models.RecurrenceEntityType.todo else models.Schedule
    result = await db.execute(select(model.id).where(
        model.recurrence_rule_id == rule.id,
        model.recurrence_date == day,
    ).limit(1))
    return result.scalar_one_or_none() is not None


async def _has_deleted_exception(db: AsyncSession, rule: models.RecurrenceRule, day: date) -> bool:
    result = await db.execute(select(models.RecurrenceException.id).where(
        models.RecurrenceException.recurrence_rule_id == rule.id,
        models.RecurrenceException.entity_type == rule.entity_type,
        models.RecurrenceException.recurrence_date == day,
        models.RecurrenceException.action == models.RecurrenceExceptionAction.deleted,
    ).limit(1))
    return result.scalar_one_or_none() is not None


def _parse_time(value: Optional[str], fallback_hour: int, fallback_minute: int = 0):
    if not value:
        return datetime.min.time().replace(hour=fallback_hour, minute=fallback_minute)
    hour, minute = value.split(":")[:2]
    return datetime.min.time().replace(hour=int(hour), minute=int(minute))


def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)


def _build_todo_from_rule(rule: models.RecurrenceRule, day: date) -> models.Todo:
    template = dict(rule.template_json or {})
    ddl_mode = template.pop("ddl_mode", "none")
    ddl_time = template.pop("ddl_time", "23:59")
    ddl_offset_days = int(template.pop("ddl_offset_days", 0) or 0)
    template.pop("recurrence", None)
    template["project_id"] = rule.project_id
    template.setdefault("name", "Recurring todo")
    template.setdefault("category", "task")
    template.setdefault("status", models.TodoStatus.not_focusing)
    template.setdefault("notes", "")
    template.setdefault("waiting_reply_person", None)
    template.setdefault("is_completed", False)
    if ddl_mode == "same_day_time":
        template["ddl_type"] = template.get("ddl_type") if template.get("ddl_type") != "none" else models.DDLType.hard
        template["ddl_date"] = datetime.combine(day, _parse_time(ddl_time, 23, 59))
        template["reminder_days"] = template.get("reminder_days") if template.get("reminder_days") is not None else 0
    elif ddl_mode == "offset_days":
        template["ddl_type"] = template.get("ddl_type") if template.get("ddl_type") != "none" else models.DDLType.hard
        template["ddl_date"] = datetime.combine(day + timedelta(days=ddl_offset_days), _parse_time(ddl_time, 23, 59))
        template["reminder_days"] = template.get("reminder_days") if template.get("reminder_days") is not None else 0
    else:
        template["ddl_type"] = models.DDLType.none
        template["ddl_date"] = None
        template["reminder_days"] = None
    return models.Todo(
        **template,
        recurrence_rule_id=rule.id,
        recurrence_date=day,
        is_recurrence_exception=False,
    )


def _build_schedule_from_rule(rule: models.RecurrenceRule, day: date) -> models.Schedule:
    template = dict(rule.template_json or {})
    start_template = _parse_datetime(template.pop("start_time", None))
    end_template = _parse_datetime(template.pop("end_time", None))
    start_time = datetime.combine(day, start_template.time() if start_template else _parse_time(None, 9, 0))
    if end_template and start_template:
        duration = end_template - start_template
    else:
        duration = timedelta(hours=1)
    end_time = start_time + duration
    template["project_id"] = rule.project_id
    template.setdefault("name", "Recurring schedule")
    template.setdefault("category", "schedule")
    template.setdefault("nature", models.ScheduleNature.no_other_task)
    template.setdefault("relax_suggestion", None)
    template.setdefault("linked_todo_ids", [])
    template.setdefault("location", None)
    template.setdefault("notes", "")
    template["is_planned"] = True
    return models.Schedule(
        **template,
        start_time=start_time,
        end_time=end_time,
        recurrence_rule_id=rule.id,
        recurrence_date=day,
        is_recurrence_exception=False,
    )


async def generate_recurrence_instances(db: AsyncSession, data: schemas.RecurrenceGenerateRequest) -> dict:
    created_todo_ids: List[int] = []
    created_schedule_ids: List[int] = []
    rules = await get_recurrence_rules(db, entity_type=data.entity_type)
    rules = [rule for rule in rules if rule.status == models.RecurrenceRuleStatus.active]
    for rule in rules:
        for day in _iter_dates(data.date_from, data.date_to):
            if not _rule_matches(rule, day):
                continue
            if await _has_recurrence_instance(db, rule, day):
                continue
            if await _has_deleted_exception(db, rule, day):
                continue
            if rule.entity_type == models.RecurrenceEntityType.todo:
                todo = _build_todo_from_rule(rule, day)
                db.add(todo)
                await db.flush()
                created_todo_ids.append(todo.id)
            else:
                schedule = _build_schedule_from_rule(rule, day)
                overlaps = await get_overlapping_schedules(
                    db,
                    start_time=schedule.start_time,
                    end_time=schedule.end_time,
                    is_planned=True,
                )
                if overlaps:
                    continue
                db.add(schedule)
                await db.flush()
                created_schedule_ids.append(schedule.id)
    await db.commit()
    return {"created_todo_ids": created_todo_ids, "created_schedule_ids": created_schedule_ids}
TODO_TEMPLATE_FIELDS = {
    "name",
    "ddl_type",
    "ddl_date",
    "reminder_days",
    "category",
    "status",
    "waiting_reply_person",
    "notes",
}

SCHEDULE_TEMPLATE_FIELDS = {
    "name",
    "start_time",
    "end_time",
    "category",
    "nature",
    "relax_suggestion",
    "linked_todo_ids",
    "location",
    "notes",
    "is_planned",
}


def _apply_todo_generated_values(target: models.Todo, generated: models.Todo):
    fields = [
        "project_id",
        "name",
        "ddl_type",
        "ddl_date",
        "reminder_days",
        "category",
        "status",
        "waiting_reply_person",
        "notes",
    ]
    for field in fields:
        setattr(target, field, getattr(generated, field))
    target.is_recurrence_exception = False
    target.updated_at = datetime.now()


def _apply_schedule_generated_values(target: models.Schedule, generated: models.Schedule):
    fields = [
        "project_id",
        "name",
        "start_time",
        "end_time",
        "category",
        "nature",
        "relax_suggestion",
        "linked_todo_ids",
        "location",
        "notes",
        "is_planned",
    ]
    for field in fields:
        setattr(target, field, getattr(generated, field))
    target.is_recurrence_exception = False
    target.updated_at = datetime.now()


def _sync_todo_ddl_template(template: dict, todo: models.Todo, update_data: dict) -> dict:
    ddl_type = update_data.get("ddl_type", todo.ddl_type)
    ddl_type_value = ddl_type.value if hasattr(ddl_type, "value") else ddl_type
    template["ddl_type"] = ddl_type_value
    if ddl_type_value == models.DDLType.none.value:
        template["ddl_mode"] = "none"
        template["ddl_date"] = None
        template["reminder_days"] = None
        return template

    ddl_date = update_data.get("ddl_date", todo.ddl_date)
    if isinstance(ddl_date, str):
        ddl_date = _parse_datetime(ddl_date)
    if ddl_date and todo.recurrence_date:
        offset = (ddl_date.date() - todo.recurrence_date).days
        template["ddl_mode"] = "same_day_time" if offset == 0 else "offset_days"
        template["ddl_offset_days"] = max(0, offset)
        template["ddl_time"] = ddl_date.strftime("%H:%M")
    template["reminder_days"] = update_data.get("reminder_days", todo.reminder_days)
    return template


async def sync_recurrence_from_todo(db: AsyncSession, todo_id: int, data: schemas.TodoUpdate) -> Optional[models.Todo]:
    todo = await get_todo(db, todo_id)
    if not todo or not todo.recurrence_rule_id:
        return None
    rule = await get_recurrence_rule(db, todo.recurrence_rule_id)
    if not rule or rule.entity_type != models.RecurrenceEntityType.todo:
        return None

    update_data = data.model_dump(exclude_unset=True, mode="json")
    template = dict(rule.template_json or {})
    for key, value in update_data.items():
        if key == "project_id":
            rule.project_id = value
        elif key in TODO_TEMPLATE_FIELDS:
            template[key] = value
    template = _sync_todo_ddl_template(template, todo, update_data)
    rule.template_json = template
    rule.updated_at = datetime.now()

    today = beijing_now().date()
    result = await db.execute(select(models.Todo).where(
        models.Todo.recurrence_rule_id == rule.id,
        models.Todo.recurrence_date >= today,
        models.Todo.is_completed == False,
        models.Todo.is_recurrence_exception == False,
    ))
    instances = list(result.scalars().all())
    for instance in instances:
        if not instance.recurrence_date:
            continue
        generated = _build_todo_from_rule(rule, instance.recurrence_date)
        _apply_todo_generated_values(instance, generated)

    await db.commit()
    await db.refresh(todo)
    return todo


async def sync_recurrence_from_schedule(db: AsyncSession, schedule_id: int, data: schemas.ScheduleUpdate) -> Optional[models.Schedule]:
    schedule = await get_schedule(db, schedule_id)
    if not schedule or not schedule.recurrence_rule_id:
        return None
    rule = await get_recurrence_rule(db, schedule.recurrence_rule_id)
    if not rule or rule.entity_type != models.RecurrenceEntityType.schedule:
        return None

    update_data = data.model_dump(exclude_unset=True, mode="json")
    template = dict(rule.template_json or {})
    for key, value in update_data.items():
        if key == "project_id":
            rule.project_id = value
        elif key in SCHEDULE_TEMPLATE_FIELDS:
            template[key] = value
    template["is_planned"] = True
    rule.template_json = template
    rule.updated_at = datetime.now()

    today = beijing_now().date()
    result = await db.execute(select(models.Schedule).where(
        models.Schedule.recurrence_rule_id == rule.id,
        models.Schedule.recurrence_date >= today,
        models.Schedule.is_recurrence_exception == False,
    ))
    instances = list(result.scalars().all())
    for instance in instances:
        if not instance.recurrence_date:
            continue
        generated = _build_schedule_from_rule(rule, instance.recurrence_date)
        overlaps = await get_overlapping_schedules(
            db,
            start_time=generated.start_time,
            end_time=generated.end_time,
            is_planned=True,
            exclude_id=instance.id,
        )
        if overlaps:
            continue
        _apply_schedule_generated_values(instance, generated)

    await db.commit()
    await db.refresh(schedule)
    return schedule
