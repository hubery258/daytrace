import { useState, useEffect, useCallback } from 'react';
import { todoApi, scheduleApi, logApi } from '../api/client';
import TodoModal from '../components/TodoModal';
import ScheduleModal from '../components/ScheduleModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, formatTime, todayStr } from '../utils/time';

export default function HomePage() {
  const [currentSchedule, setCurrentSchedule] = useState(null);
  const [waitingTodos, setWaitingTodos] = useState([]);
  const [focusingTodos, setFocusingTodos] = useState([]);
  const [ddlNearTodos, setDdlNearTodos] = useState([]);
  const [allTodos, setAllTodos] = useState([]);

  // Modals
  const [showTodoModal, setShowTodoModal] = useState(false);
  const [editTodo, setEditTodo] = useState(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showTodoPicker, setShowTodoPicker] = useState(false);

  // Context menu
  const [contextMenu, setContextMenu] = useState(null);

  // Completed animation
  const [completingIds, setCompletingIds] = useState(new Set());

  const loadData = useCallback(async () => {
    try {
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
    if (completingIds.has(todo.id)) return;
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
      }, 1000);
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
    await todoApi.delete(contextMenu.todo.id);
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
    try {
      await todoApi.update(todoId, { status: 'focusing' });
      setShowTodoPicker(false);
      loadData();
    } catch (err) {
      alert('加入关注失败：' + err.message);
    }
  };

  const contextMenuItems = contextMenu ? [
    { label: '✏️ 修改', onClick: handleEdit },
    ...(contextMenu.todo.status === 'focusing'
      ? [{ label: '🔕 取消关注', onClick: handleCancelFocus }]
      : []),
    { label: '🗑️ 删除', onClick: handleDelete, danger: true },
  ] : [];

  const renderTodoItem = (todo, showCategory = true) => (
    <div
      key={todo.id}
      className="todo-item"
      onContextMenu={e => handleContextMenu(e, todo)}
      title={todo.notes || undefined}
    >
      <div
        className={`todo-circle ${completingIds.has(todo.id) ? 'completed' : ''}`}
        onClick={() => handleComplete(todo)}
      />
      <span className="todo-main">
        <span className="todo-name">{todo.name}</span>
        {todo.notes && <span className="todo-note">📝 {todo.notes}</span>}
      </span>
      {todo.ddl_date && (
        <span className="todo-meta">
          {parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN')}
        </span>
      )}
    </div>
  );

  return (
    <div>
      {/* Current Schedule */}
      <div className="current-schedule">
        {currentSchedule ? (
          <>
            <div className="schedule-name">{currentSchedule.name}</div>
            <div className="schedule-time">
              {formatTime(currentSchedule.start_time)}
              {' - '}
              {formatTime(currentSchedule.end_time)}
              {' · 剩余 '}
              {Math.max(0, Math.floor((parseAsLocal(currentSchedule.end_time) - new Date()) / 60000))} 分钟
            </div>
            {currentSchedule.nature === 'relax' && currentSchedule.relax_suggestion && (
              <div className="schedule-extra">🎮 {currentSchedule.relax_suggestion}</div>
            )}
            {currentSchedule.nature === 'free_arrange' && currentSchedule.linked_todo_ids?.length > 0 && (
              <div className="schedule-extra">
                📌 {currentSchedule.linked_todo_ids.map(id => {
                  const t = allTodos.find(t => t.id === id);
                  return t ? t.name : `#${id}`;
                }).join('、')}
              </div>
            )}
          </>
        ) : (
          <div className="no-schedule">📭 当前无进行中的日程</div>
        )}
      </div>

      {/* Waiting Reply */}
      {waitingTodos.length > 0 && (
        <div className="card">
          <div className="card-header">⏳ 等待他人答复</div>
          {waitingTodos.map(todo => (
            <div key={todo.id} className="todo-item" onContextMenu={e => handleContextMenu(e, todo)}>
              <div
                className={`todo-circle ${completingIds.has(todo.id) ? 'completed' : ''}`}
                onClick={() => handleComplete(todo)}
              />
              <span className="todo-main">
                <span className="todo-name">{todo.name}</span>
                {todo.notes && <span className="todo-note">📝 {todo.notes}</span>}
              </span>
              {todo.waiting_reply_person && (
                <span className="todo-meta">@{todo.waiting_reply_person}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Focusing */}
      <div className="card">
        <div className="card-header">
          ⭐ 正在关注 ({focusingTodos.length}/3)
          {focusingTodos.length < 3 && (
            <button className="btn btn-sm btn-secondary" onClick={() => setShowTodoPicker(true)}>
              + 从任务库添加
            </button>
          )}
        </div>
        {focusingTodos.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', padding: '8px 0' }}>
            暂无关注中的待办，点击上方按钮添加
          </div>
        )}
        {focusingTodos.map(todo => renderTodoItem(todo))}
      </div>

      {/* DDL Near */}
      <div className="ddl-columns">
        <div className="ddl-column">
          <h3>🔴 硬性 DDL 临近</h3>
          {ddlNearTodos.filter(t => t.is_hard_ddl_near).sort((a, b) => {
            const aD = parseAsLocal(a.ddl_date);
            const bD = parseAsLocal(b.ddl_date);
            return aD - bD; // 过期在前，逼近的在后
          }).map(todo => renderTodoItem(todo))}
          {ddlNearTodos.filter(t => t.is_hard_ddl_near).length === 0 && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>暂无</div>
          )}
        </div>
        <div className="ddl-column">
          <h3>🟡 弹性 DDL 临近</h3>
          {ddlNearTodos.filter(t => t.is_soft_ddl_near).sort((a, b) => {
            const aD = parseAsLocal(a.ddl_date);
            const bD = parseAsLocal(b.ddl_date);
            return aD - bD;
          }).map(todo => renderTodoItem(todo))}
          {ddlNearTodos.filter(t => t.is_soft_ddl_near).length === 0 && (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>暂无</div>
          )}
        </div>
      </div>

      {/* Floating Action Buttons */}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-primary" onClick={() => { setEditTodo(null); setShowTodoModal(true); }}>
          ➕ 新建待办
        </button>
        <button className="btn btn-secondary" onClick={() => setShowScheduleModal(true)}>
          📅 新建日程
        </button>
      </div>

      {/* Modals */}
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

      {/* Todo Picker (select from task library to add to focusing) */}
      {showTodoPicker && (
        <div className="modal-overlay" onClick={() => setShowTodoPicker(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2>📋 从任务库选择</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 12 }}>
              点击任务将其加入"正在关注"（最多 3 个，当前 {focusingTodos.length}/3）
            </p>
            {allTodos.filter(t => t.status !== 'focusing' && !t.is_completed).length === 0 ? (
              <div style={{ color: 'var(--text-secondary)', padding: '20px 0', textAlign: 'center' }}>
                暂无可添加的任务，请先新建待办
              </div>
            ) : (
              allTodos
                .filter(t => t.status !== 'focusing' && !t.is_completed)
                .map(todo => (
                  <div
                    key={todo.id}
                    className="todo-item"
                    onClick={() => handleAddToFocusing(todo.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="todo-main">
                      <span className="todo-name">{todo.name}</span>
                      {todo.notes && <span className="todo-note">📝 {todo.notes}</span>}
                    </span>
                    {todo.ddl_date && (
                      <span className="todo-meta">
                        {parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                  </div>
                ))
            )}
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setShowTodoPicker(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
