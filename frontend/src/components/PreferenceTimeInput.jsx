import { useEffect, useState } from 'react';
import {
  DISPLAY_PREFERENCES_EVENT,
  readDisplayPreferences,
} from '../utils/displayPreferences';

const HOURS_24 = Array.from({ length: 24 }, (_, value) => value);
const HOURS_12 = Array.from({ length: 12 }, (_, index) => index + 1);
const MINUTES = Array.from({ length: 60 }, (_, value) => value);

function pad(value) {
  return String(value).padStart(2, '0');
}

function timeParts(value) {
  const [rawHour = '23', rawMinute = '59'] = String(value || '23:59').split(':');
  const hour = Math.min(23, Math.max(0, Number(rawHour) || 0));
  const minute = Math.min(59, Math.max(0, Number(rawMinute) || 0));
  return { hour, minute };
}

export function PreferenceTimeInput({ value, onChange, disabled = false, id }) {
  const [preferences, setPreferences] = useState(readDisplayPreferences);
  const { hour, minute } = timeParts(value);
  const isTwelveHour = preferences.timeFormat === '12h';
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;

  useEffect(() => {
    const refresh = () => setPreferences(readDisplayPreferences());
    window.addEventListener(DISPLAY_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(DISPLAY_PREFERENCES_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const emit = (nextHour, nextMinute = minute) => onChange(`${pad(nextHour)}:${pad(nextMinute)}`);
  const changeTwelveHour = (nextDisplayHour, nextPeriod = period) => {
    const normalized = Number(nextDisplayHour) % 12;
    emit(normalized + (nextPeriod === 'PM' ? 12 : 0));
  };

  return (
    <div className="preference-time-input" id={id}>
      <select
        aria-label="小时"
        disabled={disabled}
        value={isTwelveHour ? displayHour : hour}
        onChange={event => isTwelveHour ? changeTwelveHour(event.target.value) : emit(Number(event.target.value))}
      >
        {(isTwelveHour ? HOURS_12 : HOURS_24).map(item => <option key={item} value={item}>{pad(item)}</option>)}
      </select>
      <span aria-hidden="true">:</span>
      <select aria-label="分钟" disabled={disabled} value={minute} onChange={event => emit(hour, Number(event.target.value))}>
        {MINUTES.map(item => <option key={item} value={item}>{pad(item)}</option>)}
      </select>
      {isTwelveHour && (
        <select aria-label="上午或下午" disabled={disabled} value={period} onChange={event => changeTwelveHour(displayHour, event.target.value)}>
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      )}
    </div>
  );
}

export function PreferenceDateTimeInput({ value, onChange, required = false, id }) {
  const [date = '', time = '23:59'] = String(value || '').split('T');
  const changeDate = (nextDate) => onChange(nextDate ? `${nextDate}T${time || '23:59'}` : '');

  return (
    <div className="preference-datetime-input" id={id}>
      <input type="date" value={date} onChange={event => changeDate(event.target.value)} required={required} />
      <PreferenceTimeInput value={time || '23:59'} onChange={nextTime => date && onChange(`${date}T${nextTime}`)} disabled={!date} />
    </div>
  );
}
