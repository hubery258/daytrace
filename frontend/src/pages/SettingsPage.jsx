import { useEffect, useState } from 'react';
import DataPortabilityPanel from '../components/DataPortabilityPanel';
import {
  DEFAULT_DISPLAY_PREFERENCES,
  readDisplayPreferences,
  writeDisplayPreferences,
} from '../utils/displayPreferences';

const STORAGE_KEY_API_KEY = 'simpletasker_api_key';
const STORAGE_KEY_API_BASE = 'simpletasker_api_base';
const STORAGE_KEY_MODEL = 'simpletasker_ai_model';
const STORAGE_KEY_PROMPT = 'simpletasker_ai_prompt';

const DEFAULT_API_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

const PAGE_SWITCHES = [
  ['home', '首页', '每天打开时的总览入口'],
  ['schedule', '日程', '查看计划与实际记录'],
  ['timer', '计时', '记录真实投入的时间'],
  ['projects', '项目', '承载需要持续推进的事项'],
  ['todos', '待办', '集中查看与整理任务'],
  ['summary', '今日总结', '完成记录、日志与复盘'],
  ['zju', 'ZJU', '浙大数据的只读导入与概览'],
];

const HOME_MODULE_SWITCHES = [
  ['currentSchedule', '当前日程', '显示此刻正在进行的安排'],
  ['focusingTodos', '正在关注', '保留今天最重要的少量待办'],
  ['waitingReplies', '等待答复', '集中查看等待他人回应的事项'],
  ['projects', '项目进展', '显示最多三个进行中的项目'],
  ['nearDeadlines', '临近 DDL', '显示即将到期的硬性与弹性事项'],
];

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

function SettingToggle({ checked, title, description, onChange }) {
  return (
    <label className="setting-toggle-row">
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span className="switch-control" aria-hidden="true"><i /></span>
    </label>
  );
}

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saved, setSaved] = useState(false);
  const [displayPreferences, setDisplayPreferences] = useState(readDisplayPreferences);
  const [displaySaved, setDisplaySaved] = useState(false);

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

  const updateDisplayPreference = (group, key, checked) => {
    const next = {
      ...displayPreferences,
      [group]: { ...displayPreferences[group], [key]: checked },
    };
    const savedPreferences = writeDisplayPreferences(next);
    setDisplayPreferences(savedPreferences);
    setDisplaySaved(true);
    setTimeout(() => setDisplaySaved(false), 1600);
  };

  const resetDisplayPreferences = () => {
    const defaults = {
      pages: { ...DEFAULT_DISPLAY_PREFERENCES.pages },
      homeModules: { ...DEFAULT_DISPLAY_PREFERENCES.homeModules },
    };
    setDisplayPreferences(writeDisplayPreferences(defaults));
    setDisplaySaved(true);
    setTimeout(() => setDisplaySaved(false), 1600);
  };

  return (
    <div className="settings-page">
      <header className="settings-header">
        <div><div className="eyebrow">保持简单，也保留选择</div><h1>设置</h1><p>裁剪你每天看到的内容，并管理只保存在此设备上的配置。</p></div>
        <div className="local-badge"><span />本地配置</div>
      </header>

      <section className="settings-section" aria-labelledby="display-settings-title">
        <div className="settings-section-heading">
          <div><span className="settings-index">01</span><h2 id="display-settings-title">界面与入口</h2><p>开关会立即生效，只隐藏展示与入口，不会删除待办、日程或其他数据。</p></div>
          {displaySaved && <span className="saved-indicator" role="status">已在本地保存</span>}
        </div>

        <div className="settings-grid">
          <div className="settings-panel">
            <div className="settings-panel-title"><h3>导航页面</h3><p>设置页始终保留，避免无法恢复入口。</p></div>
            <div className="setting-toggle-list">
              {PAGE_SWITCHES.map(([key, title, description]) => (
                <SettingToggle
                  key={key}
                  checked={displayPreferences.pages[key]}
                  title={title}
                  description={description}
                  onChange={checked => updateDisplayPreference('pages', key, checked)}
                />
              ))}
            </div>
          </div>

          <div className="settings-panel">
            <div className="settings-panel-title"><h3>首页模块</h3><p>按你的日常使用方式控制首页密度。</p></div>
            <div className="setting-toggle-list">
              {HOME_MODULE_SWITCHES.map(([key, title, description]) => (
                <SettingToggle
                  key={key}
                  checked={displayPreferences.homeModules[key]}
                  title={title}
                  description={description}
                  onChange={checked => updateDisplayPreference('homeModules', key, checked)}
                />
              ))}
            </div>
            <button className="btn btn-quiet reset-display-button" onClick={resetDisplayPreferences}>恢复默认展示</button>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="ai-settings-title">
        <div className="settings-section-heading"><div><span className="settings-index">02</span><h2 id="ai-settings-title">AI 辅助</h2><p>日迹直接使用你配置的 OpenAI-compatible 接口，Key 不会提交给日迹后端。</p></div></div>
        <div className="settings-panel settings-form-panel">
          <div className="form-group">
            <label htmlFor="ai-api-key">AI API Key</label>
            <input id="ai-api-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-...（兼容 OpenAI 格式）" />
            <div className="field-hint">仅保存在当前设备的浏览器存储中。</div>
          </div>
          <div className="settings-form-grid">
            <div className="form-group"><label htmlFor="ai-api-base">API 地址</label><input id="ai-api-base" value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder={DEFAULT_API_BASE} /></div>
            <div className="form-group"><label htmlFor="ai-model">模型名</label><input id="ai-model" value={model} onChange={e => setModel(e.target.value)} placeholder={DEFAULT_MODEL} /></div>
          </div>
          <div className="form-group">
            <label htmlFor="ai-prompt">预设提示词</label>
            <textarea id="ai-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} className="prompt-editor" />
          </div>
          <div className="settings-form-actions">
            <button className="btn btn-quiet" onClick={() => setPrompt(DEFAULT_PROMPT)}>恢复默认 Prompt</button>
            <button className="btn btn-primary" onClick={handleSave}>保存 AI 设置</button>
            {saved && <span className="saved-indicator" role="status">已保存</span>}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="data-settings-title">
        <div className="settings-section-heading"><div><span className="settings-index">03</span><h2 id="data-settings-title">本地数据</h2><p>导出与导入你的核心个人数据。展示开关不会参与数据删除。</p></div></div>
        <DataPortabilityPanel />
      </section>
    </div>
  );
}
