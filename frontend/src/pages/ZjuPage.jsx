import { useEffect, useMemo, useState } from 'react';
import { zjuApi } from '../api/client';

function defaultAcademicYear() {
  const now = new Date();
  const year = now.getFullYear();
  const start = now.getMonth() + 1 >= 8 ? year : year - 1;
  return `${start}-${start + 1}`;
}


function academicYearOptions() {
  const firstYear = 2022;
  const currentYear = new Date().getFullYear();
  const lastYear = Math.max(firstYear, currentYear);
  return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => {
    const start = firstYear + index;
    return `${start}-${start + 1}`;
  });
}
function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ZjuPage() {
  const [zjuUsername, setZjuUsername] = useState('');
  const [zjuPassword, setZjuPassword] = useState('');
  const [pintiaCookie, setPintiaCookie] = useState('');
  const [includePintia, setIncludePintia] = useState(true);
  const [savePassword, setSavePassword] = useState(false);
  const [savePintiaCookie, setSavePintiaCookie] = useState(false);
  const [defaultReminderDays, setDefaultReminderDays] = useState(1);
  const [credentialState, setCredentialState] = useState(null);
  const [previewItems, setPreviewItems] = useState([]);
  const [zjuErrors, setZjuErrors] = useState([]);
  const [zjuMessage, setZjuMessage] = useState('');
  const [zjuBusy, setZjuBusy] = useState(false);

  const [academicYear, setAcademicYear] = useState(defaultAcademicYear());
  const [semester, setSemester] = useState(1);
  const [calendarState, setCalendarState] = useState(null);
  const [scheduleItems, setScheduleItems] = useState([]);
  const [scheduleErrors, setScheduleErrors] = useState([]);
  const [scheduleMessage, setScheduleMessage] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);

  const academicYears = useMemo(() => academicYearOptions(), []);
  const calendarLabel = useMemo(() => `${academicYear} ${semester === 1 ? '秋冬' : '春夏'}学期`, [academicYear, semester]);

  useEffect(() => {
    zjuApi.getCredentials()
      .then((data) => {
        setCredentialState(data);
        setZjuUsername(data.username || '');
        setSavePassword(Boolean(data.save_password));
        setSavePintiaCookie(Boolean(data.save_pintia_cookie));
        setDefaultReminderDays(data.default_reminder_days ?? 1);
      })
      .catch((err) => setZjuMessage(`读取 ZJU 凭据状态失败：${err.message}`));
  }, []);

  useEffect(() => {
    refreshCalendarState();
  }, [academicYear, semester]);

  const zjuPayload = (saveCredentials = false) => ({
    username: zjuUsername.trim(),
    password: zjuPassword,
    pintia_cookie: pintiaCookie,
    include_pintia: includePintia,
    save_credentials: saveCredentials,
    save_password: savePassword,
    save_pintia_cookie: savePintiaCookie,
    default_reminder_days: Number(defaultReminderDays) || 0,
  });

  const runZjuAction = async (action) => {
    setZjuBusy(true);
    setZjuMessage('');
    setZjuErrors([]);
    try {
      await action();
    } catch (err) {
      setZjuMessage(err.message);
    } finally {
      setZjuBusy(false);
    }
  };

  const runScheduleAction = async (action) => {
    setScheduleBusy(true);
    setScheduleMessage('');
    setScheduleErrors([]);
    try {
      await action();
    } catch (err) {
      setScheduleMessage(err.message);
    } finally {
      setScheduleBusy(false);
    }
  };

  const refreshCredentialState = async () => {
    const data = await zjuApi.getCredentials();
    setCredentialState(data);
    setZjuUsername(data.username || '');
    setSavePassword(Boolean(data.save_password));
    setSavePintiaCookie(Boolean(data.save_pintia_cookie));
    setDefaultReminderDays(data.default_reminder_days ?? 1);
  };

  const refreshCalendarState = async () => {
    try {
      const data = await zjuApi.getCalendarCache({ academic_year: academicYear.trim(), semester: Number(semester) });
      setCalendarState(data);
    } catch (err) {
      setCalendarState(null);
      setScheduleMessage(`读取校历缓存失败：${err.message}`);
    }
  };

  const handleSaveZjuCredentials = () => runZjuAction(async () => {
    const data = await zjuApi.saveCredentials({
      username: zjuUsername.trim(),
      password: zjuPassword,
      pintia_cookie: pintiaCookie,
      save_password: savePassword,
      save_pintia_cookie: savePintiaCookie,
      default_reminder_days: Number(defaultReminderDays) || 0,
    });
    setCredentialState(data);
    setZjuPassword('');
    setPintiaCookie('');
    setZjuMessage('ZJU 凭据设置已保存');
  });

  const handleClearPassword = () => runZjuAction(async () => {
    const data = await zjuApi.clearPassword();
    setCredentialState(data);
    setSavePassword(false);
    setZjuPassword('');
    setZjuMessage('已清除本地保存的 ZJU 密码');
  });

  const handleClearPintia = () => runZjuAction(async () => {
    const data = await zjuApi.clearPintiaCookie();
    setCredentialState(data);
    setSavePintiaCookie(false);
    setPintiaCookie('');
    setZjuMessage('已清除本地保存的 Pintia Cookie');
  });

  const handlePreview = () => runZjuAction(async () => {
    const data = await zjuApi.preview(zjuPayload(false));
    const items = data.items || [];
    const errors = data.errors || [];
    const hasPintiaItem = items.some((item) => item.source === 'pintia');
    const hasPintiaError = errors.some((error) => error.toLowerCase().includes('pintia'));
    const pintiaStatus = includePintia && !hasPintiaItem && !hasPintiaError
      ? '；Pintia 已连接，但暂无未截止题集'
      : '';

    setPreviewItems(items);
    setZjuErrors(errors);
    setZjuMessage(`预览完成：${items.length} 个任务${pintiaStatus}`);
    await refreshCredentialState();
  });

  const handleImport = () => runZjuAction(async () => {
    const importable = previewItems.filter((item) => item.action === 'create');
    if (importable.length === 0) {
      setZjuMessage('没有可导入的新任务');
      return;
    }
    const data = await zjuApi.importTodos({
      items: importable,
      reminder_days: Number(defaultReminderDays) || 0,
    });
    setZjuMessage(`导入完成：新增 ${data.created_count} 个，跳过 ${data.skipped_count} 个`);
    setPreviewItems((items) => items.map((item) => (
      item.action === 'create' ? { ...item, action: 'exists', reason: '已导入' } : item
    )));
  });

  const handleUndo = () => runZjuAction(async () => {
    const data = await zjuApi.undoLast();
    if (!data.batch_id) {
      setZjuMessage('没有可撤销的 ZJU 导入批次');
      return;
    }
    setZjuMessage(`撤销完成：删除 ${data.deleted_count} 个，跳过 ${data.skipped_count} 个`);
    setPreviewItems([]);
  });

  const handleFetchCalendar = () => runScheduleAction(async () => {
    const data = await zjuApi.fetchCalendar({ academic_year: academicYear.trim(), semester: Number(semester) });
    setCalendarState(data);
    setScheduleMessage(`校历已拉取并缓存：${calendarLabel}`);
  });

  const handlePreviewSchedule = () => runScheduleAction(async () => {
    const data = await zjuApi.previewSchedule({
      username: zjuUsername.trim(),
      password: zjuPassword,
      academic_year: academicYear.trim(),
      semester: Number(semester),
    });
    setScheduleItems(data.items || []);
    setScheduleErrors(data.errors || []);
    setScheduleMessage(`课表预览完成：${(data.items || []).length} 条日程`);
  });

  const handleImportSchedule = () => runScheduleAction(async () => {
    const importable = scheduleItems.filter((item) => item.action === 'create');
    if (importable.length === 0) {
      setScheduleMessage('没有可导入的新课程日程');
      return;
    }
    const data = await zjuApi.importSchedule({ items: importable });
    const firstImportedDate = [...importable]
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0]
      ?.start_time?.slice(0, 10);
    const jumpHint = firstImportedDate ? `；可在日程页跳转到 ${firstImportedDate} 查看` : '';
    setScheduleMessage(`课表导入完成：新增 ${data.created_count} 条，跳过 ${data.skipped_count} 条${jumpHint}`);
    setScheduleItems((items) => items.map((item) => (
      item.action === 'create' ? { ...item, action: 'exists', reason: '已导入' } : item
    )));
  });

  const handleUndoSchedule = () => runScheduleAction(async () => {
    const data = await zjuApi.undoLastSchedule();
    if (!data.batch_id) {
      setScheduleMessage('没有可撤销的课表导入批次');
      return;
    }
    setScheduleMessage(`课表撤销完成：删除 ${data.deleted_count} 条，跳过 ${data.skipped_count} 条`);
    setScheduleItems([]);
  });

  return (
    <div>
      <h1 style={{ fontSize: '1.2rem', marginBottom: 20 }}>ZJU 集成</h1>

      <div className="card">
        <div className="card-header">ZJU 凭据</div>
        <div className="form-group">
          <label>ZJU 学号</label>
          <input value={zjuUsername} onChange={e => setZjuUsername(e.target.value)} placeholder="学号" />
        </div>
        <div className="form-group">
          <label>ZJU 密码</label>
          <input
            type="password"
            value={zjuPassword}
            onChange={e => setZjuPassword(e.target.value)}
            placeholder={credentialState?.has_password ? '已保存，可留空使用本地保存密码' : '不勾选保存时仅用于本次操作'}
          />
        </div>
        <div className="form-group">
          <label>Pintia Cookie</label>
          <textarea
            value={pintiaCookie}
            onChange={e => setPintiaCookie(e.target.value)}
            placeholder={credentialState?.has_pintia_cookie ? '已保存，可留空使用本地保存 Cookie' : '从 Pintia 登录态复制 Cookie；不勾选保存时仅用于本次预览'}
            style={{ minHeight: 72 }}
          />
        </div>
        <div className="form-group">
          <label>默认提前提醒天数</label>
          <input
            type="number"
            min="0"
            max="60"
            value={defaultReminderDays}
            onChange={e => setDefaultReminderDays(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={includePintia} onChange={e => setIncludePintia(e.target.checked)} />
            同时预览 Pintia
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={savePassword} onChange={e => setSavePassword(e.target.checked)} />
            明文保存 ZJU 密码到本地 SQLite
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={savePintiaCookie} onChange={e => setSavePintiaCookie(e.target.checked)} />
            明文保存 Pintia Cookie 到本地 SQLite
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={handleSaveZjuCredentials} disabled={zjuBusy}>保存凭据设置</button>
          <button className="btn btn-secondary" onClick={handleClearPassword} disabled={zjuBusy}>清除密码</button>
          <button className="btn btn-secondary" onClick={handleClearPintia} disabled={zjuBusy}>清除 Cookie</button>
        </div>
        {credentialState && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 10 }}>
            本地状态：{credentialState.has_password ? '已保存 ZJU 密码' : '未保存 ZJU 密码'}；{credentialState.has_pintia_cookie ? '已保存 Pintia Cookie' : '未保存 Pintia Cookie'}
          </div>
        )}
        {zjuMessage && <div style={{ marginTop: 10, color: zjuMessage.includes('失败') || zjuMessage.includes('请') ? 'var(--danger)' : 'var(--text-secondary)' }}>{zjuMessage}</div>}
      </div>

      <div className="card">
        <div className="card-header">ZJU 学习任务导入</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={handlePreview} disabled={zjuBusy}>{zjuBusy ? '处理中...' : '预览任务'}</button>
          <button className="btn btn-primary" onClick={handleImport} disabled={zjuBusy || previewItems.length === 0}>导入可导入项</button>
          <button className="btn btn-danger" onClick={handleUndo} disabled={zjuBusy}>撤销上次任务导入</button>
        </div>
        {zjuErrors.length > 0 && (
          <div style={{ marginTop: 10, color: 'var(--warning)', fontSize: '0.85rem' }}>
            {zjuErrors.map((error, index) => <div key={index}>{error}</div>)}
          </div>
        )}
        {previewItems.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {previewItems.map((item) => (
              <div key={`${item.source}:${item.external_id}`} className="todo-item" style={{ cursor: 'default' }}>
                <div className="todo-name">
                  <div>{item.course_name ? `[${item.course_name}] ` : ''}{item.title}</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    {item.source} · {item.type || 'task'} · {item.ddl_at ? new Date(item.ddl_at).toLocaleString() : '无截止时间'}
                  </div>
                </div>
                <div className="todo-meta">{item.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">ZJU 课表导入日迹计划日程</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <div className="form-group">
            <label>学年</label>
            <select value={academicYear} onChange={e => setAcademicYear(e.target.value)}>
              {academicYears.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>学期</label>
            <select value={semester} onChange={e => setSemester(Number(e.target.value))}>
              <option value={1}>秋冬学期</option>
              <option value={2}>春夏学期</option>
            </select>
          </div>

        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 10 }}>
          校历只会在点击“拉取并缓存校历”时访问 Celechron CDN；预览课表只使用本地缓存。
          当前缓存：{calendarState?.has_cache ? `已缓存（${calendarState.fetched_at ? new Date(calendarState.fetched_at).toLocaleString() : '时间未知'}）` : '未缓存'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={handleFetchCalendar} disabled={scheduleBusy}>拉取并缓存校历</button>
          <button className="btn btn-primary" onClick={handlePreviewSchedule} disabled={scheduleBusy}>{scheduleBusy ? '处理中...' : '预览课表'}</button>
          <button className="btn btn-primary" onClick={handleImportSchedule} disabled={scheduleBusy || scheduleItems.length === 0}>导入课程日程</button>
          <button className="btn btn-danger" onClick={handleUndoSchedule} disabled={scheduleBusy}>撤销上次课表导入</button>
        </div>
        {scheduleMessage && <div style={{ marginTop: 10, color: scheduleMessage.includes('失败') || scheduleMessage.includes('请') ? 'var(--danger)' : 'var(--text-secondary)' }}>{scheduleMessage}</div>}
        {scheduleErrors.length > 0 && (
          <div style={{ marginTop: 10, color: 'var(--warning)', fontSize: '0.85rem' }}>
            {scheduleErrors.map((error, index) => <div key={index}>{error}</div>)}
          </div>
        )}
        {scheduleItems.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {scheduleItems.map((item) => (
              <div key={`${item.source}:${item.external_id}`} className="todo-item" style={{ cursor: 'default' }}>
                <div className="todo-name">
                  <div>{item.course_name}</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    {formatDateTime(item.start_time)}-{formatDateTime(item.end_time).slice(-5)} · 第 {item.week} 周 · {item.sections} 节
                    {item.location ? ` · ${item.location}` : ''}{item.teacher ? ` · ${item.teacher}` : ''}
                  </div>
                </div>
                <div className="todo-meta">{item.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
