import { useRef, useState } from 'react';
import { timeBlockApi } from '../api/client';
import { groupTimeBlocks, minuteLabel } from '../utils/timeBlocks';

const HOUR_HEIGHT = 64;

export default function ActualTimeBlocks({ date, blocks, categories, todos, projects, granularity, onChanged }) {
  const [selection, setSelection] = useState(null);
  const [editing, setEditing] = useState(false);
  const [extendFrom, setExtendFrom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ category_id: '', notes: '', linked_todo_id: '', manual_project_id: '' });
  const drag = useRef(null);
  const groups = groupTimeBlocks(blocks);
  const categoryById = new Map(categories.map(item => [item.id, item]));
  const todoById = new Map(todos.map(item => [item.id, item]));
  const projectById = new Map(projects.map(item => [item.id, item]));
  const slots = Array.from({ length: 1440 / granularity }, (_, index) => index * granularity);

  const slotFromEvent = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const minute = Math.floor(Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top)) / (HOUR_HEIGHT / 60) / granularity) * granularity;
    return Math.max(0, Math.min(1440 - granularity, minute));
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const minute = slotFromEvent(event);
    if (extendFrom !== null) {
      setSelection({ start: Math.min(extendFrom, minute), end: Math.max(extendFrom, minute) + granularity });
      setExtendFrom(null);
      return;
    }
    drag.current = { anchor: minute, last: minute };
    setSelection({ start: minute, end: minute + granularity });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event) => {
    if (!drag.current) return;
    const minute = slotFromEvent(event);
    drag.current.last = minute;
    setSelection({ start: Math.min(drag.current.anchor, minute), end: Math.max(drag.current.anchor, minute) + granularity });
  };

  const handlePointerUp = () => {
    if (!drag.current) return;
    const { anchor, last } = drag.current;
    drag.current = null;
    if (anchor === last) {
      const group = groups.find(item => item.start_minute <= anchor && item.end_minute > anchor);
      if (group) setSelection({ start: group.start_minute, end: group.end_minute });
    }
  };

  const slotMetadata = (minute) => blocks.find(item => item.start_minute <= minute && item.end_minute > minute);

  const paint = async (categoryId) => {
    if (!selection) return;
    setBusy(true);
    setError('');
    try {
      const items = [];
      const step = selection.start % granularity || selection.end % granularity ? 15 : granularity;
      for (let minute = selection.start; minute < selection.end; minute += step) {
        const halves = step === 30 && blocks.some(item => item.granularity === 15 && item.start_minute < minute + 30 && item.end_minute > minute)
          ? [minute, minute + 15] : [minute];
        for (const start of halves) {
          const original = slotMetadata(start);
          const size = halves.length === 2 ? 15 : step;
          items.push({
            start_minute: start, end_minute: start + size, granularity: size,
            category_id: categoryId, notes: original?.notes || '',
            linked_todo_id: original?.linked_todo_id || null,
            manual_project_id: original?.linked_todo_id ? null : original?.manual_project_id || null,
            source: 'manual',
          });
        }
      }
      await timeBlockApi.replaceRange({ block_date: date, start_minute: selection.start, end_minute: selection.end, blocks: items });
      await onChanged();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };

  const clear = async () => {
    if (!selection) return;
    setBusy(true);
    setError('');
    try {
      await timeBlockApi.replaceRange({ block_date: date, start_minute: selection.start, end_minute: selection.end, blocks: [] });
      setSelection(null);
      await onChanged();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };

  const openDetails = () => {
    if (!selection) return;
    const original = slotMetadata(selection.start);
    setForm({
      category_id: String(original?.category_id || categories[0]?.id || ''),
      notes: original?.notes || '',
      linked_todo_id: String(original?.linked_todo_id || ''),
      manual_project_id: String(original?.linked_todo_id ? '' : original?.manual_project_id || ''),
    });
    setEditing(true);
  };

  const saveDetails = async (event) => {
    event.preventDefault();
    if (!selection || !form.category_id) return;
    setBusy(true);
    setError('');
    try {
      const items = [];
      const step = selection.start % granularity || selection.end % granularity ? 15 : granularity;
      for (let minute = selection.start; minute < selection.end; minute += step) {
        items.push({
          start_minute: minute, end_minute: minute + step, granularity: step,
          category_id: Number(form.category_id), notes: form.notes,
          linked_todo_id: form.linked_todo_id ? Number(form.linked_todo_id) : null,
          manual_project_id: form.linked_todo_id ? null : form.manual_project_id ? Number(form.manual_project_id) : null,
          source: 'manual',
        });
      }
      await timeBlockApi.replaceRange({ block_date: date, start_minute: selection.start, end_minute: selection.end, blocks: items });
      setEditing(false);
      await onChanged();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };

  const selectedTodo = form.linked_todo_id ? todoById.get(Number(form.linked_todo_id)) : null;

  return (
    <section className="actual-block-panel">
      <div className="actual-block-toolbar">
        <div>
          <strong>实际时间块</strong>
          <small>拖动选择连续时间块，点击属性即可记录；点已有块可选中整组。</small>
          {selection && <span className="actual-block-selection">{minuteLabel(selection.start)}–{minuteLabel(selection.end)}{extendFrom !== null ? ' · 点选结束块' : ''}</span>}
        </div>
        <div className="actual-block-actions">
          {categories.map(category => (
            <button type="button" key={category.id} disabled={!selection || busy}
              style={{ '--block-color': category.color }} onClick={() => paint(category.id)}>{category.name}</button>
          ))}
          <button className="btn btn-sm btn-secondary" type="button" disabled={!selection || busy}
            onClick={() => setExtendFrom(selection.start)}>扩展选择</button>
          <button className="btn btn-sm btn-secondary" type="button" disabled={!selection || busy} onClick={openDetails}>详情</button>
          <button className="btn btn-sm btn-quiet" type="button" disabled={!selection || busy} onClick={clear}>清空</button>
        </div>
      </div>
      {error && <div role="alert" className="notice notice-error">{error}</div>}
      <div className="actual-block-grid" style={{ height: HOUR_HEIGHT * 24 }} onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
        {slots.map(minute => <div key={minute} className={'actual-block-slot' + (minute % 60 === 0 ? ' hour' : '') +
          (selection && minute >= selection.start && minute < selection.end ? ' selected' : '')}
          style={{ top: minute / 60 * HOUR_HEIGHT, height: granularity / 60 * HOUR_HEIGHT }}>
          {minute % 60 === 0 && <span>{minuteLabel(minute)}</span>}
        </div>)}
        {groups.map(group => {
          const category = categoryById.get(group.category_id);
          const todo = todoById.get(group.linked_todo_id);
          const project = projectById.get(group.project_id);
          return <div key={group.start_minute} className="actual-block-group"
            style={{ top: group.start_minute / 60 * HOUR_HEIGHT, height: Math.max(16, (group.end_minute - group.start_minute) / 60 * HOUR_HEIGHT),
              '--block-color': category?.color || '#347f88' }}>
            <strong>{group.notes || category?.name || '实际记录'}</strong>
            <span>{[category?.name, todo?.name, project?.name].filter(Boolean).join(' · ')}</span>
          </div>;
        })}
      </div>
      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(false)}>
          <form className="modal-content actual-block-dialog" onClick={event => event.stopPropagation()} onSubmit={saveDetails}>
            <h2>编辑实际记录</h2>
            <p>{date} {minuteLabel(selection.start)}–{minuteLabel(selection.end)}</p>
            <div className="form-group"><label>属性</label><select value={form.category_id}
              onChange={event => setForm(prev => ({ ...prev, category_id: event.target.value }))}>
              {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select></div>
            <div className="form-group"><label>备注</label><textarea value={form.notes}
              onChange={event => setForm(prev => ({ ...prev, notes: event.target.value }))} placeholder="具体做了什么" /></div>
            <div className="form-group"><label>关联待办</label><select value={form.linked_todo_id}
              onChange={event => setForm(prev => ({ ...prev, linked_todo_id: event.target.value, manual_project_id: '' }))}>
              <option value="">不关联待办</option>
              {todos.map(todo => <option key={todo.id} value={todo.id}>{todo.name}</option>)}
            </select></div>
            {selectedTodo ? <p>所属项目：{projectById.get(selectedTodo.project_id)?.name || '无项目'}（从待办推导）</p> :
              <div className="form-group"><label>关联项目</label><select value={form.manual_project_id}
                onChange={event => setForm(prev => ({ ...prev, manual_project_id: event.target.value }))}>
                <option value="">无项目</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select></div>}
            <div className="form-actions">
              <button className="btn btn-secondary" type="button" onClick={() => setEditing(false)}>取消</button>
              <button className="btn btn-primary" type="submit" disabled={busy}>保存</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
