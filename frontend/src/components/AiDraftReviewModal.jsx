import { useMemo, useState } from 'react';
import { scheduleApi, todoApi } from '../api/client';
import { scheduleDraftToPayload, todoDraftToPayload } from '../ai/aiDraftParser';

function asInputDateTime(value) {
  return value ? value.slice(0, 16) : '';
}

function fromInputDateTime(value) {
  return value ? `${value}:00` : null;
}

function DraftMeta({ draft, projects, todos }) {
  const project = draft.project_id ? projects.find(p => Number(p.id) === Number(draft.project_id)) : null;
  const linkedTodos = draft.linked_todo_ids?.length
    ? draft.linked_todo_ids.map(id => todos.find(t => Number(t.id) === Number(id))?.name || `#${id}`).join('、')
    : '';

  return (
    <div className="ai-draft-meta">
      {project && <span>项目：{project.name}</span>}
      {linkedTodos && <span>关联待办：{linkedTodos}</span>}
      {draft.reason && <span>依据：{draft.reason}</span>}
    </div>
  );
}

export default function AiDraftReviewModal({
  drafts,
  warnings = [],
  projects = [],
  todos = [],
  onClose,
  onCreated,
}) {
  const [items, setItems] = useState(() => drafts.map(draft => ({ ...draft, accepted: true })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const acceptedCount = useMemo(() => items.filter(item => item.accepted).length, [items]);

  const updateDraft = (id, patch) => {
    setItems(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeDraft = (id) => {
    setItems(prev => prev.filter(item => item.id !== id));
  };

  const createOne = async (draft) => {
    if (draft.draft_type === 'todo') {
      return todoApi.create(todoDraftToPayload(draft));
    }
    return scheduleApi.create(scheduleDraftToPayload(draft));
  };

  const handleCreateAccepted = async () => {
    setSaving(true);
    setError('');
    try {
      const accepted = items.filter(item => item.accepted);
      for (const draft of accepted) {
        await createOne(draft);
      }
      onCreated?.(accepted);
    } catch (err) {
      setError(err.message || '创建失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content ai-draft-modal" onClick={e => e.stopPropagation()}>
        <div className="ai-draft-head">
          <div>
            <h2>AI 草稿确认</h2>
            <p>草稿只会在你确认后写入待办或日程。</p>
          </div>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>关闭</button>
        </div>

        {warnings.length > 0 && (
          <div className="ai-draft-warning">
            {warnings.map((warning, index) => <div key={index}>{warning}</div>)}
          </div>
        )}

        {error && <div className="ai-draft-error">{error}</div>}

        {items.length === 0 ? (
          <div className="empty-state small">没有可确认的草稿。</div>
        ) : (
          <div className="ai-draft-list">
            {items.map((draft, index) => (
              <div key={draft.id} className={`ai-draft-card ${draft.accepted ? '' : 'rejected'}`}>
                <div className="ai-draft-card-head">
                  <strong>{draft.draft_type === 'todo' ? '待办' : '日程'} #{index + 1}</strong>
                  <label className="ai-draft-toggle">
                    <input
                      type="checkbox"
                      checked={draft.accepted}
                      onChange={e => updateDraft(draft.id, { accepted: e.target.checked })}
                    />
                    接受
                  </label>
                </div>

                <div className="form-group">
                  <label>名称</label>
                  <input value={draft.name} onChange={e => updateDraft(draft.id, { name: e.target.value })} />
                </div>

                {draft.draft_type === 'todo' ? (
                  <>
                    <div className="ai-draft-grid">
                      <div className="form-group">
                        <label>DDL 类型</label>
                        <select value={draft.ddl_type} onChange={e => updateDraft(draft.id, { ddl_type: e.target.value })}>
                          <option value="none">无 DDL</option>
                          <option value="hard">硬 DDL</option>
                          <option value="soft">软 DDL</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label>提醒天数</label>
                        <input
                          type="number"
                          min="0"
                          value={draft.reminder_days ?? ''}
                          disabled={draft.ddl_type === 'none'}
                          onChange={e => updateDraft(draft.id, { reminder_days: e.target.value })}
                        />
                      </div>
                    </div>
                    {draft.ddl_type !== 'none' && (
                      <div className="form-group">
                        <label>DDL 日期</label>
                        <input
                          type="datetime-local"
                          value={asInputDateTime(draft.ddl_date)}
                          onChange={e => updateDraft(draft.id, { ddl_date: fromInputDateTime(e.target.value) })}
                        />
                      </div>
                    )}
                    <div className="ai-draft-grid">
                      <div className="form-group">
                        <label>分类</label>
                        <input value={draft.category} onChange={e => updateDraft(draft.id, { category: e.target.value })} />
                      </div>
                      <div className="form-group">
                        <label>状态</label>
                        <select value={draft.status} onChange={e => updateDraft(draft.id, { status: e.target.value })}>
                          <option value="not_focusing">不关注</option>
                          <option value="focusing">关注中</option>
                          <option value="waiting_reply">等待答复</option>
                        </select>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ai-draft-grid">
                      <div className="form-group">
                        <label>开始时间</label>
                        <input
                          type="datetime-local"
                          value={asInputDateTime(draft.start_time)}
                          onChange={e => updateDraft(draft.id, { start_time: fromInputDateTime(e.target.value) })}
                        />
                      </div>
                      <div className="form-group">
                        <label>结束时间</label>
                        <input
                          type="datetime-local"
                          value={asInputDateTime(draft.end_time)}
                          onChange={e => updateDraft(draft.id, { end_time: fromInputDateTime(e.target.value) })}
                        />
                      </div>
                    </div>
                    <div className="ai-draft-grid">
                      <div className="form-group">
                        <label>类型</label>
                        <select value={draft.is_planned ? 'planned' : 'actual'} onChange={e => updateDraft(draft.id, { is_planned: e.target.value === 'planned' })}>
                          <option value="planned">计划日程</option>
                          <option value="actual">实际记录</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label>地点</label>
                        <input value={draft.location || ''} onChange={e => updateDraft(draft.id, { location: e.target.value })} />
                      </div>
                    </div>
                  </>
                )}

                <div className="form-group">
                  <label>所属项目</label>
                  <select value={draft.project_id || ''} onChange={e => updateDraft(draft.id, { project_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">不归属项目</option>
                    {projects.map(project => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>备注</label>
                  <textarea value={draft.notes || ''} onChange={e => updateDraft(draft.id, { notes: e.target.value })} />
                </div>

                <DraftMeta draft={draft} projects={projects} todos={todos} />
                <button className="btn btn-sm btn-danger" onClick={() => removeDraft(draft.id)}>拒绝这条</button>
              </div>
            ))}
          </div>
        )}

        <div className="form-actions">
          <button className="btn btn-secondary" onClick={() => setItems(prev => prev.map(item => ({ ...item, accepted: false })))}>全部拒绝</button>
          <button className="btn btn-secondary" onClick={() => setItems(prev => prev.map(item => ({ ...item, accepted: true })))}>全部接受</button>
          <button className="btn btn-primary" disabled={saving || acceptedCount === 0} onClick={handleCreateAccepted}>
            {saving ? '创建中...' : `确认创建 ${acceptedCount} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}
