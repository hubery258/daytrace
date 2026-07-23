from datetime import datetime, date, timedelta
from typing import Optional, List
from sqlalchemy import select, and_, or_, update
from sqlalchemy.ext.asyncio import AsyncSession
from . import models, schemas


# ============ Project CRUD ============

async def _attach_project_overview_fields(db: AsyncSession, project: models.Project) -> models.Project:
    todos = await get_todos(db, project_id=project.id)
    schedules = await get_schedules(db, project_id=project.id)
    todo_count = len(todos)
    completed_todo_count = len([t for t in todos if t.is_completed])
    project.todo_count = todo_count
    project.completed_todo_count = completed_todo_count
    project.progress = (completed_todo_count / todo_count) if todo_count else None
    project.next_todo = next((t for t in todos if not t.is_completed), None)
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
    next_todo = next((t for t in todos if not t.is_completed), None)
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
    project_id: Optional[int] = None,
) -> List[models.Schedule]:
    stmt = select(models.Schedule)
    if is_planned is not None:
        stmt = stmt.where(models.Schedule.is_planned == is_planned)
    if date_from:
        stmt = stmt.where(models.Schedule.start_time >= date_from)
    if date_to:
        stmt = stmt.where(models.Schedule.end_time <= date_to)
    if project_id is not None:
        stmt = stmt.where(models.Schedule.project_id == project_id)
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
