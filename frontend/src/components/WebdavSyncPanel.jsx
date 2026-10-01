import { useCallback, useEffect, useRef, useState } from 'react';

import { publishDownloadedPackage } from '../sync/downloadBridge.js';
import syncAdapter from '../sync/syncAdapter.js';
import {
  WEBDAV_AUTO_SYNC_TEASER,
  WEBDAV_INSECURE_WARNING,
  WEBDAV_REMEMBER_HINT,
  applyConfigToForm,
  buildDownloadSummaryView,
  buildUploadConfirmView,
  describeSyncError,
  emptyWebdavForm,
  formatSyncTime,
  syncStatusView,
  validateBaseUrl,
  validateWebdavForm,
} from '../sync/webdavPresentation.js';

const UPLOAD_STEPS = ['正在导出本机数据', '正在连接 WebDAV', '正在上传', '正在校验远端文件'];

function SyncModal({ title, onClose, children, footer }) {
  const dialogRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const restore = restoreRef.current;
      if (restore && typeof restore.focus === 'function') restore.focus();
    };
  }, [onClose]);

  return (
    <div className="sync-modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="sync-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <div className="sync-modal-header">
          <h3>{title}</h3>
          <button type="button" className="btn btn-quiet sync-modal-close" aria-label="关闭弹窗" onClick={onClose}>×</button>
        </div>
        <div className="sync-modal-body">{children}</div>
        <div className="sync-modal-footer">{footer}</div>
      </div>
    </div>
  );
}

function SummaryRows({ rows }) {
  return (
    <dl className="sync-summary">
      {rows.map(row => (
        <div key={row.key} className="sync-summary-row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CheckList({ checks, unknown = [] }) {
  const labels = [
    ['reachable', '服务器可达'],
    ['authenticated', '认证成功'],
    ['directory_exists', '目录存在'],
    ['directory_writable', '目录可写'],
  ];
  return (
    <ul className="sync-check-list">
      {labels.map(([key, label]) => {
        const pending = unknown.includes(key);
        const ok = checks?.[key] === true;
        return (
          <li key={key} className={pending ? 'sync-check-unknown' : (ok ? 'sync-check-ok' : 'sync-check-fail')}>
            <span aria-hidden="true">{pending ? '?' : (ok ? '✓' : '✗')}</span>
            <span>{label}</span>
            <span className="sync-check-state">{pending ? '未确认' : (ok ? '通过' : '未通过')}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function WebdavSyncPanel() {
  const [form, setForm] = useState(() => emptyWebdavForm());
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [testState, setTestState] = useState({ state: 'idle', result: null, error: null });
  const [message, setMessage] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyStep, setBusyStep] = useState('');
  const [uploadDialog, setUploadDialog] = useState(null);
  const [downloadDialog, setDownloadDialog] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);

  const reportError = useCallback((rawError) => {
    setError(describeSyncError(rawError));
    setMessage('');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextStatus] = await Promise.all([syncAdapter.getConfig(), syncAdapter.getStatus()]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setForm(previous => applyConfigToForm(nextConfig, previous));
    } catch (rawError) {
      setStatus(null);
      if (rawError?.code !== 'NOT_FOUND') reportError(rawError);
    }
  }, [reportError]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const restored = await syncAdapter.restoreRememberedPassword();
        if (cancelled) return;
        setConfig(restored.config);
      } catch {
        // A failed restore only means the user has to type the password again.
      }
      if (!cancelled) await refresh();
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  const updateForm = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

  const confirmInsecureHttp = () => {
    const url = validateBaseUrl(form.base_url);
    if (!url.valid || url.isHttps) return true;
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
    return window.confirm(`${WEBDAV_INSECURE_WARNING}\n\n确认继续使用 HTTP 吗？`);
  };

  const handleUrlBlur = () => {
    const result = validateBaseUrl(form.base_url);
    if (!result.valid) {
      setFormErrors(previous => ({ ...previous, base_url: result.error }));
      return;
    }
    setFormErrors(previous => ({ ...previous, base_url: undefined }));
    if (!result.isHttps) setMessage(result.warning);
  };

  const usesPlainHttp = () => String(form.base_url ?? '').trim().toLowerCase().startsWith('http://');

  const handleTest = async () => {
    const validation = validateWebdavForm({ ...form, has_password: form.has_password || config?.has_password });
    setFormErrors(validation.errors);
    if (!validation.valid) {
      reportError({ code: 'WEBDAV_URL_INVALID', message: validation.firstError });
      return;
    }
    if (!confirmInsecureHttp()) return;
    setBusy(true); setBusyStep('正在测试连接'); setError(null); setMessage('');
    setTestState({ state: 'testing', result: null, error: null });
    try {
      const result = await syncAdapter.testConnection({ ...form, allow_insecure_http: usesPlainHttp() });
      setTestState({ state: result.ok ? 'success' : 'failed', result, error: null });
      if (!result.ok) reportError({ code: result.code, message: result.message });
      else setMessage(result.message);
    } catch (rawError) {
      setTestState({ state: 'failed', result: null, error: rawError });
      reportError(rawError);
    } finally {
      setBusy(false); setBusyStep('');
    }
  };

  const handleSave = async () => {
    const validation = validateWebdavForm({ ...form, has_password: form.has_password || config?.has_password });
    setFormErrors(validation.errors);
    if (!validation.valid) {
      reportError({ code: 'WEBDAV_URL_INVALID', message: validation.firstError });
      return;
    }
    if (!confirmInsecureHttp()) return;
    setBusy(true); setBusyStep('正在保存配置'); setError(null); setMessage('');
    try {
      const saved = await syncAdapter.saveConfig({ ...form, allow_insecure_http: usesPlainHttp() });
      setConfig(saved);
      setForm(previous => applyConfigToForm(saved, previous));
      setMessage('WebDAV 配置已保存。密码只保存在本机数据库，不会写入 JSON 数据包。');
      await refresh();
    } catch (rawError) {
      reportError(rawError);
    } finally {
      setBusy(false); setBusyStep('');
    }
  };

  const handleUploadClick = async () => {
    setBusy(true); setBusyStep('正在导出本机数据'); setError(null); setMessage(''); setUploadResult(null);
    try {
      const preflight = await syncAdapter.preflightUpload();
      setUploadDialog({ view: buildUploadConfirmView(preflight), preflight });
    } catch (rawError) {
      reportError(rawError);
    } finally {
      setBusy(false); setBusyStep('');
    }
  };

  const handleUploadConfirm = async () => {
    if (!uploadDialog) return;
    setBusy(true); setError(null);
    try {
      for (const step of UPLOAD_STEPS) {
        setBusyStep(step);
        // Yield so the progress text is visible even on a fast local server.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const result = await syncAdapter.uploadLatest({
        confirmed: true,
        expectedRemoteEtag: uploadDialog.view.expectedRemoteEtag,
        expectedRemoteExists: uploadDialog.view.expectedRemoteExists,
      });
      setUploadDialog(null);
      setUploadResult(result);
      setMessage(`上传成功：${result.path}`);
      await refresh();
    } catch (rawError) {
      setUploadDialog(null);
      reportError(rawError);
      await refresh();
    } finally {
      setBusy(false); setBusyStep('');
    }
  };

  const handleDownloadClick = async () => {
    setBusy(true); setBusyStep('正在读取远端文件'); setError(null); setMessage('');
    try {
      const result = await syncAdapter.downloadLatest();
      setDownloadDialog({ view: buildDownloadSummaryView(result), result });
    } catch (rawError) {
      reportError(rawError);
      await refresh();
    } finally {
      setBusy(false); setBusyStep('');
    }
  };

  const handleDownloadContinue = () => {
    if (!downloadDialog) return;
    publishDownloadedPackage(downloadDialog.result.package, {
      remote: downloadDialog.result.remote,
      downloadedAt: downloadDialog.result.downloaded_at,
    });
    setDownloadDialog(null);
    setMessage('已把远端数据包交给现有导入预览流程，请在 03 本地数据 中确认合并导入。下载没有直接修改本机数据库。');
    if (typeof document !== 'undefined') {
      document.getElementById('local-data-section')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
    refresh().catch(() => {});
  };

  const statusView = syncStatusView(status, config);
  const configured = Boolean(config?.base_url && config?.username && (config?.has_password || form.password));
  const syncBusy = busy || Boolean(status?.busy);
  const testResult = testState.result;

  return (
    <div className="card webdav-panel">
      <div className="card-header">连接配置</div>
      <p className="webdav-intro">
        使用你自己的 WebDAV 服务器保存和获取日迹数据文件。同步不经过日迹开发者的服务器，
        密码只保存在本机数据库，不会写入导出的 JSON 数据包；取消“记住密码”后仅保留当前会话。
      </p>

      <form className="webdav-form" onSubmit={event => { event.preventDefault(); handleSave(); }}>
        <div className="form-group">
          <label htmlFor="webdav-base-url">服务器地址</label>
          <input
            id="webdav-base-url"
            value={form.base_url}
            placeholder="https://dav.example.com/remote.php/dav/files/username/"
            aria-invalid={formErrors.base_url ? 'true' : 'false'}
            aria-describedby={formErrors.base_url ? 'webdav-base-url-error' : undefined}
            onBlur={handleUrlBlur}
            onChange={event => updateForm('base_url', event.target.value)}
          />
          {formErrors.base_url && <div id="webdav-base-url-error" role="alert" className="field-error">{formErrors.base_url}</div>}
          {!formErrors.base_url && form.base_url && !validateBaseUrl(form.base_url).isHttps && (
            <div className="field-hint field-hint-warning">{WEBDAV_INSECURE_WARNING} 测试或保存前会再次确认。</div>
          )}
        </div>

        <div className="settings-form-grid">
          <div className="form-group">
            <label htmlFor="webdav-username">用户名</label>
            <input id="webdav-username" value={form.username} autoComplete="username"
              onChange={event => updateForm('username', event.target.value)} />
            {formErrors.username && <div role="alert" className="field-error">{formErrors.username}</div>}
          </div>
          <div className="form-group">
            <label htmlFor="webdav-password">密码或应用密码</label>
            <div className="sync-password-field">
              <input
                id="webdav-password"
                type={form.show_password ? 'text' : 'password'}
                value={form.password}
                autoComplete="current-password"
                placeholder={config?.has_password && !form.password ? '已保存，留空表示沿用' : ''}
                onChange={event => updateForm('password', event.target.value)}
              />
              <button
                type="button"
                className="btn btn-quiet sync-password-toggle"
                aria-label={form.show_password ? '隐藏密码' : '显示密码'}
                aria-pressed={form.show_password}
                onClick={() => updateForm('show_password', !form.show_password)}
              >
                {form.show_password ? '隐藏' : '显示'}
              </button>
            </div>
            {formErrors.password && <div role="alert" className="field-error">{formErrors.password}</div>}
            <div className="field-hint">建议使用应用密码，不要直接使用主账号密码。</div>
          </div>
        </div>

        <div className="form-group">
          <label className="setting-toggle-row webdav-remember-row">
            <span><strong>记住密码</strong><small>{WEBDAV_REMEMBER_HINT}</small></span>
            <input type="checkbox" checked={form.remember_password} onChange={event => updateForm('remember_password', event.target.checked)} />
            <span className="switch-control" aria-hidden="true"><i /></span>
          </label>
        </div>

        <div className="settings-form-grid">
          <div className="form-group">
            <label htmlFor="webdav-remote-directory">远程目录</label>
            <input id="webdav-remote-directory" value={form.remote_directory}
              onChange={event => updateForm('remote_directory', event.target.value)} />
            {formErrors.remote_directory && <div role="alert" className="field-error">{formErrors.remote_directory}</div>}
          </div>
          <div className="form-group">
            <button type="button" className="btn btn-quiet webdav-advanced-toggle" aria-expanded={form.show_advanced}
              onClick={() => updateForm('show_advanced', !form.show_advanced)}>
              {form.show_advanced ? '收起高级选项' : '展开高级选项'}
            </button>
            {form.show_advanced && (
              <div className="form-group webdav-advanced-field">
                <label htmlFor="webdav-remote-filename">远程文件名</label>
                <input id="webdav-remote-filename" value={form.remote_filename}
                  onChange={event => updateForm('remote_filename', event.target.value)} />
                {formErrors.remote_filename && <div role="alert" className="field-error">{formErrors.remote_filename}</div>}
                <div className="field-hint">默认 daytrace-latest.json，远端只保留这一份文件。</div>
              </div>
            )}
          </div>
        </div>

        <div className="settings-form-actions webdav-form-actions">
          <button type="button" className="btn btn-secondary" disabled={syncBusy} onClick={handleTest}>测试连接</button>
          <button type="submit" className="btn btn-primary" disabled={syncBusy}>保存配置</button>
          {busy && <span className="webdav-busy" role="status">{busyStep || '正在处理…'}</span>}
        </div>
      </form>

      {testState.state !== 'idle' && (
        <div className="webdav-test-result" role="status">
          <strong>
            {testState.state === 'testing' && '正在测试连接…'}
            {testState.state === 'success' && '连接成功'}
            {testState.state === 'failed' && '连接失败'}
          </strong>
          {testResult && <CheckList checks={testResult.checks} unknown={testResult.unknown} />}
          {testResult?.notes?.length > 0 && (
            <ul className="webdav-notes">{testResult.notes.map(note => <li key={note}>{note}</li>)}</ul>
          )}
          {testResult?.message && <p className="webdav-test-message">{testResult.message}</p>}
        </div>
      )}

      <div className="card-header webdav-section-title">手动操作</div>
      {!configured && <p className="field-hint">请先保存 WebDAV 配置，然后才能上传或下载。</p>}
      <div className="webdav-actions">
        <button className="btn btn-secondary" disabled={!configured || syncBusy || testState.state === 'failed'} onClick={handleUploadClick}>上传本机数据</button>
        <button className="btn btn-secondary" disabled={!configured || syncBusy || testState.state === 'failed'} onClick={handleDownloadClick}>下载远端数据</button>
      </div>
      <p className="field-hint">
        v0.11.x 只有手动上传和手动下载。上传前会展示本机与远端信息并等待确认；下载只进入现有导入预览，不会自动合并。
      </p>

      {uploadResult && (
        <div className="webdav-upload-result" role="status">
          <strong>上传成功</strong>
          <SummaryRows rows={[
            { key: 'path', label: '远端文件路径', value: uploadResult.path },
            { key: 'uploaded_at', label: '上传时间', value: formatSyncTime(uploadResult.uploaded_at) },
            { key: 'etag', label: '远端 ETag', value: uploadResult.etag || '未提供' },
            { key: 'content_length', label: '文件大小', value: `${uploadResult.content_length ?? 0} B` },
          ]} />
        </div>
      )}

      <div className="card-header webdav-section-title">同步状态</div>
      <SummaryRows rows={statusView.rows} />

      <div className="notice webdav-teaser" aria-label="v0.11.1 预告">
        <strong>v0.11.1 预告</strong>
        <p>{WEBDAV_AUTO_SYNC_TEASER}</p>
      </div>

      {message && <div className="webdav-message" role="status">{message}</div>}
      {error && (
        <div className="notice notice-error webdav-error" role="alert">
          <strong>{error.message}</strong>
          {error.hint && <p>{error.hint}</p>}
          {error.code && <p className="webdav-error-code">错误码：{error.code}</p>}
        </div>
      )}

      {uploadDialog && (
        <SyncModal
          title={uploadDialog.view.title}
          onClose={() => setUploadDialog(null)}
          footer={(
            <>
              <button className="btn btn-quiet" disabled={busy} onClick={() => setUploadDialog(null)}>{uploadDialog.view.cancelLabel}</button>
              <button className="btn btn-primary" disabled={busy} onClick={handleUploadConfirm}>{uploadDialog.view.confirmLabel}</button>
            </>
          )}
        >
          <SummaryRows rows={uploadDialog.view.rows} />
          <div className="notice notice-error">
            {uploadDialog.view.warnings.map(text => <p key={text}>{text}</p>)}
          </div>
          {busy && <p className="webdav-busy" role="status">{busyStep || '正在上传…'}</p>}
        </SyncModal>
      )}

      {downloadDialog && (
        <SyncModal
          title={downloadDialog.view.title}
          onClose={() => setDownloadDialog(null)}
          footer={(
            <>
              <button className="btn btn-quiet" onClick={() => setDownloadDialog(null)}>{downloadDialog.view.cancelLabel}</button>
              <button className="btn btn-primary" onClick={handleDownloadContinue}>{downloadDialog.view.confirmLabel}</button>
            </>
          )}
        >
          <SummaryRows rows={downloadDialog.view.rows} />
          {downloadDialog.view.entityRows.length > 0 && (
            <div className="data-preview-grid">
              {downloadDialog.view.entityRows.map(item => (
                <div key={item.key} className="data-preview-item">
                  <strong>{item.label}</strong>
                  <span>{item.count} 条</span>
                </div>
              ))}
            </div>
          )}
          <div className="notice">{downloadDialog.view.notice}</div>
        </SyncModal>
      )}
    </div>
  );
}
