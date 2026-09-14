import asyncio
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import crud, models, schemas
from app.data_portability import ENTITY_ORDER, export_package, import_package, validate_package
from app.database import Base
from app.main import SQLITE_SCHEMA_VERSION, ensure_sqlite_schema_compat
from app.recurrence_claims import rebuild_recurrence_claims


class V08RecurrenceClaimTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:",
            poolclass=StaticPool,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def _daily_rule(self, session, target_date, entity_type, template):
        return await crud.create_recurrence_rule(
            session,
            schemas.RecurrenceRuleCreate(
                entity_type=entity_type,
                template_json=template,
                frequency=models.RecurrenceFrequency.daily,
                start_date=target_date,
            ),
        )

    async def test_schema_migration_backfills_one_claim_without_mutating_duplicates(self):
        target_date = date(2099, 6, 1)
        async with self.sessions() as session:
            rule = await self._daily_rule(
                session,
                target_date,
                models.RecurrenceEntityType.todo,
                {"name": "daily"},
            )
            session.add_all([
                models.Todo(
                    name="legacy-a",
                    recurrence_rule_id=rule.id,
                    recurrence_date=target_date,
                ),
                models.Todo(
                    name="legacy-b",
                    recurrence_rule_id=rule.id,
                    recurrence_date=target_date,
                ),
                models.RecurrenceException(
                    recurrence_rule_id=rule.id,
                    entity_type=models.RecurrenceEntityType.todo,
                    recurrence_date=target_date,
                ),
                models.RecurrenceException(
                    recurrence_rule_id=rule.id,
                    entity_type=models.RecurrenceEntityType.todo,
                    recurrence_date=target_date,
                ),
            ])
            await session.commit()

        async with self.engine.begin() as connection:
            await connection.execute(text("DROP TABLE recurrence_instance_claims"))
            await ensure_sqlite_schema_compat(connection)
            todo_count = await connection.scalar(text("SELECT COUNT(*) FROM todos"))
            exception_count = await connection.scalar(
                text("SELECT COUNT(*) FROM recurrence_exceptions")
            )
            claim_count = await connection.scalar(
                text("SELECT COUNT(*) FROM recurrence_instance_claims")
            )
            user_version = await connection.scalar(text("PRAGMA user_version"))

        self.assertEqual(todo_count, 2)
        self.assertEqual(exception_count, 2)
        self.assertEqual(claim_count, 1)
        self.assertEqual(user_version, SQLITE_SCHEMA_VERSION)

    async def test_cross_session_generation_creates_exactly_one_instance(self):
        target_date = date(2099, 6, 2)
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "recurrence.db"
            engine = create_async_engine(
                f"sqlite+aiosqlite:///{database_path.as_posix()}",
                connect_args={"timeout": 10},
            )
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with engine.begin() as connection:
                    await connection.run_sync(Base.metadata.create_all)
                async with sessions() as session:
                    await self._daily_rule(
                        session,
                        target_date,
                        models.RecurrenceEntityType.todo,
                        {"name": "one only"},
                    )

                request = schemas.RecurrenceGenerateRequest(
                    date_from=target_date,
                    date_to=target_date,
                )

                async def generate_once():
                    async with sessions() as session:
                        return await crud._generate_recurrence_instances_unlocked(
                            session, request
                        )

                results = await asyncio.gather(generate_once(), generate_once())
                async with sessions() as session:
                    todo_count = await session.scalar(
                        select(func.count()).select_from(models.Todo)
                    )
                    claim_count = await session.scalar(
                        select(func.count()).select_from(models.RecurrenceInstanceClaim)
                    )

                self.assertEqual(
                    sum(len(result["created_todo_ids"]) for result in results),
                    1,
                )
                self.assertEqual(todo_count, 1)
                self.assertEqual(claim_count, 1)
            finally:
                await engine.dispose()

    async def test_schedule_overlap_does_not_leave_claim(self):
        target_date = date(2099, 6, 3)
        async with self.sessions() as session:
            await self._daily_rule(
                session,
                target_date,
                models.RecurrenceEntityType.schedule,
                {
                    "name": "blocked",
                    "start_time": "2099-01-01T09:00:00",
                    "end_time": "2099-01-01T10:00:00",
                },
            )
            session.add(models.Schedule(
                name="existing",
                start_time=datetime(2099, 6, 3, 9, 30),
                end_time=datetime(2099, 6, 3, 10, 30),
                is_planned=True,
            ))
            await session.commit()

            result = await crud.generate_recurrence_instances(
                session,
                schemas.RecurrenceGenerateRequest(
                    date_from=target_date,
                    date_to=target_date,
                ),
            )
            claims = list((await session.execute(
                select(models.RecurrenceInstanceClaim)
            )).scalars())

            self.assertEqual(result["created_schedule_ids"], [])
            self.assertEqual(claims, [])

    async def test_delete_future_rebuilds_claims_from_remaining_history(self):
        target_date = date(2099, 6, 4)
        async with self.sessions() as session:
            rule = await self._daily_rule(
                session,
                target_date,
                models.RecurrenceEntityType.todo,
                {"name": "future"},
            )
            generated = await crud.generate_recurrence_instances(
                session,
                schemas.RecurrenceGenerateRequest(
                    date_from=target_date,
                    date_to=date(2099, 6, 5),
                ),
            )
            first = await crud.get_todo(session, generated["created_todo_ids"][0])
            first.is_completed = True
            first.completed_at = datetime(2099, 6, 4, 12)
            await session.commit()

            with patch("app.crud.beijing_now", return_value=datetime(2099, 6, 4, 8)):
                self.assertTrue(await crud.delete_recurrence_rule(
                    session, rule.id, delete_future_instances=True
                ))

            todos = list((await session.execute(select(models.Todo))).scalars())
            claims = list((await session.execute(
                select(models.RecurrenceInstanceClaim)
            )).scalars())
            self.assertEqual([todo.id for todo in todos], [first.id])
            self.assertEqual(len(claims), 1)
            self.assertEqual(claims[0].recurrence_date, target_date)

    async def test_export_normalizes_duplicate_exceptions_and_replace_rebuilds_claims(self):
        target_date = date(2099, 6, 6)
        async with self.sessions() as session:
            rule = await self._daily_rule(
                session,
                target_date,
                models.RecurrenceEntityType.todo,
                {"name": "deleted"},
            )
            session.add_all([
                models.RecurrenceException(
                    recurrence_rule_id=rule.id,
                    entity_type=models.RecurrenceEntityType.todo,
                    recurrence_date=target_date,
                ),
                models.RecurrenceException(
                    recurrence_rule_id=rule.id,
                    entity_type=models.RecurrenceEntityType.todo,
                    recurrence_date=target_date,
                ),
            ])
            await session.commit()
            await rebuild_recurrence_claims(session)
            await session.commit()

            package = await export_package(session)
            validate_package(package)
            source_exception_count = await session.scalar(
                select(func.count()).select_from(models.RecurrenceException)
            )

            self.assertEqual(source_exception_count, 2)
            self.assertEqual(len(package["entities"]["recurrence_exceptions"]), 1)

        target_engine = create_async_engine(
            "sqlite+aiosqlite:///:memory:", poolclass=StaticPool
        )
        target_sessions = async_sessionmaker(target_engine, expire_on_commit=False)
        try:
            async with target_engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with target_sessions() as session:
                await import_package(session, package, mode="replace")
                restored_exceptions = await session.scalar(
                    select(func.count()).select_from(models.RecurrenceException)
                )
                restored_claims = await session.scalar(
                    select(func.count()).select_from(models.RecurrenceInstanceClaim)
                )
                self.assertEqual(restored_exceptions, 1)
                self.assertEqual(restored_claims, 1)

                empty_package = {
                    "app": "riji",
                    "schema_version": "0.8.0",
                    "entities": {name: [] for name in ENTITY_ORDER},
                }
                await import_package(session, empty_package, mode="replace")
                remaining_claims = await session.scalar(
                    select(func.count()).select_from(models.RecurrenceInstanceClaim)
                )
                self.assertEqual(remaining_claims, 0)
        finally:
            await target_engine.dispose()

    async def test_focusing_limit_excludes_self_and_completed_todos(self):
        async with self.sessions() as session:
            focused = [
                await crud.create_todo(
                    session,
                    schemas.TodoCreate(
                        name=f"focused-{index}",
                        status=models.TodoStatus.focusing,
                    ),
                )
                for index in range(3)
            ]
            focused_ids = [todo.id for todo in focused]
            with self.assertRaises(ValueError):
                await crud.create_todo(
                    session,
                    schemas.TodoCreate(
                        name="fourth",
                        status=models.TodoStatus.focusing,
                    ),
                )
            await session.rollback()

            same = await crud.update_todo(
                session,
                focused_ids[0],
                schemas.TodoUpdate(status=models.TodoStatus.focusing),
            )
            self.assertEqual(same.status, models.TodoStatus.focusing)
            await crud.update_todo(
                session,
                focused_ids[0],
                schemas.TodoUpdate(is_completed=True),
            )
            replacement = await crud.create_todo(
                session,
                schemas.TodoCreate(
                    name="replacement",
                    status=models.TodoStatus.focusing,
                ),
            )
            self.assertEqual(replacement.status, models.TodoStatus.focusing)


if __name__ == "__main__":
    unittest.main()
