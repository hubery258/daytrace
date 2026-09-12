import { useEffect, useRef, useState } from 'react';
import { timeBlockApi } from '../api/client';
import { groupTimeBlocks, minuteLabel } from '../utils/timeBlocks';

const HOUR_HEIGHT = 64;

function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? hours + ' 小时' : '', rest ? rest + ' 分钟' : ''].filter(Boolean).join(' ') || '0 分钟';
}

function inkForColor(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!match) return '#fff';
  const rgb = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 > 0.42 ? '#21312f' : '#fff';
}

export default function ActualTimeBlocks({ date, blocks, categories, todos, projects, granularity, onChanged }) {
  const [selection, setSelection] = useState(null);
  const [editing, setEditing] = useState(false);
  const [showEarly, setShowEarly] = useState(false);
  const [extendFrom, setExtendFrom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ category_id: '', notes: '', linked_todo_id: '', manual_project_id: '' });
  const drag = useRef(null);

  useEffect(() => {
    setSelection(null);
    setExtendFrom(null);
    setEditing(false);
    setShowEarly(false);
    setError('');
    drag.current = null;
  }, [date, granularity]);
  const groups = groupTimeBlocks(blocks);
  const categoryById = new Map(categories.map(item => [item.id, item]));
  const todoById = new Map(todos.map(item => [item.id, item]));
  const projectById = new Map(projects.map(item => [item.id, item]));
  const visibleStart = showEarly ? 0 : 360;
  const slots = Array.from({ length: (1440 - visibleStart) / granularity },
    (_, index) => visibleStart + index * granularity);
  const earlyGroups = groups.filter(item => item.start_minute < 360).length;
  const recordedMinutes = blocks.reduce((sum, item) => sum + item.end_minute - item.start_minute, 0);
  const selectedGroup = selection && groups.find(item =>
    item.start_minute === selection.start && item.end_minute === selection.end);
  const dateTitle = new Date(date + 'T12:00:00').toLocaleDateString('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long',
  });

  const slotFromEvent = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const minute = visibleStart + Math.floor(Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top)) / (HOUR_HEIGHT / 60) / granularity) * granularity;
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
    <section className="actual-block-panel" aria-label="实际时间块">
      <header className="actual-block-head">
        <div>
          <span className="actual-block-kicker">实际记录 · 时间块</span>
          <h2>{dateTitle}</h2>
        </div>
        <div className="actual-block-head-meta">
          <strong>{durationLabel(recordedMinutes)}</strong>
          <span>{groups.length} 段记录 · {granularity} 分钟一格</span>
        </div>
      </header>
      {error && <div role="alert" className="notice notice-error actual-block-error">{error}</div>}
      <div className="actual-block-workspace">
        <div className="actual-block-canvas">
          <div className="actual-block-grid-head">
            <span>时间</span>
            <div><span>轻点选一格，拖动选一段</span>
              <button type="button" onClick={() => { setShowEarly(!showEarly); setSelection(null); setExtendFrom(null); }}>
                {showEarly ? '收起凌晨' : '展开凌晨' + (earlyGroups ? ' · ' + earlyGroups : '')}
              </button>
            </div>
          </div>
          <div className="actual-block-grid" style={{ height: (1440 - visibleStart) / 60 * HOUR_HEIGHT }} role="grid"
            aria-label={dateTitle + '实际时间网格'} onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
            onPointerCancel={() => { drag.current = null; setSelection(null); }} onDoubleClick={() => openDetails()}>
            {slots.map(minute => <div key={minute} className={'actual-block-slot' + (minute % 60 === 0 ? ' hour' : '')}
              style={{ top: (minute - visibleStart) / 60 * HOUR_HEIGHT, height: granularity / 60 * HOUR_HEIGHT }}>
              {minute % 60 === 0 && <span>{minuteLabel(minute)}</span>}
            </div>)}
            {groups.filter(group => group.end_minute > visibleStart).map(group => {
              const category = categoryById.get(group.category_id);
              const todo = todoById.get(group.linked_todo_id);
              const project = projectById.get(group.project_id);
              const minutes = group.end_minute - group.start_minute;
              const title = group.notes || category?.name || '实际记录';
              const detail = [todo?.name, project?.name].filter(Boolean).join(' · ');
              return <div key={group.start_minute} className={'actual-block-group' + (minutes < 30 ? ' brief' : '')}
                style={{ top: (Math.max(group.start_minute, visibleStart) - visibleStart) / 60 * HOUR_HEIGHT + 1,
                  height: Math.max(14, (group.end_minute - Math.max(group.start_minute, visibleStart)) / 60 * HOUR_HEIGHT - 2),
                  '--block-color': category?.color || '#347f88',
                  '--block-ink': inkForColor(category?.color || '#347f88') }}
                title={[minuteLabel(group.start_minute) + '–' + minuteLabel(group.end_minute), title, detail].filter(Boolean).join(' · ')}>
                <strong>{title}</strong>
                {minutes >= 45 && <small>{detail || minuteLabel(group.start_minute) + '–' + minuteLabel(group.end_minute)}</small>}
              </div>;
            })}
            {selection && <div className="actual-block-highlight" style={{
              top: (Math.max(selection.start, visibleStart) - visibleStart) / 60 * HOUR_HEIGHT,
              height: (selection.end - Math.max(selection.start, visibleStart)) / 60 * HOUR_HEIGHT,
            }} />}
            {groups.length === 0 && <div className="actual-block-empty-hint">点选空白时间，再点右侧属性，就能记下一段实际时间。</div>}
          </div>
        </div>
        <aside className="actual-block-palette" aria-label="时间块属性与编辑">
          <div className="actual-block-palette-head">
            <strong>属性</strong>
            <span>选时间 · 点颜色</span>
          </div>
          <div className="actual-block-categories">
            {categories.map(category => <button type="button" key={category.id}
              disabled={!selection || busy}
              className={'actual-block-category' + (selectedGroup?.category_id === category.id ? ' current' : '')}
              style={{ '--block-color': category.color, '--block-ink': inkForColor(category.color) }}
              onClick={() => paint(category.id)}>
              <span>{category.name}</span><b aria-hidden="true">＋</b>
            </button>)}
            {categories.length === 0 && <p className="actual-block-no-category">先到设置中新增属性</p>}
          </div>
          <div className="actual-block-selection-panel">
            <span className="actual-block-selection-caption">当前选中</span>
            <strong>{selection ? minuteLabel(selection.start) + '–' + minuteLabel(selection.end) : '点选时间格'}</strong>
            {selection && <small>{durationLabel(selection.end - selection.start)}{extendFrom !== null ? ' · 再点结束格' : ''}</small>}
            <div className="actual-block-edit-actions">
              <button type="button" disabled={!selection || busy}
                onClick={() => setExtendFrom(selection.start)}>扩展</button>
              <button type="button" disabled={!selection || busy} onClick={openDetails}>详情</button>
              <button type="button" disabled={!selection || busy} onClick={clear}>清空</button>
            </div>
          </div>
        </aside>
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
