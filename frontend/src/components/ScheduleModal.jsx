import { useEffect, useState } from 'react';
import { projectApi, scheduleApi, todoApi } from '../api/client';
import { toLocalISO } from '../utils/time';

function asDateTimeLocal(value) {
  if (!value) return '';
  return value.slice(0, 16);
}

export default function ScheduleModal({
  schedule,
  onClose,
  onSaved,
  defaultPlanned = true,
  defaultDate = '',
  defaultProjectId = null,
  prefill = {},
}) {
  const isEdit = !!schedule;
  const [todos, setTodos] = useState([]);
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({
    project_id: schedule?.project_id ?? prefill.project_id ?? defaultProjectId ?? '',
    name: schedule?.name || prefill.name || '',
    start_time: asDateTimeLocal(schedule?.start_time || prefill.start_time) || (defaultDate ? `${defaultDate}T09:00` : ''),
    end_time: asDateTimeLocal(schedule?.end_time || prefill.end_time) || (defaultDate ? `${defaultDate}T10:00` : ''),
    category: schedule?.category || prefill.category || '普通日程',
    nature: schedule?.nature || prefill.nature || 'no_other_task',
    relax_suggestion: schedule?.relax_suggestion || prefill.relax_suggestion || '',
    linked_todo_ids: schedule?.linked_todo_ids || prefill.linked_todo_ids || [],
    location: schedule?.location || prefill.location || '',
    notes: schedule?.notes || prefill.notes || '',
    is_planned: schedule?.is_planned ?? prefill.is_planned ?? defaultPlanned,
  });

  useEffect(() => {
    projectApi.list().then(setProjects).catch(err => console.error('加载项目失败', err));
    todoApi.list({ is_completed: false }).then(setTodos).catch(err => console.error('加载待办失败', err));
  }, []);

  const handleChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleLinkedTodo = (todoId) => {
    setForm(prev => ({ ...prev, linked_todo_ids: todoId ? [Number(todoId)] : [] }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      project_id: form.project_id ? Number(form.project_id) : null,
      start_time: toLocalISO(form.start_time),
      end_time: toLocalISO(form.end_time),
      nature: 'no_other_task',
      relax_suggestion: null,
      linked_todo_ids: form.linked_todo_ids.filter(Boolean).map(Number),
    };

    try {
      const saved = isEdit
        ? await scheduleApi.update(schedule.id, payload)
        : await scheduleApi.create(payload);
      onSaved(saved);
    } catch (err) {
      alert('操作失败：' + err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2>{isEdit ? '修改日程' : '新建日程'}</h2>
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
            <label>类型</label>
            <select value={form.is_planned ? 'planned' : 'actual'} onChange={e => handleChange('is_planned', e.target.value === 'planned')}>
              <option value="planned">计划日程</option>
              <option value="actual">实际记录</option>
            </select>
          </div>

          <div className="form-group">
            <label>所属项目</label>
            <select value={form.project_id} onChange={e => handleChange('project_id', e.target.value)}>
              <option value="">不归属项目</option>
              {projects.map(project => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>关联待办</label>
            <select value={form.linked_todo_ids[0] || ''} onChange={e => handleLinkedTodo(e.target.value)}>
              <option value="">不关联待办</option>
              {todos.map(todo => (
                <option key={todo.id} value={todo.id}>{todo.name}</option>
              ))}
            </select>
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

          <div className="form-group">
            <label>地点</label>
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
              placeholder="可选备注"
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
