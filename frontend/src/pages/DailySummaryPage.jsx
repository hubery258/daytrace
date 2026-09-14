import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { logApi, projectApi, scheduleApi, templateApi, todoApi } from '../api/client';
import { addDays, dateStrInBeijing, todayStr } from '../utils/time';
import { callChatCompletion } from '../ai/aiClient';
import { parseAiDraftResponse } from '../ai/aiDraftParser';
import { AI_DRAFT_SYSTEM_PROMPT, buildDailyDraftUserMessage } from '../ai/aiPrompts';
import AiDraftReviewModal from '../components/AiDraftReviewModal';
import AiResponseDiagnostics from '../components/AiResponseDiagnostics';

const STORAGE_KEY_API_KEY = 'simpletasker_api_key';

export default function DailySummaryPage() {
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [logText, setLogText] = useState('');
  const [completedTodos, setCompletedTodos] = useState([]);
  const [allTodos, setAllTodos] = useState([]);
  const [projects, setProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftWarnings, setDraftWarnings] = useState([]);
  const [draftItems, setDraftItems] = useState([]);
  const [showDraftReview, setShowDraftReview] = useState(false);
  const [draftDiagnostics, setDraftDiagnostics] = useState(null);

  const loadLog = useCallback(async date => {
    setLoading(true);
    try {
      const data = await logApi.get(date);
      setLogText(data.log_text || '');
      setCompletedTodos(data.completed_todo_ids || []);
    } catch {
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

  useEffect(() => {
    loadLog(selectedDate);
    loadContext();
    templateApi.list().then(setTemplates).catch(() => setTemplates([]));
    setDraftError('');
    setDraftWarnings([]);
    setDraftItems([]);
    setShowDraftReview(false);
    setDraftDiagnostics(null);
  }, [selectedDate, loadLog, loadContext]);

  const visibleCompletedIds = Array.from(new Set([
    ...completedTodos.map(Number),
    ...allTodos
      .filter(todo => todo.is_completed && todo.completed_at && dateStrInBeijing(todo.completed_at) === selectedDate)
      .map(todo => Number(todo.id)),
  ]));

  const saveLog = async () => {
    try {
      await logApi.upsert({
        log_date: selectedDate,
        completed_todo_ids: visibleCompletedIds,
        log_text: logText,
      });
      alert('日志已保存');
    } catch (cause) {
      alert('保存失败：' + cause.message);
    }
  };

  const generateSuggestions = async () => {
    setDraftDiagnostics(null);
    if (!localStorage.getItem(STORAGE_KEY_API_KEY)) {
      setDraftError('请先在设置页配置 API Key。');
      return;
    }
    setDraftLoading(true);
    setDraftError('');
    setDraftWarnings([]);
    setDraftItems([]);
    try {
      const tomorrow = addDays(selectedDate, 1);
      const nextDay = addDays(tomorrow, 1);
      const [{ todos, projectData }, todaySchedules, tomorrowSchedules] = await Promise.all([
        loadContext(),
        scheduleApi.list({ date_from: selectedDate + 'T00:00:00', date_to: tomorrow + 'T00:00:00' }).catch(() => []),
        scheduleApi.list({ date_from: tomorrow + 'T00:00:00', date_to: nextDay + 'T00:00:00' }).catch(() => []),
      ]);
      const plannedToday = todaySchedules.filter(item => item.is_planned);
      const plannedTomorrow = tomorrowSchedules.filter(item => item.is_planned);
      const completedIds = new Set(visibleCompletedIds);
      const completedTodoObjects = Array.from(completedIds)
        .map(id => todos.find(todo => Number(todo.id) === id)).filter(Boolean);
      const pendingTodos = todos.filter(todo => !todo.is_completed);
      const { text: raw, responseMeta } = await callChatCompletion({
        systemPrompt: AI_DRAFT_SYSTEM_PROMPT,
        userMessage: buildDailyDraftUserMessage({
          selectedDate, logText, completedTodos: completedTodoObjects, pendingTodos,
          todaySchedules: plannedToday, tomorrowSchedules: plannedTomorrow, projects: projectData,
        }),
        maxTokens: 1600,
        temperature: 0.3,
        includeResponseMetadata: true,
      });
      const result = parseAiDraftResponse(raw, { projects: projectData, todos, schedules: plannedTomorrow });
      setDraftDiagnostics({ ...result, responseMeta });
      setDraftWarnings(result.warnings);
      setDraftItems(result.drafts);
      setShowDraftReview(result.drafts.length > 0);
      setDraftError(result.errors.join('\n'));
    } catch (cause) {
      setDraftError(cause.message || '建议生成失败。');
    } finally {
      setDraftLoading(false);
    }
  };

  const isToday = selectedDate === todayStr();
  const hasApiKey = !!localStorage.getItem(STORAGE_KEY_API_KEY);

  return (
    <div className="summary-layout">
      <header className="page-hero page-hero-compact">
        <div>
          <div className="eyebrow">把一天留给自己</div>
          <h1>每日日志</h1>
          <p>手写记录和完成事项留在这里；实际投入请到统计页查看。</p>
        </div>
      </header>
      <div className="summary-date-bar">
        <input type="date" value={selectedDate} onChange={event => setSelectedDate(event.target.value)} max={todayStr()} />
        <Link to="/stats" className="btn btn-sm btn-secondary">查看时间统计</Link>
      </div>

      <section className="card">
        <h2 style={{ marginBottom: 12 }}>当天记录</h2>
        {templates.length > 0 && <div className="template-bar">{templates.map(item =>
          <button key={item.id} className="template-chip" onClick={() => setLogText(previous =>
            previous + (previous ? '\n' : '') + item.content)} title={item.name}>{item.name}</button>)}</div>}
        <div className="log-editor">
          <textarea value={logText} onChange={event => setLogText(event.target.value)}
            placeholder="记录今天的想法、收获与感受…" readOnly={!isToday} />
        </div>
        {isToday && <div className="form-actions"><button className="btn btn-primary" onClick={saveLog}>保存日志</button></div>}
      </section>

      <section className="completed-list">
        <h2>当天完成的待办</h2>
        {loading ? <p className="hint-line">加载中…</p> :
          visibleCompletedIds.length === 0 ? <p className="hint-line">暂无完成的待办。</p> :
            visibleCompletedIds.map(id => {
              const todo = allTodos.find(item => Number(item.id) === id);
              return <div key={id} className="daily-completed-item">{todo?.name || '待办 #' + id}</div>;
            })}
      </section>

      <section className="ai-chat">
        <h2>AI 待办与日程建议</h2>
        <p className="hint-line">结合当天日志和计划，提出下一天的待办或日程草稿；确认后才写入。</p>
        {!hasApiKey && <p className="hint-line">尚未配置 API Key。<Link to="/settings">前往设置</Link></p>}
        {hasApiKey && <button className="btn btn-primary" disabled={draftLoading} onClick={generateSuggestions}>
          {draftLoading ? '正在生成建议…' : '生成下一天的建议'}
        </button>}
        {draftError && !draftDiagnostics && <div className="ai-draft-error" role="alert">{draftError}</div>}
        <AiResponseDiagnostics diagnostics={draftDiagnostics} />
        {draftWarnings.length > 0 && <div className="ai-draft-warning">{draftWarnings.map((warning, index) =>
          <div key={index}>{warning}</div>)}</div>}
        {draftItems.length > 0 && !showDraftReview && <button className="btn btn-sm btn-secondary"
          onClick={() => setShowDraftReview(true)}>查看 {draftItems.length} 条建议</button>}
      </section>

      {showDraftReview && <AiDraftReviewModal drafts={draftItems} warnings={draftWarnings}
        diagnostics={draftDiagnostics} projects={projects} todos={allTodos}
        onClose={() => setShowDraftReview(false)}
        onCreated={async () => {
          setShowDraftReview(false);
          setDraftItems([]);
          setDraftDiagnostics(null);
          await loadContext();
        }} />}
    </div>
  );
}
