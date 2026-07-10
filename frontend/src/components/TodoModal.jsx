import { useEffect, useState } from 'react';
import { todoApi } from '../api/client';
import { toLocalISO } from '../utils/time';

const DDL_TYPES = [
  { value: 'none', label: '无 DDL（放入计划箱）' },
  { value: 'hard', label: '🔴 硬性 DDL（卡死时间）' },
  { value: 'soft', label: '🟡 弹性 DDL（期望时间）' },
];

const STATUSES = [
  { value: 'not_focusing', label: '不关注' },
  { value: 'focusing', label: '⭐ 正在关注' },
  { value: 'waiting_reply', label: '⏳ 等待他人答复' },
];

export default function TodoModal({ todo, onClose, onSaved }) {
  const isEdit = !!todo;
  const [categorySuggestions, setCategorySuggestions] = useState([]);
  const [form, setForm] = useState({
    name: todo?.name || '',
    ddl_type: todo?.ddl_type || 'none',
    ddl_date: todo?.ddl_date ? todo.ddl_date.slice(0, 16) : '',
    reminder_days: todo?.reminder_days ?? '',
    category: todo?.category || '计划箱',
    status: todo?.status || 'not_focusing',
    waiting_reply_person: todo?.waiting_reply_person || '',
    notes: todo?.notes || '',
  });

  const showDdlFields = form.ddl_type === 'hard' || form.ddl_type === 'soft';
  const showReplyPerson = form.status === 'waiting_reply';

  useEffect(() => {
    todoApi.list({})
      .then(todos => {
        const categories = Array.from(new Set(todos.map(t => t.category).filter(Boolean)));
        setCategorySuggestions(categories.slice(0, 50));
      })
      .catch(() => {});
  }, []);

  const handleChange = (field, value) => {
    setForm(prev => {
      const next = { ...prev, [field]: value };
      if (field === 'ddl_type') {
        if (value === 'none') {
          next.ddl_date = '';
          next.reminder_days = '';
          if (!prev.category || prev.category === '任务') next.category = '计划箱';
        } else if (!prev.category || prev.category === '计划箱') {
          next.category = '任务';
        }
      }
      if (field === 'status' && value !== 'waiting_reply') {
        next.waiting_reply_person = '';
      }
      return next;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      reminder_days: showDdlFields ? Number(form.reminder_days) : null,
      ddl_date: showDdlFields && form.ddl_date ? toLocalISO(form.ddl_date) : null,
    };

    try {
      if (isEdit) {
        await todoApi.update(todo.id, payload);
      } else {
        await todoApi.create(payload);
      }
      onSaved();
    } catch (err) {
      alert('操作失败：' + err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2>{isEdit ? '✏️ 修改待办' : '➕ 新建待办'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>待办名 *</label>
            <input
              value={form.name}
              onChange={e => handleChange('name', e.target.value)}
              placeholder="输入待办名称"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>DDL 类型</label>
            <select value={form.ddl_type} onChange={e => handleChange('ddl_type', e.target.value)}>
              {DDL_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {showDdlFields && (
            <>
              <div className="form-group">
                <label>DDL 日期</label>
                <input
                  type="datetime-local"
                  value={form.ddl_date}
                  onChange={e => handleChange('ddl_date', e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>提前几天提醒</label>
                <input
                  type="number"
                  min="0"
                  value={form.reminder_days}
                  onChange={e => handleChange('reminder_days', e.target.value)}
                  placeholder="例如：3"
                  required
                />
              </div>
            </>
          )}

          <div className="form-group">
            <label>属性分类</label>
            <input
              value={form.category}
              onChange={e => handleChange('category', e.target.value)}
              placeholder="默认：任务"
              list="todo-category-suggestions"
            />
            <datalist id="todo-category-suggestions">
              {categorySuggestions.map(category => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </div>

          <div className="form-group">
            <label>状态</label>
            <select value={form.status} onChange={e => handleChange('status', e.target.value)}>
              {STATUSES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          {showReplyPerson && (
            <div className="form-group">
              <label>等待谁答复（可选）</label>
              <input
                value={form.waiting_reply_person}
                onChange={e => handleChange('waiting_reply_person', e.target.value)}
                placeholder="填写姓名"
              />
            </div>
          )}

          <div className="form-group">
            <label>备注</label>
            <textarea
              value={form.notes}
              onChange={e => handleChange('notes', e.target.value)}
              placeholder="可选备注..."
            />
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary">
              {isEdit ? '保存修改' : '创建待办'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
