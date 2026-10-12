import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { canonical } from './mergePlan.js';

export function createScheduleLinkRepair({rows, run, getDatabase, backupWriter}) {
  async function preview() {
    const valid=new Set((await rows('todos')).map(row=>row.id));
    const schedules=(await rows('schedules')).sort((a,b)=>a.uuid.localeCompare(b.uuid));
    const items=schedules.filter(row=>row.linked_todo_ids.some(id=>!valid.has(id))).map(row=>({
      ...row,missing_ids:row.linked_todo_ids.filter(id=>!valid.has(id)),
      remaining_ids:row.linked_todo_ids.filter(id=>valid.has(id)),
    }));
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical({schedules,todo_ids:[...valid].sort((a,b)=>a-b)})));
    return {token:[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join(''),items};
  }
  async function repair(body) {
    if (!body.confirmed || !body.preview_token) throw new Error('请先检查并确认清除失效关联');
    const db=await getDatabase(); await db.beginTransaction();
    try {
      const result=await preview();
      if (result.token!==body.preview_token) throw new Error('计划或任务已变化，请重新检查');
      if (!result.items.length) {await db.rollbackTransaction();return {repaired:0,backup_path:null};}
      const snapshot={app:'riji-reference-repair',kind:'schedule-task-links',before:result.items};
      let backup;
      if (backupWriter) backup=await backupWriter(snapshot,'before-reference-repair');
      else {
        const path=`日迹/before-reference-repair-${crypto.randomUUID()}.json`,data=JSON.stringify(snapshot);
        const saved=await Filesystem.writeFile({path,data,directory:Directory.Documents,encoding:Encoding.UTF8,recursive:true});
        const read=await Filesystem.readFile({path,directory:Directory.Documents,encoding:Encoding.UTF8});
        if (read.data!==data) throw new Error('操作前副本校验失败，未执行修复');
        backup=saved.uri;
      }
      if (!backup) throw new Error('操作前副本未能保存，未执行修复');
      for (const item of result.items) await run('UPDATE schedules SET linked_todo_ids = ? WHERE uuid = ?',[JSON.stringify(item.remaining_ids),item.uuid],false);
      await db.commitTransaction();
      return {repaired:result.items.length,backup_path:backup};
    } catch(error) {await db.rollbackTransaction();throw error;}
  }
  return {preview,repair};
}
