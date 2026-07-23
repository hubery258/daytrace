import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { callChatCompletion, getAiConfig } from '../ai/aiClient';
import { parseAiDraftResponse, parseAiQuestionsResponse } from '../ai/aiDraftParser';
import {
  AI_CLARIFICATION_SYSTEM_PROMPT,
  AI_DRAFT_SYSTEM_PROMPT,
  buildAiCreateDraftUserMessage,
  buildClarificationUserMessage,
} from '../ai/aiPrompts';
import AiDraftReviewModal from '../components/AiDraftReviewModal';
import { projectApi, scheduleApi, todoApi } from '../api/client';
import { todayStr } from '../utils/time';

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function AiCreatePage() {
  const today = todayStr();
  const tomorrow = useMemo(() => addDays(today, 1), [today]);
  const [text, setText] = useState('');
  const [projects, setProjects] = useState([]);
  const [todos, setTodos] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [clarifyLoading, setClarifyLoading] = useState(false);
  const [clarifyQuestions, setClarifyQuestions] = useState([]);
  const [clarifyAnswer, setClarifyAnswer] = useState('');
  const [showReview, setShowReview] = useState(false);
  const [createdMessage, setCreatedMessage] = useState('');

  const hasApiKey = !!getAiConfig().apiKey;

  const loadContext = async () => {
    const [projectData, todoData, scheduleData] = await Promise.all([
      projectApi.list().catch(() => []),
      todoApi.list({ is_completed: false }).catch(() => []),
      scheduleApi.list({ date_from: `${today}T00:00:00`, date_to: `${tomorrow}T23:59:59` }).catch(() => []),
    ]);
    setProjects(projectData);
    setTodos(todoData);
    setSchedules(scheduleData);
    return { projectData, todoData, scheduleData };
  };

  useEffect(() => { loadContext(); }, []);

  const resetDraftState = () => {
    setErrors([]);
    setWarnings([]);
    setDrafts([]);
    setCreatedMessage('');
  };

  const buildRequestText = () => {
    if (!clarifyQuestions.length || !clarifyAnswer.trim()) return text;
    return `${text}\n\nClarifying questions:\n${clarifyQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nUser answers:\n${clarifyAnswer}`;
  };

  const handleClarify = async () => {
    if (!text.trim()) {
      setErrors(['请先描述你的大致需求。']);
      return;
    }
    setClarifyLoading(true);
    resetDraftState();
    setClarifyQuestions([]);
    setClarifyAnswer('');
    try {
      const { projectData, todoData, scheduleData } = await loadContext();
      const raw = await callChatCompletion({
        systemPrompt: AI_CLARIFICATION_SYSTEM_PROMPT,
        userMessage: buildClarificationUserMessage({
          text,
          dateContext: { today, tomorrow },
          projects: projectData,
          todos: todoData,
          schedules: scheduleData,
        }),
        maxTokens: 600,
        temperature: 0.35,
      });
      const result = parseAiQuestionsResponse(raw, 'clarification');
      setClarifyQuestions(result.questions);
      setErrors(result.errors);
    } catch (err) {
      setErrors([err.message || 'AI澄清需求失败。']);
    } finally {
      setClarifyLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!text.trim()) {
      setErrors(['请先描述你想创建什么。']);
      return;
    }

    setLoading(true);
    resetDraftState();

    try {
      const { projectData, todoData, scheduleData } = await loadContext();
      const raw = await callChatCompletion({
        systemPrompt: AI_DRAFT_SYSTEM_PROMPT,
        userMessage: buildAiCreateDraftUserMessage({
          text: buildRequestText(),
          dateContext: { today, tomorrow },
          projects: projectData,
          todos: todoData,
          schedules: scheduleData,
        }),
        maxTokens: 1800,
        temperature: 0.25,
      });
      const result = parseAiDraftResponse(raw, { projects: projectData, todos: todoData, schedules: scheduleData });
      setWarnings(result.warnings);
      setErrors(result.errors);
      setDrafts(result.drafts);
      setShowReview(result.drafts.length > 0);
    } catch (err) {
      setErrors([err.message || 'AI草稿生成失败。']);
    } finally {
      setLoading(false);
    }
  };

  const handleCreated = async (created) => {
    setShowReview(false);
    setDrafts([]);
    setCreatedMessage(`已创建 ${created.length} 条待办/日程。`);
    await loadContext();
  };

  return (
    <div className="ai-create-page">
      <div className="detail-back"><Link to="/">返回首页</Link></div>

      <div className="page-header">
        <div>
          <h1>AI新建</h1>
          <p className="hint-line">描述你的计划或需求，AI只会返回草稿，需要你确认后才写入。</p>
        </div>
      </div>

      <div className="card">
        {!hasApiKey && <div className="ai-draft-warning">还没有配置 API Key。请先到 <Link to="/settings">设置页</Link>.</div>}

        <div className="form-group">
          <label>你想创建什么？</label>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="例如：我想读完一本九章的书，每一章一个待办，每个 DDL 比上一个后推 3 天。"
            style={{ minHeight: 160 }}
          />
        </div>

        <div className="ai-context-strip">
          <span>今天：{today}</span>
          <span>明天：{tomorrow}</span>
          <span>项目：{projects.length}</span>
          <span>未完成待办：{todos.length}</span>
          <span>今明日程：{schedules.length}</span>
        </div>

        {clarifyQuestions.length > 0 && (
          <div className="ai-followup-panel">
            <strong>生成草稿前先澄清</strong>
            <ol>
              {clarifyQuestions.map((question, index) => <li key={index}>{question}</li>)}
            </ol>
            <div className="form-group">
              <label>你的回答</label>
              <textarea value={clarifyAnswer} onChange={e => setClarifyAnswer(e.target.value)} placeholder="回答这些问题，然后生成草稿。" />
            </div>
          </div>
        )}

        <div className="form-actions">
          <button className="btn btn-secondary" disabled={!hasApiKey || clarifyLoading || loading} onClick={handleClarify}>
            {clarifyLoading ? '提问中...' : '帮我澄清需求'}
          </button>
          <button className="btn btn-primary" disabled={!hasApiKey || loading || clarifyLoading} onClick={handleGenerate}>
            {loading ? '生成中...' : '生成草稿'}
          </button>
        </div>
      </div>

      {createdMessage && <div className="ai-draft-success">{createdMessage}</div>}
      {warnings.length > 0 && <div className="ai-draft-warning">{warnings.map((warning, index) => <div key={index}>{warning}</div>)}</div>}
      {errors.length > 0 && <div className="ai-draft-error">{errors.map((error, index) => <div key={index}>{error}</div>)}</div>}

      {drafts.length > 0 && !showReview && (
        <div className="card">
          <div className="card-header">已生成 {drafts.length} 条草稿</div>
          <button className="btn btn-primary" onClick={() => setShowReview(true)}>打开确认弹窗</button>
        </div>
      )}

      {showReview && (
        <AiDraftReviewModal
          drafts={drafts}
          warnings={warnings}
          projects={projects}
          todos={todos}
          onClose={() => setShowReview(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
