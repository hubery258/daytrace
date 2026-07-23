export const AI_DRAFT_SYSTEM_PROMPT = `You are the AI draft assistant for Riji. You can only generate todo and schedule drafts. You must never directly create, edit, or delete data.

Rules:
- Output JSON only. No Markdown, no explanation, no code fence.
- Top-level shape must be {"type":"drafts","items":[...]}.
- Items may only use draft_type "todo" or "schedule". Never generate project drafts.
- Todo fields: draft_type, name, ddl_type, ddl_date, reminder_days, category, status, project_id, notes, reason.
- Schedule fields: draft_type, name, start_time, end_time, is_planned, project_id, linked_todo_ids, location, notes, reason.
- Use local datetime format YYYY-MM-DDTHH:mm:ss without timezone.
- ddl_type must be "none", "hard", or "soft". status must be "not_focusing", "focusing", or "waiting_reply".
- project_id may only use an existing project id from context, otherwise null.
- linked_todo_ids may only use existing incomplete todo ids from context, max 2.
- If the user asks for a batch, match the requested count as closely as possible.
- The user will review drafts before anything is written.`;

export const AI_CLARIFICATION_SYSTEM_PROMPT = `You are an efficiency planning assistant. The user has a vague planning need. Ask only the most important clarification questions before drafts are generated.

Rules:
- Output JSON only, no Markdown.
- Top-level shape must be {"type":"clarification","questions":["..."]}.
- Ask 1-3 concise questions.
- Focus on goal, deadline, available time, constraints, priority, and preferred rhythm.
- Do not create todos, schedules, projects, or logs.`;

export const AI_REFLECTION_QUESTION_SYSTEM_PROMPT = `You are a daily reflection assistant. Read today's data and ask focused reflection questions.

Rules:
- Output JSON only, no Markdown.
- Top-level shape must be {"type":"reflection_questions","questions":["..."]}.
- Ask 1-3 concise questions.
- Questions should help the user notice what worked, what got stuck, and what to change tomorrow.
- Do not create or modify any data.`;

export const AI_REFLECTION_SUMMARY_SYSTEM_PROMPT = `You are a daily reflection assistant. Read today's data and the user's answers, then produce a concise reflection summary.

Rules:
- Output plain text, not JSON.
- Include: today's summary, highlights, problems, concrete improvements, and tomorrow suggestions.
- Keep it actionable and gentle.
- Do not claim anything was saved or created.`;

export function buildAiCreateDraftUserMessage({ text, dateContext, projects, todos, schedules }) {
  return `User request:\n${text}\n\nDate context:\n- Today: ${dateContext.today}\n- Tomorrow: ${dateContext.tomorrow}\n\nAvailable projects:\n${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || 'none'}, status=${p.status}`).join('\n') : 'none'}\n\nIncomplete todos for reference or linking:\n${todos.length ? todos.slice(0, 30).map(t => `- id=${t.id}, name=${t.name}, ddl_type=${t.ddl_type}, ddl_date=${t.ddl_date || 'none'}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nExisting schedules today and tomorrow for conflict avoidance:\n${schedules.length ? schedules.map(s => `- id=${s.id}, ${s.name}, ${s.start_time} to ${s.end_time}, planned=${s.is_planned}, project_id=${s.project_id || 'none'}`).join('\n') : 'none'}\n\nReturn todo/schedule draft JSON.`;
}

export function buildDailyDraftUserMessage({ selectedDate, logText, completedTodos, pendingTodos, todaySchedules, tomorrowSchedules, projects }) {
  return `Generate confirmable tomorrow todo/schedule drafts from daily summary data. Do not generate project drafts.\n\nSummary date: ${selectedDate}\n\nUser log:\n${logText || '(empty)'}\n\nCompleted todos:\n${completedTodos.length ? completedTodos.map(t => `- id=${t.id}, name=${t.name}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nPending todos:\n${pendingTodos.length ? pendingTodos.slice(0, 30).map(t => `- id=${t.id}, name=${t.name}, ddl_type=${t.ddl_type}, ddl_date=${t.ddl_date || 'none'}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nToday schedules:\n${todaySchedules.length ? todaySchedules.map(s => `- ${s.name}, ${s.start_time} to ${s.end_time}`).join('\n') : 'none'}\n\nTomorrow schedules for conflict avoidance:\n${tomorrowSchedules.length ? tomorrowSchedules.map(s => `- ${s.name}, ${s.start_time} to ${s.end_time}`).join('\n') : 'none'}\n\nProjects:\n${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || 'none'}, status=${p.status}`).join('\n') : 'none'}\n\nReturn JSON drafts.`;
}

export function buildClarificationUserMessage({ text, dateContext, projects, todos, schedules }) {
  return `User's vague planning need:\n${text}\n\nDate context:\n- Today: ${dateContext.today}\n- Tomorrow: ${dateContext.tomorrow}\n\nAvailable projects:\n${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || 'none'}, status=${p.status}`).join('\n') : 'none'}\n\nIncomplete todos:\n${todos.length ? todos.slice(0, 20).map(t => `- id=${t.id}, name=${t.name}, ddl=${t.ddl_date || 'none'}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nToday and tomorrow schedules:\n${schedules.length ? schedules.map(s => `- ${s.name}, ${s.start_time} to ${s.end_time}`).join('\n') : 'none'}\n\nAsk clarification questions before generating drafts.`;
}

export function buildProjectNextDraftUserMessage({ project, todos, schedules }) {
  return `Generate next-step todo/schedule drafts for this existing project. Do not generate a project draft.\n\nProject:\n- id=${project.id}\n- name=${project.name}\n- description=${project.description || 'none'}\n- status=${project.status}\n- ddl=${project.ddl_date || 'none'}\n\nProject todos:\n${todos.length ? todos.map(t => `- id=${t.id}, name=${t.name}, completed=${t.is_completed}, ddl=${t.ddl_date || 'none'}, status=${t.status}`).join('\n') : 'none'}\n\nProject schedules:\n${schedules.length ? schedules.map(s => `- id=${s.id}, name=${s.name}, ${s.start_time} to ${s.end_time}, planned=${s.is_planned}`).join('\n') : 'none'}\n\nReturn JSON drafts. Use project_id=${project.id}.`;
}

export function buildScheduleGapDraftUserMessage({ date, todos, projects, schedules }) {
  return `Generate planned schedule drafts for open time on this date. Do not create project drafts. Avoid conflicts with existing schedules.\n\nTarget date: ${date}\n\nIncomplete todos to consider:\n${todos.length ? todos.slice(0, 30).map(t => `- id=${t.id}, name=${t.name}, ddl=${t.ddl_date || 'none'}, project_id=${t.project_id || 'none'}, status=${t.status}`).join('\n') : 'none'}\n\nProjects:\n${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || 'none'}, status=${p.status}`).join('\n') : 'none'}\n\nExisting schedules on target date:\n${schedules.length ? schedules.map(s => `- id=${s.id}, name=${s.name}, ${s.start_time} to ${s.end_time}, planned=${s.is_planned}`).join('\n') : 'none'}\n\nReturn JSON schedule drafts only when they fit open time.`;
}

export function buildReflectionQuestionUserMessage({ selectedDate, logText, completedTodos, pendingTodos, todaySchedules, projects }) {
  return `Date: ${selectedDate}\n\nUser log:\n${logText || '(empty)'}\n\nCompleted todos:\n${completedTodos.length ? completedTodos.map(t => `- id=${t.id}, name=${t.name}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nPending todos:\n${pendingTodos.length ? pendingTodos.slice(0, 30).map(t => `- id=${t.id}, name=${t.name}, ddl=${t.ddl_date || 'none'}, status=${t.status}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nSchedules:\n${todaySchedules.length ? todaySchedules.map(s => `- ${s.name}, ${s.start_time} to ${s.end_time}, planned=${s.is_planned}`).join('\n') : 'none'}\n\nProjects:\n${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || 'none'}, status=${p.status}`).join('\n') : 'none'}\n\nAsk reflection questions.`;
}

export function buildReflectionSummaryUserMessage({ selectedDate, logText, questions, answer, completedTodos, pendingTodos, todaySchedules, projects }) {
  return `Date: ${selectedDate}\n\nUser log:\n${logText || '(empty)'}\n\nAI questions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nUser answers:\n${answer || '(empty)'}\n\nCompleted todos:\n${completedTodos.length ? completedTodos.map(t => `- id=${t.id}, name=${t.name}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nPending todos:\n${pendingTodos.length ? pendingTodos.slice(0, 30).map(t => `- id=${t.id}, name=${t.name}, ddl=${t.ddl_date || 'none'}, status=${t.status}, project_id=${t.project_id || 'none'}`).join('\n') : 'none'}\n\nSchedules:\n${todaySchedules.length ? todaySchedules.map(s => `- ${s.name}, ${s.start_time} to ${s.end_time}, planned=${s.is_planned}`).join('\n') : 'none'}\n\nProjects:\n${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || 'none'}, status=${p.status}`).join('\n') : 'none'}\n\nWrite the reflection summary.`;
}
