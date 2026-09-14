import unittest
from datetime import date, datetime
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import crud, models, schemas
from app.data_portability import ENTITY_ORDER, export_package, import_package, preview_package
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

    async def test_replace_import_previews_and_deletes_missing_local_data(self):
        async with self.sessions() as session:
            session.add(models.Todo(name='仅存在于本地'))
            await session.commit()
            package = {
                'app': 'riji',
                'schema_version': '0.6.0',
                'entities': {name: [] for name in ENTITY_ORDER},
            }

            preview = await preview_package(session, package, mode='replace')
            result = await import_package(session, package, mode='replace')
            todos = list((await session.execute(select(models.Todo))).scalars())

            self.assertEqual(preview['entities']['todos']['delete'], 1)
            self.assertEqual(result['deleted'], 1)
            self.assertEqual(todos, [])

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

    async def test_project_next_todo_prefers_manual_position_before_deadline(self):
        async with self.sessions() as session:
            project = models.Project(name='项目')
            session.add(project)
            await session.flush()
            session.add_all([
                models.Todo(project_id=project.id, name='最近 DDL', ddl_type=models.DDLType.hard, ddl_date=datetime(2026, 8, 16)),
                models.Todo(project_id=project.id, name='手动第二', position=2),
                models.Todo(project_id=project.id, name='手动第一', position=1),
            ])
            await session.commit()

            overview = await crud.get_project_overview(session, project.id)
            self.assertEqual(overview['next_todo'].name, '手动第一')
            self.assertEqual([todo.name for todo in overview['todos']], ['手动第一', '手动第二', '最近 DDL'])


    async def test_recurrence_generation_and_deleted_exception_are_idempotent(self):
        target_date = date(2099, 1, 5)
        async with self.sessions() as session:
            rule = await crud.create_recurrence_rule(session, schemas.RecurrenceRuleCreate(
                entity_type=models.RecurrenceEntityType.todo,
                template_json={'name': '每日复盘'},
                frequency=models.RecurrenceFrequency.daily,
                start_date=target_date,
            ))
            request = schemas.RecurrenceGenerateRequest(date_from=target_date, date_to=target_date)
            first = await crud.generate_recurrence_instances(session, request)
            second = await crud.generate_recurrence_instances(session, request)
            self.assertEqual(len(first['created_todo_ids']), 1)
            self.assertEqual(second['created_todo_ids'], [])

            todo = await crud.get_todo(session, first['created_todo_ids'][0])
            session.add(models.RecurrenceException(
                recurrence_rule_id=rule.id,
                entity_type=models.RecurrenceEntityType.todo,
                recurrence_date=target_date,
            ))
            await session.commit()
            self.assertTrue(await crud.delete_todo(session, todo.id))
            regenerated = await crud.generate_recurrence_instances(session, request)
            exceptions = list((await session.execute(select(models.RecurrenceException))).scalars())
            self.assertEqual(regenerated['created_todo_ids'], [])
            self.assertEqual(len(exceptions), 1)

    async def test_recurrence_sync_preserves_explicit_instance_exception(self):
        start = date(2099, 2, 1)
        async with self.sessions() as session:
            rule = await crud.create_recurrence_rule(session, schemas.RecurrenceRuleCreate(
                entity_type=models.RecurrenceEntityType.todo,
                template_json={'name': '原模板'},
                frequency=models.RecurrenceFrequency.daily,
                start_date=start,
            ))
            generated = await crud.generate_recurrence_instances(session, schemas.RecurrenceGenerateRequest(
                date_from=start, date_to=date(2099, 2, 2),
            ))
            first = await crud.get_todo(session, generated['created_todo_ids'][0])
            second = await crud.get_todo(session, generated['created_todo_ids'][1])
            await crud.update_todo(session, second.id, schemas.TodoUpdate(name='单项修改'))
            await crud.sync_recurrence_from_todo(session, first.id, schemas.TodoUpdate(name='同步模板'))
            first = await crud.get_todo(session, first.id)
            second = await crud.get_todo(session, second.id)
            self.assertEqual(first.name, '同步模板')
            self.assertEqual(second.name, '单项修改')
            self.assertTrue(second.is_recurrence_exception)
            self.assertEqual((await crud.get_recurrence_rule(session, rule.id)).template_json['name'], '同步模板')

    async def test_invalid_merged_updates_are_rejected(self):
        async with self.sessions() as session:
            rule = await crud.create_recurrence_rule(session, schemas.RecurrenceRuleCreate(
                entity_type=models.RecurrenceEntityType.todo,
                template_json={'name': '规则'},
                frequency=models.RecurrenceFrequency.daily,
                start_date=date(2099, 3, 1),
            ))
            with self.assertRaises(ValueError):
                await crud.update_recurrence_rule(
                    session, rule.id,
                    schemas.RecurrenceRuleUpdate(frequency=models.RecurrenceFrequency.weekly),
                )

            todo = await crud.create_todo(session, schemas.TodoCreate(name='待办'))
            with self.assertRaises(ValueError):
                await crud.update_todo(
                    session, todo.id, schemas.TodoUpdate(ddl_type=models.DDLType.hard)
                )
            with self.assertRaises(ValueError):
                await crud.update_todo(session, todo.id, schemas.TodoUpdate(
                    status=models.TodoStatus.waiting_reply,
                ))

            schedule = await crud.create_schedule(session, schemas.ScheduleCreate(
                name='日程', start_time=datetime(2099, 3, 1, 9), end_time=datetime(2099, 3, 1, 10),
            ))
            with self.assertRaises(ValueError):
                await crud.update_schedule(session, schedule.id, schemas.ScheduleUpdate(
                    end_time=datetime(2099, 3, 1, 8),
                ))

        with self.assertRaises(ValueError):
            schemas.TodoCreate(name='缺 DDL', ddl_type=models.DDLType.hard)
        with self.assertRaises(ValueError):
            schemas.TodoCreate(name='缺回复人', status=models.TodoStatus.waiting_reply)

    async def test_legacy_0_6_package_without_exceptions_is_supported(self):
        legacy_entities = {
            name: [] for name in ENTITY_ORDER if name != 'recurrence_exceptions'
        }
        package = {'app': 'riji', 'schema_version': '0.6.0', 'entities': legacy_entities}
        async with self.sessions() as session:
            result = await import_package(session, package)
            self.assertEqual(result['schema_version'], '0.8.0')
            self.assertEqual(result['entities']['recurrence_exceptions'], {'created': 0, 'updated': 0})

    async def test_0_8_recurrence_exception_round_trip_remaps_rule_uuid(self):
        target_date = date(2099, 4, 1)
        async with self.sessions() as session:
            rule = await crud.create_recurrence_rule(session, schemas.RecurrenceRuleCreate(
                entity_type=models.RecurrenceEntityType.todo,
                template_json={'name': '不会复活'},
                frequency=models.RecurrenceFrequency.daily,
                start_date=target_date,
            ))
            session.add(models.RecurrenceException(
                recurrence_rule_id=rule.id,
                entity_type=models.RecurrenceEntityType.todo,
                recurrence_date=target_date,
            ))
            await session.commit()
            package = await export_package(session)
            self.assertEqual(package['schema_version'], '0.8.0')
            self.assertEqual(
                package['entities']['recurrence_exceptions'][0]['recurrence_rule_uuid'],
                rule.uuid,
            )

        target_engine = create_async_engine(
            'sqlite+aiosqlite:///:memory:', poolclass=StaticPool,
        )
        target_sessions = async_sessionmaker(target_engine, expire_on_commit=False)
        try:
            async with target_engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with target_sessions() as session:
                await import_package(session, package, mode='replace')
                restored_rule = (await session.execute(select(models.RecurrenceRule))).scalar_one()
                restored_exception = (await session.execute(select(models.RecurrenceException))).scalar_one()
                self.assertEqual(restored_exception.recurrence_rule_id, restored_rule.id)
                generated = await crud.generate_recurrence_instances(
                    session,
                    schemas.RecurrenceGenerateRequest(date_from=target_date, date_to=target_date),
                )
                self.assertEqual(generated['created_todo_ids'], [])
        finally:
            await target_engine.dispose()

    async def test_project_delete_detaches_rules_and_timers(self):
        async with self.sessions() as session:
            project = await crud.create_project(session, schemas.ProjectCreate(name='可删除项目'))
            rule = await crud.create_recurrence_rule(session, schemas.RecurrenceRuleCreate(
                entity_type=models.RecurrenceEntityType.todo,
                template_json={'name': '规则'},
                frequency=models.RecurrenceFrequency.daily,
                start_date=date(2099, 5, 1),
                project_id=project.id,
            ))
            timer = await crud.start_timer(session, schemas.TimerStart(name='计时', project_id=project.id))
            self.assertTrue(await crud.delete_project(session, project.id))
            self.assertIsNone((await crud.get_recurrence_rule(session, rule.id)).project_id)
            self.assertIsNone((await crud.get_timer(session, timer.id)).project_id)

    async def test_invalid_data_portability_mode_is_rejected(self):
        package = {
            'app': 'riji',
            'schema_version': '0.8.0',
            'entities': {name: [] for name in ENTITY_ORDER},
        }
        async with self.sessions() as session:
            with self.assertRaises(ValueError):
                await preview_package(session, package, mode='append')


if __name__ == '__main__':
    unittest.main()
