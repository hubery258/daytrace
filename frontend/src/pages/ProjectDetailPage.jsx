import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { projectApi, todoApi } from '../api/client';
import { callChatCompletion } from '../ai/aiClient';
import { parseAiDraftResponse } from '../ai/aiDraftParser';
import { AI_DRAFT_SYSTEM_PROMPT, buildProjectNextDraftUserMessage } from '../ai/aiPrompts';
import AiDraftReviewModal from '../components/AiDraftReviewModal';
import ProjectModal from '../components/ProjectModal';
import TodoModal from '../components/TodoModal';
import ScheduleModal from '../components/ScheduleModal';
import { parseAsLocal, todayStr } from '../utils/time';

const STATUS_LABELS = {
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  archived: '已归档',
  canceled: '已取消',
};

function formatDate(date) {
  if (!date) return '';
  return new Date(`${date}T00:00:00`).toLocaleDateString('zh-CN');
}

function formatDateTime(value) {
  if (!value) return '';
  return parseAsLocal(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function progressLabel(count, done, progress) {
  if (!count) return '暂无待办';
  return `${done}/${count} · ${Math.round((progress || 0) * 100)}%`;
}

export default function ProjectDetailPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const id = Number(projectId);
  const [overview, setOverview] = useState(null);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [showTodoModal, setShowTodoModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [editTodo, setEditTodo] = useState(null);
  const [editSchedule, setEditSchedule] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiWarnings, setAiWarnings] = useState([]);
  const [aiDrafts, setAiDrafts] = useState([]);
  const [showAiReview, setShowAiReview] = useState(false);

  const loadOverview = useCallback(async () => {
    const data = await projectApi.overview(id);
    setOverview(data);
  }, [id]);

  useEffect(() => {
    loadOverview().catch(err => console.error('加载项目详情失败', err));
  }, [loadOverview]);

  if (!overview) {
    return <div className="card empty-state">加载中...</div>;
  }

  const { project, todos, schedules, progress, todo_count, completed_todo_count } = overview;
  const incompleteTodos = todos.filter(todo => !todo.is_completed);
  const completedTodos = todos.filter(todo => todo.is_completed);

  const updateStatus = async (status) => {
    await projectApi.update(project.id, { status });
    loadOverview();
  };

  const completeTodo = async (todo) => {
    await todoApi.update(todo.id, { is_completed: true });
    loadOverview();
  };


  const handleAiNextSteps = async () => {
    if (!localStorage.getItem('simpletasker_api_key')) {
      setAiError('请先在设置页配置 API Key。');
      return;
    }
    setAiLoading(true);
    setAiError('');
    setAiWarnings([]);
    setAiDrafts([]);
    try {
      const raw = await callChatCompletion({
        systemPrompt: AI_DRAFT_SYSTEM_PROMPT,
        userMessage: buildProjectNextDraftUserMessage({ project, todos, schedules }),
        maxTokens: 1400,
        temperature: 0.3,
      });
      const result = parseAiDraftResponse(raw, { projects: [project], todos, schedules });
      setAiWarnings(result.warnings);
      setAiDrafts(result.drafts);
      setShowAiReview(result.drafts.length > 0);
      setAiError(result.errors.join('\n'));
    } catch (err) {
      setAiError(err.message || 'AI生成失败。');
    } finally {
      setAiLoading(false);
    }
  };

  const handleAiCreated = async () => {
    setShowAiReview(false);
    setAiDrafts([]);
    await loadOverview();
  };

  const handleDeleteProject = async () => {
    const first = window.confirm('确定要硬删除这个项目吗？关联待办和日程会保留，但会解除项目归属。');
    if (!first) return;
    const second = window.confirm('请再次确认：项目本身会被永久删除，无法从归档中恢复。');
    if (!second) return;
    await projectApi.delete(project.id);
    navigate('/projects');
  };

  return (
    <div>
      <div className="detail-back"><Link to="/projects">返回项目列表</Link></div>

      <section className="project-detail-head">
        <div>
          <div className="project-title-row">
            <span className="project-color large" style={{ backgroundColor: project.color || '#4f46e5' }} />
            <h1>{project.name}</h1>
            <span className={`status-pill status-${project.status}`}>{STATUS_LABELS[project.status]}</span>
          </div>
          {project.description && <p>{project.description}</p>}
          {project.ddl_date && <div className="project-card-meta">DDL：{formatDate(project.ddl_date)}</div>}
        </div>
        <button className="btn btn-secondary" onClick={() => setShowProjectModal(true)}>编辑</button>
      </section>

      <section className="card">
        <div className="card-header">项目进度</div>
        <div className="project-progress detail">
          <div className="progress-bar">
            <span style={{ width: progress == null ? '0%' : `${Math.round(progress * 100)}%` }} />
          </div>
          <strong>{progressLabel(todo_count, completed_todo_count, progress)}</strong>
        </div>
        {todo_count > 0 && completed_todo_count === todo_count && project.status !== 'completed' && (
          <div className="hint-line">所有待办已完成，项目仍需要手动确认完成。</div>
        )}
      </section>

      <div className="action-row">
        <button className="btn btn-primary" onClick={() => { setEditTodo(null); setShowTodoModal(true); }}>新建待办</button>
        <button className="btn btn-secondary" onClick={() => { setEditSchedule(null); setShowScheduleModal(true); }}>新建日程</button>
        {project.status !== 'active' && <button className="btn btn-secondary" onClick={() => updateStatus('active')}>设为进行中</button>}
        {project.status !== 'paused' && <button className="btn btn-secondary" onClick={() => updateStatus('paused')}>暂停</button>}
        {project.status !== 'completed' && <button className="btn btn-secondary" onClick={() => updateStatus('completed')}>完成</button>}
        {project.status !== 'canceled' && <button className="btn btn-secondary" onClick={() => updateStatus('canceled')}>取消</button>}
        {project.status !== 'archived' && <button className="btn btn-secondary" onClick={() => updateStatus('archived')}>归档</button>}
        <button className="btn btn-danger" onClick={handleDeleteProject}>硬删除</button>
      </div>

      {aiError && <div className="ai-draft-error" style={{ whiteSpace: 'pre-wrap' }}>{aiError}</div>}
      {aiWarnings.length > 0 && <div className="ai-draft-warning">{aiWarnings.map((warning, index) => <div key={index}>{warning}</div>)}</div>}
      {aiDrafts.length > 0 && !showAiReview && <div className="card"><button className="btn btn-primary" onClick={() => setShowAiReview(true)}>打开 {aiDrafts.length} 条AI草稿</button></div>}

      <section className="category-section">
        <h2>未完成待办 ({incompleteTodos.length})</h2>
        <div className="card">
          {incompleteTodos.length === 0 ? <div className="empty-state small">暂无未完成待办</div> : incompleteTodos.map(todo => (
            <div key={todo.id} className="todo-item" onClick={() => { setEditTodo(todo); setShowTodoModal(true); }}>
              <div className="todo-circle" onClick={(e) => { e.stopPropagation(); completeTodo(todo); }} />
              <span className="todo-name">{todo.name}</span>
              {todo.ddl_date && <span className="todo-meta">{parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN')}</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="category-section">
        <h2>已完成待办 ({completedTodos.length})</h2>
        <div className="card">
          {completedTodos.length === 0 ? <div className="empty-state small">暂无已完成待办</div> : completedTodos.map(todo => (
            <div key={todo.id} className="todo-item completed-row" onClick={() => { setEditTodo(todo); setShowTodoModal(true); }}>
              <span className="todo-name">{todo.name}</span>
              {todo.completed_at && <span className="todo-meta">完成于 {formatDateTime(todo.completed_at)}</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="category-section">
        <h2>关联日程 ({schedules.length})</h2>
        <div className="card">
          {schedules.length === 0 ? <div className="empty-state small">暂无关联日程</div> : schedules.map(schedule => (
            <div key={schedule.id} className="schedule-row" onClick={() => { setEditSchedule(schedule); setShowScheduleModal(true); }}>
              <strong>{schedule.name}</strong>
              <span>{formatDateTime(schedule.start_time)} - {formatDateTime(schedule.end_time)}</span>
              <span>{schedule.is_planned ? '计划' : '实际'}</span>
            </div>
          ))}
        </div>
      </section>

      {showAiReview && (
        <AiDraftReviewModal
          drafts={aiDrafts}
          warnings={aiWarnings}
          projects={[project]}
          todos={todos}
          onClose={() => setShowAiReview(false)}
          onCreated={handleAiCreated}
        />
      )}

      {showProjectModal && (
        <ProjectModal
          project={project}
          onClose={() => setShowProjectModal(false)}
          onSaved={() => { setShowProjectModal(false); loadOverview(); }}
        />
      )}
      {showTodoModal && (
        <TodoModal
          todo={editTodo}
          defaultProjectId={project.id}
          onClose={() => { setShowTodoModal(false); setEditTodo(null); }}
          onSaved={() => { setShowTodoModal(false); setEditTodo(null); loadOverview(); }}
        />
      )}
      {showScheduleModal && (
        <ScheduleModal
          schedule={editSchedule}
          defaultProjectId={project.id}
          defaultDate={todayStr()}
          onClose={() => { setShowScheduleModal(false); setEditSchedule(null); }}
          onSaved={() => { setShowScheduleModal(false); setEditSchedule(null); loadOverview(); }}
        />
      )}
    </div>
  );
}