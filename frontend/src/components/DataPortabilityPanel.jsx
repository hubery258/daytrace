import { useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { dataApi } from '../api/client';

const entityLabels = {
  projects: '项目', todos: '待办', schedules: '计划日程', time_block_categories: '时间块属性', time_blocks: '实际时间块', daily_logs: '每日总结',
  log_templates: '日志模板', timer_sessions: '计时会话', recurrence_rules: '重复规则',
};

function fileName(prefix = 'backup') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `riji-${prefix}-${stamp}.json`;
}

async function savePackage(pack, prefix = 'backup', shareAfterSave = true, verifyWrite = false) {
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
    if (verifyWrite) {
      const readBack = await Filesystem.readFile({ path, directory, encoding: Encoding.UTF8 });
      if (typeof readBack.data !== 'string' || readBack.data !== json) {
        throw new Error('恢复前安全备份写入后校验失败');
      }
      try {
        const verified = JSON.parse(readBack.data);
        if (verified.schema_version !== pack.schema_version || verified.package_uuid !== pack.package_uuid) {
          throw new Error('backup identity mismatch');
        }
      } catch {
        throw new Error('恢复前安全备份不是可读取的完整 JSON 数据包');
      }
    }
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

  const clearFeedback = () => { setMessage(''); setError(''); };

  const handleExport = async () => {
    clearFeedback(); setBusy(true);
    try {
      const pack = await dataApi.export();
      await savePackage(pack);
      setMessage('数据包已生成。导出不包含 AI API Key、ZJU 密码、Cookie、Session 或 token。');
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
      setPendingPackage(pack); setPreview(nextPreview);
    } catch (err) { setError(err instanceof SyntaxError ? '文件不是有效 JSON。' : (err.message || '无法预览数据包')); }
    finally { setBusy(false); }
  };

  const handleImport = async () => {
    if (!pendingPackage || !preview) return;
    const updated = Object.values(preview.entities).reduce((sum, item) => sum + item.update, 0);
    const confirmation = mode === 'replace'
      ? `确认完整恢复？将新增 ${preview.total - updated} 条、覆盖 ${updated} 条，并删除 ${preview.delete_total || 0} 条本地数据。恢复前会先自动保存当前数据。`
      : '确认合并导入？相同 UUID 的实体以数据包为准；导入时间块会覆盖同日期重叠的本地时间块，其余包外数据保留。';
    if (!window.confirm(confirmation)) return;
    clearFeedback(); setBusy(true);
    let importStarted = false;
    try {
      let safetyLocation = '';
      if (mode === 'replace') {
        try {
          safetyLocation = await savePackage(await dataApi.export(), 'before-restore', false, true);
        } catch (backupError) {
          throw new Error(`恢复前安全备份写入或校验失败，未执行恢复：${backupError.message || '未知错误'}`);
        }
      }
      importStarted = true;
      const result = await dataApi.import(pendingPackage, mode);
      setMessage(mode === 'replace'
        ? `完整恢复完成：新增 ${result.created} 条，更新 ${result.updated} 条，删除 ${result.deleted} 条。恢复前备份：${safetyLocation}`
        : `导入完成：新增 ${result.created} 条，更新 ${result.updated} 条。刷新页面后可查看全部数据。`);
      setPendingPackage(null); setPreview(null);
    } catch (err) { setError(importStarted ? `导入失败，数据库已回滚且未删除本地数据：${err.message || '未知错误'}` : (err.message || '导入前检查失败')); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-header">数据导入导出</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.86rem', lineHeight: 1.6 }}>
        JSON 数据包覆盖项目、待办、计划日程、实际时间块及属性、每日总结、日志模板、计时会话和重复规则。旧版实际日程会在导入时跳过。合并导入会覆盖同日期重叠的本地时间块，并保留其他包外数据；完整恢复会先在本机保存当前数据，再将核心数据替换为数据包内容。
      </p>
      <div className="form-group" style={{ maxWidth: 420 }}>
        <label htmlFor="import-mode">导入模式</label>
        <select
          id="import-mode"
          value={mode}
          disabled={busy}
          onChange={event => { setMode(event.target.value); setPendingPackage(null); setPreview(null); clearFeedback(); }}
        >
          <option value="merge">合并导入（不删除本地数据）</option>
          <option value="replace">完整恢复（删除数据包中不存在的数据）</option>
        </select>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn btn-secondary" disabled={busy} onClick={handleExport}>导出 JSON</button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>选择 JSON 导入</button>
        <input ref={inputRef} type="file" accept="application/json,.json" onChange={handleFile} style={{ display: 'none' }} />
      </div>
      {preview && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: '0.86rem', marginBottom: 8 }}>schema_version：{preview.schema_version}，共 {preview.total} 条</div>
          <div className="data-preview-grid">
            {Object.entries(preview.entities).map(([name, counts]) => (
              <div key={name} className="data-preview-item">
                <strong>{entityLabels[name] || name}</strong>
                <span>新增 {counts.create} · 更新 {counts.update}{mode === 'replace' ? ` · 删除 ${counts.delete}` : ''}</span>
              </div>
            ))}
          </div>
          {mode === 'replace' && <div className="notice notice-error" style={{ marginTop: 12 }}>完整恢复将删除共 {preview.delete_total || 0} 条包外数据。恢复前备份只会保存到本机。</div>}
          <button className={mode === 'replace' ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy} onClick={handleImport} style={{ marginTop: 12 }}>
            {mode === 'replace' ? '确认完整恢复' : '确认合并导入'}
          </button>
        </div>
      )}
      {busy && <div style={{ marginTop: 10, color: 'var(--text-secondary)' }}>正在处理…</div>}
      {message && <div style={{ marginTop: 10, color: 'var(--success)', lineHeight: 1.5 }}>{message}</div>}
      {error && <div style={{ marginTop: 10, color: 'var(--danger)', lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}
