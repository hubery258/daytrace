import { useState, useEffect, useCallback } from 'react';
import { todoApi, recurrenceApi } from '../api/client';
import TodoModal from '../components/TodoModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, todayStr } from '../utils/time';

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

  const statusEmoji = {
    waiting_reply: '等待',
    focusing: '关注',
    not_focusing: '任务',
  };

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
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: '1.2rem' }}>待办汇总</h1>
        <button className="btn btn-sm btn-secondary" onClick={() => { setEditTodo(null); setShowTodoModal(true); }}>
          + 新建待办
        </button>
      </div>

      {Object.keys(grouped).length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '40px' }}>
          暂无待办，点击右上角新建。
        </div>
      )}

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="category-section">
          <h2>{category} ({items.length})</h2>
          <div className="card">
            {items.map(todo => (
              <div
                key={todo.id}
                className="todo-item"
                onContextMenu={e => handleContextMenu(e, todo)}
                onClick={() => { setEditTodo(todo); setShowTodoModal(true); }}
                style={{ cursor: 'pointer' }}
              >
                <span style={{ marginRight: 8 }}>{statusEmoji[todo.status] || ''}</span>
                <span className="todo-name">{todo.name}</span>
                {todo.recurrence_rule_id && <span className="todo-meta">重复</span>}
                {todo.ddl_date && (
                  <span className="todo-meta">
                    {parseAsLocal(todo.ddl_date).toLocaleDateString('zh-CN')}
                    {todo.is_hard_ddl_near && ' 硬'}
                    {todo.is_soft_ddl_near && ' 软'}
                  </span>
                )}
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