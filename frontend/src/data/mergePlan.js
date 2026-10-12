import contract from '../../../backend/app/merge_contract.json' with { type: 'json' };

export const mergeOrder = Object.keys(contract);
const clone = value => JSON.parse(JSON.stringify(value));
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const equal = (a, b) => canonical(a) === canonical(b);
export async function digest(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
async function stableUuid(value) {
  const s = await digest(value);
  return `${s.slice(0,8)}-${s.slice(8,12)}-5${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`;
}
const uuidValid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const stamp = '2000-01-01T00:00:00'; // deterministic fallback for legitimate legacy packages
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0,10) !== value) throw new Error('日期无效');
  return value;
}
function datetime(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}+08:00`);
  if (!Number.isFinite(+parsed)) throw new Error('时间无效');
  return new Date(+parsed + 28800000).toISOString().replace(/\.000Z$/, '').replace(/Z$/, '');
}
export function normalizePackage(raw) {
  if (!raw || raw.app !== 'riji' || !['0.6.0','0.8.0','0.10.0'].includes(raw.schema_version) || !raw.entities || Array.isArray(raw.entities)) throw new Error('不是受支持的日迹数据包');
  const entities = {};
  for (const name of mergeOrder) {
    const items = raw.entities[name] ?? [];
    if (!Array.isArray(items)) throw new Error(`${name} 必须是数组`);
    const seen = new Set();
    entities[name] = items.filter(r => !(name === 'schedules' && r?.is_planned === false) && !(name === 'recurrence_rules' && r?.entity_type === 'schedule' && r?.template_json?.is_planned === false)).map(item => {
      if (!item || !uuidValid(item.uuid) || seen.has(item.uuid.toLowerCase())) throw new Error(`${name} UUID 无效或重复`);
      seen.add(item.uuid.toLowerCase());
      const row = {uuid: item.uuid.toLowerCase()};
      for (const [key, fallback] of Object.entries(contract[name])) {
        row[key] = clone(Object.hasOwn(item,key) ? item[key] : fallback);
        if (key.endsWith('_uuid') && row[key] != null) {
          if (!uuidValid(row[key])) throw new Error(`${name}.${key} UUID 无效`);
          row[key] = row[key].toLowerCase();
        }
        if (key.endsWith('_uuids')) {
          if (!Array.isArray(row[key]) || row[key].some(v => !uuidValid(v))) throw new Error('关联 UUID 数组无效');
          row[key] = [...new Set(row[key].map(v => v.toLowerCase()))].sort();
        }
        if (key.endsWith('_date') && row[key] != null && !(name === 'todos' && key === 'ddl_date')) row[key] = day(row[key]);
        if ((key.endsWith('_at') || ['start_time','end_time','ddl_date'].includes(key)) && row[key] != null && !key.endsWith('_date')) row[key] = datetime(row[key]);
        if (name === 'todos' && key === 'ddl_date') row[key] = datetime(row[key]);
        if (key.startsWith('is_') && typeof row[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
        if (typeof fallback === 'string' && typeof row[key] !== 'string') throw new Error(`${key} 必须是文本`);
      }
      row.created_at = datetime(item.created_at) || stamp;
      if (name !== 'log_templates' && name !== 'recurrence_exceptions') row.updated_at = datetime(item.updated_at) || row.created_at;
      if ('name' in row && (!row.name.trim() || row.name.length > (name === 'time_block_categories' ? 100 : 200))) throw new Error(`${name} 名称无效`);
      if (name === 'time_block_categories' && !/^#[0-9a-f]{6}$/i.test(row.color)) throw new Error('属性颜色无效');
      if (name === 'schedules' && (!row.start_time || !row.end_time || row.end_time <= row.start_time)) throw new Error('计划起止时间无效');
      if (name === 'time_blocks') {
        if (!row.block_date || !row.category_uuid) throw new Error('时间块缺少日期或属性');
        const {start_minute:a,end_minute:b,granularity:g,coverage_seconds:c} = row;
        if (![a,b,g].every(Number.isInteger) || ![15,30].includes(g) || a < 0 || b > 1440 || b-a !== g || a%g || !['manual','timer'].includes(row.source) || (c != null && (!Number.isInteger(c) || c < 0 || c > g*60))) throw new Error('时间块范围、粒度或覆盖时长无效');
        if (row.linked_todo_uuid) row.manual_project_uuid = null;
      }
      if (name === 'recurrence_rules') {
        if (!row.start_date || (row.end_date && row.end_date<row.start_date)) throw new Error('重复规则日期无效');
        if (row.month_day != null && (!Number.isInteger(row.month_day) || row.month_day<1 || row.month_day>31)) throw new Error('每月日期无效');
        if (row.weekdays != null && (!Array.isArray(row.weekdays) || row.weekdays.some(v=>!Number.isInteger(v)||v<0||v>6))) throw new Error('重复星期无效');
        if (!row.template_json || Array.isArray(row.template_json) || typeof row.template_json !== 'object') throw new Error('重复模板无效');
        delete row.template_json.project_id;
      }
      if (name === 'recurrence_exceptions' && (!row.recurrence_rule_uuid || !row.recurrence_date)) throw new Error('重复例外缺少规则或日期');
      if (name === 'daily_logs' && !row.log_date) throw new Error('日志缺少日期');
      if (name === 'timer_sessions') {
        if (!row.started_at || !Number.isInteger(row.paused_seconds) || row.paused_seconds<0 || !Array.isArray(row.active_intervals)) throw new Error('计时记录无效');
        row.active_intervals = row.active_intervals.map(range=>{
          if (!Array.isArray(range)||range.length!==2) throw new Error('计时区间无效');
          const a=datetime(range[0]),b=datetime(range[1]);
          if (!a || !b || b<a) throw new Error('计时区间无效');
          return [a,b];
        });
        if (row.status==='paused' && !row.paused_at) throw new Error('暂停计时缺少暂停时间');
        if (row.is_parked && row.status!=='paused') throw new Error('暂存计时必须暂停');
      }
      return row;
    });
  }
  const enums = {projects:{status:['active','paused','completed','archived','canceled']},todos:{ddl_type:['none','hard','soft'],status:['not_focusing','focusing','waiting_reply']},schedules:{nature:['no_other_task','relax','free_arrange']},recurrence_rules:{entity_type:['todo','schedule'],frequency:['daily','weekly','monthly'],status:['active','paused','archived']},recurrence_exceptions:{entity_type:['todo','schedule'],action:['deleted']},timer_sessions:{status:['running','paused','completed','canceled']}};
  for (const [name, fields] of Object.entries(enums)) for (const r of entities[name]) for (const [key, values] of Object.entries(fields)) if (!values.includes(r[key])) throw new Error(`${name}.${key} 无效`);
  for (const name of ['daily_logs','recurrence_exceptions']) {
    const keys = entities[name].map(r => name==='recurrence_exceptions'?exceptionKey(r):identity(name,r));
    if (new Set(keys).size !== keys.length) throw new Error(`${name} 身份重复`);
  }
  for (const name of ['time_blocks']) {
    const sorted = [...entities[name]].sort((a,b) => a.block_date.localeCompare(b.block_date) || a.start_minute-b.start_minute);
    if (sorted.some((r,i) => i && sorted[i-1].block_date === r.block_date && sorted[i-1].end_minute > r.start_minute)) throw new Error('数据包时间块重叠');
  }
  for (const items of Object.values(entities)) items.sort((a,b)=>a.uuid.localeCompare(b.uuid));
  return {app:'riji',schema_version:'0.10.0',entities};
}
function identity(name,r) {
  if (name === 'daily_logs') return r.log_date;
  return r.uuid;
}
function exceptionKey(r) { return `${r.recurrence_rule_uuid}:${r.entity_type}:${r.recurrence_date}`; }
function business(r) { return Object.fromEntries(Object.entries(r).filter(([k]) => !['uuid','created_at','updated_at','origin_uuid'].includes(k))); }
function blockContent(r) { return Object.fromEntries(Object.entries(business(r)).filter(([k]) => !['block_date','start_minute','end_minute','granularity','coverage_seconds'].includes(k))); }
function validateReferences(pack) {
  const maps = Object.fromEntries(mergeOrder.map(n => [n,new Set(pack.entities[n].map(r=>r.uuid))]));
  const targets = {project_uuid:'projects',manual_project_uuid:'projects',recurrence_rule_uuid:'recurrence_rules',linked_todo_uuid:'todos',linked_todo_uuids:'todos',template_linked_todo_uuids:'todos',completed_todo_uuids:'todos',category_uuid:'time_block_categories',source_timer_uuid:'timer_sessions',created_schedule_uuid:'schedules'};
  for (const name of mergeOrder) for (const r of pack.entities[name]) for (const [key,target] of Object.entries(targets)) {
    const values = key.endsWith('_uuids') ? r[key] || [] : r[key] ? [r[key]] : [];
    if (values.some(v=>!maps[target].has(v))) throw new Error(`${name}.${key} 引用不存在的 UUID`);
  }
}

export async function buildMergePlan(localRaw, incomingRaw, mode='merge', choices={}) {
  if (!['merge','replace'].includes(mode)) throw new Error('导入模式无效');
  const local = normalizePackage(localRaw), incoming = normalizePackage(incomingRaw);
  // Local references may supply objects omitted by a merge package. Restore must stand alone.
  validateReferences(mode === 'replace' ? incoming : {entities:Object.fromEntries(mergeOrder.map(n=>[n,[...local.entities[n],...incoming.entities[n]]]))});
  const conflicts = [], effects = [];
  function choose(id, entity, field, a, b, kind='value') {
    const choice = choices[id];
    let resolved = choice?.side === 'local' || choice?.side === 'incoming';
    if (choice?.side === 'edit' && ['notes','log_text','completed_at','name'].includes(field) && typeof choice.value === 'string') resolved = true;
    if (kind==='links') resolved=choice?.side==='links' && Array.isArray(choice.value) && choice.value.every(uuidValid);
    conflicts.push({id,entity,field,kind,local:clone(a),incoming:clone(b),resolved,choice:resolved?choice:null});
    if (!resolved) return clone(a);
    return clone(['edit','links'].includes(choice.side) ? choice.value : choice.side === 'incoming' ? b : a);
  }
  for (const row of incoming.entities.recurrence_rules) {
    const ids=row.template_json.linked_todo_ids;
    if (Array.isArray(ids) && ids.length) {
      const old=local.entities.recurrence_rules.find(r=>r.uuid===row.uuid);
      row.template_linked_todo_uuids=choose(`recurrence_rules:${row.uuid}:legacy-links`,'recurrence_rules','template_linked_todo_uuids',old?.template_linked_todo_uuids||[],ids,'links');
      conflicts.at(-1).options=[...new Map([...local.entities.todos,...incoming.entities.todos].map(r=>[r.uuid,{uuid:r.uuid,name:r.name}])).values()];
    }
    delete row.template_json.linked_todo_ids;
  }
  const output = clone(mode === 'replace' ? incoming : local);
  if (mode === 'merge') for (const name of mergeOrder.filter(n=>n!=='time_blocks')) {
    const map = new Map(output.entities[name].map(r=>[identity(name,r),r]));
    for (const r of incoming.entities[name]) {
      const key = identity(name,r), old = map.get(key) || (name==='recurrence_exceptions'?output.entities[name].find(x=>exceptionKey(x)===exceptionKey(r)):null);
      if (!old) { const added=clone(r); output.entities[name].push(added); map.set(key,added); continue; }
      if (equal(business(old),business(r))) continue;
      if (name === 'todos') {
        for (const field of Object.keys(contract.todos).filter(k=>!['is_completed','completed_at'].includes(k))) if (!equal(old[field],r[field])) old[field] = choose(`${name}:${old.uuid}:${field}`,name,field,old[field],r[field]);
        const times = [old,r].filter(t=>t.is_completed && t.completed_at).map(t=>t.completed_at).sort();
        old.is_completed = old.is_completed || r.is_completed;
        old.completed_at = old.is_completed ? times[0] || null : null;
      } else if (name === 'daily_logs') {
        if (old.log_text !== r.log_text) old.log_text = choose(`${name}:${key}:log_text`,name,'log_text',old.log_text,r.log_text);
        old.completed_todo_uuids = [...new Set([...old.completed_todo_uuids,...r.completed_todo_uuids])].sort();
      } else {
        const selected = choose(`${name}:${key}:record`,name,'record',old,r,'record');
        Object.assign(old,selected,{uuid:old.uuid});
      }
    }
  }
  if (mode === 'merge') {
    const a = clone(local.entities.time_blocks), b = clone(incoming.entities.time_blocks);
    const suppressedA = new Set(), suppressedB = new Set();
    for (const r of b) {
      const old = a.find(x=>x.uuid===r.uuid);
      // A moved UUID is an identity conflict even when its new interval is disjoint.
      if (old && !equal(business(old),business(r))) {
        const selected = choose(`time_blocks:${r.uuid}:record`,'time_blocks','record',old,r,'identity');
        if (equal(selected,old)) suppressedB.add(r.uuid); else suppressedA.add(old.uuid);
        effects.push({kind:'identity',uuid:r.uuid,local:[old.block_date,old.start_minute,old.end_minute],incoming:[r.block_date,r.start_minute,r.end_minute]});
      }
      if (!old) {
        const fragments = a.filter(x=>x.origin_uuid===r.uuid);
        // Existing fragments are kept for interval resolution on repeat import; moved origins need explicit selection.
        if (fragments.length && fragments.some(x=>x.block_date!==r.block_date || x.start_minute<r.start_minute || x.end_minute>r.end_minute)) {
          const selected = choose(`time_blocks:${r.uuid}:fragments`,'time_blocks','record',fragments,[r],'identity');
          if (Array.isArray(selected) && selected.length===1 && selected[0].uuid===r.uuid) fragments.forEach(x=>suppressedA.add(x.uuid)); else suppressedB.add(r.uuid);
          effects.push({kind:'identity',uuid:r.uuid,local:fragments.map(x=>[x.block_date,x.start_minute,x.end_minute]),incoming:[r.block_date,r.start_minute,r.end_minute]});
        }
      }
    }
    // The original can also be on this device while the imported copy already contains fragments.
    for (const original of a.filter(x=>!suppressedA.has(x.uuid))) {
      const fragments=b.filter(x=>x.origin_uuid===original.uuid && !suppressedB.has(x.uuid));
      if (fragments.length && fragments.some(x=>x.block_date!==original.block_date || x.start_minute<original.start_minute || x.end_minute>original.end_minute)) {
        const chosen=choose(`time_blocks:${original.uuid}:fragments`,'time_blocks','record',[original],fragments,'identity');
        if (equal(chosen,[original])) fragments.forEach(x=>suppressedB.add(x.uuid)); else suppressedA.add(original.uuid);
        effects.push({kind:'identity',uuid:original.uuid,local:[original.block_date,original.start_minute,original.end_minute],incoming:fragments.map(x=>[x.block_date,x.start_minute,x.end_minute])});
      }
    }
    const left=a.filter(x=>!suppressedA.has(x.uuid)), right=b.filter(x=>!suppressedB.has(x.uuid));
    const selected=[];
    const days=[...new Set([...left,...right].map(x=>x.block_date))].sort();
    for (const date of days) {
      const l=left.filter(x=>x.block_date===date), r=right.filter(x=>x.block_date===date);
      const boundaries=[...new Set([...l,...r].flatMap(x=>[x.start_minute,x.end_minute]))].sort((x,y)=>x-y);
      for (let i=0;i<boundaries.length-1;i++) {
        const start=boundaries[i],end=boundaries[i+1],one=l.find(x=>x.start_minute<=start && x.end_minute>=end),two=r.find(x=>x.start_minute<=start && x.end_minute>=end);
        if (!one && !two) continue;
        let chosen=one||two;
        if (one && two && !equal(blockContent(one),blockContent(two))) chosen=choose(`time_blocks:${date}:${start}:${end}`,'time_blocks','interval',one,two,'interval');
        if (one && two) effects.push({kind:'overlap',date,start,end,local_uuid:one.uuid,incoming_uuid:two.uuid});
        selected.push({row:chosen,start,end});
      }
    }
    // Rejoin whole source blocks when possible; only changed intervals become deterministic 15-minute fragments.
    const joined=[];
    for (const piece of selected) {
      const prev=joined.at(-1);
      if (prev && prev.row.uuid===piece.row.uuid && prev.row.block_date===piece.row.block_date && prev.end===piece.start) prev.end=piece.end;
      else joined.push({...piece});
    }
    output.entities.time_blocks=[];
    for (const {row,start,end} of joined) {
      if (start===row.start_minute && end===row.end_minute) { output.entities.time_blocks.push(row); continue; }
      effects.push({kind:'split',uuid:row.uuid,date:row.block_date,start,end});
      for (let minute=start;minute<end;minute+=15) {
        const fragment={...row,uuid:await stableUuid([row.origin_uuid||row.uuid,row.block_date,minute,minute+15]),origin_uuid:row.origin_uuid||row.uuid,start_minute:minute,end_minute:minute+15,granularity:15};
        // coverage is metadata; statistics continue to use occupied block minutes.
        if (row.coverage_seconds != null) fragment.coverage_seconds = Math.floor(row.coverage_seconds*(minute+15-row.start_minute)/row.granularity)-Math.floor(row.coverage_seconds*(minute-row.start_minute)/row.granularity);
        output.entities.time_blocks.push(fragment);
      }
    }
    // One completion log entry per task, on the chosen completion date.
    for (const todo of output.entities.todos) {
      let date=todo.completed_at?.slice(0,10);
      if (todo.is_completed && !date) {
        const dates=output.entities.daily_logs.filter(log=>log.completed_todo_uuids.includes(todo.uuid)).map(log=>log.log_date).sort();
        if (dates.length===1) date=dates[0];
        else {
          const value=choose(`todos:${todo.uuid}:completed_at`,'todos','completed_at',dates[0]||'',dates.at(-1)||'','date');
          if (value) { date=day(value.slice(0,10)); todo.completed_at=`${date}T00:00:00`; }
          else conflicts.at(-1).resolved=false;
        }
      }
      for (const log of output.entities.daily_logs) log.completed_todo_uuids=log.completed_todo_uuids.filter(v=>v!==todo.uuid);
      if (todo.is_completed && date) {
        if (!todo.completed_at) todo.completed_at=`${date}T00:00:00`;
        let log=output.entities.daily_logs.find(x=>x.log_date===date);
        if (!log) { log={...clone(contract.daily_logs),uuid:await stableUuid(['daily_logs',date]),log_date:date,created_at:stamp,updated_at:stamp}; output.entities.daily_logs.push(log); }
        log.completed_todo_uuids.push(todo.uuid); log.completed_todo_uuids.sort();
      }
    }
  }
  const categories=output.entities.time_block_categories;
  const groups=new Map();
  for (const row of categories) {
    if (!groups.has(row.name)) groups.set(row.name,[]);
    groups.get(row.name).push(row);
  }
  for (const rows of groups.values()) if (rows.length>1) for (const row of rows.slice(1)) {
    const id=`time_block_categories:${row.uuid}:name`, value=choose(id,'time_block_categories','name',row.name,row.name,'rename');
    if (choices[id]?.side==='edit' && value.trim() && value.length<=100) row.name=value.trim();
    else conflicts.at(-1).resolved=false;
  }
  if (new Set(categories.map(r=>r.name)).size!==categories.length) for (const c of conflicts.filter(x=>x.kind==='rename')) c.resolved=false;
  const active=output.entities.timer_sessions.filter(r=>['running','paused'].includes(r.status) && !r.is_parked);
  if (active.length>1) {
    const id='timer_sessions:active:record', choice=choices[id];
    const pauseAt=choice?.paused_at ? datetime(choice.paused_at) : null;
    const selected=pauseAt ? active.find(r=>r.uuid===choice?.value) : null;
    conflicts.push({id,entity:'timer_sessions',field:'record',kind:'active_timer',local:active.filter(r=>local.entities.timer_sessions.some(x=>x.uuid===r.uuid)),incoming:active.filter(r=>incoming.entities.timer_sessions.some(x=>x.uuid===r.uuid)),options:active,resolved:!!selected,choice:selected?choice:null});
    if (selected) for (const r of active) if (r!==selected) {
      r.is_parked=true;
      if (r.status==='running') {
        if (pauseAt < (r.last_resumed_at||r.started_at)) throw new Error('暂停时间早于计时开始');
        if (r.last_resumed_at) r.active_intervals.push([r.last_resumed_at,pauseAt]);
        r.paused_at=pauseAt; r.status='paused';
      }
    }
  }
  validateReferences(output);
  normalizePackage(output); // validate edited values and the complete final interval set before execution
  const summary={};
  for (const name of mergeOrder) {
    const before=new Map(local.entities[name].map(r=>[identity(name,r),r])),after=new Map(output.entities[name].map(r=>[identity(name,r),r]));
    let create=0,update=0,skip=0;
    for (const r of after.values()) { const old=before.get(identity(name,r)); if (!old) create++; else if (!equal(business(old),business(r))) update++; }
    for (const r of incoming.entities[name]) { const old=before.get(identity(name,r)) || (name==='recurrence_exceptions'?[...before.values()].find(x=>exceptionKey(x)===exceptionKey(r)):null); if (old && equal(business(old),business(r))) skip++; }
    const deleted=[...before.keys()].filter(k=>!after.has(k)).length;
    summary[name]={total:incoming.entities[name].length,create,update,skip,delete:deleted,conflict:conflicts.filter(c=>c.entity===name).length};
  }
  const token=await digest({local,incoming,mode,choices,raw:incomingRaw});
  return {app:'riji',schema_version:incomingRaw.schema_version,mode,token,conflicts,effects,entities:summary,total:Object.values(summary).reduce((s,r)=>s+r.total,0),delete_total:Object.values(summary).reduce((s,r)=>s+r.delete,0),unresolved:conflicts.filter(c=>!c.resolved).length,package:output};
}
