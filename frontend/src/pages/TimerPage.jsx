import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectApi, timerApi, todoApi } from '../api/client';
import ScheduleModal from '../components/ScheduleModal';
import { BEIJING_TIME_ZONE, parseAsLocal } from '../utils/time';

const PENDING_FINISH_TIMER_KEY = 'riji_timer_pending_schedule_id';
const DISMISSED_FINISH_TIMER_KEY = 'riji_timer_dismissed_schedule_id';

function readLocalValue(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}

function writeLocalValue(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* SQLite remains authoritative. */ }
}

function removeLocalValue(key) {
  try { localStorage.removeItem(key); } catch { /* The recovery hint is best effort. */ }
}

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
  return parseAsLocal(value).toLocaleString('zh-CN', { timeZone: BEIJING_TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function TimerPage() {
  const [timer, setTimer] = useState(null);
  const [recent, setRecent] = useState([]);
  const [projects, setProjects] = useState([]);
  const [todos, setTodos] = useState([]);
  const [nowTick, setNowTick] = useState(Date.now());
  const [finishTimer, setFinishTimer] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [form, setForm] = useState({ name: '', project_id: '', linked_todo_id: '', notes: '' });
  const timerNameInputRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const restoreInputAfterCancelRef = useRef(false);
  const finishTimerRef = useRef(null);
  const refreshInFlightRef = useRef(null);

  const loadTimer = useCallback(async () => {
    const current = await timerApi.current();
    setTimer(current);
  }, []);

  const loadRecent = useCallback(async ({ recoverFinished = false } = {}) => {
    const data = await timerApi.recent(8);
    setRecent(data);
    if (!recoverFinished || finishTimerRef.current) return;

    const pendingId = Number(readLocalValue(PENDING_FINISH_TIMER_KEY));
    let recoverable = Number.isInteger(pendingId) && pendingId > 0
      ? data.find(item => Number(item.id) === pendingId && item.status === 'completed' && !item.created_schedule_id)
      : null;

    if (!recoverable) {
      const latest = data[0];
      const dismissedId = Number(readLocalValue(DISMISSED_FINISH_TIMER_KEY));
      const updatedAt = latest?.updated_at ? parseAsLocal(latest.updated_at).getTime() : 0;
      const recentlyFinished = updatedAt > 0 && Date.now() - updatedAt <= 24 * 60 * 60 * 1000;
      if (latest?.status === 'completed' && !latest.created_schedule_id && recentlyFinished && Number(latest.id) !== dismissedId) {
        recoverable = latest;
      }
    }

    if (recoverable) {
      writeLocalValue(PENDING_FINISH_TIMER_KEY, recoverable.id);
      finishTimerRef.current = recoverable;
      setFinishTimer(recoverable);
    } else if (pendingId) {
      removeLocalValue(PENDING_FINISH_TIMER_KEY);
    }
  }, []);

  const refreshTimerState = useCallback(({ recoverFinished = false } = {}) => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const pending = Promise.allSettled([
      loadTimer(),
      loadRecent({ recoverFinished }),
    ]).then((results) => {
      setNowTick(Date.now());
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }).finally(() => {
      refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = pending;
    return pending;
  }, [loadRecent, loadTimer]);

  useEffect(() => {
    finishTimerRef.current = finishTimer;
  }, [finishTimer]);

  useEffect(() => {
    refreshTimerState({ recoverFinished: true }).catch(err => console.error('恢复计时状态失败', err));
    projectApi.list().then(setProjects).catch(err => console.error('加载项目失败', err));
    todoApi.list({ is_completed: false }).then(setTodos).catch(err => console.error('加载待办失败', err));

    const resume = () => {
      if (document.visibilityState === 'visible') {
        refreshTimerState({ recoverFinished: true }).catch(err => console.error('恢复计时状态失败', err));
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
    };
  }, [refreshTimerState]);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (timer || actionBusy || !restoreInputAfterCancelRef.current) return undefined;
    restoreInputAfterCancelRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      window.focus();
      timerNameInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timer, actionBusy]);

  const elapsed = useMemo(() => {
    nowTick;
    return computeElapsed(timer);
  }, [timer, nowTick]);

  const handleStart = async (e) => {
    e.preventDefault();
    if (actionBusy) return;
    setActionBusy(true);
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
    } finally {
      await loadTimer().catch(err => console.error('刷新当前计时失败', err));
      setActionBusy(false);
    }
  };

  const refreshAfterAction = async (action) => {
    if (actionBusy) return;
    setActionBusy(true);
    let updated = null;
    try {
      updated = await action();
      if (updated.status === 'completed') {
        writeLocalValue(PENDING_FINISH_TIMER_KEY, updated.id);
        removeLocalValue(DISMISSED_FINISH_TIMER_KEY);
        finishTimerRef.current = updated;
        setFinishTimer(updated);
      }
    } catch (err) {
      alert('操作失败：' + err.message);
    } finally {
      const results = await Promise.allSettled([loadTimer(), loadRecent()]);
      results.forEach(result => {
        if (result.status === 'rejected') console.error('刷新计时状态失败', result.reason);
      });
      setActionBusy(false);
    }
    return updated;
  };

  const handleCancel = () => {
    if (actionBusy) return;
    setShowCancelConfirm(true);
  };

  const closeCancelConfirm = () => {
    setShowCancelConfirm(false);
    window.requestAnimationFrame(() => cancelButtonRef.current?.focus({ preventScroll: true }));
  };

  const confirmCancel = async () => {
    setShowCancelConfirm(false);
    restoreInputAfterCancelRef.current = true;
    const canceled = await refreshAfterAction(timerApi.cancel);
    if (!canceled) {
      restoreInputAfterCancelRef.current = false;
      window.requestAnimationFrame(() => cancelButtonRef.current?.focus({ preventScroll: true }));
    }
  };

  const dismissFinishTimer = () => {
    if (finishTimer) writeLocalValue(DISMISSED_FINISH_TIMER_KEY, finishTimer.id);
    removeLocalValue(PENDING_FINISH_TIMER_KEY);
    finishTimerRef.current = null;
    setFinishTimer(null);
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
                <button className="btn btn-secondary" disabled={actionBusy} onClick={() => refreshAfterAction(timerApi.pause)}>暂停</button>
              ) : (
                <button className="btn btn-primary" disabled={actionBusy} onClick={() => refreshAfterAction(timerApi.resume)}>继续</button>
              )}
              <button className="btn btn-primary" disabled={actionBusy} onClick={() => refreshAfterAction(timerApi.finish)}>结束</button>
              <button ref={cancelButtonRef} type="button" className="btn btn-danger" disabled={actionBusy} onClick={handleCancel}>取消</button>
            </div>
          </div>
        ) : (
          <form className="timer-start-form" onSubmit={handleStart}>
            <div className="form-group">
              <label>事项名称 *</label>
              <input ref={timerNameInputRef} value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} required placeholder="正在做什么？" />
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
            <button className="btn btn-primary" type="submit" disabled={actionBusy}>开始计时</button>
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

      {showCancelConfirm && (
        <div className="modal-overlay" onClick={closeCancelConfirm}>
          <div
            className="modal-content confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-timer-title"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              if (event.key === 'Escape') closeCancelConfirm();
            }}
          >
            <h2 id="cancel-timer-title">取消本次计时？</h2>
            <p>取消后不会生成实际记录，已经记录的计时时长也不会保留。</p>
            <div className="form-actions">
              <button type="button" className="btn btn-secondary" autoFocus onClick={closeCancelConfirm}>继续计时</button>
              <button type="button" className="btn btn-danger" onClick={confirmCancel}>确认取消</button>
            </div>
          </div>
        </div>
      )}

      {finishPrefill && (
        <ScheduleModal
          defaultPlanned={false}
          prefill={finishPrefill}
          onClose={dismissFinishTimer}
          onSaved={async (schedule) => {
            await timerApi.attachSchedule(finishTimer.id, schedule.id);
            removeLocalValue(PENDING_FINISH_TIMER_KEY);
            removeLocalValue(DISMISSED_FINISH_TIMER_KEY);
            finishTimerRef.current = null;
            setFinishTimer(null);
            await loadRecent();
          }}
        />
      )}
    </div>
  );
}
