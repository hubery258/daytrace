import { useCallback, useEffect, useMemo, useState } from 'react';
import { projectApi, timerApi, todoApi } from '../api/client';
import ScheduleModal from '../components/ScheduleModal';
import { parseAsLocal } from '../utils/time';

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function computeElapsed(timer) {
  if (!timer) return 0;
  const started = parseAsLocal(timer.started_at).getTime();
  const ended = timer.ended_at ? parseAsLocal(timer.ended_at).getTime() : Date.now();
  let paused = timer.paused_seconds || 0;
  if (timer.status === 'paused' && timer.paused_at) {
    paused += Math.max(0, Math.floor((Date.now() - parseAsLocal(timer.paused_at).getTime()) / 1000));
  }
  return Math.max(0, Math.floor((ended - started) / 1000) - paused);
}

function toDateTimeLocal(value) {
  return value ? value.slice(0, 16) : '';
}

function formatDateTime(value) {
  if (!value) return '';
  return parseAsLocal(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function TimerPage() {
  const [timer, setTimer] = useState(null);
  const [recent, setRecent] = useState([]);
  const [projects, setProjects] = useState([]);
  const [todos, setTodos] = useState([]);
  const [nowTick, setNowTick] = useState(Date.now());
  const [finishTimer, setFinishTimer] = useState(null);
  const [form, setForm] = useState({ name: '', project_id: '', linked_todo_id: '', notes: '' });

  const loadTimer = useCallback(async () => {
    const current = await timerApi.current();
    setTimer(current);
  }, []);

  const loadRecent = useCallback(async () => {
    const data = await timerApi.recent(8);
    setRecent(data);
  }, []);

  useEffect(() => {
    loadTimer().catch(err => console.error('加载计时失败', err));
    loadRecent().catch(err => console.error('加载最近计时失败', err));
    projectApi.list().then(setProjects).catch(err => console.error('加载项目失败', err));
    todoApi.list({ is_completed: false }).then(setTodos).catch(err => console.error('加载待办失败', err));
  }, [loadTimer, loadRecent]);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = useMemo(() => {
    nowTick;
    return computeElapsed(timer);
  }, [timer, nowTick]);

  const handleStart = async (e) => {
    e.preventDefault();
    try {
      const started = await timerApi.start({
        name: form.name,
        project_id: form.project_id ? Number(form.project_id) : null,
        linked_todo_id: form.linked_todo_id ? Number(form.linked_todo_id) : null,
        notes: form.notes,
      });
      setTimer(started);
      setForm({ name: '', project_id: '', linked_todo_id: '', notes: '' });
    } catch (err) {
      alert('开始计时失败：' + err.message);
    }
  };

  const refreshAfterAction = async (action) => {
    try {
      const updated = await action();
      setTimer(updated.status === 'running' || updated.status === 'paused' ? updated : null);
      if (updated.status === 'completed') setFinishTimer(updated);
      await loadRecent();
    } catch (err) {
      alert('操作失败：' + err.message);
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('取消后不会生成实际记录，确定取消这次计时吗？')) return;
    await refreshAfterAction(timerApi.cancel);
  };

  const finishPrefill = finishTimer ? {
    name: finishTimer.name,
    project_id: finishTimer.project_id,
    linked_todo_ids: finishTimer.linked_todo_id ? [finishTimer.linked_todo_id] : [],
    start_time: toDateTimeLocal(finishTimer.started_at),
    end_time: toDateTimeLocal(finishTimer.ended_at),
    notes: finishTimer.notes,
    is_planned: false,
  } : null;

  return (
    <div className="timer-page">
      <section className="timer-panel">
        <div className="timer-head">
          <div>
            <h1>计时</h1>
            <p>记录正在发生的事，结束确认后生成实际日程。</p>
          </div>
          <div className={`timer-status ${timer?.status || 'idle'}`}>{timer ? (timer.status === 'paused' ? '已暂停' : '进行中') : '未开始'}</div>
        </div>

        {timer ? (
          <div className="timer-active">
            <div className="timer-clock">{formatDuration(elapsed)}</div>
            <h2>{timer.name}</h2>
            <div className="timer-meta">
              <span>开始：{formatDateTime(timer.started_at)}</span>
              {timer.notes && <span>备注：{timer.notes}</span>}
            </div>
            <div className="timer-actions">
              {timer.status === 'running' ? (
                <button className="btn btn-secondary" onClick={() => refreshAfterAction(timerApi.pause)}>暂停</button>
              ) : (
                <button className="btn btn-primary" onClick={() => refreshAfterAction(timerApi.resume)}>继续</button>
              )}
              <button className="btn btn-primary" onClick={() => refreshAfterAction(timerApi.finish)}>结束</button>
              <button className="btn btn-danger" onClick={handleCancel}>取消</button>
            </div>
          </div>
        ) : (
          <form className="timer-start-form" onSubmit={handleStart}>
            <div className="form-group">
              <label>事项名称 *</label>
              <input value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} required placeholder="正在做什么？" />
            </div>
            <div className="form-group">
              <label>所属项目</label>
              <select value={form.project_id} onChange={e => setForm(prev => ({ ...prev, project_id: e.target.value }))}>
                <option value="">不归属项目</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>关联待办</label>
              <select value={form.linked_todo_id} onChange={e => setForm(prev => ({ ...prev, linked_todo_id: e.target.value }))}>
                <option value="">不关联待办</option>
                {todos.map(todo => <option key={todo.id} value={todo.id}>{todo.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>备注</label>
              <textarea value={form.notes} onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))} placeholder="可选备注" />
            </div>
            <button className="btn btn-primary" type="submit">开始计时</button>
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-header">最近计时</div>
        {recent.length === 0 ? <div className="empty-state small">暂无最近计时</div> : recent.map(item => (
          <div key={item.id} className="timer-recent-row">
            <strong>{item.name}</strong>
            <span>{formatDuration(item.elapsed_seconds)} · {item.status === 'completed' ? '已结束' : '已取消'}</span>
          </div>
        ))}
      </section>

      {finishPrefill && (
        <ScheduleModal
          defaultPlanned={false}
          prefill={finishPrefill}
          onClose={() => setFinishTimer(null)}
          onSaved={async (schedule) => {
            await timerApi.attachSchedule(finishTimer.id, schedule.id);
            setFinishTimer(null);
            loadRecent();
          }}
        />
      )}
    </div>
  );
}
