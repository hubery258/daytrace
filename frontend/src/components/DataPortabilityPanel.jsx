import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { dataApi } from '../api/client';
import { takeDownloadedPackage, subscribeDownloadedPackage } from '../sync/downloadBridge';

const entityLabels = {
  projects: '项目', todos: '待办', schedules: '计划日程', time_block_categories: '时间块属性', time_blocks: '实际时间块', daily_logs: '每日总结',
  log_templates: '日志模板', timer_sessions: '计时会话', recurrence_rules: '重复规则', recurrence_exceptions: '重复规则例外',
};

function fileName(prefix = 'backup') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `daytrace-${prefix}-${stamp}.json`;
}

async function savePackage(pack, prefix = 'backup', shareAfterSave = true) {
  const json = JSON.stringify(pack, null, 2);
  const name = fileName(prefix);
  if (Capacitor.isNativePlatform()) {
    const path = shareAfterSave ? name : `日迹/${name}`;
    const directory = shareAfterSave ? Directory.Cache : Directory.Documents;
    const saved = await Filesystem.writeFile({
      path,
      data: json,
      directory,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    if (shareAfterSave) {
      await Share.share({ title: '导出日迹数据', text: '日迹 JSON 数据包', files: [saved.uri], dialogTitle: '保存或分享数据包' });
    }
    return saved.uri;
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
  return name;
}

export default function DataPortabilityPanel() {
  const inputRef = useRef(null);
  const [pendingPackage, setPendingPackage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mode, setMode] = useState('merge');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState({});
  const [scope, setScope] = useState('all');
  const [linkPreview, setLinkPreview] = useState(null);

  const checkLinks = async () => {
    clearFeedback(); setBusy(true); setLinkPreview(null);
    try { const result=await dataApi.checkScheduleLinks(); setLinkPreview(result); }
    catch(err) {setError(err.message || '检查失败');}
    finally {setBusy(false);}
  };
  const repairLinks = async () => {
    clearFeedback(); setBusy(true);
    try {
      const result=await dataApi.repairScheduleLinks(linkPreview.token);
      setLinkPreview(null); setPreview(null);
      setMessage(`已修复 ${result.repaired} 条计划的失效关联。计划内容和有效关联均保留。修复前记录副本：${result.backup_path || '无需修复'}。现在可以重新上传。`);
    } catch(err) {setLinkPreview(null);setError(err.message || '修复结果未确认，请重新检查');}
    finally {setBusy(false);}
  };

  const clearFeedback = () => { setMessage(''); setError(''); };

  const previewPackage = async (pack, importMode = mode, nextChoices = {}) => {
    const nextPreview = await dataApi.previewImport(pack, importMode, nextChoices);
    setChoices(nextChoices);
    setPendingPackage(pack); setPreview(nextPreview);
  };

  const chooseConflicts = async (nextChoices) => {
    if (!pendingPackage || busy) return;
    setBusy(true); clearFeedback();
    try { await previewPackage(pendingPackage, mode, nextChoices); }
    catch (err) { setPreview(null); setError(err.message || '无法重新预览'); }
    finally { setBusy(false); }
  };

  // WebDAV downloads are handed to this existing preview + confirm flow so a
  // download never writes the local database on its own.
  useEffect(() => {
    const unsubscribe = subscribeDownloadedPackage((incoming) => {
      takeDownloadedPackage();
      clearFeedback();
      setBusy(true);
      (async () => {
        try {
          setMode('merge');
          await previewPackage(incoming.package, 'merge');
          setMessage('已载入远端数据，请在下方预览并确认合并。确认前不会修改本机数据。');
        } catch (err) {
          setError(err.message || '无法预览远端数据包');
        } finally {
          setBusy(false);
        }
      })();
    });
    return unsubscribe;
  }, [mode]);

  const handleExport = async () => {
    clearFeedback(); setBusy(true);
    try {
      const pack = await dataApi.export();
      await savePackage(pack);
      setMessage('数据包已生成，不含 AI Key、ZJU 密码、Cookie、Session、token 或 WebDAV 密码。');
    } catch (err) { setError(err.message || '导出失败'); }
    finally { setBusy(false); }
  };

  const handleFile = async (event) => {
    clearFeedback(); setPreview(null); setPendingPackage(null);
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const pack = JSON.parse(await file.text());
      const nextPreview = await dataApi.previewImport(pack, mode);
      setChoices({});
      setPendingPackage(pack); setPreview(nextPreview);
    } catch (err) { setError(err instanceof SyntaxError ? '文件不是有效 JSON。' : (err.message || '无法预览数据包')); }
    finally { setBusy(false); }
  };

  const handleImport = async () => {
    if (!pendingPackage || !preview || preview.unresolved) return;
    const updated = Object.values(preview.entities).reduce((sum, item) => sum + item.update, 0);
    const created = Object.values(preview.entities).reduce((sum, item) => sum + item.create, 0);
    const confirmation = mode === 'replace'
      ? `确认恢复备份？将新增 ${created} 条、变更 ${updated} 条，并删除 ${preview.delete_total || 0} 条本地数据。执行前会保存并校验本机副本。`
      : '确认按当前预览和冲突选择合并设备数据？完成状态优先保留，时间块只处理选定冲突区间。执行前会保存并校验本机副本。';
    if (!window.confirm(confirmation)) return;
    clearFeedback(); setBusy(true);
    let importStarted = false;
    try {
      let safetyLocation = '';
      importStarted = true;
      const result = await dataApi.import(pendingPackage, mode, choices, preview.token);
      safetyLocation = result.backup_path;
      setMessage(mode === 'replace'
        ? `核心数据恢复完成：新增 ${result.created} 条，更新 ${result.updated} 条，删除 ${result.deleted} 条。恢复前备份：${safetyLocation}`
        : `合并完成：新增 ${result.created} 条，变更 ${result.updated} 条。操作前副本：${safetyLocation}。请将合并结果导入另一设备。`);
      setPendingPackage(null); setPreview(null);
    } catch (err) {
      setError(importStarted
        ? `未能确认导入结果：${err.message || '未知错误'}。请重新读取本机数据并预览；响应丢失时，操作可能已经完成。`
        : (err.message || '导入前检查失败'));
      setPreview(null);
    }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-header">数据导入导出</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.86rem', lineHeight: 1.6 }}>
        合并保留双方独有记录和已完成状态；时间冲突按区间选择，计划整条选择，日志可整理。恢复替换核心数据（含完成状态），删除包外记录，保留本机设置与凭据。两种操作前均保存并校验本机副本。
      </p>
      <p className="notice" style={{fontSize:'0.86rem'}}>合并不传播删除或“取消完成”；另一边仍已完成时，再合并可能恢复完成。结果需再导入另一设备。</p>
      <div className="form-group" style={{ maxWidth: 420 }}>
        <label htmlFor="import-mode">导入模式</label>
        <select
          id="import-mode"
          value={mode}
          disabled={busy}
          onChange={async event => {
            const nextMode = event.target.value;
            setMode(nextMode); setPreview(null); clearFeedback();
            if (!pendingPackage) return;
            setBusy(true);
            try { await previewPackage(pendingPackage, nextMode); }
            catch (err) { setError(err.message || '无法重新预览数据包'); }
            finally { setBusy(false); }
          }}
        >
          <option value="merge">合并设备数据</option>
          <option value="replace">恢复备份（替换核心数据）</option>
        </select>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn btn-secondary" disabled={busy} onClick={handleExport}>导出 JSON</button>
        <button className="btn btn-secondary" disabled={busy} onClick={checkLinks}>检查计划失效关联</button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>选择 JSON 导入</button>
        {pendingPackage && <button className="btn btn-secondary" disabled={busy} onClick={()=>chooseConflicts(choices)}>重新预览</button>}
        <input ref={inputRef} type="file" accept="application/json,.json" onChange={handleFile} style={{ display: 'none' }} />
      </div>
      {linkPreview && <div className="notice" style={{marginTop:12}}>
        <strong>发现 {linkPreview.items.length} 条计划存在失效任务关联</strong>
        {linkPreview.items.map(item=><p key={item.uuid}>{item.name} · {item.start_time.replace('T',' ')} 至 {item.end_time.replace('T',' ')} · 清除 {item.missing_ids.length} 个失效关联，保留 {item.remaining_ids.length} 个有效关联</p>)}
        {!!linkPreview.items.length && <><p>先保存并校验修复前记录，再清除已不存在的任务关联；不删除计划、待办或实际时间，保留有效关联。副本仅用于追溯，不能作为整库备份导入。</p><button className="btn btn-primary" disabled={busy} onClick={repairLinks}>确认清除上述失效关联</button></>}
        <button className="btn btn-secondary" disabled={busy} onClick={()=>setLinkPreview(null)}>关闭检查</button>
      </div>}
      {preview && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: '0.86rem', marginBottom: 8 }}>schema_version：{preview.schema_version}，共 {preview.total} 条</div>
          <div className="data-preview-grid">
            {Object.entries(preview.entities).map(([name, counts]) => (
              <div key={name} className="data-preview-item">
                <strong>{entityLabels[name] || name}</strong>
                <span>新增 {counts.create} · 变更 {counts.update} · 相同跳过 {counts.skip || 0} · 冲突 {counts.conflict || 0}{counts.delete ? ` · 移除/替换 ${counts.delete}` : ''}</span>
              </div>
            ))}
          </div>
          {!!preview.effects?.length && <details style={{marginTop:12}}><summary>时间块影响（{preview.effects.length} 项）</summary>{preview.effects.map((effect,i)=><div key={i} style={{padding:6}}>{effect.kind==='split'?'拆分':effect.kind==='identity'?'同一记录版本选择':'重叠去重/选择'} · {effect.date || ''} {effect.start != null ? `${minuteText(effect.start)}–${minuteText(effect.end)}` : `${rangeText(effect.local)} → ${rangeText(effect.incoming)}`}</div>)}</details>}
          {!!preview.conflicts?.length && <div style={{marginTop:16}}>
            <label>当前冲突范围 <select value={scope} onChange={e=>setScope(e.target.value)} disabled={busy}><option value="all">全部冲突</option>{Object.keys(entityLabels).filter(n=>preview.conflicts.some(c=>c.entity===n)).map(n=><option key={n} value={n}>{entityLabels[n]}</option>)}</select></label>
            <div style={{display:'flex',gap:8,flexWrap:'wrap',margin:'10px 0'}}>{['local','incoming'].map(side=><button key={side} className="btn btn-secondary" disabled={busy} onClick={()=>{
              const next={...choices};
              for (const c of preview.conflicts.filter(c=>!c.resolved && (scope==='all'||scope===c.entity) && !['rename','date','active_timer','links'].includes(c.kind))) next[c.id]={side};
              chooseConflicts(next);
            }}>剩余冲突全部{side==='local'?'保留本机':'使用导入'}</button>)}</div>
            {preview.conflicts.filter(c=>scope==='all'||scope===c.entity).map(c=><ConflictCard key={c.id} conflict={c} busy={busy} onChoose={choice=>chooseConflicts({...choices,[c.id]:choice})} />)}
          </div>}
          {!!preview.unresolved && <div className="notice notice-error">还有 {preview.unresolved} 项冲突未解决。改名、完成日期、活动计时和旧包关联需单独确认。</div>}
          {mode === 'replace' && <div className="notice notice-error" style={{ marginTop: 12 }}>恢复将删除 {preview.delete_total || 0} 条包外核心记录，保留本机设置与凭据。恢复前备份仅存本机。</div>}
          <button className={mode === 'replace' ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy || preview.unresolved > 0} onClick={handleImport} style={{ marginTop: 12 }}>
            {mode === 'replace' ? '确认恢复核心数据' : '确认合并导入'}
          </button>
        </div>
      )}
      {busy && <div style={{ marginTop: 10, color: 'var(--text-secondary)' }}>正在处理…</div>}
      {message && <div style={{ marginTop: 10, color: 'var(--success)', lineHeight: 1.5 }}>{message}</div>}
      {error && <div style={{ marginTop: 10, color: 'var(--danger)', lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

function minuteText(value) { return value == null ? '' : `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`; }
function rangeText(ranges) { return (Array.isArray(ranges?.[0])?ranges:[ranges]).filter(Boolean).map(([date,start,end])=>`${date} ${minuteText(start)}–${minuteText(end)}`).join('；'); }
const fieldLabels={name:'名称',notes:'备注',log_text:'日志正文',record:'完整记录',interval:'冲突区间',completed_at:'完成日期',ddl_date:'DDL',ddl_type:'DDL 类型',project_uuid:'所属项目',recurrence_rule_uuid:'重复规则',position:'排序',reminder_days:'提醒天数',category:'分类',status:'状态',waiting_reply_person:'等待答复人',recurrence_date:'重复日期',is_recurrence_exception:'重复例外',description:'说明',color:'颜色',archived_at:'归档时间',entity_type:'类型',template_json:'重复模板',frequency:'频率',start_date:'开始日期',end_date:'结束日期',weekdays:'星期',month_day:'每月日期',action:'例外操作',start_time:'开始时间',end_time:'结束时间',nature:'性质',relax_suggestion:'休息建议',location:'地点',is_planned:'计划',template_linked_todo_uuids:'重复计划关联任务',linked_todo_uuids:'关联任务',block_date:'记录日期',start_minute:'开始',end_minute:'结束',granularity:'粒度',category_uuid:'属性',source:'来源',coverage_seconds:'有效秒数',linked_todo_uuid:'关联任务',manual_project_uuid:'项目',source_timer_uuid:'来源计时',content:'正文',started_at:'开始时间',last_resumed_at:'上次继续',paused_at:'暂停时间',paused_seconds:'暂停秒数',active_intervals:'活动区间',ended_at:'结束时间',created_schedule_uuid:'关联日程',is_parked:'暂存暂停',is_completed:'已完成',log_date:'日志日期',completed_todo_uuids:'完成任务'};
function showValue(value) {
  if (value == null || value === '') return '（空白）';
  if (typeof value==='boolean') return value?'是':'否';
  if (Array.isArray(value)) return value.map(showValue).join('\n');
  if (typeof value==='object') return Object.entries(value).filter(([k])=>!['uuid','origin_uuid','created_at','updated_at'].includes(k)).map(([k,v])=>`${fieldLabels[k]||k}：${showValue(v)}`).join('\n');
  return String(value);
}
function ConflictCard({conflict:c,busy,onChoose}) {
  const [text,setText]=useState(c.choice?.side==='edit'?c.choice.value:String(c.local??''));
  const [links,setLinks]=useState(c.choice?.side==='links'?c.choice.value:[]);
  return <div className="card" style={{padding:12,margin:'10px 0'}}>
    <strong>{entityLabels[c.entity]} · {fieldLabels[c.field]||c.field} {c.resolved?'✓ 已选择':'· 待选择'}</strong>
    <div style={{display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:12,marginTop:8}}>{[['local','本机',c.local],['incoming','导入',c.incoming]].map(([side,label,value])=><div key={side}><strong>{label}</strong><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontFamily:'inherit',fontSize:'0.85rem'}}>{showValue(value)}</pre>{!['rename','date','active_timer','links'].includes(c.kind)&&<button className="btn btn-secondary" disabled={busy} onClick={()=>onChoose({side})}>{side==='local'?'保留本机':'使用导入'}</button>}</div>)}</div>
    {c.kind==='links' && <div><p>旧包只有源设备的任务编号，请重新选择关联任务。也可以明确确认无关联。</p>{c.options.map(r=><label key={r.uuid} style={{display:'block'}}><input type="checkbox" checked={links.includes(r.uuid)} disabled={busy} onChange={e=>setLinks(e.target.checked?[...links,r.uuid]:links.filter(v=>v!==r.uuid))}/>{r.name}</label>)}<button className="btn btn-secondary" disabled={busy} onClick={()=>onChoose({side:'links',value:links})}>确认关联选择{links.length===0?'（无关联）':''}</button></div>}
    {c.kind==='active_timer' && <><p>选择当前计时；其余记录保留为暂存暂停，可在计时页继续。</p>{c.options.map(r=><button key={r.uuid} className="btn btn-secondary" disabled={busy} onClick={()=>onChoose({side:'select',value:r.uuid,paused_at:new Date().toISOString()})}>{r.name}</button>)}</>}
    {(['notes','log_text'].includes(c.field)||['rename','date'].includes(c.kind))&&<div style={{marginTop:10}}>
      {c.field==='log_text'&&<button className="btn btn-secondary" disabled={busy} onClick={()=>setText(`${c.local}\n\n${c.incoming}`)}>把两份放入编辑框整理</button>}
      <label>{c.kind==='rename'?'导入属性同名，请改名（保留两项属性）':c.kind==='date'?'指定完成日期':'手动整理后确认'}{c.kind==='date'?<input type="date" value={text} onChange={e=>setText(e.target.value)}/>:<textarea value={text} onChange={e=>setText(e.target.value)} rows={4}/>}</label>
      <button className="btn btn-secondary" disabled={busy || (['rename','date'].includes(c.kind)&&!text.trim())} onClick={()=>onChoose({side:'edit',value:text})}>确认整理结果</button>
    </div>}
  </div>;
}
