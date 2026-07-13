from datetime import datetime, date, timedelta
from typing import Optional, List
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from . import models, schemas


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
) -> List[models.Todo]:
    stmt = select(models.Todo)
    if category:
        stmt = stmt.where(models.Todo.category == category)
    if status:
        stmt = stmt.where(models.Todo.status == status)
    if is_completed is not None:
        stmt = stmt.where(models.Todo.is_completed == is_completed)
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
    if "is_completed" in update_data and update_data["is_completed"]:
        update_data["completed_at"] = datetime.now()
    for key, value in update_data.items():
        setattr(todo, key, value)
    await db.commit()
    await db.refresh(todo)
    return todo


async def delete_todo(db: AsyncSession, todo_id: int) -> bool:
    todo = await get_todo(db, todo_id)
    if not todo:
        return False
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
) -> List[models.Schedule]:
    stmt = select(models.Schedule)
    if is_planned is not None:
        stmt = stmt.where(models.Schedule.is_planned == is_planned)
    if date_from:
        stmt = stmt.where(models.Schedule.start_time >= date_from)
    if date_to:
        stmt = stmt.where(models.Schedule.end_time <= date_to)
    stmt = stmt.order_by(models.Schedule.start_time.asc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_current_schedule(db: AsyncSession) -> Optional[models.Schedule]:
    """Get the schedule that is currently active (start <= now <= end)."""
    now = datetime.now()
    result = await db.execute(
        select(models.Schedule).where(
            models.Schedule.start_time <= now,
            models.Schedule.end_time >= now,
        ).order_by(models.Schedule.start_time.asc()).limit(1)
    )
    return result.scalar_one_or_none()


async def update_schedule(db: AsyncSession, schedule_id: int, data: schemas.ScheduleUpdate) -> Optional[models.Schedule]:
    schedule = await get_schedule(db, schedule_id)
    if not schedule:
        return None
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(schedule, key, value)
    await db.commit()
    await db.refresh(schedule)
    return schedule


async def delete_schedule(db: AsyncSession, schedule_id: int) -> bool:
    schedule = await get_schedule(db, schedule_id)
    if not schedule:
        return False
    await db.delete(schedule)
    await db.commit()
    return True


# ============ DailyLog CRUD ============

async def upsert_daily_log(db: AsyncSession, data: schemas.DailyLogCreate) -> models.DailyLog:
    existing = await get_daily_log_by_date(db, data.log_date)
    if existing:
        existing.completed_todo_ids = data.completed_todo_ids
        existing.log_text = data.log_text
        existing.updated_at = datetime.now()
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
