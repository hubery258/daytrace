import { useEffect, useState } from 'react';
import { projectApi, recurrenceApi, todoApi } from '../api/client';
import { toLocalISO, todayStr } from '../utils/time';

const T = {
  noDdl: '\u65e0 DDL',
  hardDdl: '\u786c\u6027 DDL',
  softDdl: '\u5f39\u6027 DDL',
  normal: '\u666e\u901a',
  focused: '\u5173\u6ce8\u4e2d',
  waitingReply: '\u7b49\u5f85\u7b54\u590d',
  daily: '\u6bcf\u5929',
  weekly: '\u6bcf\u5468',
  monthly: '\u6bcf\u6708',
  editTodo: '\u4fee\u6539\u5f85\u529e',
  newTodo: '\u65b0\u5efa\u5f85\u529e',
  todoName: '\u5f85\u529e\u540d *',
  todoNamePlaceholder: '\u8f93\u5165\u5f85\u529e\u540d\u79f0',
  project: '\u6240\u5c5e\u9879\u76ee',
  noProject: '\u4e0d\u5f52\u5c5e\u9879\u76ee',
  ddlType: 'DDL \u7c7b\u578b',
  ddlDate: 'DDL \u65e5\u671f',
  reminderDays: '\u63d0\u524d\u51e0\u5929\u63d0\u9192',
  createRecurring: '\u521b\u5efa\u4e3a\u91cd\u590d\u5f85\u529e',
  frequency: '\u91cd\u590d\u9891\u7387',
  startDate: '\u5f00\u59cb\u65e5\u671f',
  endDate: '\u7ed3\u675f\u65e5\u671f',
  weekdays: '\u661f\u671f',
  monthDay: '\u6bcf\u6708\u51e0\u53f7',
  instanceDdl: '\u91cd\u590d\u5b9e\u4f8b DDL',
  sameDayTime: '\u5b9e\u4f8b\u5f53\u5929\u67d0\u4e2a\u65f6\u95f4',
  offsetDays: '\u5b9e\u4f8b\u65e5\u671f\u540e N \u5929',
  ddlTime24: 'DDL \u65f6\u95f4\uff0824 \u5c0f\u65f6\u5236\uff09',
  daysAfter: '\u5b9e\u4f8b\u65e5\u671f\u540e\u51e0\u5929',
  category: '\u5c5e\u6027\u5206\u7c7b',
  status: '\u72b6\u6001',
  replyPerson: '\u7b49\u5f85\u8c01\u7b54\u590d\uff08\u53ef\u9009\uff09',
  notes: '\u5907\u6ce8',
  notesPlaceholder: '\u53ef\u9009\u5907\u6ce8',
  cancel: '\u53d6\u6d88',
  save: '\u4fdd\u5b58\u4fee\u6539',
  createRule: '\u521b\u5efa\u91cd\u590d\u89c4\u5219',
  createTodo: '\u521b\u5efa\u5f85\u529e',
};

const DDL_TYPES = [
  { value: 'none', label: T.noDdl },
  { value: 'hard', label: T.hardDdl },
  { value: 'soft', label: T.softDdl },
];

const STATUSES = [
  { value: 'not_focusing', label: T.normal },
  { value: 'focusing', label: T.focused },
  { value: 'waiting_reply', label: T.waitingReply },
];

const FREQUENCIES = [
  { value: 'daily', label: T.daily },
  { value: 'weekly', label: T.weekly },
  { value: 'monthly', label: T.monthly },
];

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekdayFromDate(dateStr) {
  const day = new Date(`${dateStr}T00:00:00`).getDay();
  return day === 0 ? 7 : day;
}

function weekdayLabel(day) {
  return day === 7 ? '\u5468\u65e5' : `\u5468${day}`;
}

export default function TodoModal({ todo, onClose, onSaved, defaultProjectId = null }) {
  const isEdit = !!todo;
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({
    project_id: todo?.project_id ?? defaultProjectId ?? '',
    name: todo?.name || '',
    ddl_type: todo?.ddl_type || 'none',
    ddl_date: todo?.ddl_date ? todo.ddl_date.slice(0, 16) : '',
    reminder_days: todo?.reminder_days ?? '',
    category: todo?.category || '\u4efb\u52a1',
    status: todo?.status || 'not_focusing',
    waiting_reply_person: todo?.waiting_reply_person || '',
    notes: todo?.notes || '',
  });
  const [recurrence, setRecurrence] = useState({
    enabled: false,
    frequency: 'daily',
    start_date: todayStr(),
    end_date: '',
    weekdays: [],
    month_day: new Date().getDate(),
    ddl_mode: 'none',
    ddl_time: '23:59',
    ddl_offset_days: 0,
  });

  useEffect(() => {
    projectApi.list().then(setProjects).catch(err => console.error('Load projects failed', err));
  }, []);

  const showDdlFields = form.ddl_type === 'hard' || form.ddl_type === 'soft';
  const showReplyPerson = form.status === 'waiting_reply';
  const canCreateRule = !isEdit && recurrence.enabled;

  const handleChange = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  const handleRecurrenceChange = (field, value) => setRecurrence(prev => ({ ...prev, [field]: value }));

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
    reminder_days: showDdlFields || recurrence.ddl_mode !== 'none' ? Number(form.reminder_days || 0) : null,
    ddl_date: showDdlFields && form.ddl_date ? toLocalISO(form.ddl_date) : null,
  });

  const createRecurrenceRule = async (payload) => {
    const weekdays = recurrence.weekdays.length > 0 ? recurrence.weekdays : [weekdayFromDate(recurrence.start_date)];
    const template = {
      ...payload,
      ddl_mode: recurrence.ddl_mode,
      ddl_time: recurrence.ddl_time,
      ddl_offset_days: Number(recurrence.ddl_offset_days || 0),
    };
    await recurrenceApi.create({
      entity_type: 'todo',
      template_json: template,
      frequency: recurrence.frequency,
      start_date: recurrence.start_date,
      end_date: recurrence.end_date || null,
      weekdays: recurrence.frequency === 'weekly' ? weekdays : null,
      month_day: recurrence.frequency === 'monthly' ? Number(recurrence.month_day || 1) : null,
      project_id: payload.project_id,
      status: 'active',
    });
    await recurrenceApi.generate({ entity_type: 'todo', date_from: todayStr(), date_to: addDays(todayStr(), 7) });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = buildPayload();
    try {
      if (isEdit) {
        if (todo.recurrence_rule_id) {
          const syncAll = window.confirm('\u8fd9\u662f\u91cd\u590d\u5f85\u529e\u5b9e\u4f8b\u3002\u70b9\u51fb\u786e\u5b9a\u540c\u6b65\u4fee\u6539\u6240\u6709\u672a\u6765\u672a\u5b8c\u6210\u5b9e\u4f8b\uff1b\u70b9\u51fb\u53d6\u6d88\u53ea\u4fee\u6539\u5f53\u524d\u4e00\u4e2a\u3002');
          if (syncAll) await recurrenceApi.syncTodo(todo.id, payload);
          else await todoApi.update(todo.id, payload);
        } else {
          await todoApi.update(todo.id, payload);
        }
      } else if (canCreateRule) {
        await createRecurrenceRule(payload);
      } else {
        await todoApi.create(payload);
      }
      onSaved();
    } catch (err) {
      alert('\u64cd\u4f5c\u5931\u8d25\uff1a' + err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2>{isEdit ? T.editTodo : T.newTodo}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{T.todoName}</label>
            <input value={form.name} onChange={e => handleChange('name', e.target.value)} placeholder={T.todoNamePlaceholder} required autoFocus />
          </div>

          <div className="form-group">
            <label>{T.project}</label>
            <select value={form.project_id} onChange={e => handleChange('project_id', e.target.value)}>
              <option value="">{T.noProject}</option>
              {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>

          {!canCreateRule && (
            <>
              <div className="form-group">
                <label>{T.ddlType}</label>
                <select value={form.ddl_type} onChange={e => handleChange('ddl_type', e.target.value)}>
                  {DDL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              {showDdlFields && (
                <>
                  <div className="form-group">
                    <label>{T.ddlDate}</label>
                    <input type="datetime-local" value={form.ddl_date} onChange={e => handleChange('ddl_date', e.target.value)} required />
                  </div>
                  <div className="form-group">
                    <label>{T.reminderDays}</label>
                    <input type="number" min="0" value={form.reminder_days} onChange={e => handleChange('reminder_days', e.target.value)} required />
                  </div>
                </>
              )}
            </>
          )}

          {!isEdit && (
            <div className="form-group">
              <label>
                <input type="checkbox" checked={recurrence.enabled} onChange={e => handleRecurrenceChange('enabled', e.target.checked)} />
                {' '}{T.createRecurring}
              </label>
            </div>
          )}

          {canCreateRule && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="form-group">
                <label>{T.frequency}</label>
                <select value={recurrence.frequency} onChange={e => handleRecurrenceChange('frequency', e.target.value)}>
                  {FREQUENCIES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>{T.startDate}</label>
                <input type="date" value={recurrence.start_date} onChange={e => handleRecurrenceChange('start_date', e.target.value)} required />
              </div>
              <div className="form-group">
                <label>{T.endDate}</label>
                <input type="date" value={recurrence.end_date} onChange={e => handleRecurrenceChange('end_date', e.target.value)} />
              </div>
              {recurrence.frequency === 'weekly' && (
                <div className="form-group">
                  <label>{T.weekdays}</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {[1, 2, 3, 4, 5, 6, 7].map(day => (
                      <label key={day}><input type="checkbox" checked={recurrence.weekdays.includes(day)} onChange={() => toggleWeekday(day)} /> {weekdayLabel(day)}</label>
                    ))}
                  </div>
                </div>
              )}
              {recurrence.frequency === 'monthly' && (
                <div className="form-group">
                  <label>{T.monthDay}</label>
                  <input type="number" min="1" max="31" value={recurrence.month_day} onChange={e => handleRecurrenceChange('month_day', e.target.value)} />
                </div>
              )}
              <div className="form-group">
                <label>{T.instanceDdl}</label>
                <select value={recurrence.ddl_mode} onChange={e => handleRecurrenceChange('ddl_mode', e.target.value)}>
                  <option value="none">{T.noDdl}</option>
                  <option value="same_day_time">{T.sameDayTime}</option>
                  <option value="offset_days">{T.offsetDays}</option>
                </select>
              </div>
              {recurrence.ddl_mode !== 'none' && (
                <>
                  <div className="form-group">
                    <label>{T.ddlType}</label>
                    <select value={form.ddl_type === 'none' ? 'hard' : form.ddl_type} onChange={e => handleChange('ddl_type', e.target.value)}>
                      <option value="hard">{T.hardDdl}</option>
                      <option value="soft">{T.softDdl}</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>{T.ddlTime24}</label>
                    <input type="text" inputMode="numeric" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" placeholder="23:59" title="Use 24-hour time, for example 23:59" value={recurrence.ddl_time} onChange={e => handleRecurrenceChange('ddl_time', e.target.value)} />
                  </div>
                  {recurrence.ddl_mode === 'offset_days' && (
                    <div className="form-group">
                      <label>{T.daysAfter}</label>
                      <input type="number" min="0" value={recurrence.ddl_offset_days} onChange={e => handleRecurrenceChange('ddl_offset_days', e.target.value)} />
                    </div>
                  )}
                  <div className="form-group">
                    <label>{T.reminderDays}</label>
                    <input type="number" min="0" value={form.reminder_days || 0} onChange={e => handleChange('reminder_days', e.target.value)} />
                  </div>
                </>
              )}
            </div>
          )}

          <div className="form-group">
            <label>{T.category}</label>
            <input value={form.category} onChange={e => handleChange('category', e.target.value)} placeholder="\u4efb\u52a1" />
          </div>

          <div className="form-group">
            <label>{T.status}</label>
            <select value={form.status} onChange={e => handleChange('status', e.target.value)}>
              {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>

          {showReplyPerson && (
            <div className="form-group">
              <label>{T.replyPerson}</label>
              <input value={form.waiting_reply_person} onChange={e => handleChange('waiting_reply_person', e.target.value)} placeholder="\u59d3\u540d" />
            </div>
          )}

          <div className="form-group">
            <label>{T.notes}</label>
            <textarea value={form.notes} onChange={e => handleChange('notes', e.target.value)} placeholder={T.notesPlaceholder} />
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{T.cancel}</button>
            <button type="submit" className="btn btn-primary">{isEdit ? T.save : canCreateRule ? T.createRule : T.createTodo}</button>
          </div>
        </form>
      </div>
    </div>
  );
}