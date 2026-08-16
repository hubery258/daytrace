import unittest
from datetime import date, datetime
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import crud, models, schemas
from app.data_portability import ENTITY_ORDER, import_package
from app.database import Base
from app.zju_client import _parse_datetime


class ZjuTimeTests(unittest.TestCase):
    def test_utc_deadline_is_converted_to_beijing_time(self):
        self.assertEqual(
            _parse_datetime('2026-08-14T16:30:00Z'),
            datetime(2026, 8, 15, 0, 30),
        )

    def test_naive_deadline_remains_beijing_wall_time(self):
        self.assertEqual(
            _parse_datetime('2026-08-15T08:00:00'),
            datetime(2026, 8, 15, 8, 0),
        )


class DatabaseHardeningTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine(
            'sqlite+aiosqlite:///:memory:',
            poolclass=StaticPool,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_schedule_range_uses_interval_intersection(self):
        async with self.sessions() as session:
            session.add_all([
                models.Schedule(
                    name='跨天日程',
                    start_time=datetime(2026, 8, 13, 23, 0),
                    end_time=datetime(2026, 8, 14, 2, 0),
                ),
                models.Schedule(
                    name='恰好在窗口开始时结束',
                    start_time=datetime(2026, 8, 13, 22, 0),
                    end_time=datetime(2026, 8, 14, 0, 0),
                ),
                models.Schedule(
                    name='恰好在窗口结束时开始',
                    start_time=datetime(2026, 8, 15, 0, 0),
                    end_time=datetime(2026, 8, 15, 1, 0),
                ),
            ])
            await session.commit()

            schedules = await crud.get_schedules(
                session,
                date_from=datetime(2026, 8, 14, 0, 0),
                date_to=datetime(2026, 8, 15, 0, 0),
            )

            self.assertEqual([item.name for item in schedules], ['跨天日程'])

    async def test_current_schedule_excludes_exact_end_boundary(self):
        now = datetime(2026, 8, 14, 12, 0)
        async with self.sessions() as session:
            session.add_all([
                models.Schedule(
                    name='已结束',
                    start_time=datetime(2026, 8, 14, 10, 0),
                    end_time=now,
                ),
                models.Schedule(
                    name='当前日程',
                    start_time=datetime(2026, 8, 14, 11, 30),
                    end_time=datetime(2026, 8, 14, 12, 30),
                ),
            ])
            await session.commit()

            with patch('app.crud.beijing_now', return_value=now):
                current = await crud.get_current_schedule(session)

            self.assertIsNotNone(current)
            self.assertEqual(current.name, '当前日程')

    async def test_complete_todo_and_log_is_idempotent_and_preserves_log_text(self):
        target_date = date(2026, 8, 14)
        async with self.sessions() as session:
            existing = models.Todo(name='已有完成项')
            target = models.Todo(name='待完成项')
            session.add_all([existing, target])
            await session.flush()
            session.add(models.DailyLog(
                log_date=target_date,
                completed_todo_ids=[existing.id],
                log_text='保留这段日志',
            ))
            await session.commit()

            await crud.complete_todo_and_log(session, target.id, target_date)
            await crud.complete_todo_and_log(session, target.id, target_date)
            log = await crud.get_daily_log_by_date(session, target_date)
            completed = await crud.get_todo(session, target.id)

            self.assertTrue(completed.is_completed)
            self.assertIsNotNone(completed.completed_at)
            self.assertEqual(log.completed_todo_ids, [existing.id, target.id])
            self.assertEqual(log.log_text, '保留这段日志')

            await crud.upsert_daily_log(session, schemas.DailyLogCreate(
                log_date=target_date,
                completed_todo_ids=[existing.id],
                log_text='更新后的日志',
            ))
            merged_log = await crud.get_daily_log_by_date(session, target_date)
            self.assertEqual(merged_log.completed_todo_ids, [existing.id, target.id])
            self.assertEqual(merged_log.log_text, '更新后的日志')

    async def test_empty_merge_import_does_not_delete_local_data(self):
        async with self.sessions() as session:
            local_todo = models.Todo(name='仅存在于本地')
            session.add(local_todo)
            await session.commit()

            package = {
                'app': 'riji',
                'schema_version': '0.6.0',
                'entities': {name: [] for name in ENTITY_ORDER},
            }
            result = await import_package(session, package)
            todos = list((await session.execute(select(models.Todo))).scalars())

            self.assertEqual(result['created'], 0)
            self.assertEqual(result['updated'], 0)
            self.assertEqual([item.name for item in todos], ['仅存在于本地'])

    async def test_project_next_todo_prefers_earliest_deadline(self):
        async with self.sessions() as session:
            project = models.Project(name='项目')
            session.add(project)
            await session.flush()
            session.add_all([
                models.Todo(project_id=project.id, name='无 DDL', created_at=datetime(2026, 8, 10)),
                models.Todo(project_id=project.id, name='较晚 DDL', ddl_type=models.DDLType.hard, ddl_date=datetime(2026, 8, 20), created_at=datetime(2026, 8, 9)),
                models.Todo(project_id=project.id, name='最近 DDL', ddl_type=models.DDLType.hard, ddl_date=datetime(2026, 8, 16), created_at=datetime(2026, 8, 11)),
            ])
            await session.commit()

            overview = await crud.get_project_overview(session, project.id)
            self.assertEqual(overview['next_todo'].name, '最近 DDL')


if __name__ == '__main__':
    unittest.main()
