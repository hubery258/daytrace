import unittest
from datetime import date, datetime
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import crud, models, schemas
from app.data_portability import export_package, import_package
from app.database import Base
from app.routers.time_blocks import TimerConversion, from_timer, list_blocks, replace_range


class TimeBlockTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:', poolclass=StaticPool)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_current_schedule_only_reads_plans(self):
        at = datetime(2026, 9, 12, 10)
        async with self.sessions() as db:
            db.add_all([
                models.Schedule(name='旧实际', is_planned=False,
                    start_time=datetime(2026, 9, 12, 9), end_time=datetime(2026, 9, 12, 11)),
                models.Schedule(name='计划', is_planned=True,
                    start_time=datetime(2026, 9, 12, 9), end_time=datetime(2026, 9, 12, 11)),
            ])
            await db.commit()
            with patch('app.crud.beijing_now', return_value=at):
                self.assertEqual((await crud.get_current_schedule(db)).name, '计划')
            self.assertEqual([item.name for item in await crud.get_schedules(db)], ['计划'])

    async def test_partial_edit_splits_block_and_derives_project(self):
        async with self.sessions() as db:
            project = models.Project(name='待办项目')
            other = models.Project(name='错误的手选项目')
            category = models.TimeBlockCategory(name='学习', color='#347f88')
            db.add_all([project, other, category])
            await db.flush()
            todo = models.Todo(name='复习', project_id=project.id)
            db.add(todo)
            await db.flush()
            db.add(models.TimeBlock(block_date=date(2026, 9, 12), start_minute=0,
                end_minute=30, granularity=30, category_id=category.id))
            await db.commit()
            blocks = await replace_range(schemas.TimeBlockReplace(
                block_date=date(2026, 9, 12), start_minute=0, end_minute=15,
                blocks=[schemas.TimeBlockItem(start_minute=0, end_minute=15, granularity=15,
                    category_id=category.id, linked_todo_id=todo.id, manual_project_id=other.id,
                    notes='复习第一章')]), db)
            self.assertEqual([(b.start_minute, b.end_minute) for b in blocks], [(0, 15), (15, 30)])
            self.assertEqual(blocks[0].project_id, project.id)
            self.assertIsNone(blocks[0].manual_project_id)
            self.assertEqual(blocks[1].granularity, 15)
            todo.project_id = other.id
            await db.commit()
            refreshed = await list_blocks(date(2026, 9, 12), None, db)
            self.assertEqual(refreshed[0].project_id, other.id)

    async def test_timer_uses_half_coverage_and_preserves_manual_corrections(self):
        async with self.sessions() as db:
            category = models.TimeBlockCategory(name='开发', color='#536fba')
            timer = models.TimerSession(name='编码', status=models.TimerStatus.completed,
                started_at=datetime(2026, 9, 12, 9, 7),
                ended_at=datetime(2026, 9, 12, 9, 23),
                active_intervals=[['2026-09-12T09:07:00', '2026-09-12T09:23:00']])
            db.add_all([category, timer])
            await db.commit()
            blocks = await from_timer(timer.id, TimerConversion(category_id=category.id, granularity=15), db)
            self.assertEqual([b.start_minute for b in blocks], [540, 555])
            self.assertEqual([b.coverage_seconds for b in blocks], [480, 480])
            await replace_range(schemas.TimeBlockReplace(
                block_date=date(2026, 9, 12), start_minute=540, end_minute=555,
                blocks=[schemas.TimeBlockItem(start_minute=540, end_minute=555, granularity=15,
                    category_id=category.id, notes='人工修正')]), db)
            await from_timer(timer.id, TimerConversion(category_id=category.id, granularity=15), db)
            all_blocks = await list_blocks(date(2026, 9, 12), date(2026, 9, 12), db)
            self.assertEqual(all_blocks[0].notes, '人工修正')
            self.assertEqual(all_blocks[0].source, 'manual')

    async def test_longer_timer_coverage_wins_same_block(self):
        async with self.sessions() as db:
            category = models.TimeBlockCategory(name='开发', color='#536fba')
            first = models.TimerSession(name='先计时', status=models.TimerStatus.completed,
                started_at=datetime(2026, 9, 12, 9, 7),
                ended_at=datetime(2026, 9, 12, 9, 23),
                active_intervals=[['2026-09-12T09:07:00', '2026-09-12T09:23:00']])
            second = models.TimerSession(name='后计时', status=models.TimerStatus.completed,
                started_at=datetime(2026, 9, 12, 9, 1),
                ended_at=datetime(2026, 9, 12, 9, 14),
                active_intervals=[['2026-09-12T09:01:00', '2026-09-12T09:14:00']])
            db.add_all([category, first, second])
            await db.commit()
            await from_timer(first.id, TimerConversion(category_id=category.id, granularity=15), db)
            await from_timer(second.id, TimerConversion(category_id=category.id, granularity=15), db)
            blocks = await list_blocks(date(2026, 9, 12), None, db)
            self.assertEqual([(item.start_minute, item.notes) for item in blocks],
                             [(540, '后计时'), (555, '先计时')])

    async def test_below_half_timer_coverage_does_not_claim_blocks(self):
        async with self.sessions() as db:
            category = models.TimeBlockCategory(name='学习', color='#347f88')
            timer = models.TimerSession(name='短计时', status=models.TimerStatus.completed,
                started_at=datetime(2026, 9, 12, 9, 38),
                ended_at=datetime(2026, 9, 12, 9, 52),
                active_intervals=[['2026-09-12T09:38:00', '2026-09-12T09:52:00']])
            db.add_all([category, timer])
            await db.commit()
            self.assertEqual(await from_timer(timer.id, TimerConversion(category_id=category.id, granularity=15), db), [])

    async def test_json_roundtrip_and_legacy_actual_filter(self):
        async with self.sessions() as source:
            category = models.TimeBlockCategory(name='运动', color='#4c9b67')
            planned = models.Schedule(name='体育课', is_planned=True,
                start_time=datetime(2026, 9, 12, 8), end_time=datetime(2026, 9, 12, 9))
            legacy = models.Schedule(name='旧实际', is_planned=False,
                start_time=datetime(2026, 9, 12, 9), end_time=datetime(2026, 9, 12, 10))
            source.add_all([category, planned, legacy])
            await source.flush()
            source.add(models.TimeBlock(block_date=date(2026, 9, 12), start_minute=600,
                end_minute=630, granularity=30, category_id=category.id, notes='跑步'))
            await source.commit()
            package = await export_package(source)
            self.assertEqual(package['schema_version'], '0.10.0')
            self.assertEqual([item['name'] for item in package['entities']['schedules']], ['体育课'])
            self.assertEqual(package['entities']['time_blocks'][0]['category_uuid'], category.uuid)
            legacy_package = {**package, 'schema_version': '0.6.0',
                'entities': {key: value for key, value in package['entities'].items()
                             if key not in ('time_blocks', 'time_block_categories')}}
            legacy_package['entities']['schedules'].append({
                'uuid': legacy.uuid, 'name': '旧实际', 'is_planned': False,
                'start_time': legacy.start_time.isoformat(), 'end_time': legacy.end_time.isoformat(),
                'category': '普通日程', 'nature': 'no_other_task'})
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as target:
            local_category = models.TimeBlockCategory(name='运动', color='#111111')
            target.add(local_category)
            await target.flush()
            target.add(models.TimeBlock(block_date=date(2026, 9, 12), start_minute=600,
                end_minute=630, granularity=30, category_id=local_category.id, notes='本地冲突'))
            await target.commit()
            await import_package(target, package)
            categories = list((await target.execute(select(models.TimeBlockCategory))).scalars())
            schedules = list((await target.execute(select(models.Schedule))).scalars())
            blocks = list((await target.execute(select(models.TimeBlock))).scalars())
            self.assertEqual(len(categories), 1)
            self.assertEqual(categories[0].color, '#4c9b67')
            self.assertEqual([item.name for item in schedules], ['体育课'])
            self.assertEqual(len(blocks), 1)
            self.assertEqual(blocks[0].notes, '跑步')
            await import_package(target, legacy_package)
            schedules = list((await target.execute(select(models.Schedule))).scalars())
            self.assertEqual([item.name for item in schedules], ['体育课'])


if __name__ == '__main__':
    unittest.main()
