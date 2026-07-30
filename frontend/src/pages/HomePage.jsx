import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { todoApi, scheduleApi, logApi, recurrenceApi } from '../api/client';
import TodoModal from '../components/TodoModal';
import ScheduleModal from '../components/ScheduleModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, formatTime, todayStr } from '../utils/time';

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function HomePage() {
  const [currentSchedule, setCurrentSchedule] = useState(null);
  const [waitingTodos, setWaitingTodos] = useState([]);
  const [focusingTodos, setFocusingTodos] = useState([]);
  const [ddlNearTodos, setDdlNearTodos] = useState([]);
  const [allTodos, setAllTodos] = useState([]);
  const [showTodoModal, setShowTodoModal] = useState(false);
  const [editTodo, setEditTodo] = useState(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showTodoPicker, setShowTodoPicker] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [completingIds, setCompletingIds] = useState(new Set());

  const loadData = useCallback(async () => {
    try {
      const today = todayStr();
      await Promise.all([
        recurrenceApi.generate({ entity_type: 'todo', date_from: today, date_to: addDays(today, 7) }),
        recurrenceApi.generate({ entity_type: 'schedule', date_from: today, date_to: today }),
      ]);
      const [current, waiting, focusing, ddlNear, todos] = await Promise.all([
        scheduleApi.current(),
        todoApi.waitingReply(),
        todoApi.focusing(),
        todoApi.ddlNear(),
        todoApi.list({ is_completed: false }),
      ]);
      setCurrentSchedule(current);
      setWaitingTodos(waiting);
      setFocusingTodos(focusing);
      setDdlNearTodos(ddlNear);
      setAllTodos(todos);
    } catch (err) {
      console.error('加载首页数据失败', err);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

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

  const renderTodoItem = (todo) => (
    <div key={todo.id} className="todo-item" onContextMenu={e => handleContextMenu(e, todo)} title={todo.notes || undefined}>
      <div className={`todo-circle ${completingIds.has(todo.id) ? 'completed' : ''}`} onClick={() => handleComplete(todo)} />
      <span className="todo-name">{todo.name}</span>
      {todo.recurrence_rule_id && <span className="todo-meta">重复</span>}
      {todo.ddl_date && <span className="todo-meta">{parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN')}</span>}
    </div>
  );

  const hardNearTodos = ddlNearTodos.filter(t => t.is_hard_ddl_near);
  const softNearTodos = ddlNearTodos.filter(t => t.is_soft_ddl_near);
  const availableTodos = allTodos.filter(t => t.status !== 'focusing' && !t.is_completed);

  return (
    <div>
      <div className="current-schedule">
        {currentSchedule ? (
          <>
            <div className="schedule-name">{currentSchedule.name}</div>
            <div className="schedule-time">
              {formatTime(currentSchedule.start_time)} - {formatTime(currentSchedule.end_time)} · 剩余{' '}
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
          <div className="no-schedule">当前没有进行中的日程</div>
        )}
      </div>

      {waitingTodos.length > 0 && (
        <div className="card">
          <div className="card-header">等待他人答复</div>
          {waitingTodos.map(todo => renderTodoItem(todo))}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          正在关注 ({focusingTodos.length}/3)
          {focusingTodos.length < 3 && <button className="btn btn-sm btn-secondary" onClick={() => setShowTodoPicker(true)}>+ 从任务库添加</button>}
        </div>
        {focusingTodos.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '8px 0' }}>暂无关注中的待办。</div>}
        {focusingTodos.map(todo => renderTodoItem(todo))}
      </div>

      <div className="ddl-columns">
        <div className="ddl-column">
          <h3>硬性 DDL 临近</h3>
          {hardNearTodos.map(todo => renderTodoItem(todo))}
          {hardNearTodos.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>暂无</div>}
        </div>
        <div className="ddl-column">
          <h3>弹性 DDL 临近</h3>
          {softNearTodos.map(todo => renderTodoItem(todo))}
          {softNearTodos.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>暂无</div>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-primary" onClick={() => { setEditTodo(null); setShowTodoModal(true); }}>新建待办</button>
        <button className="btn btn-secondary" onClick={() => setShowScheduleModal(true)}>新建日程</button>
        <Link className="btn btn-secondary" to="/ai-create">AI 新建</Link>
      </div>

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
              <div style={{ color: 'var(--text-secondary)', padding: '20px 0', textAlign: 'center' }}>暂无可添加的任务。</div>
            ) : availableTodos.map(todo => (
              <div key={todo.id} className="todo-item" onClick={() => handleAddToFocusing(todo.id)} style={{ cursor: 'pointer' }}>
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