import { useState } from 'react';
import { scheduleApi, todoApi } from '../api/client';
import { toLocalISO } from '../utils/time';

const NATURES = [
  { value: 'no_other_task', label: '🚫 不能安排其他任务' },
  { value: 'relax', label: '🎮 安排摸鱼任务' },
  { value: 'free_arrange', label: '📌 自由安排任务' },
];

export default function ScheduleModal({ schedule, onClose, onSaved, defaultPlanned = true, defaultDate = '' }) {
  const isEdit = !!schedule;
  const [todos, setTodos] = useState([]);
  const [form, setForm] = useState({
    name: schedule?.name || '',
    start_time: schedule?.start_time ? schedule.start_time.slice(0, 16) : (defaultDate ? `${defaultDate}T09:00` : ''),
    end_time: schedule?.end_time ? schedule.end_time.slice(0, 16) : (defaultDate ? `${defaultDate}T10:00` : ''),
    category: schedule?.category || '普通日程',
    nature: schedule?.nature || 'no_other_task',
    relax_suggestion: schedule?.relax_suggestion || '',
    linked_todo_ids: schedule?.linked_todo_ids || [],
    location: schedule?.location || '',
    notes: schedule?.notes || '',
    is_planned: schedule?.is_planned ?? defaultPlanned,
  });
  const [loadedTodos, setLoadedTodos] = useState(false);

  const loadTodos = async () => {
    if (loadedTodos) return;
    try {
      const data = await todoApi.list({ is_completed: false });
      setTodos(data);
      setLoadedTodos(true);
    } catch (err) {
      console.error('加载待办失败', err);
    }
  };

  const handleChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleLinkedTodo = (idx, todoId) => {
    const next = [...form.linked_todo_ids];
    next[idx] = todoId ? Number(todoId) : undefined;
    setForm(prev => ({ ...prev, linked_todo_ids: next.filter(Boolean) }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      start_time: toLocalISO(form.start_time),
      end_time: toLocalISO(form.end_time),
      linked_todo_ids: form.nature === 'free_arrange' ? form.linked_todo_ids.slice(0, 2) : [],
    };

    try {
      if (isEdit) {
        await scheduleApi.update(schedule.id, payload);
      } else {
        await scheduleApi.create(payload);
      }
      onSaved();
    } catch (err) {
      alert('操作失败：' + err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2>{isEdit ? '✏️ 修改日程' : '➕ 新建日程'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>日程名称 *</label>
            <input
              value={form.name}
              onChange={e => handleChange('name', e.target.value)}
              placeholder="输入日程名称"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>开始时间 *</label>
            <input
              type="datetime-local"
              value={form.start_time}
              onChange={e => handleChange('start_time', e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label>结束时间 *</label>
            <input
              type="datetime-local"
              value={form.end_time}
              onChange={e => handleChange('end_time', e.target.value)}
              required
            />
          </div>

          {/* 日程分类暂时隐藏，以后可能恢复
          <div className="form-group">
            <label>属性分类</label>
            <input
              value={form.category}
              onChange={e => handleChange('category', e.target.value)}
              placeholder="默认：普通日程"
            />
          </div>
          */}

          <div className="form-group">
            <label>性质分类</label>
            <select value={form.nature} onChange={e => handleChange('nature', e.target.value)}>
              {NATURES.map(n => (
                <option key={n.value} value={n.value}>{n.label}</option>
              ))}
            </select>
          </div>

          {form.nature === 'relax' && (
            <div className="form-group">
              <label>摸鱼建议</label>
              <input
                value={form.relax_suggestion}
                onChange={e => handleChange('relax_suggestion', e.target.value)}
                placeholder="例如：看一集动漫放松一下"
              />
            </div>
          )}

          {form.nature === 'free_arrange' && (
            <div className="form-group">
              <label>指定关联任务（最多2个）</label>
              {[0, 1].map(idx => (
                <select
                  key={idx}
                  value={form.linked_todo_ids[idx] || ''}
                  onChange={e => handleLinkedTodo(idx, e.target.value)}
                  onFocus={loadTodos}
                  style={{ marginBottom: idx === 0 ? 8 : 0 }}
                >
                  <option value="">不指定</option>
                  {todos.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              ))}
            </div>
          )}

          <div className="form-group">
            <label>地点（可选）</label>
            <input
              value={form.location}
              onChange={e => handleChange('location', e.target.value)}
              placeholder="例如：图书馆"
            />
          </div>

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
              {isEdit ? '保存修改' : '创建日程'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
