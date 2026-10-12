import json
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.database import Base
from app.data_portability import export_package
from app.merge_plan import build_merge_plan, normalize_package
from app.routers.data_portability import ImportRequest, preview_import, commit_import

FIXTURES = json.loads((Path(__file__).parents[2] / 'tests/manual-merge-fixtures.json').read_text(encoding='utf-8'))


class ManualMergeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='riji-merge-')
        self.engine = create_async_engine('sqlite+aiosqlite:///' + str(Path(self.temp.name) / 'test.db'))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()
        self.temp.cleanup()

    async def apply(self, db, package, mode='merge', choices=None):
        data = ImportRequest(package=package, mode=mode, choices=choices or {})
        preview = await preview_import(data, db)
        self.assertEqual(preview['unresolved'], 0, preview['conflicts'])
        data.preview_token = preview['token']
        return await commit_import(data, db)

    async def test_shared_acceptance_fixtures_on_actual_router(self):
        async with self.sessions() as db:
            for fixture in FIXTURES:
                with self.subTest(fixture=fixture['name']):
                    await self.apply(db, fixture['local'], 'replace')
                    await self.apply(db, fixture['incoming'], fixture.get('mode', 'merge'), fixture['choices'])
                    first = await export_package(db)
                    expected = build_merge_plan(fixture['local'], fixture['incoming'], fixture.get('mode', 'merge'), fixture['choices'])
                    self.assertEqual(normalize_package(first), normalize_package(expected['package']))
                    choices = dict(fixture['choices'])
                    preview = await preview_import(ImportRequest(package=fixture['incoming'], mode=fixture.get('mode', 'merge'), choices=choices), db)
                    for conflict in preview['conflicts']:
                        if not conflict['resolved']:
                            choices[conflict['id']] = {'side': 'local'}
                    repeated = await self.apply(db, fixture['incoming'], fixture.get('mode', 'merge'), choices)
                    self.assertEqual((repeated['created'], repeated['updated'], repeated['deleted']), (0, 0, 0))
                    self.assertEqual((await export_package(db))['entities'], first['entities'])
                    self.assertTrue(Path(repeated['backup_path']).exists())

    async def test_stale_unresolved_backup_and_write_failure_are_atomic(self):
        fixture = next(f for f in FIXTURES if f['name'] == 'task-fields')
        async with self.sessions() as db:
            await self.apply(db, fixture['local'], 'replace')
            data = ImportRequest(package=fixture['incoming'])
            data.preview_token = (await preview_import(data, db))['token']
            with self.assertRaisesRegex(HTTPException, '未解决'):
                await commit_import(data, db)
            data.choices = fixture['choices']
            data.preview_token = (await preview_import(data, db))['token']
            db.add(models.LogTemplate(name='preview changed', content=''))
            await db.commit()
            with self.assertRaisesRegex(HTTPException, '重新预览'):
                await commit_import(data, db)
            stable = (await export_package(db))['entities']
            data.preview_token = (await preview_import(data, db))['token']
            with patch('app.data_portability.save_operation_backup', side_effect=OSError('backup failed')):
                with self.assertRaisesRegex(OSError, 'backup failed'):
                    await commit_import(data, db)
            self.assertEqual((await export_package(db))['entities'], stable)
            data.preview_token = (await preview_import(data, db))['token']
            with patch('app.data_portability.rebuild_recurrence_claims', side_effect=RuntimeError('write failure')):
                with self.assertRaisesRegex(RuntimeError, 'write failure'):
                    await commit_import(data, db)
            self.assertEqual((await export_package(db))['entities'], stable)
            damaged = json.loads(json.dumps(fixture['incoming']))
            damaged['entities']['todos'][0]['project_uuid'] = '123e4567-e89b-42d3-a456-999999999999'
            with self.assertRaisesRegex(HTTPException, '引用不存在'):
                await preview_import(ImportRequest(package=damaged), db)
            self.assertEqual((await export_package(db))['entities'], stable)

    async def test_restore_credentials_and_completion(self):
        fixture = next(f for f in FIXTURES if f['name'] == 'restore-uncompleted')
        async with self.sessions() as db:
            await self.apply(db, fixture['local'], 'replace')
            db.add(models.WebDavConfig(base_url='https://example.invalid', username='local', password='local-secret'))
            await db.commit()
            await self.apply(db, fixture['incoming'], 'replace')
            self.assertFalse((await export_package(db))['entities']['todos'][0]['is_completed'])
            credential = (await db.execute(select(models.WebDavConfig))).scalar_one()
            self.assertEqual(credential.password, 'local-secret')
            self.assertNotIn('local-secret', json.dumps(await export_package(db)))

    def test_python_matches_javascript_golden_plans(self):
        runner = Path(__file__).parents[2] / 'tests/merge-fixture-runner.mjs'
        expected = json.loads(subprocess.check_output(['node', str(runner)], encoding='utf-8'))
        for fixture, golden in zip(FIXTURES, expected):
            with self.subTest(fixture=fixture['name']):
                self.assertEqual(build_merge_plan(fixture['local'], fixture['incoming'], fixture.get('mode', 'merge'), fixture['choices']), golden)

    async def test_schema_upgrade_and_parked_timer_resume(self):
        from app.main import ensure_sqlite_schema_compat
        from app.routers.timer import resume_timer, finish_timer
        async with self.engine.begin() as conn:
            await conn.execute(text('ALTER TABLE timer_sessions DROP COLUMN is_parked'))
            await conn.execute(text('ALTER TABLE time_blocks DROP COLUMN origin_uuid'))
            await ensure_sqlite_schema_compat(conn)
        fixture = next(f for f in FIXTURES if f['name'] == 'active-timers-park-other')
        async with self.sessions() as db:
            await self.apply(db, fixture['local'], 'replace')
            await self.apply(db, fixture['incoming'], choices=fixture['choices'])
            parked = (await db.execute(select(models.TimerSession).where(models.TimerSession.is_parked.is_(True)))).scalar_one()
            parked_id = parked.id
            with self.assertRaisesRegex(HTTPException, '先结束当前'):
                await resume_timer(db, {'timer_id': parked_id})
            await finish_timer(db)
            resumed = await resume_timer(db, {'timer_id': parked_id})
            self.assertFalse(resumed.is_parked)
            self.assertEqual(resumed.status, models.TimerStatus.running)


    async def test_token_binds_packet_choices_and_mode(self):
        fixture = next(f for f in FIXTURES if f['name'] == 'task-fields')
        async with self.sessions() as db:
            await self.apply(db, fixture['local'], 'replace')
            data = ImportRequest(package=fixture['incoming'], choices=fixture['choices'])
            token = (await preview_import(data, db))['token']
            before = (await export_package(db))['entities']
            changed = json.loads(json.dumps(fixture['incoming']))
            changed['entities']['todos'][0]['notes'] = 'changed packet'
            for args in [dict(package=changed, choices=fixture['choices']), dict(package=fixture['incoming'], choices={**fixture['choices'], 'unused': {'side': 'local'}}), dict(package=fixture['incoming'], choices=fixture['choices'], mode='replace')]:
                with self.assertRaisesRegex(HTTPException, '重新预览'):
                    await commit_import(ImportRequest(**args, preview_token=token), db)
                self.assertEqual((await export_package(db))['entities'], before)

    async def test_local_dangling_refs_are_not_silently_discarded(self):
        fixture = next(f for f in FIXTURES if f['name'] == 'whole-schedule-overnight')
        async with self.sessions() as db:
            for statement in ["UPDATE todos SET project_id=999999", "UPDATE schedules SET linked_todo_ids='[999999]'"]:
                await self.apply(db, fixture['local'], 'replace')
                data = ImportRequest(package=fixture['local'])
                data.preview_token = (await preview_import(data, db))['token']
                await db.execute(text(statement)); await db.commit()
                db.expire_all()
                raw_before = (await db.execute(text('SELECT * FROM todos'))).all()
                with self.assertRaisesRegex(ValueError, '断裂关联'):
                    await export_package(db)
                with self.assertRaisesRegex(HTTPException, '断裂关联'):
                    await preview_import(data, db)
                with self.assertRaisesRegex(HTTPException, '断裂关联'):
                    await commit_import(data, db)
                self.assertEqual((await db.execute(text('SELECT * FROM todos'))).all(), raw_before)
                await db.execute(text('UPDATE todos SET project_id=NULL'))
                await db.execute(text("UPDATE schedules SET linked_todo_ids='[]'")); await db.commit(); db.expire_all()


    async def test_exception_key_swap_write_failure_is_atomic(self):
        fixture = next(f for f in FIXTURES if f['name'] == 'exception-date-swap')
        async with self.sessions() as db:
            await self.apply(db, fixture['local'], 'replace')
            before = (await export_package(db))['entities']
            data = ImportRequest(package=fixture['incoming'], choices=fixture['choices'])
            data.preview_token = (await preview_import(data, db))['token']
            with patch('app.data_portability.rebuild_recurrence_claims', side_effect=RuntimeError('failure after exception key swap')):
                with self.assertRaisesRegex(RuntimeError, 'exception key swap'):
                    await commit_import(data, db)
            self.assertEqual((await export_package(db))['entities'], before)


    async def test_local_deletions_preserve_reference_integrity(self):
        from app import crud
        fixture = next(f for f in FIXTURES if f['name'] == 'complete-reference-graph')
        async with self.sessions() as db:
            await self.apply(db, fixture['local'], 'replace')
            for model, remove in [(models.Todo, crud.delete_todo), (models.Schedule, crud.delete_schedule), (models.Project, crud.delete_project)]:
                row = (await db.execute(select(model))).scalar_one()
                self.assertTrue(await remove(db, row.id))
                pack = await export_package(db)
                plan = build_merge_plan(pack, pack)
                self.assertEqual(plan['unresolved'], 0)
            self.assertEqual(len(pack['entities']['time_blocks']), 2)
            self.assertEqual(pack['entities']['daily_logs'][0]['log_text'], '正文保留')
            self.assertEqual(pack['entities']['daily_logs'][0]['completed_todo_uuids'], [])
            self.assertEqual(pack['entities']['recurrence_rules'][0]['template_linked_todo_uuids'], [])
