"""SQLite-backed idempotency claims for recurrence generation."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from . import models


async def ensure_recurrence_claim(
    db: AsyncSession,
    rule: models.RecurrenceRule,
    recurrence_date: date,
) -> bool:
    """Atomically claim one rule/type/date slot.

    Returns True only for the transaction that inserted the claim. SQLite's
    primary-key conflict handling makes this safe across worker processes.
    """

    statement = (
        sqlite_insert(models.RecurrenceInstanceClaim)
        .values(
            rule_uuid=rule.uuid,
            entity_type=rule.entity_type,
            recurrence_date=recurrence_date,
            created_at=datetime.now(),
        )
        .on_conflict_do_nothing(
            index_elements=("rule_uuid", "entity_type", "recurrence_date")
        )
    )
    result = await db.execute(statement)
    return result.rowcount == 1


async def rebuild_recurrence_claims(db: AsyncSession) -> int:
    """Rebuild derived claims without changing any source history rows."""

    await db.flush()
    await db.execute(delete(models.RecurrenceInstanceClaim))

    keys: set[tuple[str, models.RecurrenceEntityType, date]] = set()
    todo_rows = await db.execute(
        select(models.RecurrenceRule.uuid, models.Todo.recurrence_date)
        .join(models.Todo, models.Todo.recurrence_rule_id == models.RecurrenceRule.id)
        .where(models.Todo.recurrence_date.is_not(None))
    )
    keys.update(
        (rule_uuid, models.RecurrenceEntityType.todo, recurrence_date)
        for rule_uuid, recurrence_date in todo_rows.all()
    )

    schedule_rows = await db.execute(
        select(models.RecurrenceRule.uuid, models.Schedule.recurrence_date)
        .join(
            models.Schedule,
            models.Schedule.recurrence_rule_id == models.RecurrenceRule.id,
        )
        .where(models.Schedule.recurrence_date.is_not(None))
    )
    keys.update(
        (rule_uuid, models.RecurrenceEntityType.schedule, recurrence_date)
        for rule_uuid, recurrence_date in schedule_rows.all()
    )

    exception_rows = await db.execute(
        select(
            models.RecurrenceRule.uuid,
            models.RecurrenceException.entity_type,
            models.RecurrenceException.recurrence_date,
        ).join(
            models.RecurrenceException,
            models.RecurrenceException.recurrence_rule_id == models.RecurrenceRule.id,
        )
    )
    keys.update(exception_rows.all())

    if keys:
        statement = (
            sqlite_insert(models.RecurrenceInstanceClaim)
            .values([
                {
                    "rule_uuid": rule_uuid,
                    "entity_type": entity_type,
                    "recurrence_date": recurrence_date,
                    "created_at": datetime.now(),
                }
                for rule_uuid, entity_type, recurrence_date in sorted(
                    keys, key=lambda item: (item[0], item[1].value, item[2])
                )
            ])
            .on_conflict_do_nothing(
                index_elements=("rule_uuid", "entity_type", "recurrence_date")
            )
        )
        await db.execute(statement)
    return len(keys)
