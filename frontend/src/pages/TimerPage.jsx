import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectApi, timeBlockApi, timerApi, todoApi } from '../api/client';
import { readDisplayPreferences } from '../utils/displayPreferences';
import { BEIJING_TIME_ZONE, parseAsLocal } from '../utils/time';

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
  const [categories, setCategories] = useState([]);
  const [finishCategoryId, setFinishCategoryId] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [form, setForm] = useState({ name: '', project_id: '', linked_todo_id: '', notes: '' });
  const timerNameInputRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const restoreInputAfterCancelRef = useRef(false);

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
    timeBlockApi.categories().then(items => { setCategories(items); setFinishCategoryId(String(items[0]?.id || '')); }).catch(err => console.error('加载时间块属性失败', err));
  }, [loadTimer, loadRecent]);

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
        project_id: form.linked_todo_id ? null : form.project_id ? Number(form.project_id) : null,
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
      if (updated.status === 'completed') setFinishTimer(updated);
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

  const convertFinished = async (completed) => {
    if (!finishCategoryId) {
      alert('请先选择实际记录属性');
      return;
    }
    try {
      const converted = await timeBlockApi.fromTimer(completed.id, {
        category_id: Number(finishCategoryId),
        granularity: readDisplayPreferences().timeBlockGranularity,
      });
      setFinishTimer(null);
      if (converted.length === 0) alert('本次计时未覆盖任何时间块的 50%，可在日程页手动补录。');
      await loadRecent();
    } catch (error) {
      alert('计时已结束，但时间块折算失败：' + error.message);
    }
  };

  const handleFinish = async () => {
    if (!finishCategoryId) { alert('请先选择实际记录属性'); return; }
    const completed = await refreshAfterAction(timerApi.finish);
    if (completed) await convertFinished(completed);
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


  return (
    <div className="timer-page">
      <section className="timer-panel">
        <div className="timer-head">
          <div>
            <h1>计时</h1>
            <p>记录正在发生的事，结束后按 50% 覆盖规则折算为实际时间块。</p>
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
              <select aria-label="计时属性" value={finishCategoryId} onChange={event => setFinishCategoryId(event.target.value)} disabled={actionBusy}>
                {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
              <button className="btn btn-primary" disabled={actionBusy || !finishCategoryId} onClick={handleFinish}>结束并记录</button>
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
              <select value={form.project_id} disabled={Boolean(form.linked_todo_id)} onChange={e => setForm(prev => ({ ...prev, project_id: e.target.value }))}>
                <option value="">不归属项目</option>
                {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              {form.linked_todo_id && <small>项目将从关联待办推导。</small>}
            </div>
            <div className="form-group">
              <label>关联待办</label>
              <select value={form.linked_todo_id} onChange={e => setForm(prev => ({ ...prev, linked_todo_id: e.target.value, project_id: e.target.value ? '' : prev.project_id }))}>
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
            {item.status === 'completed' && <button className="btn btn-sm btn-secondary" onClick={() => setFinishTimer(item)}>折算时间块</button>}
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

      {finishTimer && (
        <div className="modal-overlay">
          <div className="modal-content confirm-dialog" role="dialog" aria-modal="true">
            <h2>完成时间块折算</h2>
            <p>计时已结束。选择属性后可写入时间块，之后仍可在日程页修正。</p>
            <select aria-label="实际记录属性" value={finishCategoryId} onChange={event => setFinishCategoryId(event.target.value)}>
              {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => setFinishTimer(null)}>关闭</button>
              <button className="btn btn-primary" disabled={!finishCategoryId} onClick={() => convertFinished(finishTimer)}>折算时间块</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
