import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectApi } from '../api/client';
import ProjectModal from '../components/ProjectModal';

const STATUS_LABELS = {
  active: '进行中',
  paused: '暂停',
  completed: '已完成',
  archived: '已归档',
  canceled: '已取消',
};

function formatDate(date) {
  if (!date) return '';
  return new Date(`${date}T00:00:00`).toLocaleDateString('zh-CN');
}

function formatProgress(project) {
  if (!project.todo_count) return '暂无待办';
  return `${project.completed_todo_count}/${project.todo_count} · ${Math.round((project.progress || 0) * 100)}%`;
}

export default function ProjectListPage() {
  const [projects, setProjects] = useState([]);
  const [statusFilter, setStatusFilter] = useState('visible');
  const [showModal, setShowModal] = useState(false);

  const loadProjects = useCallback(async () => {
    const params = statusFilter === 'visible'
      ? {}
      : { status: statusFilter, include_hidden: true };
    const data = await projectApi.list(params);
    setProjects(data);
  }, [statusFilter]);

  useEffect(() => {
    loadProjects().catch(err => console.error('加载项目失败', err));
  }, [loadProjects]);

  return (
    <div>
      <div className="page-header">
        <h1>项目</h1>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>新建项目</button>
      </div>

      <div className="filter-row">
        {[
          ['visible', '默认'],
          ['active', '进行中'],
          ['paused', '暂停'],
          ['completed', '已完成'],
          ['archived', '归档'],
          ['canceled', '取消'],
        ].map(([value, label]) => (
          <button
            key={value}
            className={`btn btn-sm ${statusFilter === value ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatusFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {projects.length === 0 ? (
        <div className="card empty-state">暂无项目</div>
      ) : (
        <div className="project-grid">
          {projects.map(project => (
            <Link key={project.id} className="project-card" to={`/projects/${project.id}`}>
              <div className="project-card-top">
                <span className="project-color" style={{ backgroundColor: project.color || '#4f46e5' }} />
                <span className={`status-pill status-${project.status}`}>{STATUS_LABELS[project.status]}</span>
              </div>
              <h2>{project.name}</h2>
              {project.description && <p>{project.description}</p>}
              <div className="project-progress">
                <div className="progress-bar">
                  <span style={{ width: project.progress == null ? '0%' : `${Math.round(project.progress * 100)}%` }} />
                </div>
                <span>{formatProgress(project)}</span>
              </div>
              {project.next_todo && <div className="project-card-meta">下一步：{project.next_todo.name}</div>}
              {project.ddl_date && <div className="project-card-meta">DDL：{formatDate(project.ddl_date)}</div>}
            </Link>
          ))}
        </div>
      )}

      {showModal && (
        <ProjectModal
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); loadProjects(); }}
        />
      )}
    </div>
  );
}