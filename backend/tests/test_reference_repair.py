import json
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models
from app.database import Base
from app.data_portability import DataPackageError, export_package
from app.reference_repair import preview_schedule_repair, repair_schedule_links


class ReferenceRepairTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.db = async_sessionmaker(self.engine, expire_on_commit=False)()
        todo = models.Todo(name='有效任务')
        self.db.add(todo)
        await self.db.flush()
        self.valid_id = todo.id
        self.db.add(models.Schedule(name='历史计划', start_time=datetime(2020,1,2,9),
            end_time=datetime(2020,1,2,10),linked_todo_ids=[todo.id,999],notes='保留正文'))
        await self.db.commit()

    async def asyncTearDown(self):
        await self.db.close()
        await self.engine.dispose()

    async def links(self):
        self.db.expire_all()
        return (await self.db.execute(select(models.Schedule))).scalar_one()

    async def test_preview_confirm_backup_and_repeat(self):
        preview = await preview_schedule_repair(self.db)
        self.assertEqual(preview['items'][0]['start_time'],'2020-01-02T09:00:00')
        self.assertEqual(preview['items'][0]['missing_ids'],[999])
        result = await repair_schedule_links(self.db,preview['token'],True)
        backup = Path(result['backup_path'])
        try:
            snapshot=json.loads(backup.read_text(encoding='utf-8'))
            self.assertEqual(snapshot['before'][0]['linked_todo_ids'],[self.valid_id,999])
            self.assertNotIn('password',snapshot)
            schedule=await self.links()
            self.assertEqual(schedule.linked_todo_ids,[self.valid_id])
            self.assertEqual(schedule.notes,'保留正文')
            await export_package(self.db)
            repeat=await preview_schedule_repair(self.db)
            self.assertEqual(repeat['items'],[])
            self.assertEqual((await repair_schedule_links(self.db,repeat['token'],True))['repaired'],0)
        finally:
            backup.unlink()

    async def test_stale_and_unconfirmed_never_write(self):
        preview=await preview_schedule_repair(self.db)
        with self.assertRaises(DataPackageError):
            await repair_schedule_links(self.db,preview['token'],False)
        row=await self.links()
        row.notes='检查后的修改'
        await self.db.commit()
        with self.assertRaisesRegex(DataPackageError,'重新检查'):
            await repair_schedule_links(self.db,preview['token'],True)
        self.assertEqual((await self.links()).linked_todo_ids,[self.valid_id,999])

    async def test_backup_and_write_failure_preserve_all_links(self):
        preview=await preview_schedule_repair(self.db)
        with patch('app.reference_repair.save_operation_backup',side_effect=DataPackageError('副本失败')):
            with self.assertRaises(DataPackageError):
                await repair_schedule_links(self.db,preview['token'],True)
        self.assertEqual((await self.links()).linked_todo_ids,[self.valid_id,999])
        original=self.db.execute
        async def fail_write(statement,*args,**kwargs):
            if str(statement).startswith('UPDATE schedules'):
                raise RuntimeError('模拟写入失败')
            return await original(statement,*args,**kwargs)
        with patch.object(self.db,'execute',side_effect=fail_write), patch('app.reference_repair.save_operation_backup',return_value='verified-test-copy'):
            with self.assertRaises(RuntimeError):
                await repair_schedule_links(self.db,preview['token'],True)
        self.assertEqual((await self.links()).linked_todo_ids,[self.valid_id,999])
