// Resolve against current projects at render time; never store this label on an entity.
export function projectItemDisplayName(item, projects = []) {
  const name = item?.name ?? '';
  if (item?.project_id == null || item.project_id === '') return name;
  const project = projects.find(project => String(project.id) === String(item.project_id));
  return project?.name ? `${project.name}·${name}` : name;
}

// Actual records retain their existing historical display semantics.
export function scheduleDisplayName(schedule, projects = []) {
  return schedule?.is_planned && !schedule.is_time_block
    ? projectItemDisplayName(schedule, projects)
    : schedule?.name ?? '';
}
