import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { logApi, templateApi, todoApi, scheduleApi, projectApi } from '../api/client';
import { todayStr, formatTime } from '../utils/time';
import { callChatCompletion } from '../ai/aiClient';
import { parseAiDraftResponse } from '../ai/aiDraftParser';
import { AI_DRAFT_SYSTEM_PROMPT, buildDailyDraftUserMessage } from '../ai/aiPrompts';
import AiDraftReviewModal from '../components/AiDraftReviewModal';

const TODAY = todayStr();

const STORAGE_KEY_API_KEY = 'simpletasker_api_key';
const STORAGE_KEY_PROMPT = 'simpletasker_ai_prompt';

const DEFAULT_PROMPT = `你是一位专业的个人效率助手。请根据用户提供的今日待办、日程和日志，生成温和、具体、可执行的效率分析和明日建议。

要求：
- 语气温和，避免责备。
- 分析要引用实际数据。
- 建议要具体可执行。
- 控制在 300-500 字。`;

function addDays(dateString, days) {
  const date = new Date(dateString + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function DailySummaryPage() {
  const [log, setLog] = useState(null);
  const [logText, setLogText] = useState('');
  const [completedTodos, setCompletedTodos] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(TODAY);
  const [loading, setLoading] = useState(false);
  const [allTodos, setAllTodos] = useState([]);
  const [projects, setProjects] = useState([]);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiMessage, setAiMessage] = useState('');
  const [aiError, setAiError] = useState('');

  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftWarnings, setDraftWarnings] = useState([]);
  const [draftItems, setDraftItems] = useState([]);
  const [showDraftReview, setShowDraftReview] = useState(false);

  const loadLog = useCallback(async (date) => {
    setLoading(true);
    try {
      const data = await logApi.get(date);
      setLog(data);
      setLogText(data.log_text || '');
      setCompletedTodos(data.completed_todo_ids || []);
    } catch {
      setLog(null);
      setLogText('');
      setCompletedTodos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadContext = useCallback(async () => {
    const [todos, projectData] = await Promise.all([
      todoApi.list({}).catch(() => []),
      projectApi.list().catch(() => []),
    ]);
    setAllTodos(todos);
    setProjects(projectData);
    return { todos, projectData };
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const data = await templateApi.list();
      setTemplates(data);
    } catch (err) {
      console.error('加载模板失败', err);
    }
  }, []);

  useEffect(() => {
    loadLog(selectedDate);
    loadTemplates();
    loadContext();
    setAiMessage('');
    setAiError('');
    setDraftError('');
    setDraftWarnings([]);
    setDraftItems([]);
    setShowDraftReview(false);
  }, [selectedDate, loadLog, loadTemplates, loadContext]);

  const handleSave = async () => {
    try {
      await logApi.upsert({
        log_date: selectedDate,
        completed_todo_ids: completedTodos,
        log_text: logText,
      });
      alert('已保存');
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  };

  const applyTemplate = (content) => {
    setLogText(prev => prev + (prev ? '\n' : '') + content);
  };

  const handleAiAnalyze = async () => {
    if (!localStorage.getItem(STORAGE_KEY_API_KEY)) {
      setAiError('请先在设置页填写 API Key');
      return;
    }

    setAiLoading(true);
    setAiError('');
    setAiMessage('');

    try {
      const [todos, schedules] = await Promise.all([
        todoApi.list({ is_completed: false }).catch(() => []),
        scheduleApi.list({ date_from: `${selectedDate}T00:00:00`, date_to: `${selectedDate}T23:59:59` }).catch(() => []),
      ]);

      const completedList = completedTodos.length
        ? `完成了 ${completedTodos.length} 个待办，ID: ${completedTodos.join(', ')}`
        : '今日暂无完成待办';
      const pendingTodos = todos.filter(t => !t.is_completed);
      const pendingList = pendingTodos.length
        ? pendingTodos.map(t => `- ${t.name}，DDL 类型 ${t.ddl_type}，状态 ${t.status}`).join('\n')
        : '无待完成待办';
      const plannedSchedules = schedules.filter(s => s.is_planned);
      const actualSchedules = schedules.filter(s => !s.is_planned);
      const scheduleInfo = [
        `计划日程 ${plannedSchedules.length} 个：`,
        ...plannedSchedules.map(s => `  - ${s.name}，${formatTime(s.start_time)}-${formatTime(s.end_time)}`),
        `实际记录 ${actualSchedules.length} 个：`,
        ...actualSchedules.map(s => `  - ${s.name}，${formatTime(s.start_time)}-${formatTime(s.end_time)}`),
      ].join('\n');
      const todayLog = log?.log_text || '（用户还没有写今日日志）';
      const userMessage = `## 今日数据

日期：${selectedDate}

待办完成情况：
${completedList}

未完成待办：
${pendingList}

日程执行情况：
${scheduleInfo}

用户今日日志：
${todayLog}

请帮我分析今日效率并给出建议。`;
      const systemPrompt = localStorage.getItem(STORAGE_KEY_PROMPT) || DEFAULT_PROMPT;
      const message = await callChatCompletion({
        systemPrompt,
        userMessage,
        maxTokens: 800,
        temperature: 0.7,
      });
      setAiMessage(message || '（AI 未返回内容）');
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  };

  const handleAiGenerateDrafts = async () => {
    if (!localStorage.getItem(STORAGE_KEY_API_KEY)) {
      setDraftError('请先在设置页配置 API Key');
      return;
    }

    setDraftLoading(true);
    setDraftError('');
    setDraftWarnings([]);
    setDraftItems([]);

    try {
      const tomorrow = addDays(selectedDate, 1);
      const [{ todos, projectData }, todaySchedules, tomorrowSchedules] = await Promise.all([
        loadContext(),
        scheduleApi.list({ date_from: `${selectedDate}T00:00:00`, date_to: `${selectedDate}T23:59:59` }).catch(() => []),
        scheduleApi.list({ date_from: `${tomorrow}T00:00:00`, date_to: `${tomorrow}T23:59:59` }).catch(() => []),
      ]);
      const completedTodoObjects = completedTodos
        .map(id => todos.find(todo => Number(todo.id) === Number(id)))
        .filter(Boolean);
      const pendingTodos = todos.filter(todo => !todo.is_completed);
      const userMessage = buildDailyDraftUserMessage({
        selectedDate,
        logText,
        completedTodos: completedTodoObjects,
        pendingTodos,
        todaySchedules,
        tomorrowSchedules,
        projects: projectData,
      });
      const raw = await callChatCompletion({
        systemPrompt: AI_DRAFT_SYSTEM_PROMPT,
        userMessage,
        maxTokens: 1600,
        temperature: 0.3,
      });
      const result = parseAiDraftResponse(raw, {
        projects: projectData,
        todos,
        schedules: tomorrowSchedules,
      });
      setDraftWarnings(result.warnings);
      setDraftItems(result.drafts);
      setShowDraftReview(result.drafts.length > 0);
      setDraftError(result.errors.join('\n'));
    } catch (err) {
      setDraftError(err.message || 'AI 草稿生成失败');
    } finally {
      setDraftLoading(false);
    }
  };

  const handleDraftCreated = async () => {
    setShowDraftReview(false);
    setDraftItems([]);
    await loadContext();
  };

  const isToday = selectedDate === TODAY;
  const hasApiKey = !!localStorage.getItem(STORAGE_KEY_API_KEY);

  return (
    <div className="summary-layout">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          max={TODAY}
          style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.95rem' }}
        />
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {isToday ? '今日日志与总结' : '往日记录，只读参考'}
        </span>
      </div>

      <div className="ai-chat">
        <h3>AI 效率分析</h3>

        {!hasApiKey && (
          <div className="ai-chat-placeholder">
            <p>还未配置 API Key</p>
            <Link to="/settings" style={{ color: 'var(--primary)', fontSize: '0.9rem' }}>前往设置页配置</Link>
          </div>
        )}

        {hasApiKey && !aiMessage && !aiLoading && (
          <div style={{ textAlign: 'center', padding: '20px 0 12px' }}>
            <button className="btn btn-primary" onClick={handleAiAnalyze}>分析今日效率</button>
          </div>
        )}

        {hasApiKey && (
          <div style={{ textAlign: 'center', padding: '0 0 16px' }}>
            <button className="btn btn-secondary" disabled={draftLoading} onClick={handleAiGenerateDrafts}>
              {draftLoading ? '生成草稿中...' : '生成明日待办/日程草稿'}
            </button>
          </div>
        )}

        {aiLoading && (
          <div className="ai-chat-placeholder"><p>AI 正在分析你的今日数据...</p></div>
        )}

        {aiError && (
          <div className="ai-draft-error">
            {aiError}
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>重试</button>
            </div>
          </div>
        )}

        {draftError && <div className="ai-draft-error" style={{ whiteSpace: 'pre-wrap' }}>{draftError}</div>}
        {draftWarnings.length > 0 && (
          <div className="ai-draft-warning">
            {draftWarnings.map((warning, index) => <div key={index}>{warning}</div>)}
          </div>
        )}
        {draftItems.length > 0 && !showDraftReview && (
          <div style={{ textAlign: 'center', paddingBottom: 16 }}>
            <button className="btn btn-sm btn-primary" onClick={() => setShowDraftReview(true)}>
              打开 {draftItems.length} 条草稿
            </button>
          </div>
        )}

        {aiMessage && (
          <div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: '0.92rem', background: '#f9fafb', padding: '16px', borderRadius: 8, marginBottom: 12 }}>
              {aiMessage}
            </div>
            <button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>重新分析</button>
          </div>
        )}
      </div>

      {showDraftReview && (
        <AiDraftReviewModal
          drafts={draftItems}
          warnings={draftWarnings}
          projects={projects}
          todos={allTodos}
          onClose={() => setShowDraftReview(false)}
          onCreated={handleDraftCreated}
        />
      )}

      <div className="completed-list">
        <h3>今日完成待办</h3>
        {loading ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>加载中...</div>
        ) : completedTodos.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>暂无完成的待办。</div>
        ) : (
          completedTodos.map((id, index) => {
            const todo = allTodos.find(t => Number(t.id) === Number(id));
            return <div key={index} style={{ padding: '4px 0', fontSize: '0.9rem' }}>{todo ? todo.name : `待办 #${id}`}</div>;
          })
        )}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>今日日志</h3>

        {templates.length > 0 && (
          <div className="template-bar">
            {templates.map(t => (
              <button key={t.id} className="template-chip" onClick={() => applyTemplate(t.content)} title={t.name}>
                {t.name}
              </button>
            ))}
          </div>
        )}

        <div className="log-editor">
          <textarea
            value={logText}
            onChange={e => setLogText(e.target.value)}
            placeholder="记录今天的想法、收获和反思..."
            readOnly={!isToday}
          />
        </div>

        {isToday && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleSave}>保存日志</button>
          </div>
        )}
      </div>
    </div>
  );
}
