import policy from '../../../backend/app/merge_field_policy.json' with { type: 'json' };
export { policy as mergeFieldPolicy };

const clone = value => JSON.parse(JSON.stringify(value));
const matches = (rule, entity, row) => rule.entity === entity &&
  Object.entries(rule.when || {}).every(([key, value]) => row[key] === value);

// Comparison and conflict payloads use this projection; portable records stay intact.
export function conflictRecord(entity, row) {
  const result = clone(row);
  for (const rule of policy) if (matches(rule, entity, row)) {
    const target = rule.container ? result[rule.container] || {} : result;
    for (const field of rule.fields) delete target[field];
  }
  return result;
}

export function preserveLocalFields(entity, selected, local) {
  const result = clone(selected);
  for (const rule of policy) if (matches(rule, entity, local) && matches(rule, entity, selected)) {
    const source = rule.container ? local[rule.container] || {} : local;
    const target = rule.container ? (result[rule.container] ??= {}) : result;
    for (const field of rule.fields) {
      if (Object.hasOwn(source, field)) target[field] = clone(source[field]);
      else delete target[field];
    }
  }
  return result;
}
