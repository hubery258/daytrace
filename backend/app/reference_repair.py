"""Explicit, narrow repair of historical dangling schedule task links."""
import hashlib

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .data_portability import DataPackageError, _json_value, save_operation_backup
from .merge_plan import canonical


async def preview_schedule_repair(db: AsyncSession) -> dict:
    valid = set((await db.execute(select(models.Todo.id))).scalars())
    schedules = (await db.execute(select(models.Schedule).order_by(models.Schedule.uuid))).scalars().all()
    state, affected = [], []
    for row in schedules:
        record = {column.name: _json_value(getattr(row, column.name)) for column in row.__table__.columns}
        state.append(record)
        missing = [item for item in row.linked_todo_ids if item not in valid]
        if missing:
            affected.append({**record, 'missing_ids': missing,
                             'remaining_ids': [item for item in row.linked_todo_ids if item in valid]})
    token = hashlib.sha256(canonical({'schedules': state, 'todo_ids': sorted(valid)}).encode()).hexdigest()
    return {'token': token, 'items': affected}


async def repair_schedule_links(db: AsyncSession, token: str, confirmed: bool) -> dict:
    if not confirmed or not token:
        raise DataPackageError('请先检查并确认清除失效关联')
    try:
        await db.rollback()
        await db.execute(text('BEGIN IMMEDIATE'))
        preview = await preview_schedule_repair(db)
        if preview['token'] != token:
            raise DataPackageError('计划或任务已变化，请重新检查')
        if not preview['items']:
            await db.rollback()
            return {'repaired': 0, 'backup_path': None}
        # This is a repair journal, not a portable/importable package. It keeps
        # every affected original row including its local task ids, no secrets.
        backup = save_operation_backup(db, {'app': 'riji-reference-repair',
            'kind': 'schedule-task-links', 'before': preview['items']}, prefix='before-reference-repair')
        for item in preview['items']:
            await db.execute(text('UPDATE schedules SET linked_todo_ids = :links WHERE uuid = :uuid'),
                             {'links': canonical(item['remaining_ids']), 'uuid': item['uuid']})
        await db.commit()
        return {'repaired': len(preview['items']), 'backup_path': backup}
    except Exception:
        await db.rollback()
        raise
