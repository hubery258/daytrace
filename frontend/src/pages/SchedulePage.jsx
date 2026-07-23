import { useState, useEffect, useCallback } from 'react';
import { scheduleApi } from '../api/client';
import ScheduleModal from '../components/ScheduleModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, formatTime, formatDate, startOfDay, todayStr } from '../utils/time';

const HOUR_HEIGHT = 64;
const MIN_EVENT_HEIGHT = 28;
const SNAP_MINUTES = 15;

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

export default function SchedulePage() {
  const today = startOfDay(new Date());
  const [currentDate, setCurrentDate] = useState(today);
  const [jumpDate, setJumpDate] = useState(getDateStr(today));
  const [plannedSchedules, setPlannedSchedules] = useState([]);
  const [actualSchedules, setActualSchedules] = useState([]);
  const [weekSchedules, setWeekSchedules] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editSchedule, setEditSchedule] = useState(null);
  const [isPlanned, setIsPlanned] = useState(true);
  const [prefill, setPrefill] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [mobileLane, setMobileLane] = useState('planned');
  const [dragSelection, setDragSelection] = useState(null);

  const dateStr = getDateStr(currentDate);

  const loadSchedules = useCallback(async () => {
    try {
      const currentDateStr = getDateStr(currentDate);
      const weekDays = getWeekDays(currentDate);
      const weekStart = getDateStr(weekDays[0]);
      const weekEndDate = new Date(weekDays[6]);
      weekEndDate.setDate(weekEndDate.getDate() + 1);
      const weekEnd = getDateStr(weekEndDate);
      const [planned, actual, week] = await Promise.all([
        scheduleApi.list({ is_planned: true, date_from: `${currentDateStr}T00:00:00`, date_to: `${currentDateStr}T23:59:59` }),
        scheduleApi.list({ is_planned: false, date_from: `${currentDateStr}T00:00:00`, date_to: `${currentDateStr}T23:59:59` }),
        scheduleApi.list({ date_from: `${weekStart}T00:00:00`, date_to: `${weekEnd}T00:00:00` }),
      ]);
      setPlannedSchedules(planned);
      setActualSchedules(actual);
      setWeekSchedules(week);
    } catch (err) {
      console.error('Load schedules failed', err);
    }
  }, [currentDate]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

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

  const goPrev = () => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() - 1);
    setCurrentDate(d);
  };

  const goNext = () => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + 1);
    setCurrentDate(d);
  };

  const goToday = () => setCurrentDate(today);

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
        : [{ label: 'Edit', onClick: handleEditSchedule }]
    ),
    { label: 'Delete', onClick: handleDeleteSchedule, danger: true },
  ] : [];

  const openSchedule = (schedule, canEditFn) => {
    if (canEditFn?.(schedule) ?? true) {
      setEditSchedule(schedule);
      setIsPlanned(schedule.is_planned);
      setPrefill(null);
      setShowModal(true);
    }
  };

  const openCreateSchedule = (planned) => {
    setIsPlanned(planned);
    setEditSchedule(null);
    setPrefill(null);
    setShowModal(true);
  };

  const handleLaneMouseDown = (event, lane) => {
    if (event.button !== 0 || event.target.closest('.event')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    const minutes = snapMinutes((y / HOUR_HEIGHT) * 60);
    setDragSelection({ lane, startMinute: minutes, currentMinute: minutes, rect });
  };

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
      {schedules.length === 0 && <div className="timeline-empty">No schedules</div>}
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
            style={getEventStyle(s)}
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

  const weekDays = getWeekDays(currentDate);
  const markedDates = new Set(weekSchedules.map(s => getDateStr(parseAsLocal(s.start_time))));
  const isToday = dateStr === todayStr();

  return (
    <div>
      <div className="week-nav improved">
        <button className="btn btn-sm btn-secondary" onClick={goPrev}>Prev</button>
        <button className="btn btn-sm btn-secondary" onClick={goToday}>Today</button>
        <input type="date" value={jumpDate} onChange={e => setJumpDate(e.target.value)} aria-label="Select schedule date" />
        <button className="btn btn-sm btn-primary" onClick={handleJumpDate}>Go</button>
        <button className="btn btn-sm btn-secondary" onClick={goNext}>Next</button>
      </div>

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

      <div className="schedule-current-label">{formatDate(`${dateStr}T12:00:00`)}{isToday ? ' · Today' : ''}</div>

      <div className="timeline-mobile-switch" aria-label="Switch schedule lane">
        <button className={`btn btn-sm ${mobileLane === 'planned' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMobileLane('planned')}>Plan</button>
        <button className={`btn btn-sm ${mobileLane === 'actual' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMobileLane('actual')}>Actual</button>
        <button className="btn btn-sm btn-secondary timeline-mobile-add" onClick={() => openCreateSchedule(mobileLane === 'planned')}>+</button>
      </div>

      <div className="timeline-compare">
        <div className="timeline-compare-header">
          <h3>Plan <button className="btn btn-sm btn-secondary" onClick={() => openCreateSchedule(true)}>+</button></h3>
          <div className="timeline-axis-title">Time</div>
          <h3>Actual <button className="btn btn-sm btn-secondary" onClick={() => openCreateSchedule(false)}>+</button></h3>
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
