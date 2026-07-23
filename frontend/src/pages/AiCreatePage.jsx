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
      setErrors(['Describe your rough need first.']);
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
      setErrors([err.message || 'AI clarification failed.']);
    } finally {
      setClarifyLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!text.trim()) {
      setErrors(['Describe what you want to create first.']);
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
      setErrors([err.message || 'AI draft generation failed.']);
    } finally {
      setLoading(false);
    }
  };

  const handleCreated = async (created) => {
    setShowReview(false);
    setDrafts([]);
    setCreatedMessage(`Created ${created.length} todo/schedule item(s).`);
    await loadContext();
  };

  return (
    <div className="ai-create-page">
      <div className="detail-back"><Link to="/">Back to home</Link></div>

      <div className="page-header">
        <div>
          <h1>AI Create</h1>
          <p className="hint-line">Describe a plan. AI returns drafts only after you review them.</p>
        </div>
      </div>

      <div className="card">
        {!hasApiKey && <div className="ai-draft-warning">No API Key yet. Configure it in <Link to="/settings">Settings</Link>.</div>}

        <div className="form-group">
          <label>What do you want to create?</label>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Example: I want to finish a nine-chapter book. Make one todo per chapter and move each DDL 3 days later."
            style={{ minHeight: 160 }}
          />
        </div>

        <div className="ai-context-strip">
          <span>Today: {today}</span>
          <span>Tomorrow: {tomorrow}</span>
          <span>Projects: {projects.length}</span>
          <span>Open todos: {todos.length}</span>
          <span>Schedules: {schedules.length}</span>
        </div>

        {clarifyQuestions.length > 0 && (
          <div className="ai-followup-panel">
            <strong>Clarify before drafting</strong>
            <ol>
              {clarifyQuestions.map((question, index) => <li key={index}>{question}</li>)}
            </ol>
            <div className="form-group">
              <label>Your answer</label>
              <textarea value={clarifyAnswer} onChange={e => setClarifyAnswer(e.target.value)} placeholder="Answer these questions, then generate drafts." />
            </div>
          </div>
        )}

        <div className="form-actions">
          <button className="btn btn-secondary" disabled={!hasApiKey || clarifyLoading || loading} onClick={handleClarify}>
            {clarifyLoading ? 'Asking...' : 'Help me clarify'}
          </button>
          <button className="btn btn-primary" disabled={!hasApiKey || loading || clarifyLoading} onClick={handleGenerate}>
            {loading ? 'Generating...' : 'Generate drafts'}
          </button>
        </div>
      </div>

      {createdMessage && <div className="ai-draft-success">{createdMessage}</div>}
      {warnings.length > 0 && <div className="ai-draft-warning">{warnings.map((warning, index) => <div key={index}>{warning}</div>)}</div>}
      {errors.length > 0 && <div className="ai-draft-error">{errors.map((error, index) => <div key={index}>{error}</div>)}</div>}

      {drafts.length > 0 && !showReview && (
        <div className="card">
          <div className="card-header">Generated {drafts.length} draft(s)</div>
          <button className="btn btn-primary" onClick={() => setShowReview(true)}>Open review</button>
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
