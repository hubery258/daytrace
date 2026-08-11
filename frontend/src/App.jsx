import { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import HomePage from './pages/HomePage';
import SchedulePage from './pages/SchedulePage';
import TimerPage from './pages/TimerPage';
import TodoSummaryPage from './pages/TodoSummaryPage';
import ProjectListPage from './pages/ProjectListPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import DailySummaryPage from './pages/DailySummaryPage';
import SettingsPage from './pages/SettingsPage';
import ZjuPage from './pages/ZjuPage';
import AiCreatePage from './pages/AiCreatePage';
import logo from './assets/brand/riji-logo.svg';
import { DISPLAY_PREFERENCES_EVENT, readDisplayPreferences } from './utils/displayPreferences';

const NAV_ITEMS = [
  { key: 'home', to: '/', label: '首页', end: true },
  { key: 'schedule', to: '/schedule', label: '日程' },
  { key: 'timer', to: '/timer', label: '计时' },
  { key: 'projects', to: '/projects', label: '项目' },
  { key: 'todos', to: '/todos', label: '待办' },
  { key: 'summary', to: '/summary', label: '今日总结' },
  { key: 'zju', to: '/zju', label: 'ZJU' },
];

export default function App() {
  const [displayPreferences, setDisplayPreferences] = useState(readDisplayPreferences);

  useEffect(() => {
    const refresh = () => setDisplayPreferences(readDisplayPreferences());
    window.addEventListener(DISPLAY_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(DISPLAY_PREFERENCES_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return (
    <div className="app">
      <nav className="nav-bar">
        <div className="brand-lockup" aria-label="日迹，本地优先个人效率工具">
          <img src={logo} alt="" className="brand-mark" />
          <span className="brand-copy"><strong>日迹</strong><small>计划与现实的每日痕迹</small></span>
        </div>
        <div className="nav-links" aria-label="主要页面">
          {NAV_ITEMS.filter(item => displayPreferences.pages[item.key]).map(item => (
            <NavLink
              key={item.key}
              to={item.to}
              end={item.end}
              className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
            >
              {item.label}
            </NavLink>
          ))}
          <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
            设置
          </NavLink>
        </div>
      </nav>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/timer" element={<TimerPage />} />
          <Route path="/projects" element={<ProjectListPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/todos" element={<TodoSummaryPage />} />
          <Route path="/summary" element={<DailySummaryPage />} />
          <Route path="/zju" element={<ZjuPage />} />
          <Route path="/ai-create" element={<AiCreatePage />} />
        </Routes>
      </main>
    </div>
  );
}
