function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (!DATE_PATTERN.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

export function statisticsRange(mode, anchor, customStart, customEnd) {
  if (!validDate(anchor)) throw new Error('请选择有效日期');
  if (mode === 'day') return { from: anchor, to: anchor };
  if (mode === 'week') {
    const weekday = new Date(anchor + 'T00:00:00Z').getUTCDay() || 7;
    const from = addDays(anchor, 1 - weekday);
    return { from, to: addDays(from, 6) };
  }
  if (mode === 'year') {
    const year = anchor.slice(0, 4);
    return { from: year + '-01-01', to: year + '-12-31' };
  }
  if (mode === 'custom') {
    if (!validDate(customStart) || !validDate(customEnd) || customStart > customEnd) {
      throw new Error('自定义范围至少为一天，结束日期不能早于开始日期');
    }
    return { from: customStart, to: customEnd };
  }
  throw new Error('未知统计视图');
}

export function shiftStatisticsAnchor(mode, anchor, direction) {
  if (mode === 'day') return addDays(anchor, direction);
  if (mode === 'week') return addDays(anchor, direction * 7);
  if (mode === 'year') return String(Number(anchor.slice(0, 4)) + direction) + '-01-01';
  return anchor;
}

export async function fetchTimeBlocksRange(api, from, to) {
  if (!validDate(from) || !validDate(to) || from > to) throw new Error('统计日期范围无效');
  const windows = [];
  for (let cursor = from; cursor <= to;) {
    const end = addDays(cursor, 45) < to ? addDays(cursor, 45) : to;
    windows.push([cursor, end]);
    cursor = addDays(end, 1);
  }
  const blocks = [];
  for (let index = 0; index < windows.length; index += 4) {
    const batch = await Promise.all(windows.slice(index, index + 4).map(([start, end]) => api.list(start, end)));
    batch.forEach(items => blocks.push(...items));
  }
  return blocks;
}

function sortByMinutes(items) {
  return items.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'zh-CN'));
}

export function formatStatisticsMinutes(minutes) {
  const value = Math.max(0, Math.round(minutes || 0));
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return (hours ? hours + '小时' : '') + (rest ? rest + '分钟' : '') || '0分钟';
}

export function aggregateTimeStatistics(blocks, categories, todos, projects) {
  const categoryById = new Map(categories.map(item => [String(item.id), item]));
  const todoById = new Map(todos.map(item => [String(item.id), item]));
  const projectById = new Map(projects.map(item => [String(item.id), item]));
  const categoryRows = new Map();
  const taskRows = new Map();
  const projectRows = new Map();
  const activeDates = new Set();
  let totalMinutes = 0;
  let linkedMinutes = 0;

  for (const block of blocks) {
    const minutes = Number(block.end_minute) - Number(block.start_minute);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    totalMinutes += minutes;
    activeDates.add(block.block_date);

    const categoryKey = String(block.category_id);
    const category = categoryById.get(categoryKey);
    if (!categoryRows.has(categoryKey)) {
      categoryRows.set(categoryKey, {
        id: block.category_id, name: category?.name || '其他',
        color: category?.color || '#688b87', minutes: 0, events: new Map(),
      });
    }
    const categoryRow = categoryRows.get(categoryKey);
    categoryRow.minutes += minutes;

    const todoKey = block.linked_todo_id == null ? null : String(block.linked_todo_id);
    const todo = todoKey ? todoById.get(todoKey) : null;
    const projectId = todo ? todo.project_id : block.project_id;
    const project = projectId == null ? null : projectById.get(String(projectId));
    const notes = String(block.notes || '').trim();
    const eventKey = JSON.stringify([notes, todoKey, projectId == null ? null : String(projectId)]);
    if (!categoryRow.events.has(eventKey)) {
      categoryRow.events.set(eventKey, {
        name: notes || todo?.name || project?.name || '未注明事件',
        detail: [notes && todo?.name, project?.name].filter(Boolean).join(' · '),
        minutes: 0,
      });
    }
    categoryRow.events.get(eventKey).minutes += minutes;

    if (todoKey) {
      linkedMinutes += minutes;
      if (!taskRows.has(todoKey)) {
        taskRows.set(todoKey, {
          id: block.linked_todo_id, name: todo?.name || '待办 #' + todoKey,
          projectName: project?.name || '未归属项目', minutes: 0,
        });
      }
      taskRows.get(todoKey).minutes += minutes;
      if (project) {
        const key = String(project.id);
        if (!projectRows.has(key)) projectRows.set(key, { id: project.id, name: project.name, minutes: 0 });
        projectRows.get(key).minutes += minutes;
      }
    }
  }

  const categoryTotals = sortByMinutes(Array.from(categoryRows.values()).map(item => ({
    ...item, events: sortByMinutes(Array.from(item.events.values())),
  })));
  return {
    totalMinutes,
    linkedMinutes,
    activeDays: activeDates.size,
    categories: categoryTotals,
    tasks: sortByMinutes(Array.from(taskRows.values())),
    projects: sortByMinutes(Array.from(projectRows.values())),
  };
}
