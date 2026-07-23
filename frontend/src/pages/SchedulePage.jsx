import { useState, useEffect, useCallback } from 'react';
import { projectApi, scheduleApi } from '../api/client';
import ScheduleModal from '../components/ScheduleModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, formatTime, formatDate, startOfDay, todayStr } from '../utils/time';

const HOUR_HEIGHT = 64;
const WEEK_HOUR_HEIGHT = 48;
const MIN_EVENT_HEIGHT = 28;
const SNAP_MINUTES = 15;

const T = {
  edit: '\u7f16\u8f91',
  delete: '\u5220\u9664',
  noSchedules: '\u6682\u65e0\u65e5\u7a0b',
  weekView: '\u5468\u89c6\u56fe',
  monthView: '\u6708\u89c6\u56fe',
  plannedSchedules: '\u8ba1\u5212\u65e5\u7a0b',
  actualRecords: '\u5b9e\u9645\u8bb0\u5f55',
  switchWeekLane: '\u5207\u6362\u5468\u89c6\u56fe\u7c7b\u578b',
  switchMonthLane: '\u5207\u6362\u6708\u89c6\u56fe\u7c7b\u578b',
  planned: '\u8ba1\u5212',
  actual: '\u5b9e\u9645',
  add: '\u65b0\u589e',
  empty: '\u6682\u65e0',
  switchScheduleView: '\u5207\u6362\u65e5\u7a0b\u89c6\u56fe',
  dayView: '\u65e5\u89c6\u56fe',
  prevWeek: '\u4e0a\u4e00\u5468',
  prevMonth: '\u4e0a\u4e00\u6708',
  prevDay: '\u524d\u4e00\u5929',
  today: '\u4eca\u5929',
  selectScheduleDate: '\u9009\u62e9\u65e5\u7a0b\u65e5\u671f',
  jump: '\u8df3\u8f6c',
  nextWeek: '\u4e0b\u4e00\u5468',
  nextMonth: '\u4e0b\u4e00\u6708',
  nextDay: '\u540e\u4e00\u5929',
  switchScheduleLane: '\u5207\u6362\u65e5\u7a0b\u7c7b\u578b',
  time: '\u65f6\u95f4',
  more: '\u66f4\u591a',
};

function getDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function minutesSinceStartOfDay(datetimeStr) {
  const d = parseAsLocal(datetimeStr);
  return d.getHours() * 60 + d.getMinutes();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function snapMinutes(minutes) {
  return clamp(Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES, 0, 24 * 60);
}

function minutesToLocalValue(dateStr, minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getEventStyle(schedule) {
  const startMinutes = minutesSinceStartOfDay(schedule.start_time);
  const endMinutes = minutesSinceStartOfDay(schedule.end_time);
  const duration = Math.max(15, endMinutes - startMinutes);

  return {
    top: `${(startMinutes / 60) * HOUR_HEIGHT}px`,
    height: `${Math.max(MIN_EVENT_HEIGHT, (duration / 60) * HOUR_HEIGHT)}px`,
  };
}

function getWeekEventStyle(schedule) {
  const startMinutes = minutesSinceStartOfDay(schedule.start_time);
  const endMinutes = minutesSinceStartOfDay(schedule.end_time);
  const duration = Math.max(15, endMinutes - startMinutes);
  return {
    top: `${(startMinutes / 60) * WEEK_HOUR_HEIGHT}px`,
    height: `${Math.max(24, (duration / 60) * WEEK_HOUR_HEIGHT)}px`,
  };
}

function getWeekDays(date) {
  const base = startOfDay(date);
  const day = base.getDay() || 7;
  const monday = new Date(base);
  monday.setDate(base.getDate() - day + 1);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function getMonthGridDays(date) {
  const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  const lastOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const start = new Date(firstOfMonth);
  const startOffset = start.getDay() || 7;
  start.setDate(start.getDate() - startOffset + 1);
  const end = new Date(lastOfMonth);
  const endOffset = end.getDay() || 7;
  end.setDate(end.getDate() + (7 - endOffset));
  const days = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function formatWeekRange(days) {
  if (!days.length) return '';
  const first = days[0].toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  const last = days[6].toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  return `${first} - ${last}`;
}

function formatMonthTitle(date) {
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
}

function groupSchedulesByDate(schedules) {
  return schedules.reduce((acc, schedule) => {
    const key = getDateStr(parseAsLocal(schedule.start_time));
    acc[key] = acc[key] || [];
    acc[key].push(schedule);
    return acc;
  }, {});
}

export default function SchedulePage() {
  const today = startOfDay(new Date());
  const [currentDate, setCurrentDate] = useState(today);
  const [jumpDate, setJumpDate] = useState(getDateStr(today));
  const [plannedSchedules, setPlannedSchedules] = useState([]);
  const [actualSchedules, setActualSchedules] = useState([]);
  const [weekSchedules, setWeekSchedules] = useState([]);
  const [monthSchedules, setMonthSchedules] = useState([]);
  const [projects, setProjects] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editSchedule, setEditSchedule] = useState(null);
  const [isPlanned, setIsPlanned] = useState(true);
  const [prefill, setPrefill] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [mobileLane, setMobileLane] = useState('planned');
  const [dragSelection, setDragSelection] = useState(null);
  const [viewMode, setViewMode] = useState('day');
  const [weekLane, setWeekLane] = useState('planned');
  const [monthLane, setMonthLane] = useState('planned');

  const dateStr = getDateStr(currentDate);
  const weekDays = getWeekDays(currentDate);
  const monthGridDays = getMonthGridDays(currentDate);

  const loadSchedules = useCallback(async () => {
    try {
      const currentDateStr = getDateStr(currentDate);
      const days = getWeekDays(currentDate);
      const weekStart = getDateStr(days[0]);
      const weekEndDate = new Date(days[6]);
      weekEndDate.setDate(weekEndDate.getDate() + 1);
      const weekEnd = getDateStr(weekEndDate);
      const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
      const [planned, actual, week, month] = await Promise.all([
        scheduleApi.list({ is_planned: true, date_from: `${currentDateStr}T00:00:00`, date_to: `${currentDateStr}T23:59:59` }),
        scheduleApi.list({ is_planned: false, date_from: `${currentDateStr}T00:00:00`, date_to: `${currentDateStr}T23:59:59` }),
        scheduleApi.list({ date_from: `${weekStart}T00:00:00`, date_to: `${weekEnd}T00:00:00` }),
        scheduleApi.list({ date_from: `${getDateStr(monthStart)}T00:00:00`, date_to: `${getDateStr(monthEnd)}T00:00:00` }),
      ]);
      setPlannedSchedules(planned);
      setActualSchedules(actual);
      setWeekSchedules(week);
      setMonthSchedules(month);
    } catch (err) {
      console.error('Load schedules failed', err);
    }
  }, [currentDate]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

  useEffect(() => {
    projectApi.list().then(setProjects).catch(err => console.error('Load projects failed', err));
  }, []);

  useEffect(() => {
    setJumpDate(getDateStr(currentDate));
  }, [currentDate]);

  useEffect(() => {
    if (!dragSelection) return undefined;
    const handleMove = (event) => {
      const rect = dragSelection.rect;
      const y = clamp(event.clientY - rect.top, 0, rect.height);
      const minutes = snapMinutes((y / HOUR_HEIGHT) * 60);
      setDragSelection(prev => prev ? { ...prev, currentMinute: minutes } : prev);
    };
    const handleUp = () => {
      setDragSelection(prev => {
        if (!prev) return null;
        let startMinute = Math.min(prev.startMinute, prev.currentMinute);
        let endMinute = Math.max(prev.startMinute, prev.currentMinute);
        if (endMinute - startMinute < SNAP_MINUTES) {
          endMinute = clamp(startMinute + SNAP_MINUTES, SNAP_MINUTES, 24 * 60);
          startMinute = endMinute - SNAP_MINUTES;
        }
        setEditSchedule(null);
        setIsPlanned(prev.lane === 'planned');
        setPrefill({
          start_time: minutesToLocalValue(dateStr, startMinute),
          end_time: minutesToLocalValue(dateStr, endMinute),
          is_planned: prev.lane === 'planned',
        });
        setShowModal(true);
        return null;
      });
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp, { once: true });
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragSelection, dateStr]);

  const moveDate = (amount) => {
    const d = new Date(currentDate);
    if (viewMode === 'month') {
      d.setMonth(d.getMonth() + amount);
    } else {
      d.setDate(d.getDate() + amount);
    }
    setCurrentDate(d);
  };

  const goPrev = () => moveDate(viewMode === 'month' ? -1 : viewMode === 'week' ? -7 : -1);
  const goNext = () => moveDate(viewMode === 'month' ? 1 : viewMode === 'week' ? 7 : 1);
  const goToday = () => setCurrentDate(today);

  const prevLabel = viewMode === 'month' ? T.prevMonth : viewMode === 'week' ? T.prevWeek : T.prevDay;
  const nextLabel = viewMode === 'month' ? T.nextMonth : viewMode === 'week' ? T.nextWeek : T.nextDay;

  const handleJumpDate = () => {
    if (!jumpDate) return;
    const d = new Date(`${jumpDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return;
    setCurrentDate(startOfDay(d));
  };

  const canEditPlanned = (schedule) => {
    const sDate = parseAsLocal(schedule.start_time);
    sDate.setHours(0, 0, 0, 0);
    return sDate >= today;
  };

  const handleDeleteSchedule = async () => {
    if (!contextMenu) return;
    await scheduleApi.delete(contextMenu.schedule.id);
    setContextMenu(null);
    loadSchedules();
  };

  const handleEditSchedule = () => {
    if (!contextMenu) return;
    const s = contextMenu.schedule;
    if (s.is_planned && !canEditPlanned(s)) return;
    setEditSchedule(s);
    setIsPlanned(s.is_planned);
    setPrefill(null);
    setShowModal(true);
    setContextMenu(null);
  };

  const contextMenuItems = contextMenu ? [
    ...(
      contextMenu.schedule.is_planned && !canEditPlanned(contextMenu.schedule)
        ? []
        : [{ label: T.edit, onClick: handleEditSchedule }]
    ),
    { label: T.delete, onClick: handleDeleteSchedule, danger: true },
  ] : [];

  const openSchedule = (schedule, canEditFn) => {
    if (canEditFn?.(schedule) ?? true) {
      setEditSchedule(schedule);
      setIsPlanned(schedule.is_planned);
      setPrefill(null);
      setShowModal(true);
    }
  };

  const openCreateSchedule = (planned, targetDateStr = dateStr) => {
    setIsPlanned(planned);
    setEditSchedule(null);
    setPrefill({ is_planned: planned, start_time: `${targetDateStr}T09:00`, end_time: `${targetDateStr}T10:00` });
    setShowModal(true);
  };

  const selectDay = (day) => {
    setCurrentDate(day);
    setViewMode('day');
  };

  const handleLaneMouseDown = (event, lane) => {
    if (event.button !== 0 || event.target.closest('.event')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    const minutes = snapMinutes((y / HOUR_HEIGHT) * 60);
    setDragSelection({ lane, startMinute: minutes, currentMinute: minutes, rect });
  };

  const projectById = new Map(projects.map(project => [project.id, project]));
  const projectColor = (schedule) => projectById.get(schedule.project_id)?.color || (schedule.is_planned ? '#4f46e5' : '#16a34a');

  const renderSelection = (lane) => {
    if (!dragSelection || dragSelection.lane !== lane) return null;
    const startMinute = Math.min(dragSelection.startMinute, dragSelection.currentMinute);
    const endMinute = Math.max(dragSelection.startMinute, dragSelection.currentMinute);
    const duration = Math.max(SNAP_MINUTES, endMinute - startMinute);
    return (
      <div
        className="timeline-selection"
        style={{ top: `${(startMinute / 60) * HOUR_HEIGHT}px`, height: `${(duration / 60) * HOUR_HEIGHT}px` }}
      />
    );
  };

  const renderEvents = (schedules, canEditFn) => (
    <>
      {schedules.length === 0 && <div className="timeline-empty">{T.noSchedules}</div>}
      {schedules.map(s => {
        const canEdit = canEditFn?.(s) ?? true;
        return (
          <button
            key={s.id}
            type="button"
            className={`event ${s.is_planned ? '' : 'actual'} ${canEdit ? '' : 'readonly'}`}
            onClick={() => openSchedule(s, canEditFn)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY, schedule: s });
            }}
            style={{ ...getEventStyle(s), borderLeftColor: projectColor(s), borderLeftWidth: 4 }}
            title={s.notes || undefined}
          >
            <span className="event-title">{s.name}</span>
            <span className="event-time">{formatTime(s.start_time)}-{formatTime(s.end_time)}</span>
            {s.notes && <span className="event-note">{s.notes}</span>}
          </button>
        );
      })}
    </>
  );

  const renderAxis = () => (
    <div className="timeline-axis" aria-hidden="true">
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="timeline-hour"><span>{String(h).padStart(2, '0')}:00</span></div>
      ))}
    </div>
  );

  const renderWeekAxis = () => (
    <div className="week-time-axis" aria-hidden="true">
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="week-time-hour"><span>{String(h).padStart(2, '0')}:00</span></div>
      ))}
    </div>
  );

  const renderWeekView = () => {
    const filtered = weekSchedules.filter(schedule => schedule.is_planned === (weekLane === 'planned'));
    const grouped = groupSchedulesByDate(filtered);
    return (
      <section className="week-view-card timeline-week-view" style={{ '--week-hour-height': `${WEEK_HOUR_HEIGHT}px` }}>
        <div className="week-view-head">
          <div>
            <h2>{T.weekView}</h2>
            <p>{formatWeekRange(weekDays)} - {weekLane === 'planned' ? T.plannedSchedules : T.actualRecords}</p>
          </div>
          <div className="segmented-control" aria-label={T.switchWeekLane}>
            <button className={weekLane === 'planned' ? 'active' : ''} onClick={() => setWeekLane('planned')}>{T.planned}</button>
            <button className={weekLane === 'actual' ? 'active' : ''} onClick={() => setWeekLane('actual')}>{T.actual}</button>
          </div>
        </div>

        <div className="week-timeline-header">
          <div className="week-time-title">{T.time}</div>
          {weekDays.map(day => {
            const dayKey = getDateStr(day);
            return (
              <button key={dayKey} className={`week-column-head ${dayKey === dateStr ? 'selected' : ''} ${dayKey === todayStr() ? 'today' : ''}`} onClick={() => selectDay(day)}>
                <span>{day.toLocaleDateString('zh-CN', { weekday: 'short' })}</span>
                <strong>{day.getDate()}</strong>
              </button>
            );
          })}
        </div>

        <div className="week-timeline-grid">
          {renderWeekAxis()}
          {weekDays.map(day => {
            const dayKey = getDateStr(day);
            const dayItems = grouped[dayKey] || [];
            return (
              <div key={dayKey} className="week-timeline-day">
                {dayItems.length === 0 && <div className="week-timeline-empty">{T.empty}</div>}
                {dayItems.map(schedule => (
                  <button
                    key={schedule.id}
                    type="button"
                    className={`week-time-event ${schedule.is_planned ? 'planned' : 'actual'}`}
                    style={{ ...getWeekEventStyle(schedule), borderLeftColor: projectColor(schedule) }}
                    onClick={() => openSchedule(schedule, schedule.is_planned ? canEditPlanned : undefined)}
                  >
                    <span>{formatTime(schedule.start_time)}-{formatTime(schedule.end_time)}</span>
                    <strong>{schedule.name}</strong>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const renderMonthView = () => {
    const filtered = monthSchedules.filter(schedule => schedule.is_planned === (monthLane === 'planned'));
    const grouped = groupSchedulesByDate(filtered);
    return (
      <section className="month-view-card">
        <div className="week-view-head">
          <div>
            <h2>{T.monthView}</h2>
            <p>{formatMonthTitle(currentDate)} - {monthLane === 'planned' ? T.plannedSchedules : T.actualRecords}</p>
          </div>
          <div className="segmented-control" aria-label={T.switchMonthLane}>
            <button className={monthLane === 'planned' ? 'active' : ''} onClick={() => setMonthLane('planned')}>{T.planned}</button>
            <button className={monthLane === 'actual' ? 'active' : ''} onClick={() => setMonthLane('actual')}>{T.actual}</button>
          </div>
        </div>

        <div className="month-weekday-row">
          {weekDays.map(day => <span key={getDateStr(day)}>{day.toLocaleDateString('zh-CN', { weekday: 'short' })}</span>)}
        </div>
        <div className="month-grid">
          {monthGridDays.map(day => {
            const dayKey = getDateStr(day);
            const items = grouped[dayKey] || [];
            const inMonth = day.getMonth() === currentDate.getMonth();
            return (
              <section key={dayKey} className={`month-day ${inMonth ? '' : 'outside'} ${dayKey === dateStr ? 'selected' : ''} ${dayKey === todayStr() ? 'today' : ''}`}>
                <button className="month-day-head" onClick={() => selectDay(day)}>
                  <strong>{day.getDate()}</strong>
                  {items.length > 0 && <span>{items.length}</span>}
                </button>
                <div className="month-event-list">
                  {items.slice(0, 3).map(schedule => (
                    <button
                      key={schedule.id}
                      type="button"
                      className={`month-event ${schedule.is_planned ? 'planned' : 'actual'}`}
                      style={{ borderLeftColor: projectColor(schedule) }}
                      onClick={() => openSchedule(schedule, schedule.is_planned ? canEditPlanned : undefined)}
                    >
                      <span>{formatTime(schedule.start_time)}</span>
                      <strong>{schedule.name}</strong>
                    </button>
                  ))}
                  {items.length > 3 && <div className="month-more">+{items.length - 3} {T.more}</div>}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    );
  };

  const markedDates = new Set(weekSchedules.map(s => getDateStr(parseAsLocal(s.start_time))));
  const isToday = dateStr === todayStr();

  return (
    <div>
      <div className="schedule-toolbar">
        <div className="segmented-control" aria-label={T.switchScheduleView}>
          <button className={viewMode === 'day' ? 'active' : ''} onClick={() => setViewMode('day')}>{T.dayView}</button>
          <button className={viewMode === 'week' ? 'active' : ''} onClick={() => setViewMode('week')}>{T.weekView}</button>
          <button className={viewMode === 'month' ? 'active' : ''} onClick={() => setViewMode('month')}>{T.monthView}</button>
        </div>
        <div className="week-nav improved">
          <button className="btn btn-sm btn-secondary" onClick={goPrev}>{prevLabel}</button>
          <button className="btn btn-sm btn-secondary" onClick={goToday}>{T.today}</button>
          <input type="date" value={jumpDate} onChange={e => setJumpDate(e.target.value)} aria-label={T.selectScheduleDate} />
          <button className="btn btn-sm btn-primary" onClick={handleJumpDate}>{T.jump}</button>
          <button className="btn btn-sm btn-secondary" onClick={goNext}>{nextLabel}</button>
        </div>
      </div>

      {viewMode !== 'month' && (
        <div className="week-strip">
          {weekDays.map(day => {
            const dayStr = getDateStr(day);
            return (
              <button key={dayStr} className={`week-strip-day ${dayStr === dateStr ? 'active' : ''}`} onClick={() => setCurrentDate(day)}>
                <span>{day.toLocaleDateString('zh-CN', { weekday: 'short' })}</span>
                <strong>{day.getDate()}</strong>
                {markedDates.has(dayStr) && <i />}
              </button>
            );
          })}
        </div>
      )}

      {viewMode === 'week' ? renderWeekView() : viewMode === 'month' ? renderMonthView() : (
        <>
          <div className="schedule-current-label">{formatDate(`${dateStr}T12:00:00`)}{isToday ? ` - ${T.today}` : ''}</div>

          <div className="timeline-mobile-switch" aria-label={T.switchScheduleLane}>
            <button className={`btn btn-sm ${mobileLane === 'planned' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMobileLane('planned')}>{T.planned}</button>
            <button className={`btn btn-sm ${mobileLane === 'actual' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMobileLane('actual')}>{T.actual}</button>
            <button className="btn btn-sm btn-secondary timeline-mobile-add" onClick={() => openCreateSchedule(mobileLane === 'planned')}>+</button>
          </div>

          <div className="timeline-compare">
            <div className="timeline-compare-header">
              <h3>{T.planned} <button className="btn btn-sm btn-secondary" onClick={() => openCreateSchedule(true)}>+</button></h3>
              <div className="timeline-axis-title">{T.time}</div>
              <h3>{T.actual} <button className="btn btn-sm btn-secondary" onClick={() => openCreateSchedule(false)}>+</button></h3>
            </div>

            <div className="timeline-compare-grid" style={{ '--hour-height': `${HOUR_HEIGHT}px` }}>
              <div className={`timeline-lane planned ${mobileLane === 'planned' ? 'mobile-active' : ''}`} onMouseDown={e => handleLaneMouseDown(e, 'planned')}>
                {renderSelection('planned')}
                {renderEvents(plannedSchedules, canEditPlanned)}
              </div>
              {renderAxis()}
              <div className={`timeline-lane actual ${mobileLane === 'actual' ? 'mobile-active' : ''}`} onMouseDown={e => handleLaneMouseDown(e, 'actual')}>
                {renderSelection('actual')}
                {renderEvents(actualSchedules)}
              </div>
            </div>
          </div>
        </>
      )}

      {showModal && (
        <ScheduleModal
          schedule={editSchedule ? { ...editSchedule, is_planned: isPlanned } : null}
          defaultPlanned={isPlanned}
          defaultDate={dateStr}
          prefill={prefill || {}}
          onClose={() => { setShowModal(false); setEditSchedule(null); setPrefill(null); }}
          onSaved={() => { setShowModal(false); setEditSchedule(null); setPrefill(null); loadSchedules(); }}
        />
      )}

      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenuItems} onClose={() => setContextMenu(null)} />}
    </div>
  );
}
