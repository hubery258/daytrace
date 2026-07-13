import { useEffect, useState } from 'react';
import { zjuApi } from '../api/client';

const STORAGE_KEY_API_KEY = 'simpletasker_api_key';
const STORAGE_KEY_API_BASE = 'simpletasker_api_base';
const STORAGE_KEY_MODEL = 'simpletasker_ai_model';
const STORAGE_KEY_PROMPT = 'simpletasker_ai_prompt';

const DEFAULT_API_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

const DEFAULT_PROMPT = `你是一位专业的个人效率助手，你的任务是帮助用户分析每日的时间管理情况并提供改进建议。

## 你的职责
1. 阅读用户提供的今日待办完成情况和日程执行情况
2. 分析用户的效率表现，指出亮点和不足
3. 针对不足之处给出具体的改进建议
4. 根据用户明天的日程和待办，给出合理的明日安排建议

## 注意事项
- 保持语气温和、鼓励，像一位关心朋友成长的导师
- 分析要具体，引用实际数据（如完成了几个待办、日程执行率等）
- 建议要可操作，不要太空泛
- 如果用户某天表现不佳，不要批评，而是帮助用户找到原因
- 回复长度控制在 300-500 字`;

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saved, setSaved] = useState(false);

  const [zjuUsername, setZjuUsername] = useState('');
  const [zjuPassword, setZjuPassword] = useState('');
  const [pintiaCookie, setPintiaCookie] = useState('');
  const [includePintia, setIncludePintia] = useState(true);
  const [savePassword, setSavePassword] = useState(false);
  const [savePintiaCookie, setSavePintiaCookie] = useState(false);
  const [defaultReminderDays, setDefaultReminderDays] = useState(1);
  const [credentialState, setCredentialState] = useState(null);
  const [previewItems, setPreviewItems] = useState([]);
  const [zjuErrors, setZjuErrors] = useState([]);
  const [zjuMessage, setZjuMessage] = useState('');
  const [zjuBusy, setZjuBusy] = useState(false);

  useEffect(() => {
    setApiKey(localStorage.getItem(STORAGE_KEY_API_KEY) || '');
    setApiBase(localStorage.getItem(STORAGE_KEY_API_BASE) || DEFAULT_API_BASE);
    setModel(localStorage.getItem(STORAGE_KEY_MODEL) || DEFAULT_MODEL);
    setPrompt(localStorage.getItem(STORAGE_KEY_PROMPT) || DEFAULT_PROMPT);

    zjuApi.getCredentials()
      .then((data) => {
        setCredentialState(data);
        setZjuUsername(data.username || '');
        setSavePassword(Boolean(data.save_password));
        setSavePintiaCookie(Boolean(data.save_pintia_cookie));
        setDefaultReminderDays(data.default_reminder_days ?? 1);
      })
      .catch((err) => setZjuMessage(`读取 ZJU 凭据状态失败：${err.message}`));
  }, []);

  const normalizedApiBase = () => (apiBase.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
  const normalizedModel = () => model.trim() || DEFAULT_MODEL;

  const handleSave = () => {
    localStorage.setItem(STORAGE_KEY_API_KEY, apiKey.trim());
    localStorage.setItem(STORAGE_KEY_API_BASE, normalizedApiBase());
    localStorage.setItem(STORAGE_KEY_MODEL, normalizedModel());
    localStorage.setItem(STORAGE_KEY_PROMPT, prompt);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleResetPrompt = () => {
    setPrompt(DEFAULT_PROMPT);
  };

  const zjuPayload = (saveCredentials = false) => ({
    username: zjuUsername.trim(),
    password: zjuPassword,
    pintia_cookie: pintiaCookie,
    include_pintia: includePintia,
    save_credentials: saveCredentials,
    save_password: savePassword,
    save_pintia_cookie: savePintiaCookie,
    default_reminder_days: Number(defaultReminderDays) || 0,
  });

  const runZjuAction = async (action) => {
    setZjuBusy(true);
    setZjuMessage('');
    setZjuErrors([]);
    try {
      await action();
    } catch (err) {
      setZjuMessage(err.message);
    } finally {
      setZjuBusy(false);
    }
  };

  const refreshCredentialState = async () => {
    const data = await zjuApi.getCredentials();
    setCredentialState(data);
    setZjuUsername(data.username || '');
    setSavePassword(Boolean(data.save_password));
    setSavePintiaCookie(Boolean(data.save_pintia_cookie));
    setDefaultReminderDays(data.default_reminder_days ?? 1);
  };

  const handleSaveZjuCredentials = () => runZjuAction(async () => {
    const data = await zjuApi.saveCredentials({
      username: zjuUsername.trim(),
      password: zjuPassword,
      pintia_cookie: pintiaCookie,
      save_password: savePassword,
      save_pintia_cookie: savePintiaCookie,
      default_reminder_days: Number(defaultReminderDays) || 0,
    });
    setCredentialState(data);
    setZjuPassword('');
    setPintiaCookie('');
    setZjuMessage('ZJU 凭据设置已保存');
  });

  const handleClearPassword = () => runZjuAction(async () => {
    const data = await zjuApi.clearPassword();
    setCredentialState(data);
    setSavePassword(false);
    setZjuPassword('');
    setZjuMessage('已清除本地保存的 ZJU 密码');
  });

  const handleClearPintia = () => runZjuAction(async () => {
    const data = await zjuApi.clearPintiaCookie();
    setCredentialState(data);
    setSavePintiaCookie(false);
    setPintiaCookie('');
    setZjuMessage('已清除本地保存的 Pintia Cookie');
  });

  const handlePreview = () => runZjuAction(async () => {
    const data = await zjuApi.preview(zjuPayload(false));
    const items = data.items || [];
    const errors = data.errors || [];
    const hasPintiaItem = items.some((item) => item.source === 'pintia');
    const hasPintiaError = errors.some((error) => error.toLowerCase().includes('pintia'));
    const pintiaStatus = includePintia && !hasPintiaItem && !hasPintiaError
      ? '；Pintia 已连接，但暂无未截止题集'
      : '';

    setPreviewItems(items);
    setZjuErrors(errors);
    setZjuMessage(`预览完成：${items.length} 个任务${pintiaStatus}`);
    await refreshCredentialState();
  });

  const handleImport = () => runZjuAction(async () => {
    const importable = previewItems.filter((item) => item.action === 'create');
    if (importable.length === 0) {
      setZjuMessage('没有可导入的新任务');
      return;
    }
    const data = await zjuApi.importTodos({
      items: importable,
      reminder_days: Number(defaultReminderDays) || 0,
    });
    setZjuMessage(`导入完成：新增 ${data.created_count} 个，跳过 ${data.skipped_count} 个`);
    setPreviewItems((items) => items.map((item) => (
      item.action === 'create' ? { ...item, action: 'exists', reason: '已导入' } : item
    )));
  });

  const handleUndo = () => runZjuAction(async () => {
    const data = await zjuApi.undoLast();
    if (!data.batch_id) {
      setZjuMessage('没有可撤销的 ZJU 导入批次');
      return;
    }
    setZjuMessage(`撤销完成：删除 ${data.deleted_count} 个，跳过 ${data.skipped_count} 个`);
    setPreviewItems([]);
  });

  return (
    <div>
      <h1 style={{ fontSize: '1.2rem', marginBottom: 20 }}>设置</h1>

      <div className="card">
        <div className="card-header">AI 设置</div>
        <div className="form-group">
          <label>AI API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-...（兼容 OpenAI 格式）"
          />
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            你的 API Key 仅存储在本地浏览器中，不会上传到服务器
          </div>
        </div>

        <div className="form-group">
          <label>API 地址（可选）</label>
          <input
            value={apiBase}
            onChange={e => setApiBase(e.target.value)}
            placeholder={DEFAULT_API_BASE}
          />
        </div>

        <div className="form-group">
          <label>模型名</label>
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={DEFAULT_MODEL}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-header">ZJU 学习任务导入</div>
        <div className="form-group">
          <label>ZJU 学号</label>
          <input value={zjuUsername} onChange={e => setZjuUsername(e.target.value)} placeholder="学号" />
        </div>
        <div className="form-group">
          <label>ZJU 密码</label>
          <input
            type="password"
            value={zjuPassword}
            onChange={e => setZjuPassword(e.target.value)}
            placeholder={credentialState?.has_password ? '已保存，可留空使用本地保存密码' : '不勾选保存时仅用于本次预览'}
          />
        </div>
        <div className="form-group">
          <label>Pintia Cookie</label>
          <textarea
            value={pintiaCookie}
            onChange={e => setPintiaCookie(e.target.value)}
            placeholder={credentialState?.has_pintia_cookie ? '已保存，可留空使用本地保存 Cookie' : '从 Pintia 登录态复制 Cookie；不勾选保存时仅用于本次预览'}
            style={{ minHeight: 72 }}
          />
        </div>
        <div className="form-group">
          <label>默认提前提醒天数</label>
          <input
            type="number"
            min="0"
            max="60"
            value={defaultReminderDays}
            onChange={e => setDefaultReminderDays(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={includePintia} onChange={e => setIncludePintia(e.target.checked)} />
            同时预览 Pintia
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={savePassword} onChange={e => setSavePassword(e.target.checked)} />
            明文保存 ZJU 密码到本地 SQLite
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={savePintiaCookie} onChange={e => setSavePintiaCookie(e.target.checked)} />
            明文保存 Pintia Cookie 到本地 SQLite
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={handleSaveZjuCredentials} disabled={zjuBusy}>保存凭据设置</button>
          <button className="btn btn-secondary" onClick={handleClearPassword} disabled={zjuBusy}>清除密码</button>
          <button className="btn btn-secondary" onClick={handleClearPintia} disabled={zjuBusy}>清除 Cookie</button>
          <button className="btn btn-primary" onClick={handlePreview} disabled={zjuBusy}>{zjuBusy ? '处理中...' : '预览任务'}</button>
          <button className="btn btn-primary" onClick={handleImport} disabled={zjuBusy || previewItems.length === 0}>导入可导入项</button>
          <button className="btn btn-danger" onClick={handleUndo} disabled={zjuBusy}>撤销上次导入</button>
        </div>
        {credentialState && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 10 }}>
            本地状态：{credentialState.has_password ? '已保存 ZJU 密码' : '未保存 ZJU 密码'}；{credentialState.has_pintia_cookie ? '已保存 Pintia Cookie' : '未保存 Pintia Cookie'}
          </div>
        )}
        {zjuMessage && <div style={{ marginTop: 10, color: zjuMessage.includes('失败') || zjuMessage.includes('请') ? 'var(--danger)' : 'var(--text-secondary)' }}>{zjuMessage}</div>}
        {zjuErrors.length > 0 && (
          <div style={{ marginTop: 10, color: 'var(--warning)', fontSize: '0.85rem' }}>
            {zjuErrors.map((error, index) => <div key={index}>{error}</div>)}
          </div>
        )}
        {previewItems.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {previewItems.map((item) => (
              <div key={`${item.source}:${item.external_id}`} className="todo-item" style={{ cursor: 'default' }}>
                <div className="todo-name">
                  <div>{item.course_name ? `[${item.course_name}] ` : ''}{item.title}</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    {item.source} · {item.type || 'task'} · {item.ddl_at ? new Date(item.ddl_at).toLocaleString() : '无截止时间'}
                  </div>
                </div>
                <div className="todo-meta">{item.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="form-group">
          <label>AI 预设提示词（Prompt）</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            style={{ minHeight: 280, fontFamily: 'monospace', fontSize: '0.82rem' }}
          />
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button className="btn btn-sm btn-secondary" onClick={handleResetPrompt}>
              恢复默认 Prompt
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={handleSave}>
          保存设置
        </button>
        {saved && <span style={{ color: 'var(--success)', fontSize: '0.9rem' }}>已保存</span>}
      </div>
    </div>
  );
}
