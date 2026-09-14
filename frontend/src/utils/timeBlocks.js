export function groupTimeBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) =>
    String(a.block_date).localeCompare(String(b.block_date)) || a.start_minute - b.start_minute);
  const groups = [];
  for (const block of sorted) {
    const last = groups.at(-1);
    if (last && last.block_date === block.block_date && last.end_minute === block.start_minute &&
        last.category_id === block.category_id && (last.notes || '') === (block.notes || '') &&
        (last.linked_todo_id || null) === (block.linked_todo_id || null) &&
        (last.project_id || null) === (block.project_id || null)) {
      last.end_minute = block.end_minute;
      last.blocks.push(block);
    } else {
      groups.push({ ...block, blocks: [block] });
    }
  }
  return groups;
}

export function minuteLabel(minute) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

export function groupsAsEvents(groups, categories, todos, projects) {
  const categoryById = new Map(categories.map(item => [item.id, item]));
  const todoById = new Map(todos.map(item => [item.id, item]));
  const projectById = new Map(projects.map(item => [item.id, item]));
  return groups.map(group => {
    const category = categoryById.get(group.category_id);
    const todo = todoById.get(group.linked_todo_id);
    const project = projectById.get(group.project_id);
    const start_time = group.block_date + 'T' + minuteLabel(group.start_minute) + ':00';
    const end_time = group.end_minute === 1440
      ? new Date(new Date(group.block_date + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10) + 'T00:00:00'
      : group.block_date + 'T' + minuteLabel(group.end_minute) + ':00';
    return {
      id: 'block-' + group.block_date + '-' + group.start_minute,
      is_time_block: true, is_planned: false, block_group: group,
      name: group.notes || category?.name || '实际记录',
      start_time, end_time, project_id: group.project_id,
      notes: [category?.name, todo?.name, project?.name].filter(Boolean).join(' · '),
      location: null, color: category?.color || '#347f88',
    };
  });
}
