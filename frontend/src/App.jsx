import { Routes, Route, NavLink } from 'react-router-dom';
import HomePage from './pages/HomePage';
import SchedulePage from './pages/SchedulePage';
import TodoSummaryPage from './pages/TodoSummaryPage';
import ProjectListPage from './pages/ProjectListPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import DailySummaryPage from './pages/DailySummaryPage';
import SettingsPage from './pages/SettingsPage';
import ZjuPage from './pages/ZjuPage';

export default function App() {
  return (
    <div className="app">
      <nav className="nav-bar">
        <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          🏠 首页
        </NavLink>
        <NavLink to="/schedule" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          📅 日程
        </NavLink>
        <NavLink to="/projects" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          🗂️ 项目
        </NavLink>
        <NavLink to="/todos" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          📋 待办汇总
        </NavLink>
        <NavLink to="/summary" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          📝 今日总结
        </NavLink>
        <NavLink to="/zju" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          🎓 ZJU
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          ⚙️
        </NavLink>
      </nav>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/projects" element={<ProjectListPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route path="/todos" element={<TodoSummaryPage />} />
          <Route path="/summary" element={<DailySummaryPage />} />
          <Route path="/zju" element={<ZjuPage />} />
        </Routes>
      </main>
    </div>
  );
}