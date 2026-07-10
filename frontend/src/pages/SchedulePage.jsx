import { useState, useEffect, useCallback } from 'react';
import { scheduleApi } from '../api/client';
import ScheduleModal from '../components/ScheduleModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, formatTime, formatDate, startOfDay, todayStr } from '../utils/time';

const HOUR_HEIGHT = 64;
const MIN_EVENT_HEIGHT = 28;

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

function getEventStyle(schedule) {
  const startMinutes = minutesSinceStartOfDay(schedule.start_time);
  const endMinutes = minutesSinceStartOfDay(schedule.end_time);
  const duration = Math.max(15, endMinutes - startMinutes);

  return {
    top: `${(startMinutes / 60) * HOUR_HEIGHT}px`,
    height: `${Math.max(MIN_EVENT_HEIGHT, (duration / 60) * HOUR_HEIGHT)}px`,
  };
}

export default function SchedulePage() {
  const today = startOfDay(new Date());
  const [currentDate, setCurrentDate] = useState(today);
  const [plannedSchedules, setPlannedSchedules] = useState([]);
  const [actualSchedules, setActualSchedules] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editSchedule, setEditSchedule] = useState(null);
  const [isPlanned, setIsPlanned] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);
  const [mobileLane, setMobileLane] = useState('planned');

  const loadSchedules = useCallback(async () => {
    try {
      const dateStr = getDateStr(currentDate);
      const [planned, actual] = await Promise.all([
        scheduleApi.list({
          is_planned: true,
          date_from: `${dateStr}T00:00:00`,
          date_to: `${dateStr}T23:59:59`,
        }),
        scheduleApi.list({
          is_planned: false,
          date_from: `${dateStr}T00:00:00`,
          date_to: `${dateStr}T23:59:59`,
        }),
      ]);
      setPlannedSchedules(planned);
      setActualSchedules(actual);
    } catch (err) {
      console.error('加载日程失败', err);
    }
  }, [currentDate]);

  useEffect(() => { loadSchedules(); }, [loadSchedules]);

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

  const isToday = getDateStr(currentDate) === todayStr();

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
    setShowModal(true);
    setContextMenu(null);
  };

  const contextMenuItems = contextMenu ? [
    ...(
      contextMenu.schedule.is_planned && !canEditPlanned(contextMenu.schedule)
        ? []
        : [{ label: '✏️ 修改', onClick: handleEditSchedule }]
    ),
    { label: '🗑️ 删除', onClick: handleDeleteSchedule, danger: true },
  ] : [];

  const openSchedule = (schedule, canEditFn) => {
    if (canEditFn?.(schedule) ?? true) {
      setEditSchedule(schedule);
      setIsPlanned(schedule.is_planned);
      setShowModal(true);
    }
  };

  const openCreateSchedule = (planned) => {
    setIsPlanned(planned);
    setEditSchedule(null);
    setShowModal(true);
  };

  const renderEvents = (schedules, canEditFn) => (
    <>
      {schedules.length === 0 && (
        <div className="timeline-empty">暂无日程</div>
      )}
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
            {s.notes && <span className="event-note">📝 {s.notes}</span>}
          </button>
        );
      })}
    </>
  );

  const renderAxis = () => (
    <div className="timeline-axis" aria-hidden="true">
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} className="timeline-hour">
          <span>{String(h).padStart(2, '0')}:00</span>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {/* Day Navigator */}
      <div className="week-nav">
        <button className="btn btn-sm btn-secondary" onClick={goPrev}>← 前一天</button>
        <span>{formatDate(`${getDateStr(currentDate)}T12:00:00`)}{isToday ? '（今天）' : ''}</span>
        <button className="btn btn-sm btn-secondary" onClick={goNext}>后一天 →</button>
      </div>

      <div className="timeline-mobile-switch" aria-label="切换日程类型">
        <button
          className={`btn btn-sm ${mobileLane === 'planned' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMobileLane('planned')}
        >
          计划
        </button>
        <button
          className={`btn btn-sm ${mobileLane === 'actual' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setMobileLane('actual')}
        >
          实际
        </button>
        <button
          className="btn btn-sm btn-secondary timeline-mobile-add"
          onClick={() => openCreateSchedule(mobileLane === 'planned')}
        >
          +
        </button>
      </div>

      {/* Shared Timeline */}
      <div className="timeline-compare">
        <div className="timeline-compare-header">
          <h3>
            📋 规划日程
            <button className="btn btn-sm btn-secondary" onClick={() => openCreateSchedule(true)}>+</button>
          </h3>
          <div className="timeline-axis-title">时间</div>
          <h3>
            ✍️ 实际记录
            <button className="btn btn-sm btn-secondary" onClick={() => openCreateSchedule(false)}>+</button>
          </h3>
        </div>

        <div className="timeline-compare-grid" style={{ '--hour-height': `${HOUR_HEIGHT}px` }}>
          <div className={`timeline-lane planned ${mobileLane === 'planned' ? 'mobile-active' : ''}`}>
            {renderEvents(plannedSchedules, canEditPlanned)}
          </div>
          {renderAxis()}
          <div className={`timeline-lane actual ${mobileLane === 'actual' ? 'mobile-active' : ''}`}>
            {renderEvents(actualSchedules)}
          </div>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <ScheduleModal
          schedule={editSchedule ? { ...editSchedule, is_planned: isPlanned } : null}
          defaultPlanned={isPlanned}
          defaultDate={getDateStr(currentDate)}
          onClose={() => { setShowModal(false); setEditSchedule(null); }}
          onSaved={() => { setShowModal(false); setEditSchedule(null); loadSchedules(); }}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
