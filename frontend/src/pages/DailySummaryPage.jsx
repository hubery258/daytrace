import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { logApi, templateApi, todoApi, scheduleApi, projectApi } from '../api/client';
import { todayStr, formatTime } from '../utils/time';
import { callChatCompletion } from '../ai/aiClient';
import { parseAiDraftResponse, parseAiQuestionsResponse } from '../ai/aiDraftParser';
import {
  AI_DRAFT_SYSTEM_PROMPT,
  AI_REFLECTION_QUESTION_SYSTEM_PROMPT,
  AI_REFLECTION_SUMMARY_SYSTEM_PROMPT,
  buildDailyDraftUserMessage,
  buildReflectionQuestionUserMessage,
  buildReflectionSummaryUserMessage,
} from '../ai/aiPrompts';
import AiDraftReviewModal from '../components/AiDraftReviewModal';

const TODAY = todayStr();
const STORAGE_KEY_API_KEY = 'simpletasker_api_key';
const STORAGE_KEY_PROMPT = 'simpletasker_ai_prompt';

const DEFAULT_PROMPT = `你是一位个人效率助手。请根据用户提供的今日待办、日程和日志，生成温和、具体、可执行的效率分析和明日建议，控制在 300-500 字左右。`;

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

  const [reflectionLoading, setReflectionLoading] = useState(false);
  const [reflectionQuestions, setReflectionQuestions] = useState([]);
  const [reflectionAnswer, setReflectionAnswer] = useState('');
  const [reflectionSummary, setReflectionSummary] = useState('');
  const [reflectionError, setReflectionError] = useState('');

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
    setReflectionQuestions([]);
    setReflectionAnswer('');
    setReflectionSummary('');
    setReflectionError('');
    setDraftError('');
    setDraftWarnings([]);
    setDraftItems([]);
    setShowDraftReview(false);
  }, [selectedDate, loadLog, loadTemplates, loadContext]);

  const requireApiKey = (setter) => {
    if (!localStorage.getItem(STORAGE_KEY_API_KEY)) {
      setter('请先在设置页配置 API Key。');
      return false;
    }
    return true;
  };

  const getDailyContext = async () => {
    const tomorrow = addDays(selectedDate, 1);
    const [{ todos, projectData }, todaySchedules, tomorrowSchedules] = await Promise.all([
      loadContext(),
      scheduleApi.list({ date_from: `${selectedDate}T00:00:00`, date_to: `${selectedDate}T23:59:59` }).catch(() => []),
      scheduleApi.list({ date_from: `${tomorrow}T00:00:00`, date_to: `${tomorrow}T23:59:59` }).catch(() => []),
    ]);
    const completedTodoObjects = completedTodos.map(id => todos.find(todo => Number(todo.id) === Number(id))).filter(Boolean);
    const pendingTodos = todos.filter(todo => !todo.is_completed);
    return { todos, projectData, todaySchedules, tomorrowSchedules, completedTodoObjects, pendingTodos };
  };

  const handleSave = async () => {
    try {
      await logApi.upsert({ log_date: selectedDate, completed_todo_ids: completedTodos, log_text: logText });
      alert('已保存');
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  };

  const applyTemplate = (content) => setLogText(prev => prev + (prev ? '\n' : '') + content);

  const handleAiAnalyze = async () => {
    if (!requireApiKey(setAiError)) return;
    setAiLoading(true);
    setAiError('');
    setAiMessage('');

    try {
      const { todaySchedules, completedTodoObjects, pendingTodos } = await getDailyContext();
      const scheduleInfo = todaySchedules.map(s => `- ${s.name}，${formatTime(s.start_time)}-${formatTime(s.end_time)}，${s.is_planned ? '计划' : '实际'}`).join('\n') || '无';
      const userMessage = `日期：${selectedDate}\n\n完成待办：\n${completedTodoObjects.map(t => `- ${t.name}`).join('\n') || '无'}\n\n未完成待办：\n${pendingTodos.map(t => `- ${t.name}，DDL=${t.ddl_date || '无'}，状态=${t.status}`).join('\n') || '无'}\n\n日程：\n${scheduleInfo}\n\n用户日志：\n${log?.log_text || logText || '空'}\n\n请分析今日效率并给出建议。`;
      const message = await callChatCompletion({
        systemPrompt: localStorage.getItem(STORAGE_KEY_PROMPT) || DEFAULT_PROMPT,
        userMessage,
        maxTokens: 900,
        temperature: 0.7,
      });
      setAiMessage(message || 'AI 没有返回内容。');
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  };

  const handleStartReflection = async () => {
    if (!requireApiKey(setReflectionError)) return;
    setReflectionLoading(true);
    setReflectionError('');
    setReflectionQuestions([]);
    setReflectionAnswer('');
    setReflectionSummary('');

    try {
      const { projectData, todaySchedules, completedTodoObjects, pendingTodos } = await getDailyContext();
      const raw = await callChatCompletion({
        systemPrompt: AI_REFLECTION_QUESTION_SYSTEM_PROMPT,
        userMessage: buildReflectionQuestionUserMessage({ selectedDate, logText, completedTodos: completedTodoObjects, pendingTodos, todaySchedules, projects: projectData }),
        maxTokens: 700,
        temperature: 0.35,
      });
      const result = parseAiQuestionsResponse(raw, 'reflection_questions');
      setReflectionQuestions(result.questions);
      setReflectionError(result.errors.join('\n'));
    } catch (err) {
      setReflectionError(err.message || 'AI 复盘提问失败。');
    } finally {
      setReflectionLoading(false);
    }
  };

  const handleFinishReflection = async () => {
    if (!requireApiKey(setReflectionError)) return;
    setReflectionLoading(true);
    setReflectionError('');
    setReflectionSummary('');

    try {
      const { projectData, todaySchedules, completedTodoObjects, pendingTodos } = await getDailyContext();
      const summary = await callChatCompletion({
        systemPrompt: AI_REFLECTION_SUMMARY_SYSTEM_PROMPT,
        userMessage: buildReflectionSummaryUserMessage({ selectedDate, logText, questions: reflectionQuestions, answer: reflectionAnswer, completedTodos: completedTodoObjects, pendingTodos, todaySchedules, projects: projectData }),
        maxTokens: 1000,
        temperature: 0.55,
      });
      setReflectionSummary(summary || 'AI 没有返回内容。');
    } catch (err) {
      setReflectionError(err.message || 'AI 复盘总结失败。');
    } finally {
      setReflectionLoading(false);
    }
  };

  const handleAiGenerateDrafts = async () => {
    if (!requireApiKey(setDraftError)) return;
    setDraftLoading(true);
    setDraftError('');
    setDraftWarnings([]);
    setDraftItems([]);

    try {
      const { projectData, todaySchedules, tomorrowSchedules, completedTodoObjects, pendingTodos } = await getDailyContext();
      const raw = await callChatCompletion({
        systemPrompt: AI_DRAFT_SYSTEM_PROMPT,
        userMessage: buildDailyDraftUserMessage({ selectedDate, logText: [logText, reflectionSummary].filter(Boolean).join('\n\n复盘结果：\n'), completedTodos: completedTodoObjects, pendingTodos, todaySchedules, tomorrowSchedules, projects: projectData }),
        maxTokens: 1600,
        temperature: 0.3,
      });
      const result = parseAiDraftResponse(raw, { projects: projectData, todos: allTodos, schedules: tomorrowSchedules });
      setDraftWarnings(result.warnings);
      setDraftItems(result.drafts);
      setShowDraftReview(result.drafts.length > 0);
      setDraftError(result.errors.join('\n'));
    } catch (err) {
      setDraftError(err.message || '草稿生成失败。');
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
        <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} max={TODAY} style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.95rem' }} />
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{isToday ? '今日总结' : '往日记录'}</span>
      </div>

      <div className="ai-chat">
        <h3>AI 单独总结</h3>
        {!hasApiKey && <div className="ai-chat-placeholder"><p>还没有配置 API Key。</p><Link to="/settings" style={{ color: 'var(--primary)', fontSize: '0.9rem' }}>前往设置</Link></div>}
        {hasApiKey && !aiMessage && !aiLoading && <div style={{ textAlign: 'center', padding: '16px 0 8px' }}><button className="btn btn-primary" onClick={handleAiAnalyze}>分析今日</button></div>}
        {aiLoading && <div className="ai-chat-placeholder"><p>AI 正在分析...</p></div>}
        {aiError && <div className="ai-draft-error">{aiError}<div style={{ marginTop: 8 }}><button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>重试</button></div></div>}
        {aiMessage && <div><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: '0.92rem', background: '#f9fafb', padding: '16px', borderRadius: 8, marginBottom: 12 }}>{aiMessage}</div><button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>重新分析</button></div>}
      </div>

      <div className="ai-chat">
        <h3>AI 复盘</h3>
        <p className="hint-line">单轮流程：AI 先提问，你回答后再生成复盘总结。结果不会自动保存。</p>
        {hasApiKey && reflectionQuestions.length === 0 && !reflectionSummary && <div style={{ textAlign: 'center', padding: '12px 0' }}><button className="btn btn-primary" disabled={reflectionLoading} onClick={handleStartReflection}>{reflectionLoading ? '提问中...' : '开始 AI 复盘'}</button></div>}
        {reflectionQuestions.length > 0 && (
          <div className="ai-followup-panel">
            <strong>问题</strong>
            <ol>{reflectionQuestions.map((question, index) => <li key={index}>{question}</li>)}</ol>
            <div className="form-group"><label>你的回答</label><textarea value={reflectionAnswer} onChange={e => setReflectionAnswer(e.target.value)} placeholder="回答一次，然后生成复盘总结。" /></div>
            <button className="btn btn-primary" disabled={reflectionLoading || !reflectionAnswer.trim()} onClick={handleFinishReflection}>{reflectionLoading ? '总结中...' : '生成复盘总结'}</button>
          </div>
        )}
        {reflectionError && <div className="ai-draft-error" style={{ whiteSpace: 'pre-wrap' }}>{reflectionError}</div>}
        {reflectionSummary && <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, background: '#f9fafb', padding: 16, borderRadius: 8, marginTop: 12 }}>{reflectionSummary}</div>}
        {hasApiKey && <div style={{ textAlign: 'center', paddingTop: 16 }}><button className="btn btn-secondary" disabled={draftLoading} onClick={handleAiGenerateDrafts}>{draftLoading ? '生成草稿中...' : '生成明日草稿'}</button></div>}
        {draftError && <div className="ai-draft-error" style={{ whiteSpace: 'pre-wrap' }}>{draftError}</div>}
        {draftWarnings.length > 0 && <div className="ai-draft-warning">{draftWarnings.map((warning, index) => <div key={index}>{warning}</div>)}</div>}
        {draftItems.length > 0 && !showDraftReview && <div style={{ textAlign: 'center', paddingTop: 12 }}><button className="btn btn-sm btn-primary" onClick={() => setShowDraftReview(true)}>打开 {draftItems.length} 条草稿</button></div>}
      </div>

      {showDraftReview && <AiDraftReviewModal drafts={draftItems} warnings={draftWarnings} projects={projects} todos={allTodos} onClose={() => setShowDraftReview(false)} onCreated={handleDraftCreated} />}

      <div className="completed-list">
        <h3>今日完成待办</h3>
        {loading ? <div className="hint-line">加载中...</div> : completedTodos.length === 0 ? <div className="hint-line">暂无完成的待办。</div> : completedTodos.map((id, index) => {
          const todo = allTodos.find(t => Number(t.id) === Number(id));
          return <div key={index} style={{ padding: '4px 0', fontSize: '0.9rem' }}>{todo ? todo.name : `待办 #${id}`}</div>;
        })}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>今日日志</h3>
        {templates.length > 0 && <div className="template-bar">{templates.map(t => <button key={t.id} className="template-chip" onClick={() => applyTemplate(t.content)} title={t.name}>{t.name}</button>)}</div>}
        <div className="log-editor"><textarea value={logText} onChange={e => setLogText(e.target.value)} placeholder="记录今天的想法、收获和反思..." readOnly={!isToday} /></div>
        {isToday && <div style={{ marginTop: 12, display: 'flex', gap: 8 }}><button className="btn btn-primary" onClick={handleSave}>保存日志</button></div>}
      </div>
    </div>
  );
}
