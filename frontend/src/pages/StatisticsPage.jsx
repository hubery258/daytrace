import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectApi, timeBlockApi, todoApi } from '../api/client';
import { todayStr } from '../utils/time';
import {
  aggregateTimeStatistics, fetchTimeBlocksRange, formatStatisticsMinutes,
  shiftStatisticsAnchor, statisticsRange,
} from '../utils/timeStatistics';

const VIEW_OPTIONS = [
  ['day', '今天'],
  ['week', '本周'],
  ['year', '本年'],
  ['custom', '自定义'],
];

function dateLabel(value) {
  return new Date(value + 'T12:00:00').toLocaleDateString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function DonutChart({ rows, total, selectedId, onSelect }) {
  const radius = 68;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="statistics-donut-wrap">
      <svg className="statistics-donut" viewBox="0 0 200 200" aria-label="属性时间占比图">
        <circle cx="100" cy="100" r={radius} fill="none" stroke="#edf0eb" strokeWidth="30" />
        {rows.map(row => {
          const length = total ? row.minutes / total * circumference : 0;
          const start = offset;
          offset += length;
          return <circle key={row.id} cx="100" cy="100" r={radius} fill="none"
            stroke={row.color} strokeWidth={String(row.id) === String(selectedId) ? 36 : 30}
            strokeDasharray={length + ' ' + (circumference - length)}
            strokeDashoffset={-start} transform="rotate(-90 100 100)"
            role="button" tabIndex={0}
            aria-label={row.name + '，' + formatStatisticsMinutes(row.minutes)}
            onClick={() => onSelect(row.id)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.id); } }} />;
        })}
        <text x="100" y="95" textAnchor="middle" className="statistics-donut-value">
          {formatStatisticsMinutes(total)}
        </text>
        <text x="100" y="117" textAnchor="middle" className="statistics-donut-caption">已记录时间</text>
      </svg>
      <p>占比以已记录的时间为分母</p>
    </div>
  );
}

function TimeBar({ value, maximum, color }) {
  return <span className="statistics-bar-track"><span
    style={{ width: Math.max(0, Math.min(100, maximum ? value / maximum * 100 : 0)) + '%', backgroundColor: color }} />
  </span>;
}

export default function StatisticsPage() {
  const today = todayStr();
  const [mode, setMode] = useState('day');
  const [anchor, setAnchor] = useState(today);
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [blocks, setBlocks] = useState([]);
  const [categories, setCategories] = useState([]);
  const [todos, setTodos] = useState([]);
  const [projects, setProjects] = useState([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState(null);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  let range = null;
  let rangeError = '';
  try { range = statisticsRange(mode, anchor, customStart, customEnd); }
  catch (cause) { rangeError = cause.message; }

  useEffect(() => {
    if (!range) {
      setBlocks([]);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError('');
    Promise.all([
      fetchTimeBlocksRange(timeBlockApi, range.from, range.to),
      timeBlockApi.categories(), todoApi.list({}), projectApi.list({ include_hidden: true }),
    ]).then(([blockItems, categoryItems, todoItems, projectItems]) => {
      if (!active) return;
      setBlocks(blockItems);
      setCategories(categoryItems);
      setTodos(todoItems);
      setProjects(projectItems);
      setLoading(false);
    }).catch(cause => {
      if (!active) return;
      setError(cause.message || '统计数据读取失败');
      setLoading(false);
    });
    return () => { active = false; };
  }, [range?.from, range?.to]);

  const statistics = useMemo(
    () => aggregateTimeStatistics(blocks, categories, todos, projects),
    [blocks, categories, todos, projects],
  );
  const selectedCategory = statistics.categories.find(item =>
    String(item.id) === String(selectedCategoryId)) || statistics.categories[0];
  const categoryMaximum = statistics.categories[0]?.minutes || 0;
  const taskMaximum = statistics.tasks[0]?.minutes || 0;
  const visibleTasks = showAllTasks ? statistics.tasks : statistics.tasks.slice(0, 10);
  const rangeCaption = range
    ? range.from === range.to ? dateLabel(range.from) : dateLabel(range.from) + ' 至 ' + dateLabel(range.to)
    : '';

  const chooseMode = value => {
    setMode(value);
    setShowAllTasks(false);
  };

  const changeCustomStart = value => {
    setCustomStart(value);
    if (value > customEnd) setCustomEnd(value);
  };

  const changeCustomEnd = value => {
    setCustomEnd(value);
    if (value < customStart) setCustomStart(value);
  };

  return (
    <div className="statistics-page">
      <header className="page-hero page-hero-compact statistics-hero">
        <div>
          <div className="eyebrow">把真实投入看清楚</div>
          <h1>时间统计</h1>
          <p>按实际时间块计算。计划日程和旧实际日程都不会进入统计。</p>
        </div>
      </header>

      <section className="statistics-range-panel" aria-label="统计日期范围">
        <div className="statistics-view-tabs" role="group" aria-label="统计视图">
          {VIEW_OPTIONS.map(([key, name]) => <button key={key} type="button"
            className={mode === key ? 'active' : ''} aria-pressed={mode === key}
            onClick={() => chooseMode(key)}>{name}</button>)}
        </div>
        {mode === 'custom' ? (
          <div className="statistics-date-controls">
            <label>从 <input type="date" value={customStart} onChange={event => changeCustomStart(event.target.value)} /></label>
            <span>—</span>
            <label>到 <input type="date" value={customEnd} onChange={event => changeCustomEnd(event.target.value)} /></label>
          </div>
        ) : (
          <div className="statistics-date-controls">
            <button type="button" aria-label="上一段时间" onClick={() => setAnchor(shiftStatisticsAnchor(mode, anchor, -1))}>‹</button>
            <input type="date" value={anchor} aria-label="选择统计日期" onChange={event => setAnchor(event.target.value)} />
            <button type="button" onClick={() => setAnchor(todayStr())}>回到当前</button>
            <button type="button" aria-label="下一段时间" onClick={() => setAnchor(shiftStatisticsAnchor(mode, anchor, 1))}>›</button>
          </div>
        )}
        <div className="statistics-range-caption">{rangeCaption}{mode === 'custom' && <span> · 最小单位 1 天</span>}</div>
      </section>

      {rangeError && <div role="alert" className="notice notice-error">{rangeError}</div>}
      {error && <div role="alert" className="notice notice-error">{error}</div>}
      {loading ? <div className="statistics-loading" role="status">正在整理时间块…</div> : !rangeError && !error && (
        <>
          <div className="statistics-overview">
            <div><span>记录总时长</span><strong>{formatStatisticsMinutes(statistics.totalMinutes)}</strong><small>所选范围内的实际时间</small></div>
            <div><span>有记录的天数</span><strong>{statistics.activeDays} 天</strong><small>仅计存在时间块的日期</small></div>
            <div><span>关联任务时长</span><strong>{formatStatisticsMinutes(statistics.linkedMinutes)}</strong><small>未关联待办不计入任务</small></div>
          </div>

          {statistics.totalMinutes === 0 ? (
            <div className="statistics-empty">
              <strong>这段时间还没有实际记录</strong>
              <p>在日程页给时间格标上属性，统计就会出现在这里。</p>
              <Link className="btn btn-primary" to="/schedule">去记录时间</Link>
            </div>
          ) : (
            <div className="statistics-columns">
              <section className="statistics-card statistics-category-card">
                <div className="statistics-card-head">
                  <div><span className="statistics-section-kicker">01 / 时间去向</span><h2>按属性统计</h2></div>
                  <p>点选一种属性，查看其中的具体事件。</p>
                </div>
                <div className="statistics-chart-area">
                  <DonutChart rows={statistics.categories} total={statistics.totalMinutes}
                    selectedId={selectedCategory?.id} onSelect={setSelectedCategoryId} />
                  <div className="statistics-category-bars">
                    {statistics.categories.map(item => <button key={item.id} type="button"
                      className={'statistics-category-row' + (selectedCategory?.id === item.id ? ' active' : '')}
                      aria-pressed={selectedCategory?.id === item.id}
                      onClick={() => setSelectedCategoryId(item.id)}>
                      <span className="statistics-row-top">
                        <span className="statistics-swatch" style={{ backgroundColor: item.color }} />
                        <strong>{item.name}</strong>
                        <span>{formatStatisticsMinutes(item.minutes)}</span>
                        <small>{Math.round(item.minutes / statistics.totalMinutes * 100)}%</small>
                      </span>
                      <TimeBar value={item.minutes} maximum={categoryMaximum} color={item.color} />
                    </button>)}
                  </div>
                </div>
                {selectedCategory && <div className="statistics-event-details">
                  <div className="statistics-detail-head">
                    <h3><span className="statistics-swatch" style={{ backgroundColor: selectedCategory.color }} />
                      {selectedCategory.name} · 事件明细</h3>
                    <strong>{formatStatisticsMinutes(selectedCategory.minutes)}</strong>
                  </div>
                  {selectedCategory.events.map((event, index) => <div className="statistics-detail-row" key={index}>
                    <span><strong>{event.name}</strong>{event.detail && <small>{event.detail}</small>}</span>
                    <b>{formatStatisticsMinutes(event.minutes)}</b>
                    <TimeBar value={event.minutes} maximum={selectedCategory.minutes} color={selectedCategory.color} />
                  </div>)}
                </div>}
              </section>

              <section className="statistics-card statistics-task-card">
                <div className="statistics-card-head">
                  <div><span className="statistics-section-kicker">02 / 任务投入</span><h2>关联待办</h2></div>
                  <p>按时间块关联的待办汇总，同一任务跨日累加。</p>
                </div>
                {statistics.tasks.length === 0 ? <div className="statistics-task-empty">这段时间的记录尚未关联待办。编辑时间块并选择待办后，这里会显示任务投入。</div> :
                  <div className="statistics-task-list">
                    {visibleTasks.map((task, index) => <div className="statistics-task-row" key={task.id}>
                      <span className="statistics-task-rank">{String(index + 1).padStart(2, '0')}</span>
                      <div className="statistics-task-main">
                        <div><strong>{task.name}</strong><b>{formatStatisticsMinutes(task.minutes)}</b></div>
                        <small>{task.projectName}</small>
                        <TimeBar value={task.minutes} maximum={taskMaximum} color="#357f82" />
                      </div>
                    </div>)}
                    {statistics.tasks.length > 10 && <button className="statistics-show-more" type="button"
                      onClick={() => setShowAllTasks(!showAllTasks)}>{showAllTasks ? '收起任务' : '查看全部 ' + statistics.tasks.length + ' 个任务'}</button>}
                  </div>}
                {statistics.projects.length > 0 && <div className="statistics-project-summary">
                  <h3>按任务所属项目</h3>
                  {statistics.projects.map(project => <div key={project.id}>
                    <span>{project.name}</span><strong>{formatStatisticsMinutes(project.minutes)}</strong>
                  </div>)}
                </div>}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
