import { useEffect, useState } from 'react';
import DataPortabilityPanel from '../components/DataPortabilityPanel';
import WebdavSyncPanel from '../components/WebdavSyncPanel';
import UserManual from '../components/UserManual';
import { timeBlockApi } from '../api/client';
import {
  DEFAULT_DISPLAY_PREFERENCES,
  readDisplayPreferences,
  writeDisplayPreferences,
} from '../utils/displayPreferences';

const STORAGE_KEY_API_KEY = 'simpletasker_api_key';
const STORAGE_KEY_API_BASE = 'simpletasker_api_base';
const STORAGE_KEY_MODEL = 'simpletasker_ai_model';

const DEFAULT_API_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

const PAGE_SWITCHES = [
  ['home', '首页', '查看当前日程和待办'],
  ['schedule', '日程', '查看计划与实际记录'],
  ['timer', '计时', '开始、暂停或结束计时'],
  ['projects', '项目', '查看项目待办与日程'],
  ['todos', '待办', '集中查看与整理任务'],
  ['stats', '统计', '按实际时间块查看时间和任务投入'],
  ['summary', '日志', '记录每日文字和已完成待办'],
  ['zju', 'ZJU', '浙大数据的只读导入与概览'],
];

const HOME_MODULE_SWITCHES = [
  ['currentSchedule', '当前日程', '显示此刻正在进行的安排'],
  ['focusingTodos', '正在关注', '显示设为关注中的待办'],
  ['waitingReplies', '等待答复', '集中查看等待他人回应的事项'],
  ['projects', '项目进展', '显示最多三个进行中的项目'],
  ['nearDeadlines', '临近 DDL', '显示即将到期的硬性与弹性事项'],
];

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
  const [saved, setSaved] = useState(false);
  const [displayPreferences, setDisplayPreferences] = useState(readDisplayPreferences);
  const [displaySaved, setDisplaySaved] = useState(false);
  const [blockCategories, setBlockCategories] = useState([]);
  const [categoryEdits, setCategoryEdits] = useState({});
  const [newCategory, setNewCategory] = useState({ name: '', color: '#347f88' });
  const [categoryError, setCategoryError] = useState('');

  useEffect(() => {
    setApiKey(localStorage.getItem(STORAGE_KEY_API_KEY) || '');
    setApiBase(localStorage.getItem(STORAGE_KEY_API_BASE) || DEFAULT_API_BASE);
    setModel(localStorage.getItem(STORAGE_KEY_MODEL) || DEFAULT_MODEL);
  }, []);

  const loadCategories = async () => {
    const items = await timeBlockApi.categories();
    setBlockCategories(items);
    setCategoryEdits(Object.fromEntries(items.map(item => [item.id, { name: item.name, color: item.color }])));
  };

  useEffect(() => { loadCategories().catch(error => setCategoryError(error.message)); }, []);

  const saveCategory = async (id) => {
    try {
      await timeBlockApi.updateCategory(id, categoryEdits[id]);
      setCategoryError('');
      await loadCategories();
    } catch (error) { setCategoryError(error.message); }
  };

  const addCategory = async (event) => {
    event.preventDefault();
    try {
      await timeBlockApi.createCategory(newCategory);
      setNewCategory({ name: '', color: '#347f88' });
      setCategoryError('');
      await loadCategories();
    } catch (error) { setCategoryError(error.message); }
  };

  const removeCategory = async (id) => {
    try {
      await timeBlockApi.deleteCategory(id);
      setCategoryError('');
      await loadCategories();
    } catch (error) { setCategoryError(error.message); }
  };

  const updateActualPreference = (key, value) => {
    setDisplayPreferences(writeDisplayPreferences({ ...displayPreferences, [key]: value }));
    setDisplaySaved(true);
    setTimeout(() => setDisplaySaved(false), 1600);
  };

  const normalizedApiBase = () => (apiBase.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
  const normalizedModel = () => model.trim() || DEFAULT_MODEL;

  const handleSave = () => {
    localStorage.setItem(STORAGE_KEY_API_KEY, apiKey.trim());
    localStorage.setItem(STORAGE_KEY_API_BASE, normalizedApiBase());
    localStorage.setItem(STORAGE_KEY_MODEL, normalizedModel());
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

  const updateTimeFormat = (timeFormat) => {
    const savedPreferences = writeDisplayPreferences({ ...displayPreferences, timeFormat });
    setDisplayPreferences(savedPreferences);
    setDisplaySaved(true);
    setTimeout(() => setDisplaySaved(false), 1600);
  };

  const resetDisplayPreferences = () => {
    const defaults = {
      timeFormat: DEFAULT_DISPLAY_PREFERENCES.timeFormat,
      actualDisplayMode: DEFAULT_DISPLAY_PREFERENCES.actualDisplayMode,
      timeBlockGranularity: DEFAULT_DISPLAY_PREFERENCES.timeBlockGranularity,
      homeUpcomingScheduleCount: DEFAULT_DISPLAY_PREFERENCES.homeUpcomingScheduleCount,
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
        <div><div className="eyebrow">本机配置</div><h1>设置</h1><p>调整显示，配置 AI 与 WebDAV，导入或导出数据。</p></div>
        <div className="local-badge"><span />本地配置</div>
      </header>

      <UserManual />

      <section className="settings-section" aria-labelledby="display-settings-title">
        <div className="settings-section-heading">
          <div><span className="settings-index">01</span><h2 id="display-settings-title">界面与入口</h2><p>开关立即生效；隐藏页面或模块不会删除数据。</p></div>
          {displaySaved && <span className="saved-indicator" role="status">已在本地保存</span>}
        </div>

        <div className="settings-grid">
          <div className="settings-panel">
            <div className="settings-panel-title"><h3>导航页面</h3><p>隐藏的页面可在此重新开启。</p></div>
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
            <div className="settings-panel-title"><h3>首页模块</h3><p>选择首页显示的内容。</p></div>
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
            <div className="form-group home-upcoming-setting">
              <label htmlFor="home-upcoming-count">“接下来”显示数量</label>
              <select id="home-upcoming-count" value={displayPreferences.homeUpcomingScheduleCount}
                onChange={event => updateActualPreference('homeUpcomingScheduleCount', Number(event.target.value))}>
                <option value={0}>0 个（隐藏接下来）</option>
                <option value={1}>1 个</option>
                <option value={2}>2 个</option>
              </select>
              <p className="field-hint">按开始时间显示今天接下来的计划；选择 0 不影响“此刻”。</p>
            </div>
          </div>
          <div className="settings-panel">
            <div className="settings-panel-title"><h3>时间格式</h3><p>控制 DDL 时间输入和日程时间轴的显示方式。</p></div>
            <div className="form-group">
              <label htmlFor="time-format">小时制</label>
              <select id="time-format" value={displayPreferences.timeFormat} onChange={event => updateTimeFormat(event.target.value)}>
                <option value="24h">24 小时制（23:30）</option>
                <option value="12h">12 小时制（11:30 PM）</option>
              </select>
            </div>
          </div>
          <div className="settings-panel">
            <div className="settings-panel-title"><h3>实际记录</h3><p>同一份时间块数据可按时间块或时间轴查看。</p></div>
            <div className="form-group">
              <label htmlFor="actual-display-mode">显示模式</label>
              <select id="actual-display-mode" value={displayPreferences.actualDisplayMode}
                onChange={event => updateActualPreference('actualDisplayMode', event.target.value)}>
                <option value="blocks">时间块</option>
                <option value="timeline">时间轴</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="time-block-granularity">时间块粒度</label>
              <select id="time-block-granularity" value={displayPreferences.timeBlockGranularity}
                onChange={event => updateActualPreference('timeBlockGranularity', Number(event.target.value))}>
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
              </select>
            </div>
          </div>
          <div className="settings-panel">
            <div className="settings-panel-title"><h3>时间块属性</h3><p>属性与颜色用于实际记录和时间轴。</p></div>
            <div className="setting-toggle-list">
              {blockCategories.map(item => (
                <div className="form-group" key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input aria-label="属性名称" value={categoryEdits[item.id]?.name || ''}
                    onChange={event => setCategoryEdits(prev => ({ ...prev, [item.id]: { ...prev[item.id], name: event.target.value } }))} />
                  <input aria-label="属性颜色" type="color" value={categoryEdits[item.id]?.color || item.color}
                    onChange={event => setCategoryEdits(prev => ({ ...prev, [item.id]: { ...prev[item.id], color: event.target.value } }))} />
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => saveCategory(item.id)}>保存</button>
                  <button type="button" className="btn btn-sm btn-quiet" onClick={() => removeCategory(item.id)}>删除</button>
                </div>
              ))}
            </div>
            <form className="form-group" onSubmit={addCategory} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input aria-label="新属性名称" value={newCategory.name} required maxLength={100} placeholder="添加属性"
                onChange={event => setNewCategory(prev => ({ ...prev, name: event.target.value }))} />
              <input aria-label="新属性颜色" type="color" value={newCategory.color}
                onChange={event => setNewCategory(prev => ({ ...prev, color: event.target.value }))} />
              <button className="btn btn-sm btn-primary" type="submit">添加</button>
            </form>
            {categoryError && <p role="alert" className="notice notice-error">{categoryError}</p>}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="ai-settings-title">
        <div className="settings-section-heading"><div><span className="settings-index">02</span><h2 id="ai-settings-title">AI 辅助</h2><p>请求直接发送到你配置的兼容 OpenAI 接口，Key 不发送给日迹后端。</p></div></div>
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
          <div className="settings-form-actions">
            <button className="btn btn-primary" onClick={handleSave}>保存 AI 设置</button>
            {saved && <span className="saved-indicator" role="status">已保存</span>}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="data-settings-title" id="local-data-section">
        <div className="settings-section-heading"><div><span className="settings-index">03</span><h2 id="data-settings-title">本地数据</h2><p>备份、合并或恢复核心个人数据。</p></div></div>
        <DataPortabilityPanel />
      </section>

      <section className="settings-section" aria-labelledby="webdav-settings-title" id="webdav-section">
        <div className="settings-section-heading">
          <div>
            <span className="settings-index">04</span>
            <h2 id="webdav-settings-title">WebDAV 同步</h2>
            <p>手动上传或下载到自己的服务器，不经过日迹开发者服务器。</p>
          </div>
        </div>
        <WebdavSyncPanel />
      </section>
    </div>
  );
}
