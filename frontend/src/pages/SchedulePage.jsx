import { useState, useEffect, useCallback } from 'react';
import { scheduleApi } from '../api/client';
import ScheduleModal from '../components/ScheduleModal';
import ContextMenu from '../components/ContextMenu';
import { parseAsLocal, formatTime, formatDate, startOfDay, endOfDay, todayStr } from '../utils/time';

function getDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
    return sDate > today;
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
    setEditSchedule(s);
    setIsPlanned(s.is_planned);
    setShowModal(true);
    setContextMenu(null);
  };

  const contextMenuItems = contextMenu ? [
    { label: '✏️ 修改', onClick: handleEditSchedule },
    { label: '🗑️ 删除', onClick: handleDeleteSchedule, danger: true },
  ] : [];

  const renderTimeline = (schedules, canEditFn) => {
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const scheduleMap = {};
    schedules.forEach(s => {
      const startH = parseAsLocal(s.start_time).getHours();
      const endH = parseAsLocal(s.end_time).getHours();
      // 跨小时的日程放入每个覆盖的小时格
      for (let h = startH; h <= endH && h < 24; h++) {
        if (!scheduleMap[h]) scheduleMap[h] = [];
        scheduleMap[h].push(s);
      }
    });

    return hours.map(h => (
      <div key={h} className="timeline-slot">
        <span className="hour">{String(h).padStart(2, '0')}:00</span>
        <div style={{ flex: 1 }}>
          {(scheduleMap[h] || []).map(s => (
            <div key={s.id} className={`event ${s.is_planned ? '' : 'actual'}`}
              onClick={() => {
                if (canEditFn?.(s) ?? true) {
                  setEditSchedule(s);
                  setIsPlanned(s.is_planned);
                  setShowModal(true);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, schedule: s });
              }}
              style={{ cursor: canEditFn?.(s) ?? true ? 'pointer' : 'default' }}
            >
              {s.name} ({formatTime(s.start_time)}-{formatTime(s.end_time)})
            </div>
          ))}
        </div>
      </div>
    ));
  };

  return (
    <div>
      {/* Day Navigator */}
      <div className="week-nav">
        <button className="btn btn-sm btn-secondary" onClick={goPrev}>← 前一天</button>
        <span>{formatDate(`${getDateStr(currentDate)}T12:00:00`)}{isToday ? '（今天）' : ''}</span>
        <button className="btn btn-sm btn-secondary" onClick={goNext}>后一天 →</button>
      </div>

      {/* Timeline Columns */}
      <div className="timeline-columns">
        <div className="timeline-column">
          <h3>
            📋 计划日程
            <button className="btn btn-sm btn-secondary" onClick={() => {
              setIsPlanned(true);
              setEditSchedule(null);
              setShowModal(true);
            }}>+</button>
          </h3>
          {renderTimeline(plannedSchedules, canEditPlanned)}
        </div>
        <div className="timeline-column">
          <h3>
            ✍️ 实际记录
            <button className="btn btn-sm btn-secondary" onClick={() => {
              setIsPlanned(false);
              setEditSchedule(null);
              setShowModal(true);
            }}>+</button>
          </h3>
          {renderTimeline(actualSchedules)}
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
