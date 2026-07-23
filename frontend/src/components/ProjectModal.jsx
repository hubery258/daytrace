import { useState } from 'react';
import { projectApi } from '../api/client';

const STATUSES = [
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '暂停' },
  { value: 'completed', label: '已完成' },
  { value: 'archived', label: '已归档' },
  { value: 'canceled', label: '已取消' },
];

const COLORS = ['#4f46e5', '#0f766e', '#dc2626', '#d97706', '#7c3aed', '#475569'];

export default function ProjectModal({ project, onClose, onSaved }) {
  const isEdit = !!project;
  const [form, setForm] = useState({
    name: project?.name || '',
    description: project?.description || '',
    status: project?.status || 'active',
    ddl_date: project?.ddl_date || '',
    color: project?.color || COLORS[0],
  });

  const handleChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      ddl_date: form.ddl_date || null,
      color: form.color || null,
    };

    try {
      if (isEdit) {
        await projectApi.update(project.id, payload);
      } else {
        await projectApi.create(payload);
      }
      onSaved();
    } catch (err) {
      alert('操作失败：' + err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2>{isEdit ? '修改项目' : '新建项目'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>项目名 *</label>
            <input
              value={form.name}
              onChange={e => handleChange('name', e.target.value)}
              placeholder="输入项目名称"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>状态</label>
            <select value={form.status} onChange={e => handleChange('status', e.target.value)}>
              {STATUSES.map(status => (
                <option key={status.value} value={status.value}>{status.label}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>DDL</label>
            <input
              type="date"
              value={form.ddl_date || ''}
              onChange={e => handleChange('ddl_date', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>颜色</label>
            <div className="color-row">
              {COLORS.map(color => (
                <button
                  key={color}
                  type="button"
                  className={`color-swatch ${form.color === color ? 'active' : ''}`}
                  style={{ backgroundColor: color }}
                  onClick={() => handleChange('color', color)}
                  aria-label={`选择颜色 ${color}`}
                />
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>描述/备注</label>
            <textarea
              value={form.description}
              onChange={e => handleChange('description', e.target.value)}
              placeholder="项目说明、推进备注、验收条件等"
            />
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary">{isEdit ? '保存修改' : '创建项目'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}