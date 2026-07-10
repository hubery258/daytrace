import { useState, useEffect } from 'react';

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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    setApiKey(localStorage.getItem(STORAGE_KEY_API_KEY) || '');
    setApiBase(localStorage.getItem(STORAGE_KEY_API_BASE) || DEFAULT_API_BASE);
    setModel(localStorage.getItem(STORAGE_KEY_MODEL) || DEFAULT_MODEL);
    setPrompt(localStorage.getItem(STORAGE_KEY_PROMPT) || DEFAULT_PROMPT);
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

  const handleTestConnection = async () => {
    if (!apiKey.trim()) {
      setTestResult({ ok: false, message: '请先填写 API Key' });
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${normalizedApiBase()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: normalizedModel(),
          messages: [
            { role: 'system', content: 'You are a connection test endpoint.' },
            { role: 'user', content: 'Reply with ok.' },
          ],
          max_tokens: 8,
          temperature: 0,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `请求失败 (${res.status})`);
      }

      setTestResult({ ok: true, message: '连接成功' });
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleResetPrompt = () => {
    setPrompt(DEFAULT_PROMPT);
  };

  return (
    <div>
      <h1 style={{ fontSize: '1.2rem', marginBottom: 20 }}>⚙️ 设置</h1>

      <div className="card">
        <div className="form-group">
          <label>AI API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-... （兼容 OpenAI 格式）"
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
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            默认 DeepSeek，可改为其他兼容接口（如 OpenAI、Groq 等）
          </div>
        </div>

        <div className="form-group">
          <label>模型名</label>
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={DEFAULT_MODEL}
          />
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 4 }}>
            例如 deepseek-chat、gpt-4.1-mini，取决于你的服务商支持什么模型
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" onClick={handleTestConnection} disabled={testing}>
            {testing ? '测试中...' : '测试连接'}
          </button>
          {testResult && (
            <span style={{
              color: testResult.ok ? 'var(--success)' : 'var(--danger)',
              fontSize: '0.85rem',
            }}>
              {testResult.ok ? '✅' : '❌'} {testResult.message}
            </span>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
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
          💾 保存设置
        </button>
        {saved && <span style={{ color: 'var(--success)', fontSize: '0.9rem' }}>✅ 已保存</span>}
      </div>
    </div>
  );
}
