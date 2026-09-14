import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { projectApi, recurrenceApi, scheduleApi, todoApi } from '../api/client';
import { toLocalISO } from '../utils/time';

function asDateTimeLocal(value) {
  if (!value) return '';
  return value.slice(0, 16);
}

function datePart(value) {
  return value ? value.slice(0, 10) : '';
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekdayFromDate(dateStr) {
  const day = new Date(`${dateStr}T00:00:00`).getDay();
  return day === 0 ? 7 : day;
}

const FREQUENCIES = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

function shouldAutoFocus() {
  return !Capacitor.isNativePlatform() && !window.matchMedia('(max-width: 600px)').matches;
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
    is_planned: true,
  });
  const [recurrence, setRecurrence] = useState({
    enabled: false,
    frequency: 'weekly',
    start_date: datePart(asDateTimeLocal(schedule?.start_time || prefill.start_time)) || defaultDate || datePart(new Date().toISOString()),
    end_date: '',
    weekdays: [],
    month_day: new Date().getDate(),
  });

  useEffect(() => {
    projectApi.list().then(setProjects).catch(err => console.error('加载项目失败', err));
    todoApi.list({ is_completed: false }).then(setTodos).catch(err => console.error('加载待办失败', err));
  }, []);

  const canCreateRule = !isEdit && form.is_planned && recurrence.enabled;

  const handleChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleRecurrenceChange = (field, value) => {
    setRecurrence(prev => ({ ...prev, [field]: value }));
  };

  const handleLinkedTodo = (todoId) => {
    setForm(prev => ({ ...prev, linked_todo_ids: todoId ? [Number(todoId)] : [] }));
  };

  const toggleWeekday = (day) => {
    setRecurrence(prev => {
      const selected = new Set(prev.weekdays);
      if (selected.has(day)) selected.delete(day);
      else selected.add(day);
      return { ...prev, weekdays: Array.from(selected).sort((a, b) => a - b) };
    });
  };

  const buildPayload = () => ({
    ...form,
    project_id: form.project_id ? Number(form.project_id) : null,
    start_time: toLocalISO(form.start_time),
    end_time: toLocalISO(form.end_time),
    nature: 'no_other_task',
    relax_suggestion: null,
    linked_todo_ids: form.linked_todo_ids.filter(Boolean).map(Number),
    is_planned: true,
  });

  const createRecurrenceRule = async (payload) => {
    const startDate = recurrence.start_date || datePart(form.start_time);
    const weekdays = recurrence.weekdays.length > 0 ? recurrence.weekdays : [weekdayFromDate(startDate)];
    await recurrenceApi.create({
      entity_type: 'schedule',
      template_json: { ...payload, is_planned: true },
      frequency: recurrence.frequency,
      start_date: startDate,
      end_date: recurrence.end_date || null,
      weekdays: recurrence.frequency === 'weekly' ? weekdays : null,
      month_day: recurrence.frequency === 'monthly' ? Number(recurrence.month_day || 1) : null,
      project_id: payload.project_id,
      status: 'active',
    });
    await recurrenceApi.generate({ entity_type: 'schedule', date_from: startDate, date_to: addDays(startDate, 31) });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = buildPayload();

    try {
      let saved;
      if (isEdit) {
        if (schedule.recurrence_rule_id) {
          const syncAll = window.confirm('这是重复日程实例。点击“确定”同步修改所有未来未例外实例；点击“取消”只修改当前一个。');
          saved = syncAll
            ? await recurrenceApi.syncSchedule(schedule.id, payload)
            : await scheduleApi.update(schedule.id, payload);
        } else {
          saved = await scheduleApi.update(schedule.id, payload);
        }
      } else if (canCreateRule) {
        saved = await createRecurrenceRule(payload);
      } else {
        saved = await scheduleApi.create(payload);
      }
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
            <input value={form.name} onChange={e => handleChange('name', e.target.value)} placeholder="输入日程名称" required autoFocus={shouldAutoFocus()} />
          </div>

          <div className="form-group">
            <label>所属项目</label>
            <select value={form.project_id} onChange={e => handleChange('project_id', e.target.value)}>
              <option value="">不归属项目</option>
              {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label>关联待办</label>
            <select value={form.linked_todo_ids[0] || ''} onChange={e => handleLinkedTodo(e.target.value)}>
              <option value="">不关联待办</option>
              {todos.map(todo => <option key={todo.id} value={todo.id}>{todo.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label>开始时间 *</label>
            <input type="datetime-local" value={form.start_time} onChange={e => handleChange('start_time', e.target.value)} required />
          </div>

          <div className="form-group">
            <label>结束时间 *</label>
            <input type="datetime-local" value={form.end_time} onChange={e => handleChange('end_time', e.target.value)} required />
          </div>

          {!isEdit && form.is_planned && (
            <div className="form-group">
              <label>
                <input type="checkbox" checked={recurrence.enabled} onChange={e => handleRecurrenceChange('enabled', e.target.checked)} />
                {' '}创建为重复计划日程
              </label>
            </div>
          )}

          {canCreateRule && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="form-group">
                <label>重复频率</label>
                <select value={recurrence.frequency} onChange={e => handleRecurrenceChange('frequency', e.target.value)}>
                  {FREQUENCIES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>开始日期</label>
                <input type="date" value={recurrence.start_date} onChange={e => handleRecurrenceChange('start_date', e.target.value)} required />
              </div>
              <div className="form-group">
                <label>结束日期</label>
                <input type="date" value={recurrence.end_date} onChange={e => handleRecurrenceChange('end_date', e.target.value)} />
              </div>
              {recurrence.frequency === 'weekly' && (
                <div className="form-group">
                  <label>星期</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {[1, 2, 3, 4, 5, 6, 7].map(day => (
                      <label key={day}><input type="checkbox" checked={recurrence.weekdays.includes(day)} onChange={() => toggleWeekday(day)} /> 周{day === 7 ? '日' : day}</label>
                    ))}
                  </div>
                </div>
              )}
              {recurrence.frequency === 'monthly' && (
                <div className="form-group">
                  <label>每月几号</label>
                  <input type="number" min="1" max="31" value={recurrence.month_day} onChange={e => handleRecurrenceChange('month_day', e.target.value)} />
                </div>
              )}
            </div>
          )}

          <div className="form-group">
            <label>地点</label>
            <input value={form.location} onChange={e => handleChange('location', e.target.value)} placeholder="例如：图书馆" />
          </div>

          <div className="form-group">
            <label>备注</label>
            <textarea value={form.notes} onChange={e => handleChange('notes', e.target.value)} placeholder="可选备注" />
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary">{isEdit ? '保存修改' : canCreateRule ? '创建重复规则' : '创建日程'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
