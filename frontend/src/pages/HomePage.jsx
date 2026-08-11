import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { todoApi, scheduleApi, logApi, recurrenceApi, projectApi } from '../api/client';
import TodoModal from '../components/TodoModal';
import ScheduleModal from '../components/ScheduleModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, formatTime, todayStr } from '../utils/time';
import { DISPLAY_PREFERENCES_EVENT, readDisplayPreferences } from '../utils/displayPreferences';

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayLabel() {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());
}

export default function HomePage() {
  const [currentSchedule, setCurrentSchedule] = useState(null);
  const [waitingTodos, setWaitingTodos] = useState([]);
  const [focusingTodos, setFocusingTodos] = useState([]);
  const [ddlNearTodos, setDdlNearTodos] = useState([]);
  const [allTodos, setAllTodos] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [displayPreferences, setDisplayPreferences] = useState(readDisplayPreferences);
  const [showTodoModal, setShowTodoModal] = useState(false);
  const [editTodo, setEditTodo] = useState(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showTodoPicker, setShowTodoPicker] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [completingIds, setCompletingIds] = useState(new Set());

  const loadData = useCallback(async () => {
    try {
      setLoadError('');
      const today = todayStr();
      await Promise.all([
        recurrenceApi.generate({ entity_type: 'todo', date_from: today, date_to: addDays(today, 7) }),
        recurrenceApi.generate({ entity_type: 'schedule', date_from: today, date_to: today }),
      ]);
      const [current, waiting, focusing, ddlNear, todos, projectList] = await Promise.all([
        scheduleApi.current(),
        todoApi.waitingReply(),
        todoApi.focusing(),
        todoApi.ddlNear(),
        todoApi.list({ is_completed: false }),
        projectApi.list(),
      ]);
      setCurrentSchedule(current);
      setWaitingTodos(waiting);
      setFocusingTodos(focusing);
      setDdlNearTodos(ddlNear);
      setAllTodos(todos);
      setProjects(projectList.filter(project => project.status === 'active').slice(0, 3));
    } catch (err) {
      console.error('加载首页数据失败', err);
      setLoadError('首页数据暂时没有加载完整。你的本地数据没有变化，可以稍后重试。');
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const refresh = () => setDisplayPreferences(readDisplayPreferences());
    window.addEventListener(DISPLAY_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(DISPLAY_PREFERENCES_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const handleComplete = async (todo) => {
    setCompletingIds(prev => new Set([...prev, todo.id]));
    try {
      await todoApi.update(todo.id, { is_completed: true });
      const today = todayStr();
      const existingLog = await logApi.get(today).catch(() => null);
      const completedIds = existingLog
        ? Array.from(new Set([...existingLog.completed_todo_ids, todo.id]))
        : [todo.id];
      await logApi.upsert({ log_date: today, completed_todo_ids: completedIds, log_text: existingLog?.log_text || '' });
      setTimeout(() => {
        setCompletingIds(prev => {
          const next = new Set(prev);
          next.delete(todo.id);
          return next;
        });
        loadData();
      }, 300);
    } catch (err) {
      console.error('完成任务失败', err);
      setCompletingIds(prev => {
        const next = new Set(prev);
        next.delete(todo.id);
        return next;
      });
    }
  };

  const handleContextMenu = (e, todo) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, todo });
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    const todo = contextMenu.todo;
    if (todo.recurrence_rule_id) {
      const deleteAll = window.confirm('这是重复待办实例。点击“确定”删除所有未来未完成实例并停止规则；点击“取消”只删除当前一个。');
      if (deleteAll) await recurrenceApi.delete(todo.recurrence_rule_id, true);
      else await todoApi.delete(todo.id);
    } else {
      await todoApi.delete(todo.id);
    }
    setContextMenu(null);
    loadData();
  };

  const handleCancelFocus = async () => {
    if (!contextMenu) return;
    await todoApi.update(contextMenu.todo.id, { status: 'not_focusing' });
    setContextMenu(null);
    loadData();
  };

  const handleEdit = () => {
    if (!contextMenu) return;
    setEditTodo(contextMenu.todo);
    setShowTodoModal(true);
    setContextMenu(null);
  };

  const handleAddToFocusing = async (todoId) => {
    await todoApi.update(todoId, { status: 'focusing' });
    setShowTodoPicker(false);
    loadData();
  };

  const contextMenuItems = contextMenu ? [
    { label: '修改', onClick: handleEdit },
    ...(contextMenu.todo.status === 'focusing' ? [{ label: '取消关注', onClick: handleCancelFocus }] : []),
    { label: '删除', onClick: handleDelete, danger: true },
  ] : [];

  const renderTodoItem = (todo, { showDdlType = false } = {}) => (
    <div key={todo.id} className="todo-item" onContextMenu={e => handleContextMenu(e, todo)} title={todo.notes || undefined}>
      <button
        className={`todo-circle ${completingIds.has(todo.id) ? 'completed' : ''}`}
        onClick={() => handleComplete(todo)}
        aria-label={`完成待办：${todo.name}`}
      />
      <span className="todo-name">{todo.name}</span>
      {todo.recurrence_rule_id && <span className="todo-meta">重复</span>}
      {showDdlType && todo.is_hard_ddl_near && <span className="deadline-type hard">硬性</span>}
      {showDdlType && todo.is_soft_ddl_near && <span className="deadline-type soft">弹性</span>}
      {todo.ddl_date && <span className="todo-meta">{parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN')}</span>}
    </div>
  );

  const hardNearTodos = ddlNearTodos.filter(t => t.is_hard_ddl_near);
  const softNearTodos = ddlNearTodos.filter(t => t.is_soft_ddl_near);
  const availableTodos = allTodos.filter(t => t.status !== 'focusing' && !t.is_completed);
  const modules = displayPreferences.homeModules;

  return (
    <div className="home-page">
      <header className="home-hero">
        <div>
          <div className="eyebrow">今天 · {todayLabel()}</div>
          <h1>日子缓缓向前，走过的地方自会留下痕迹。</h1>
          <p>先照顾眼前最重要的事，晚些时候再回看计划与现实。</p>
        </div>
        <div className="home-actions">
          <button className="btn btn-primary" onClick={() => { setEditTodo(null); setShowTodoModal(true); }}>新建待办</button>
          <button className="btn btn-secondary" onClick={() => setShowScheduleModal(true)}>安排日程</button>
          <Link className="btn btn-quiet" to="/ai-create">AI 新建</Link>
        </div>
      </header>

      {loadError && <div className="notice notice-error" role="alert">{loadError}</div>}

      {modules.currentSchedule && (
        <section className="current-schedule" aria-labelledby="current-schedule-title">
          <div className="current-schedule-label" id="current-schedule-title"><span />此刻</div>
          {currentSchedule ? (
            <>
              <div className="schedule-name">{currentSchedule.name}</div>
              <div className="schedule-time">
                {formatTime(currentSchedule.start_time)}—{formatTime(currentSchedule.end_time)} · 剩余{' '}
                {Math.max(0, Math.floor((parseAsLocal(currentSchedule.end_time) - new Date()) / 60000))} 分钟
              </div>
              {currentSchedule.recurrence_rule_id && <div className="schedule-extra">重复日程</div>}
              {currentSchedule.linked_todo_ids?.length > 0 && (
                <div className="schedule-extra">
                  关联待办：{currentSchedule.linked_todo_ids.map(id => allTodos.find(t => t.id === id)?.name || `#${id}`).join('、')}
                </div>
              )}
            </>
          ) : (
            <div className="no-schedule"><strong>现在没有进行中的日程</strong><span>留白也是一天的一部分。</span></div>
          )}
        </section>
      )}

      <div className="home-grid">
        <div className="home-main-column">
          {modules.focusingTodos && (
            <section className="card home-section">
              <div className="card-header">
                <span><small>优先关注</small>正在关注 <em>{focusingTodos.length}/3</em></span>
                {focusingTodos.length < 3 && <button className="btn btn-sm btn-secondary" onClick={() => setShowTodoPicker(true)}>添加</button>}
              </div>
              {focusingTodos.length === 0
                ? <div className="empty-state small">今天还没有设定关注项。</div>
                : focusingTodos.map(todo => renderTodoItem(todo))}
            </section>
          )}

          {modules.nearDeadlines && (
            <section className="card home-section">
              <div className="card-header"><span><small>提前看见</small>临近 DDL <em>{ddlNearTodos.length}</em></span></div>
              {ddlNearTodos.length === 0 ? <div className="empty-state small">近期没有临近期限。</div> : (
                <>
                  {hardNearTodos.map(todo => renderTodoItem(todo, { showDdlType: true }))}
                  {softNearTodos.map(todo => renderTodoItem(todo, { showDdlType: true }))}
                </>
              )}
            </section>
          )}
        </div>

        <aside className="home-side-column">
          {modules.projects && (
            <section className="card home-section project-glance">
              <div className="card-header"><span><small>持续推进</small>项目</span><Link to="/projects">查看全部</Link></div>
              {projects.length === 0 ? <div className="empty-state small">暂无进行中的项目。</div> : projects.map(project => (
                <Link className="home-project-row" key={project.id} to={`/projects/${project.id}`}>
                  <i style={{ background: project.color || 'var(--primary)' }} />
                  <span><strong>{project.name}</strong><small>{project.next_todo ? `下一步 · ${project.next_todo.name}` : '还没有下一步待办'}</small></span>
                  <em>{Math.round((project.progress || 0) * 100)}%</em>
                </Link>
              ))}
            </section>
          )}

          {modules.waitingReplies && (
            <section className="card home-section waiting-glance">
              <div className="card-header"><span><small>留给对方一点时间</small>等待答复 <em>{waitingTodos.length}</em></span></div>
              {waitingTodos.length === 0
                ? <div className="empty-state small">没有等待中的事项。</div>
                : waitingTodos.map(todo => renderTodoItem(todo))}
            </section>
          )}
        </aside>
      </div>

      <footer className="local-trust-note"><span aria-hidden="true">●</span> 数据保存在你的设备上 · 页面开关不会删除任何记录</footer>

      {showTodoModal && (
        <TodoModal
          todo={editTodo}
          onClose={() => { setShowTodoModal(false); setEditTodo(null); }}
          onSaved={() => { setShowTodoModal(false); setEditTodo(null); loadData(); }}
        />
      )}

      {showScheduleModal && (
        <ScheduleModal
          onClose={() => setShowScheduleModal(false)}
          onSaved={() => { setShowScheduleModal(false); loadData(); }}
        />
      )}

      {showTodoPicker && (
        <div className="modal-overlay" onClick={() => setShowTodoPicker(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>从任务库选择</h2>
            {availableTodos.length === 0 ? (
              <div className="empty-state">暂无可添加的任务。</div>
            ) : availableTodos.map(todo => (
              <div key={todo.id} className="todo-item" onClick={() => handleAddToFocusing(todo.id)}>
                <span className="todo-name">{todo.name}</span>
                {todo.ddl_date && <span className="todo-meta">{parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN')}</span>}
              </div>
            ))}
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setShowTodoPicker(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenuItems} onClose={() => setContextMenu(null)} />}
    </div>
  );
}
