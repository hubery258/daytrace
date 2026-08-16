import { useState, useEffect, useCallback } from 'react';
import { todoApi, recurrenceApi } from '../api/client';
import TodoModal from '../components/TodoModal';
import ContextMenu from '../components/ContextMenu';
import { BEIJING_TIME_ZONE, parseAsLocal, todayStr } from '../utils/time';

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function TodoSummaryPage() {
  const [todos, setTodos] = useState([]);
  const [showTodoModal, setShowTodoModal] = useState(false);
  const [editTodo, setEditTodo] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  const loadTodos = useCallback(async () => {
    const today = todayStr();
    await recurrenceApi.generate({ entity_type: 'todo', date_from: today, date_to: addDays(today, 7) });
    const data = await todoApi.list({ is_completed: false });
    setTodos(data);
  }, []);

  useEffect(() => { loadTodos().catch(console.error); }, [loadTodos]);

  const grouped = {};
  todos.forEach(t => {
    const cat = t.category || '任务';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(t);
  });

  const handleContextMenu = (e, todo) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, todo });
  };

  const handleEdit = () => {
    if (!contextMenu) return;
    setEditTodo(contextMenu.todo);
    setShowTodoModal(true);
    setContextMenu(null);
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
    loadTodos();
  };

  const contextMenuItems = contextMenu ? [
    { label: '修改', onClick: handleEdit },
    { label: '删除', onClick: handleDelete, danger: true },
  ] : [];

  return (
    <div className="todo-summary-page">
      <header className="page-hero page-hero-compact">
        <div>
          <div className="eyebrow">收拢琐事，留出余地</div>
          <h1>待办</h1>
          <p>按分类整理仍需推进的事项，普通状态不再占用注意力。</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setEditTodo(null); setShowTodoModal(true); }}>
          新建待办
        </button>
      </header>

      {Object.keys(grouped).length === 0 && (
        <div className="card empty-state">
          暂无待办，点击右上角新建。
        </div>
      )}

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="category-section">
          <h2>{category}<span>{items.length}</span></h2>
          <div className="card">
            {items.map(todo => (
              <div
                key={todo.id}
                className={`todo-item ${todo.status === 'focusing' ? 'is-focusing' : ''}`}
                onContextMenu={e => handleContextMenu(e, todo)}
                onClick={() => { setEditTodo(todo); setShowTodoModal(true); }}
              >
                {todo.status === 'focusing' && <span className="todo-focus-marker" title="正在关注" aria-label="正在关注" />}
                {todo.status === 'waiting_reply' && <span className="todo-state-note">等待答复</span>}
                <span className="todo-name">{todo.name}</span>
                {todo.recurrence_rule_id && <span className="todo-meta">重复</span>}
                {todo.ddl_date && (
                  <span className="todo-meta">
                    {parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN', { timeZone: BEIJING_TIME_ZONE })}
                  </span>
                )}
                {todo.is_hard_ddl_near && <span className="deadline-type hard">硬性</span>}
                {todo.is_soft_ddl_near && <span className="deadline-type soft">弹性</span>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {showTodoModal && (
        <TodoModal
          todo={editTodo}
          onClose={() => { setShowTodoModal(false); setEditTodo(null); }}
          onSaved={() => { setShowTodoModal(false); setEditTodo(null); loadTodos(); }}
        />
      )}

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
