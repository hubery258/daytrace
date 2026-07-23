export const AI_DRAFT_SYSTEM_PROMPT = `你是日迹的 AI 草稿助手，只能生成待办和日程草稿，不能直接创建、修改或删除任何数据。

必须遵守：
- 只输出 JSON，不要输出 Markdown、解释文字或代码块。
- 顶层结构必须是 {"type":"drafts","items":[...]}。
- items 里只能包含 draft_type 为 "todo" 或 "schedule" 的草稿，绝对不要生成项目草稿。
- 待办草稿字段：draft_type, name, ddl_type, ddl_date, reminder_days, category, status, project_id, notes, reason。
- 日程草稿字段：draft_type, name, start_time, end_time, is_planned, project_id, linked_todo_ids, location, notes, reason。
- 时间使用 YYYY-MM-DDTHH:mm:ss，本地时间，不要带时区。
- ddl_type 只能是 "none", "hard", "soft"；status 只能是 "not_focusing", "focusing", "waiting_reply"。
- project_id 只能使用上下文里已有项目的 id；没有归属项目时用 null。
- linked_todo_ids 只能使用上下文里已有未完成待办的 id 数组，最多 2 个。
- 如果用户要求批量生成，请尽量精确匹配数量。
- AI 只提供草稿，用户确认后才会写入。`;

export function buildAiCreateDraftUserMessage({ text, dateContext, projects, todos, schedules }) {
  return `用户自然语言需求：
${text}

日期上下文：
- 今天：${dateContext.today}
- 明天：${dateContext.tomorrow}

当前可用项目：
${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || '无'}, status=${p.status}`).join('\n') : '无'}

可参考未完成待办（只用于关联或避免重复）：
${todos.length ? todos.slice(0, 30).map(t => `- id=${t.id}, name=${t.name}, ddl_type=${t.ddl_type}, ddl_date=${t.ddl_date || '无'}, project_id=${t.project_id || '无'}`).join('\n') : '无'}

今天和明天已有日程（用于避开冲突）：
${schedules.length ? schedules.map(s => `- id=${s.id}, ${s.name}, ${s.start_time} 到 ${s.end_time}, planned=${s.is_planned}, project_id=${s.project_id || '无'}`).join('\n') : '无'}

请生成待办/日程草稿 JSON。`;
}

export function buildDailyDraftUserMessage({ selectedDate, logText, completedTodos, pendingTodos, todaySchedules, tomorrowSchedules, projects }) {
  return `请根据今日总结数据，生成可供用户确认的明日待办或日程草稿。不要生成项目草稿。

日期：
- 总结日期：${selectedDate}

用户今日日志：
${logText || '（用户还没有写日志）'}

今日完成待办：
${completedTodos.length ? completedTodos.map(t => `- id=${t.id}, name=${t.name}, project_id=${t.project_id || '无'}`).join('\n') : '无'}

仍未完成待办：
${pendingTodos.length ? pendingTodos.slice(0, 30).map(t => `- id=${t.id}, name=${t.name}, ddl_type=${t.ddl_type}, ddl_date=${t.ddl_date || '无'}, project_id=${t.project_id || '无'}`).join('\n') : '无'}

今日已有日程：
${todaySchedules.length ? todaySchedules.map(s => `- ${s.name}, ${s.start_time} 到 ${s.end_time}`).join('\n') : '无'}

明日已有日程（用于避开冲突）：
${tomorrowSchedules.length ? tomorrowSchedules.map(s => `- ${s.name}, ${s.start_time} 到 ${s.end_time}`).join('\n') : '无'}

当前项目：
${projects.length ? projects.map(p => `- id=${p.id}, name=${p.name}, ddl=${p.ddl_date || '无'}, status=${p.status}`).join('\n') : '无'}

请输出 JSON 草稿。`;
}
