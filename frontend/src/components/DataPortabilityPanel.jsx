import { useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { dataApi } from '../api/client';

const entityLabels = {
  projects: '项目', todos: '待办', schedules: '日程', daily_logs: '每日总结',
  log_templates: '日志模板', timer_sessions: '计时会话', recurrence_rules: '重复规则',
};

function fileName() {
  return `riji-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

export default function DataPortabilityPanel() {
  const inputRef = useRef(null);
  const [pendingPackage, setPendingPackage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const clearFeedback = () => { setMessage(''); setError(''); };

  const handleExport = async () => {
    clearFeedback(); setBusy(true);
    try {
      const pack = await dataApi.export();
      const json = JSON.stringify(pack, null, 2);
      const name = fileName();
      if (Capacitor.isNativePlatform()) {
        const saved = await Filesystem.writeFile({ path: name, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
        await Share.share({ title: '导出日迹数据', text: '日迹 JSON 数据包', files: [saved.uri], dialogTitle: '保存或分享数据包' });
      } else {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = name; anchor.click();
        URL.revokeObjectURL(url);
      }
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
      const nextPreview = await dataApi.previewImport(pack);
      setPendingPackage(pack); setPreview(nextPreview);
    } catch (err) { setError(err instanceof SyntaxError ? '文件不是有效 JSON。' : (err.message || '无法预览数据包')); }
    finally { setBusy(false); }
  };

  const handleImport = async () => {
    if (!pendingPackage || !preview) return;
    if (!window.confirm('确认合并导入？相同 UUID 的本地实体会被数据包内容覆盖；未出现在包中的本地数据会保留。')) return;
    clearFeedback(); setBusy(true);
    try {
      const result = await dataApi.import(pendingPackage);
      setMessage(`导入完成：新增 ${result.created} 条，更新 ${result.updated} 条。刷新页面后可查看全部数据。`);
      setPendingPackage(null); setPreview(null);
    } catch (err) { setError(`导入失败，数据库已回滚且未删除本地数据：${err.message || '未知错误'}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="card-header">数据导入导出</div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.86rem', lineHeight: 1.6 }}>
        JSON 数据包覆盖项目、待办、日程、每日总结、日志模板、计时会话和重复规则。当前仅支持合并导入：以 UUID 为准，导入包内容优先，未出现在包中的本地数据不会删除。
      </p>
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
                <span>新增 {counts.create} · 更新 {counts.update}</span>
              </div>
            ))}
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={handleImport} style={{ marginTop: 12 }}>确认合并导入</button>
        </div>
      )}
      {busy && <div style={{ marginTop: 10, color: 'var(--text-secondary)' }}>正在处理…</div>}
      {message && <div style={{ marginTop: 10, color: 'var(--success)', lineHeight: 1.5 }}>{message}</div>}
      {error && <div style={{ marginTop: 10, color: 'var(--danger)', lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}
