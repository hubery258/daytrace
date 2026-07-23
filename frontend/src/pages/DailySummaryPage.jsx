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

const DEFAULT_PROMPT = `You are a personal productivity assistant. Analyze today's todos, schedules, and log. Be concrete, gentle, and actionable. Keep the reply around 300-500 Chinese characters if possible.`;

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
      console.error('Load templates failed', err);
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
      setter('Please configure API Key in Settings first.');
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
      alert('Saved');
    } catch (err) {
      alert('Save failed: ' + err.message);
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
      const scheduleInfo = todaySchedules.map(s => `- ${s.name}, ${formatTime(s.start_time)}-${formatTime(s.end_time)}, planned=${s.is_planned}`).join('\n') || 'none';
      const userMessage = `Date: ${selectedDate}\n\nCompleted todos:\n${completedTodoObjects.map(t => `- ${t.name}`).join('\n') || 'none'}\n\nPending todos:\n${pendingTodos.map(t => `- ${t.name}, ddl=${t.ddl_date || 'none'}, status=${t.status}`).join('\n') || 'none'}\n\nSchedules:\n${scheduleInfo}\n\nUser log:\n${log?.log_text || logText || '(empty)'}\n\nAnalyze today's productivity and give suggestions.`;
      const message = await callChatCompletion({
        systemPrompt: localStorage.getItem(STORAGE_KEY_PROMPT) || DEFAULT_PROMPT,
        userMessage,
        maxTokens: 900,
        temperature: 0.7,
      });
      setAiMessage(message || '(AI returned no content)');
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
        userMessage: buildReflectionQuestionUserMessage({
          selectedDate,
          logText,
          completedTodos: completedTodoObjects,
          pendingTodos,
          todaySchedules,
          projects: projectData,
        }),
        maxTokens: 700,
        temperature: 0.35,
      });
      const result = parseAiQuestionsResponse(raw, 'reflection_questions');
      setReflectionQuestions(result.questions);
      setReflectionError(result.errors.join('\n'));
    } catch (err) {
      setReflectionError(err.message || 'Reflection failed.');
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
        userMessage: buildReflectionSummaryUserMessage({
          selectedDate,
          logText,
          questions: reflectionQuestions,
          answer: reflectionAnswer,
          completedTodos: completedTodoObjects,
          pendingTodos,
          todaySchedules,
          projects: projectData,
        }),
        maxTokens: 1000,
        temperature: 0.55,
      });
      setReflectionSummary(summary || '(AI returned no content)');
    } catch (err) {
      setReflectionError(err.message || 'Reflection summary failed.');
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
        userMessage: buildDailyDraftUserMessage({
          selectedDate,
          logText: [logText, reflectionSummary].filter(Boolean).join('\n\nReflection result:\n'),
          completedTodos: completedTodoObjects,
          pendingTodos,
          todaySchedules,
          tomorrowSchedules,
          projects: projectData,
        }),
        maxTokens: 1600,
        temperature: 0.3,
      });
      const result = parseAiDraftResponse(raw, { projects: projectData, todos: allTodos, schedules: tomorrowSchedules });
      setDraftWarnings(result.warnings);
      setDraftItems(result.drafts);
      setShowDraftReview(result.drafts.length > 0);
      setDraftError(result.errors.join('\n'));
    } catch (err) {
      setDraftError(err.message || 'Draft generation failed.');
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
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{isToday ? 'Today summary' : 'Past summary'}</span>
      </div>

      <div className="ai-chat">
        <h3>AI Summary</h3>
        {!hasApiKey && <div className="ai-chat-placeholder"><p>No API Key yet.</p><Link to="/settings" style={{ color: 'var(--primary)', fontSize: '0.9rem' }}>Open Settings</Link></div>}
        {hasApiKey && !aiMessage && !aiLoading && <div style={{ textAlign: 'center', padding: '16px 0 8px' }}><button className="btn btn-primary" onClick={handleAiAnalyze}>Analyze today</button></div>}
        {aiLoading && <div className="ai-chat-placeholder"><p>AI is analyzing...</p></div>}
        {aiError && <div className="ai-draft-error">{aiError}<div style={{ marginTop: 8 }}><button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>Retry</button></div></div>}
        {aiMessage && <div><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: '0.92rem', background: '#f9fafb', padding: '16px', borderRadius: 8, marginBottom: 12 }}>{aiMessage}</div><button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>Analyze again</button></div>}
      </div>

      <div className="ai-chat">
        <h3>AI Reflection</h3>
        <p className="hint-line">Single round: AI asks, you answer, then AI summarizes. Nothing is saved automatically.</p>
        {hasApiKey && reflectionQuestions.length === 0 && !reflectionSummary && <div style={{ textAlign: 'center', padding: '12px 0' }}><button className="btn btn-primary" disabled={reflectionLoading} onClick={handleStartReflection}>{reflectionLoading ? 'Asking...' : 'Start AI reflection'}</button></div>}
        {reflectionQuestions.length > 0 && (
          <div className="ai-followup-panel">
            <strong>Questions</strong>
            <ol>{reflectionQuestions.map((question, index) => <li key={index}>{question}</li>)}</ol>
            <div className="form-group"><label>Your answer</label><textarea value={reflectionAnswer} onChange={e => setReflectionAnswer(e.target.value)} placeholder="Answer once, then generate the reflection summary." /></div>
            <button className="btn btn-primary" disabled={reflectionLoading || !reflectionAnswer.trim()} onClick={handleFinishReflection}>{reflectionLoading ? 'Summarizing...' : 'Generate reflection summary'}</button>
          </div>
        )}
        {reflectionError && <div className="ai-draft-error" style={{ whiteSpace: 'pre-wrap' }}>{reflectionError}</div>}
        {reflectionSummary && <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, background: '#f9fafb', padding: 16, borderRadius: 8, marginTop: 12 }}>{reflectionSummary}</div>}
        {hasApiKey && <div style={{ textAlign: 'center', paddingTop: 16 }}><button className="btn btn-secondary" disabled={draftLoading} onClick={handleAiGenerateDrafts}>{draftLoading ? 'Generating drafts...' : 'Generate tomorrow drafts'}</button></div>}
        {draftError && <div className="ai-draft-error" style={{ whiteSpace: 'pre-wrap' }}>{draftError}</div>}
        {draftWarnings.length > 0 && <div className="ai-draft-warning">{draftWarnings.map((warning, index) => <div key={index}>{warning}</div>)}</div>}
        {draftItems.length > 0 && !showDraftReview && <div style={{ textAlign: 'center', paddingTop: 12 }}><button className="btn btn-sm btn-primary" onClick={() => setShowDraftReview(true)}>Open {draftItems.length} draft(s)</button></div>}
      </div>

      {showDraftReview && <AiDraftReviewModal drafts={draftItems} warnings={draftWarnings} projects={projects} todos={allTodos} onClose={() => setShowDraftReview(false)} onCreated={handleDraftCreated} />}

      <div className="completed-list">
        <h3>Completed todos</h3>
        {loading ? <div className="hint-line">Loading...</div> : completedTodos.length === 0 ? <div className="hint-line">No completed todos.</div> : completedTodos.map((id, index) => {
          const todo = allTodos.find(t => Number(t.id) === Number(id));
          return <div key={index} style={{ padding: '4px 0', fontSize: '0.9rem' }}>{todo ? todo.name : `Todo #${id}`}</div>;
        })}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Daily log</h3>
        {templates.length > 0 && <div className="template-bar">{templates.map(t => <button key={t.id} className="template-chip" onClick={() => applyTemplate(t.content)} title={t.name}>{t.name}</button>)}</div>}
        <div className="log-editor"><textarea value={logText} onChange={e => setLogText(e.target.value)} placeholder="Record thoughts, wins, and reflection..." readOnly={!isToday} /></div>
        {isToday && <div style={{ marginTop: 12, display: 'flex', gap: 8 }}><button className="btn btn-primary" onClick={handleSave}>Save log</button></div>}
      </div>
    </div>
  );
}
