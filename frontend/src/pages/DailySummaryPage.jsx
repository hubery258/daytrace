import { useState, useEffect, useCallback } from 'react';
import { logApi, templateApi, todoApi, scheduleApi } from '../api/client';
import { todayStr, parseAsLocal, formatTime } from '../utils/time';

const TODAY = todayStr();

const STORAGE_KEY_API_KEY = 'simpletasker_api_key';
const STORAGE_KEY_API_BASE = 'simpletasker_api_base';
const STORAGE_KEY_MODEL = 'simpletasker_ai_model';
const STORAGE_KEY_PROMPT = 'simpletasker_ai_prompt';
const DEFAULT_API_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

const DEFAULT_PROMPT = `你是一位专业的个人效率助手，你的任务是帮助用户分析每日的时间管理情况并提供改进建议。

## 你的职责
1. 阅读用户提供的今日待办完成情况和日程执行情况
2. 分析用户的效率表现，指出亮点和不足
3. 针对不足之处给出具体的改进建议
4. 根据用户明天的日程和待办，给出合理的明日安排建议

## 注意事项
- 保持语气温和、鼓励，像一位关心朋友成长的导师
- 分析要具体，引用实际数据（如完成了几个待办、日程执行率等）
- 建议要可操作，不要太空泛
- 如果用户某天表现不佳，不要批评，而是帮助用户找到原因
- 回复长度控制在 300-500 字`;

export default function DailySummaryPage() {
  const [log, setLog] = useState(null);
  const [logText, setLogText] = useState('');
  const [completedTodos, setCompletedTodos] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(TODAY);
  const [loading, setLoading] = useState(false);
  const [allTodos, setAllTodos] = useState([]);

  // AI state
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMessage, setAiMessage] = useState('');
  const [aiError, setAiError] = useState('');

  const loadLog = useCallback(async (date) => {
    setLoading(true);
    try {
      const data = await logApi.get(date);
      setLog(data);
      setLogText(data.log_text || '');
      setCompletedTodos(data.completed_todo_ids || []);
    } catch {
      setLog(null);
      setLogText('');
      setCompletedTodos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const data = await templateApi.list();
      setTemplates(data);
    } catch (err) {
      console.error('加载模板失败', err);
    }
  }, []);

  useEffect(() => {
    loadLog(selectedDate);
    loadTemplates();
    todoApi.list({}).then(setAllTodos).catch(() => {});
    setAiMessage('');
    setAiError('');
  }, [selectedDate, loadLog, loadTemplates]);

  const handleSave = async () => {
    try {
      await logApi.upsert({
        log_date: selectedDate,
        completed_todo_ids: completedTodos,
        log_text: logText,
      });
      alert('已保存');
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  };

  const applyTemplate = (content) => {
    setLogText(prev => prev + (prev ? '\n' : '') + content);
  };

  const handleAiAnalyze = async () => {
    const apiKey = localStorage.getItem(STORAGE_KEY_API_KEY);
    if (!apiKey) {
      setAiError('请先在设置页填写 API Key');
      return;
    }

    setAiLoading(true);
    setAiError('');
    setAiMessage('');

    try {
      // Fetch today's data
      const [todos, schedules] = await Promise.all([
        todoApi.list({ is_completed: false }).catch(() => []),
        scheduleApi.list({ date_from: `${selectedDate}T00:00:00`, date_to: `${selectedDate}T23:59:59` }).catch(() => []),
      ]);

      // Build context
      const completedList = completedTodos.length
        ? `完成了 ${completedTodos.length} 个待办（ID: ${completedTodos.join(', ')}）`
        : '今日暂无完成的待办';

      const pendingTodos = todos.filter(t => !t.is_completed);
      const pendingList = pendingTodos.length
        ? pendingTodos.map(t => `- ${t.name}（${t.ddl_type === 'hard' ? '硬性' : t.ddl_type === 'soft' ? '弹性' : '无'}DDL，状态: ${t.status}）`).join('\n')
        : '无待完成待办';

      const plannedSchedules = schedules.filter(s => s.is_planned);
      const actualSchedules = schedules.filter(s => !s.is_planned);
      const scheduleInfo = [
        `计划日程 ${plannedSchedules.length} 个：`,
        ...plannedSchedules.map(s => `  - ${s.name}（${formatTime(s.start_time)}-${formatTime(s.end_time)}）`),
        `实际记录 ${actualSchedules.length} 个：`,
        ...actualSchedules.map(s => `  - ${s.name}（${formatTime(s.start_time)}-${formatTime(s.end_time)}）`),
      ].join('\n');

      const todayLog = log?.log_text || '（用户还未写今日日志）';

      const userMessage = `## 今日数据

**日期**：${selectedDate}

**待办完成情况**：
${completedList}

**未完成待办**：
${pendingList}

**日程执行情况**：
${scheduleInfo}

**用户今日日志**：
${todayLog}

请帮我分析今日效率并给出建议。`;

      // Call AI
      const apiBase = (localStorage.getItem(STORAGE_KEY_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, '');
      const model = localStorage.getItem(STORAGE_KEY_MODEL) || DEFAULT_MODEL;
      const systemPrompt = localStorage.getItem(STORAGE_KEY_PROMPT) || DEFAULT_PROMPT;

      const res = await fetch(`${apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 800,
          temperature: 0.7,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `请求失败 (${res.status})`);
      }

      const data = await res.json();
      setAiMessage(data.choices?.[0]?.message?.content || '（AI 未返回内容）');
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  };

  const isToday = selectedDate === TODAY;
  const hasApiKey = !!localStorage.getItem(STORAGE_KEY_API_KEY);

  return (
    <div className="summary-layout">
      {/* Date Selector */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          max={TODAY}
          style={{
            padding: '8px 12px',
            border: '1px solid var(--border)',
            borderRadius: 8,
            fontSize: '0.95rem',
          }}
        />
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          {isToday ? '📝 今日总结' : '📖 往日记录（只读参考）'}
        </span>
      </div>

      {/* AI Chat */}
      <div className="ai-chat">
        <h3>🤖 AI 效率分析</h3>

        {!hasApiKey && (
          <div className="ai-chat-placeholder">
            <p>还未配置 API Key</p>
            <a href="/settings" style={{ color: 'var(--primary)', fontSize: '0.9rem' }}>
              前往设置页配置 →
            </a>
          </div>
        )}

        {hasApiKey && !aiMessage && !aiLoading && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <button className="btn btn-primary" onClick={handleAiAnalyze}>
              🔍 分析今日效率
            </button>
          </div>
        )}

        {aiLoading && (
          <div className="ai-chat-placeholder">
            <p>🤔 AI 正在分析你的今日数据...</p>
          </div>
        )}

        {aiError && (
          <div style={{
            background: '#fef2f2',
            color: 'var(--danger)',
            padding: '12px 16px',
            borderRadius: 8,
            fontSize: '0.9rem',
            marginBottom: 12,
          }}>
            ❌ {aiError}
            <div style={{ marginTop: 8 }}>
              <button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>重试</button>
            </div>
          </div>
        )}

        {aiMessage && (
          <div>
            <div style={{
              whiteSpace: 'pre-wrap',
              lineHeight: 1.8,
              fontSize: '0.92rem',
              background: '#f9fafb',
              padding: '16px',
              borderRadius: 8,
              marginBottom: 12,
            }}>
              {aiMessage}
            </div>
            <button className="btn btn-sm btn-secondary" onClick={handleAiAnalyze}>
              🔄 重新分析
            </button>
          </div>
        )}
      </div>

      {/* Completed Todos */}
      <div className="completed-list">
        <h3>✅ 今日完成待办</h3>
        {completedTodos.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            暂无完成的待办，去首页点击待办旁的圆圈来完成任务吧
          </div>
        ) : (
          completedTodos.map((id, i) => {
            const todo = allTodos.find(t => t.id === id);
            return (
              <div key={i} style={{ padding: '4px 0', fontSize: '0.9rem' }}>
                🎯 {todo ? todo.name : `待办 #${id}`}
              </div>
            );
          })
        )}
      </div>

      {/* Daily Log */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>📓 今日日志</h3>

        {/* Templates */}
        {templates.length > 0 && (
          <div className="template-bar">
            {templates.map(t => (
              <button
                key={t.id}
                className="template-chip"
                onClick={() => applyTemplate(t.content)}
                title={t.name}
              >
                {t.name}
              </button>
            ))}
          </div>
        )}

        <div className="log-editor">
          <textarea
            value={logText}
            onChange={e => setLogText(e.target.value)}
            placeholder="记录今天的想法、收获、反思..."
            readOnly={!isToday}
          />
        </div>

        {isToday && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleSave}>保存日志</button>
          </div>
        )}
      </div>
    </div>
  );
}
