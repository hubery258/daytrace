import test, {beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildMergePlan} from '../src/data/mergePlan.js';
import {mobileRequest,__installDatabaseForTests,__resetDatabaseForTests} from '../src/data/mobileDatabase.js';
import {createSqlJsConnection} from './helpers/sqlJsDatabase.mjs';

const fixtures=JSON.parse(await readFile(new URL('../../tests/manual-merge-fixtures.json',import.meta.url),'utf8'));
let db,backupDir;
process.env.NODE_ENV='test';
const request=(path,body)=>mobileRequest(path,body?{method:'POST',body:JSON.stringify(body)}:{});
async function apply(pack,mode='merge',choices={}) {
  const preview=await request('/data/import/preview',{package:pack,mode,choices});
  assert.equal(preview.unresolved,0,JSON.stringify(preview.conflicts));
  return request('/data/import',{package:pack,mode,choices,preview_token:preview.token});
}
beforeEach(async()=>{
  db=await createSqlJsConnection(); backupDir=await mkdtemp(join(tmpdir(),'riji-merge-'));
  await __installDatabaseForTests(db,async pack=>{
    const path=join(backupDir,'snapshot.json'),json=JSON.stringify(pack);
    await writeFile(path,json); assert.equal(await readFile(path,'utf8'),json); return path;
  });
});
afterEach(async()=>{__resetDatabaseForTests();await db.close();await rm(backupDir,{recursive:true,force:true});});

for (const fixture of fixtures) test(`Android actual preview/write/reimport: ${fixture.name}`,async()=>{
  await apply(fixture.local,'replace');
  await apply(fixture.incoming,fixture.mode||'merge',fixture.choices);
  const first=await request('/data/export');
  const expected=await buildMergePlan(fixture.local,fixture.incoming,fixture.mode||'merge',fixture.choices);
  assert.equal(expected.unresolved,0);
  // Ignore export timestamp and compare normalized portable records including associations.
  const actualPlan=await buildMergePlan(first,expected.package,'replace');
  assert.equal(Object.values(actualPlan.entities).reduce((s,r)=>s+r.create+r.update+r.delete,0),0);
  const repeatChoices={...fixture.choices};
  const repeatPreview=await request('/data/import/preview',{package:fixture.incoming,mode:fixture.mode||'merge',choices:repeatChoices});
  for (const c of repeatPreview.conflicts.filter(c=>!c.resolved)) repeatChoices[c.id]={side:'local'};
  const repeated=await apply(fixture.incoming,fixture.mode||'merge',repeatChoices);
  assert.equal(repeated.created,0);
  assert.equal(repeated.updated,0);
  assert.equal(repeated.deleted,0);
  const second=await request('/data/export');
  assert.deepEqual(second.entities,first.entities);
  if (fixture.name==='partial-overlap') {
    assert.equal(first.entities.time_blocks.reduce((s,r)=>s+r.end_minute-r.start_minute,0),30);
    assert.deepEqual(first.entities.time_blocks.map(r=>[r.start_minute,r.end_minute,r.notes]),[[540,555,''],[555,570,'跑步']]);
  }
  if (fixture.name.includes('completed') && fixture.mode!=='replace') assert.equal(first.entities.todos[0].is_completed,true);
  if (fixture.name==='move-identity') assert.equal(first.entities.time_blocks.length,1);
  if (fixture.name.startsWith('split-moved-')) {
    const moved=fixture.name.includes('reverse-local') || fixture.name.includes('forward-incoming');
    const blocks=first.entities.time_blocks;
    assert.equal(blocks.some(r=>r.start_minute===840),moved);
    assert.equal(blocks.some(r=>r.start_minute===540),!moved);
    assert.ok(blocks.some(r=>r.notes==='跑步'));
    assert.equal(blocks.reduce((sum,r)=>sum+r.end_minute-r.start_minute,0),moved?45:30);
  }

  if (fixture.name==='earliest-completion') {
    assert.equal(first.entities.todos[0].completed_at,'2026-10-10T09:00:00');
    assert.equal(first.entities.daily_logs.flatMap(r=>r.completed_todo_uuids).length,1);
  }
});

test('unresolved, stale, damaged, dangling, backup and write failures never partially modify Android',async()=>{
  const f=fixtures.find(r=>r.name==='task-fields'); await apply(f.local,'replace');
  const before=(await request('/data/export')).entities;
  const unresolved=await request('/data/import/preview',{package:f.incoming});
  await assert.rejects(request('/data/import',{package:f.incoming,preview_token:unresolved.token}),/未解决/);
  const preview=await request('/data/import/preview',{package:f.incoming,choices:f.choices});
  await request('/templates',{name:'changed after preview'});
  await assert.rejects(request('/data/import',{package:f.incoming,choices:f.choices,preview_token:preview.token}),/重新预览/);
  const damaged=structuredClone(f.incoming);damaged.entities.todos[0].uuid='broken';
  await assert.rejects(request('/data/import/preview',{package:damaged}),/UUID/);
  const dangling=structuredClone(f.incoming);dangling.entities.todos[0].project_uuid='123e4567-e89b-42d3-a456-999999999999';
  await assert.rejects(request('/data/import/preview',{package:dangling}),/引用不存在/);
  const stable=(await request('/data/export')).entities;
  await __installDatabaseForTests(db,async()=>{throw new Error('backup failed');});
  await assert.rejects(apply(f.incoming,'merge',f.choices),/backup failed/);
  assert.deepEqual((await request('/data/export')).entities,stable);
  await __installDatabaseForTests(db,async()=>join(backupDir,'snapshot.json'));
  const originalRun=db.run.bind(db);let count=0;
  db.run=async(...args)=>{if(++count===2) throw new Error('injected write failure');return originalRun(...args);};
  const failingIncoming=structuredClone(f.incoming);
  failingIncoming.entities.projects=[{uuid:'123e4567-e89b-42d3-a456-777777777777',name:'must rollback'}];
  await assert.rejects(apply(failingIncoming,'merge',f.choices),/injected write failure/);
  db.run=originalRun;
  assert.deepEqual((await request('/data/export')).entities,stable);
  assert.equal(before.todos[0].name,stable.todos[0].name);
});

test('restore preserves local credentials and restores uncompleted state',async()=>{
  const f=fixtures.find(r=>r.name==='restore-uncompleted');await apply(f.local,'replace');
  await db.run("INSERT INTO webdav_config (id,uuid,password,created_at,updated_at) VALUES (1,?,'local-secret',?,?)",[f.local.entities.todos[0].uuid,'2026-10-11T00:00:00','2026-10-11T00:00:00']);
  await apply(f.incoming,'replace');
  assert.equal((await request('/data/export')).entities.todos[0].is_completed,false);
  assert.equal((await db.query('SELECT password FROM webdav_config')).values[0].password,'local-secret');
  assert.equal(JSON.stringify(await request('/data/export')).includes('local-secret'),false);
});

test('upgrades old Android tables without losing records and validates parked timer resume',async()=>{
  await db.execute('ALTER TABLE timer_sessions DROP COLUMN is_parked; ALTER TABLE time_blocks DROP COLUMN origin_uuid');
  await __installDatabaseForTests(db,async pack=>{
    const path=join(backupDir,'upgrade.json'),json=JSON.stringify(pack);await writeFile(path,json);assert.equal(await readFile(path,'utf8'),json);return path;
  });
  assert.ok((await db.query('PRAGMA table_info(timer_sessions)')).values.some(r=>r.name==='is_parked'));
  assert.ok((await db.query('PRAGMA table_info(time_blocks)')).values.some(r=>r.name==='origin_uuid'));
  const f=fixtures.find(r=>r.name==='active-timers-park-other');
  await apply(f.local,'replace');await apply(f.incoming,'merge',f.choices);
  const current=await request('/timer/current'),recent=await request('/timer/recent');
  assert.equal(current.uuid,f.local.entities.timer_sessions[0].uuid);
  assert.equal(recent[0].is_parked,true);assert.equal(recent[0].status,'paused');
  await assert.rejects(request('/timer/resume',{timer_id:recent[0].id}),/先结束当前/);
  await request('/timer/finish',{});
  const resumed=await request('/timer/resume',{timer_id:recent[0].id});
  assert.equal(resumed.is_parked,false);assert.equal(resumed.status,'running');
  assert.equal((await request('/timer/current')).uuid,recent[0].uuid);
});

test('moving an original block after splitting removes its old fragments and preserves coverage',async()=>{
  const f=fixtures.find(r=>r.name==='partial-overlap');
  const local=structuredClone(f.local);local.entities.time_blocks[0].coverage_seconds=1200;
  await apply(local,'replace');await apply(f.incoming,'merge',f.choices);
  const first=(await request('/data/export')).entities.time_blocks;
  assert.equal(first.find(r=>r.start_minute===540).coverage_seconds,600);
  const moved=structuredClone(local);moved.entities.time_blocks[0].start_minute=840;moved.entities.time_blocks[0].end_minute=870;
  const key=`time_blocks:${moved.entities.time_blocks[0].uuid}:fragments`;
  const preview=await request('/data/import/preview',{package:moved});assert.ok(preview.conflicts.some(c=>c.id===key));
  await apply(moved,'merge',{[key]:{side:'incoming'}});
  const final=(await request('/data/export')).entities.time_blocks;
  assert.equal(final.some(r=>r.start_minute===540),false);
  assert.equal(final.filter(r=>r.uuid===moved.entities.time_blocks[0].uuid).length,1);
  assert.ok(final.some(r=>r.notes==='跑步'));
});


test('preview token binds the exact packet, choices and mode',async()=>{
  const f=fixtures.find(r=>r.name==='task-fields');await apply(f.local,'replace');
  const before=(await request('/data/export')).entities;
  const preview=await request('/data/import/preview',{package:f.incoming,choices:f.choices});
  const changed=structuredClone(f.incoming);changed.entities.todos[0].notes='changed packet';
  for (const body of [
    {package:changed,choices:f.choices},
    {package:f.incoming,choices:{...f.choices,unused:{side:'local'}}},
    {package:f.incoming,choices:f.choices,mode:'replace'},
  ]) {
    await assert.rejects(request('/data/import',{...body,preview_token:preview.token}),/重新预览/);
    assert.deepEqual((await request('/data/export')).entities,before);
  }
});

test('dangling local scalar and list references block export, preview and stale execution without writes',async()=>{
  const f=fixtures.find(r=>r.name==='whole-schedule-overnight');
  for (const statement of ["UPDATE todos SET project_id=999999", "UPDATE schedules SET linked_todo_ids='[999999]'"]) {
    await apply(f.local,'replace');
    const preview=await request('/data/import/preview',{package:f.local});
    await db.run(statement);
    const rawBefore=await db.query('SELECT * FROM todos');
    await assert.rejects(request('/data/export'),/断裂关联/);
    await assert.rejects(request('/data/import/preview',{package:f.local}),/断裂关联/);
    await assert.rejects(request('/data/import',{package:f.local,preview_token:preview.token}),/断裂关联/);
    assert.deepEqual(await db.query('SELECT * FROM todos'),rawBefore);
    // Repair only the intentionally corrupted fixture so the next isolated case can restore.
    await db.run('UPDATE todos SET project_id=NULL');await db.run("UPDATE schedules SET linked_todo_ids='[]'");
  }
});


test('failure after deleting a changed exception key rolls back every Android row',async()=>{
  const f=fixtures.find(r=>r.name==='exception-date-swap');await apply(f.local,'replace');
  const before=(await request('/data/export')).entities;
  const originalRun=db.run.bind(db);let deletions=0;
  db.run=async(statement,...args)=>{
    if (statement.startsWith('DELETE FROM recurrence_exceptions') && ++deletions===2) throw new Error('failure after first exception deletion');
    return originalRun(statement,...args);
  };
  await assert.rejects(apply(f.incoming,'merge',f.choices),/first exception deletion/);
  db.run=originalRun;
  assert.deepEqual((await request('/data/export')).entities,before);
});


test('ordinary local deletions clean references and leave remaining content portable',async()=>{
  const f=fixtures.find(r=>r.name==='complete-reference-graph');await apply(f.local,'replace');
  for (const table of ['todos','schedules','projects']) {
    const id=(await db.query(`SELECT id FROM ${table}`)).values[0].id;
    await mobileRequest(`/${table}/${id}`,{method:'DELETE'});
    const pack=await request('/data/export');
    const plan=await buildMergePlan(pack,pack);
    assert.equal(plan.unresolved,0);
    assert.equal(plan.entities.time_blocks.create+plan.entities.time_blocks.update,0);
  }
  const pack=await request('/data/export');
  assert.equal(pack.entities.time_blocks.length,2);
  assert.equal(pack.entities.daily_logs[0].log_text,'正文保留');
  assert.deepEqual(pack.entities.daily_logs[0].completed_todo_uuids,[]);
  assert.deepEqual(pack.entities.recurrence_rules[0].template_linked_todo_uuids,[]);
});
