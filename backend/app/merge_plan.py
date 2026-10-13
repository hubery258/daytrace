"""Pure manual merge planner. Mirrored by mergePlan.js and checked with shared fixtures."""
from __future__ import annotations

import copy
import hashlib
import json
import re
import uuid
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from .merge_fields import POLICY, conflict_record, preserve_local_fields

CONTRACT = json.loads(Path(__file__).with_name('merge_contract.json').read_text(encoding='utf-8'))
ORDER = list(CONTRACT)
STAMP = '2000-01-01T00:00:00'
BEIJING = timezone(timedelta(hours=8))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def stable_uuid(value):
    s = digest(value)
    return f'{s[:8]}-{s[8:12]}-5{s[13:16]}-a{s[17:20]}-{s[20:32]}'


def day(value):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        raise ValueError('日期无效')
    return value


def timestamp(value):
    if value is None or value == '':
        return None
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo:
        parsed = parsed.astimezone(BEIJING).replace(tzinfo=None)
    return parsed.isoformat(timespec='milliseconds' if parsed.microsecond else 'seconds')


def uuid_valid(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', value))


def identity(name, row):
    if name == 'daily_logs':
        return row['log_date']
    return row['uuid']


def exception_key(row):
    return (row['recurrence_rule_uuid'], row['entity_type'], row['recurrence_date'])


def business(row, entity=None, mode='merge'):
    compared = conflict_record(entity, row) if entity and mode == 'merge' else row
    return {k: v for k, v in compared.items() if k not in ('uuid', 'created_at', 'updated_at', 'origin_uuid')}


def block_content(row):
    return {k: v for k, v in business(row).items() if k not in ('block_date', 'start_minute', 'end_minute', 'granularity', 'coverage_seconds')}


def normalize_package(raw):
    if (not isinstance(raw, dict) or raw.get('app') != 'riji' or raw.get('schema_version') not in ('0.6.0', '0.8.0', '0.10.0') or not isinstance(raw.get('entities'), dict)):
        raise ValueError('不是受支持的日迹数据包')
    entities = {}
    for name in ORDER:
        items = raw['entities'].get(name, [])
        if not isinstance(items, list):
            raise ValueError(f'{name} 必须是数组')
        seen = set()
        result = []
        for item in items:
            if not isinstance(item, dict):
                raise ValueError('记录必须是对象')
            if name == 'schedules' and item.get('is_planned') is False:
                continue
            if name == 'recurrence_rules' and item.get('entity_type') == 'schedule' and isinstance(item.get('template_json'), dict) and item['template_json'].get('is_planned') is False:
                continue
            if not uuid_valid(item.get('uuid')) or item['uuid'].lower() in seen:
                raise ValueError(f'{name} UUID 无效或重复')
            seen.add(item['uuid'].lower())
            row = {'uuid': item['uuid'].lower()}
            for key, fallback in CONTRACT[name].items():
                value = copy.deepcopy(item.get(key, fallback))
                if key.endswith('_uuid') and value is not None:
                    if not uuid_valid(value):
                        raise ValueError(f'{name}.{key} UUID 无效')
                    value = value.lower()
                if key.endswith('_uuids'):
                    if not isinstance(value, list) or any(not uuid_valid(v) for v in value):
                        raise ValueError('关联 UUID 数组无效')
                    value = sorted(set(v.lower() for v in value))
                if key.endswith('_date') and value is not None and not (name == 'todos' and key == 'ddl_date'):
                    value = day(value)
                if value is not None and (key.endswith('_at') or key in ('start_time', 'end_time') or (name == 'todos' and key == 'ddl_date')):
                    value = timestamp(value)
                if key.startswith('is_') and type(value) is not bool:
                    raise ValueError(f'{key} 必须是布尔值')
                if isinstance(fallback, str) and not isinstance(value, str):
                    raise ValueError(f'{key} 必须是文本')
                row[key] = value
            row['created_at'] = timestamp(item.get('created_at')) or STAMP
            if name not in ('log_templates', 'recurrence_exceptions'):
                row['updated_at'] = timestamp(item.get('updated_at')) or row['created_at']
            if 'name' in row and (not row['name'].strip() or len(row['name']) > (100 if name == 'time_block_categories' else 200)):
                raise ValueError(f'{name} 名称无效')
            if name == 'time_block_categories' and not re.fullmatch(r'#[0-9a-fA-F]{6}', row['color']):
                raise ValueError('属性颜色无效')
            if name == 'schedules' and (not row['start_time'] or not row['end_time'] or row['end_time'] <= row['start_time']):
                raise ValueError('计划起止时间无效')
            if name == 'time_blocks':
                if not row['block_date'] or not row['category_uuid']:
                    raise ValueError('时间块缺少日期或属性')
                a, b, g, c = (row[k] for k in ('start_minute', 'end_minute', 'granularity', 'coverage_seconds'))
                if (any(type(v) is not int for v in (a, b, g)) or g not in (15, 30) or a < 0 or b > 1440 or b-a != g or a % g or row['source'] not in ('manual', 'timer') or (c is not None and (type(c) is not int or c < 0 or c > g*60))):
                    raise ValueError('时间块范围、粒度或覆盖时长无效')
                if row['linked_todo_uuid']:
                    row['manual_project_uuid'] = None
            if name == 'recurrence_rules':
                if not row['start_date'] or (row['end_date'] and row['end_date'] < row['start_date']):
                    raise ValueError('重复规则日期无效')
                if row['month_day'] is not None and (type(row['month_day']) is not int or not 1 <= row['month_day'] <= 31):
                    raise ValueError('每月日期无效')
                if row['weekdays'] is not None and (not isinstance(row['weekdays'], list) or any(type(v) is not int or not 0 <= v <= 6 for v in row['weekdays'])):
                    raise ValueError('重复星期无效')
                if not isinstance(row['template_json'], dict):
                    raise ValueError('重复模板无效')
                row['template_json'].pop('project_id', None)
            if name == 'recurrence_exceptions' and (not row['recurrence_rule_uuid'] or not row['recurrence_date']):
                raise ValueError('重复例外缺少规则或日期')
            if name == 'daily_logs' and not row['log_date']:
                raise ValueError('日志缺少日期')
            if name == 'timer_sessions':
                if not row['started_at'] or type(row['paused_seconds']) is not int or row['paused_seconds'] < 0 or not isinstance(row['active_intervals'], list):
                    raise ValueError('计时记录无效')
                intervals = []
                for span in row['active_intervals']:
                    if not isinstance(span, list) or len(span) != 2:
                        raise ValueError('计时区间无效')
                    a, b = timestamp(span[0]), timestamp(span[1])
                    if not a or not b or b < a:
                        raise ValueError('计时区间无效')
                    intervals.append([a, b])
                row['active_intervals'] = intervals
                if row['status'] == 'paused' and not row['paused_at']:
                    raise ValueError('暂停计时缺少暂停时间')
                if row['is_parked'] and row['status'] != 'paused':
                    raise ValueError('暂存计时必须暂停')
            result.append(row)
        entities[name] = result
    enums = {
        'projects': {'status': ['active', 'paused', 'completed', 'archived', 'canceled']},
        'todos': {'ddl_type': ['none', 'hard', 'soft'], 'status': ['not_focusing', 'focusing', 'waiting_reply']},
        'schedules': {'nature': ['no_other_task', 'relax', 'free_arrange']},
        'recurrence_rules': {'entity_type': ['todo', 'schedule'], 'frequency': ['daily', 'weekly', 'monthly'], 'status': ['active', 'paused', 'archived']},
        'recurrence_exceptions': {'entity_type': ['todo', 'schedule'], 'action': ['deleted']},
        'timer_sessions': {'status': ['running', 'paused', 'completed', 'canceled']},
    }
    for name, fields in enums.items():
        for row in entities[name]:
            for key, values in fields.items():
                if row[key] not in values:
                    raise ValueError(f'{name}.{key} 无效')
    for name in ('daily_logs', 'recurrence_exceptions'):
        keys = [exception_key(r) if name == 'recurrence_exceptions' else identity(name, r) for r in entities[name]]
        if len(set(keys)) != len(keys):
            raise ValueError(f'{name} 身份重复')
    blocks = sorted(entities['time_blocks'], key=lambda r: (r['block_date'], r['start_minute']))
    if any(a['block_date'] == b['block_date'] and a['end_minute'] > b['start_minute'] for a, b in zip(blocks, blocks[1:])):
        raise ValueError('数据包时间块重叠')
    for items in entities.values():
        items.sort(key=lambda r: r['uuid'])
    return {'app': 'riji', 'schema_version': '0.10.0', 'entities': entities}


def validate_references(pack):
    maps = {n: {r['uuid'] for r in pack['entities'][n]} for n in ORDER}
    targets = {'project_uuid': 'projects', 'manual_project_uuid': 'projects', 'recurrence_rule_uuid': 'recurrence_rules', 'linked_todo_uuid': 'todos', 'linked_todo_uuids': 'todos', 'template_linked_todo_uuids': 'todos', 'completed_todo_uuids': 'todos', 'category_uuid': 'time_block_categories', 'source_timer_uuid': 'timer_sessions', 'created_schedule_uuid': 'schedules'}
    for name in ORDER:
        for row in pack['entities'][name]:
            for key, target in targets.items():
                values = row.get(key, []) if key.endswith('_uuids') else [row[key]] if row.get(key) else []
                if any(v not in maps[target] for v in values):
                    raise ValueError(f'{name}.{key} 引用不存在的 UUID')


def build_merge_plan(local_raw, incoming_raw, mode='merge', choices=None):
    choices = choices or {}
    if mode not in ('merge', 'replace'):
        raise ValueError('导入模式无效')
    local, incoming = normalize_package(local_raw), normalize_package(incoming_raw)
    validate_references(incoming if mode == 'replace' else {'entities': {n: local['entities'][n] + incoming['entities'][n] for n in ORDER}})
    conflicts, effects = [], []

    def choose(key, entity, field, a, b, kind='value'):
        choice = choices.get(key, {})
        resolved = choice.get('side') in ('local', 'incoming') or (choice.get('side') == 'edit' and field in ('notes', 'log_text', 'completed_at', 'name') and isinstance(choice.get('value'), str))
        if kind == 'links':
            resolved = choice.get('side') == 'links' and isinstance(choice.get('value'), list) and all(uuid_valid(v) for v in choice['value'])
        shown_a = conflict_record(entity, a) if field == 'record' else copy.deepcopy(a)
        shown_b = conflict_record(entity, b) if field == 'record' else copy.deepcopy(b)
        conflicts.append({'id': key, 'entity': entity, 'field': field, 'kind': kind, 'local': shown_a, 'incoming': shown_b, 'resolved': resolved, 'choice': choice if resolved else None})
        return copy.deepcopy(choice.get('value') if choice.get('side') in ('edit', 'links') and resolved else b if choice.get('side') == 'incoming' and resolved else a)

    for row in incoming['entities']['recurrence_rules']:
        ids = row['template_json'].get('linked_todo_ids')
        if isinstance(ids, list) and ids:
            old = next((r for r in local['entities']['recurrence_rules'] if r['uuid'] == row['uuid']), None)
            row['template_linked_todo_uuids'] = choose(f'recurrence_rules:{row["uuid"]}:legacy-links', 'recurrence_rules', 'template_linked_todo_uuids', old['template_linked_todo_uuids'] if old else [], ids, 'links')
            conflicts[-1]['options'] = list({r['uuid']: {'uuid': r['uuid'], 'name': r['name']} for r in local['entities']['todos'] + incoming['entities']['todos']}.values())
        row['template_json'].pop('linked_todo_ids', None)

    output = copy.deepcopy(incoming if mode == 'replace' else local)
    if mode == 'merge':
        for name in (n for n in ORDER if n != 'time_blocks'):
            mapping = {identity(name, r): r for r in output['entities'][name]}
            for row in incoming['entities'][name]:
                key = identity(name, row)
                old = mapping.get(key)
                if old is None and name == 'recurrence_exceptions':
                    old = next((x for x in output['entities'][name] if exception_key(x) == exception_key(row)), None)
                if old is None:
                    added = copy.deepcopy(row)
                    output['entities'][name].append(added)
                    mapping[key] = added
                    continue
                if business(old, name) == business(row, name):
                    continue
                if name == 'todos':
                    for field in (k for k in CONTRACT['todos'] if k not in ('is_completed', 'completed_at')):
                        if old[field] != row[field]:
                            old[field] = choose(f'{name}:{old["uuid"]}:{field}', name, field, old[field], row[field])
                    times = sorted(t['completed_at'] for t in (old, row) if t['is_completed'] and t['completed_at'])
                    old['is_completed'] = old['is_completed'] or row['is_completed']
                    old['completed_at'] = (times[0] if times else None) if old['is_completed'] else None
                elif name == 'daily_logs':
                    if old['log_text'] != row['log_text']:
                        old['log_text'] = choose(f'{name}:{key}:log_text', name, 'log_text', old['log_text'], row['log_text'])
                    old['completed_todo_uuids'] = sorted(set(old['completed_todo_uuids'] + row['completed_todo_uuids']))
                else:
                    selected = preserve_local_fields(name, choose(f'{name}:{key}:record', name, 'record', old, row, 'record'), old)
                    selected['uuid'] = old['uuid']
                    old.update(selected)

        a, b = copy.deepcopy(local['entities']['time_blocks']), copy.deepcopy(incoming['entities']['time_blocks'])
        suppress_a, suppress_b = set(), set()
        for row in b:
            old = next((x for x in a if x['uuid'] == row['uuid']), None)
            if old and business(old) != business(row):
                selected = choose(f'time_blocks:{row["uuid"]}:record', 'time_blocks', 'record', old, row, 'identity')
                (suppress_b if selected == old else suppress_a).add(row['uuid'])
                effects.append({'kind': 'identity', 'uuid': row['uuid'], 'local': [old['block_date'], old['start_minute'], old['end_minute']], 'incoming': [row['block_date'], row['start_minute'], row['end_minute']]})
            if not old:
                fragments = [x for x in a if x.get('origin_uuid') == row['uuid']]
                if fragments and any(x['block_date'] != row['block_date'] or x['start_minute'] < row['start_minute'] or x['end_minute'] > row['end_minute'] for x in fragments):
                    selected = choose(f'time_blocks:{row["uuid"]}:fragments', 'time_blocks', 'record', fragments, [row], 'identity')
                    if len(selected) == 1 and selected[0]['uuid'] == row['uuid']:
                        suppress_a.update(x['uuid'] for x in fragments)
                    else:
                        suppress_b.add(row['uuid'])
                    effects.append({'kind': 'identity', 'uuid': row['uuid'], 'local': [[x['block_date'], x['start_minute'], x['end_minute']] for x in fragments], 'incoming': [row['block_date'], row['start_minute'], row['end_minute']]})
        for original in (x for x in a if x['uuid'] not in suppress_a):
            fragments = [x for x in b if x.get('origin_uuid') == original['uuid'] and x['uuid'] not in suppress_b]
            if fragments and any(x['block_date'] != original['block_date'] or x['start_minute'] < original['start_minute'] or x['end_minute'] > original['end_minute'] for x in fragments):
                chosen = choose(f'time_blocks:{original["uuid"]}:fragments', 'time_blocks', 'record', [original], fragments, 'identity')
                if chosen == [original]:
                    suppress_b.update(x['uuid'] for x in fragments)
                else:
                    suppress_a.add(original['uuid'])
                effects.append({'kind': 'identity', 'uuid': original['uuid'], 'local': [original['block_date'], original['start_minute'], original['end_minute']], 'incoming': [[x['block_date'], x['start_minute'], x['end_minute']] for x in fragments]})
        left = [x for x in a if x['uuid'] not in suppress_a]
        right = [x for x in b if x['uuid'] not in suppress_b]
        pieces = []
        for current_day in sorted({x['block_date'] for x in left + right}):
            l = [x for x in left if x['block_date'] == current_day]
            r = [x for x in right if x['block_date'] == current_day]
            boundaries = sorted({x[k] for x in l + r for k in ('start_minute', 'end_minute')})
            for start, end in zip(boundaries, boundaries[1:]):
                one = next((x for x in l if x['start_minute'] <= start and x['end_minute'] >= end), None)
                two = next((x for x in r if x['start_minute'] <= start and x['end_minute'] >= end), None)
                if not one and not two:
                    continue
                chosen = one or two
                if one and two and block_content(one) != block_content(two):
                    chosen = choose(f'time_blocks:{current_day}:{start}:{end}', 'time_blocks', 'interval', one, two, 'interval')
                if one and two:
                    effects.append({'kind': 'overlap', 'date': current_day, 'start': start, 'end': end, 'local_uuid': one['uuid'], 'incoming_uuid': two['uuid']})
                pieces.append({'row': chosen, 'start': start, 'end': end})
        joined = []
        for piece in pieces:
            prev = joined[-1] if joined else None
            if prev and prev['row']['uuid'] == piece['row']['uuid'] and prev['row']['block_date'] == piece['row']['block_date'] and prev['end'] == piece['start']:
                prev['end'] = piece['end']
            else:
                joined.append(dict(piece))
        output['entities']['time_blocks'] = []
        for piece in joined:
            row, start, end = piece['row'], piece['start'], piece['end']
            if start == row['start_minute'] and end == row['end_minute']:
                output['entities']['time_blocks'].append(row)
                continue
            effects.append({'kind': 'split', 'uuid': row['uuid'], 'date': row['block_date'], 'start': start, 'end': end})
            for minute in range(start, end, 15):
                origin = row.get('origin_uuid') or row['uuid']
                fragment = dict(row, uuid=stable_uuid([origin, row['block_date'], minute, minute+15]), origin_uuid=origin, start_minute=minute, end_minute=minute+15, granularity=15)
                if row['coverage_seconds'] is not None:
                    fragment['coverage_seconds'] = row['coverage_seconds']*(minute+15-row['start_minute'])//row['granularity'] - row['coverage_seconds']*(minute-row['start_minute'])//row['granularity']
                output['entities']['time_blocks'].append(fragment)

        for todo in output['entities']['todos']:
            completed_day = todo['completed_at'][:10] if todo['completed_at'] else None
            if todo['is_completed'] and not completed_day:
                dates = sorted(log['log_date'] for log in output['entities']['daily_logs'] if todo['uuid'] in log['completed_todo_uuids'])
                if len(dates) == 1:
                    completed_day = dates[0]
                else:
                    value = choose(f'todos:{todo["uuid"]}:completed_at', 'todos', 'completed_at', dates[0] if dates else '', dates[-1] if dates else '', 'date')
                    if value:
                        completed_day = day(value[:10])
                        todo['completed_at'] = completed_day + 'T00:00:00'
                    else:
                        conflicts[-1]['resolved'] = False
            for log in output['entities']['daily_logs']:
                log['completed_todo_uuids'] = [v for v in log['completed_todo_uuids'] if v != todo['uuid']]
            if todo['is_completed'] and completed_day:
                if not todo['completed_at']:
                    todo['completed_at'] = completed_day + 'T00:00:00'
                log = next((x for x in output['entities']['daily_logs'] if x['log_date'] == completed_day), None)
                if log is None:
                    log = dict(copy.deepcopy(CONTRACT['daily_logs']), uuid=stable_uuid(['daily_logs', completed_day]), log_date=completed_day, created_at=STAMP, updated_at=STAMP)
                    output['entities']['daily_logs'].append(log)
                log['completed_todo_uuids'].append(todo['uuid'])
                log['completed_todo_uuids'].sort()

    groups = {}
    for row in output['entities']['time_block_categories']:
        groups.setdefault(row['name'], []).append(row)
    for rows in groups.values():
        if len(rows) <= 1:
            continue
        for row in rows[1:]:
            key = f'time_block_categories:{row["uuid"]}:name'
            value = choose(key, 'time_block_categories', 'name', row['name'], row['name'], 'rename')
            if choices.get(key, {}).get('side') == 'edit' and value.strip() and len(value) <= 100:
                row['name'] = value.strip()
            else:
                conflicts[-1]['resolved'] = False
    names = [r['name'] for r in output['entities']['time_block_categories']]
    if len(set(names)) != len(names):
        for conflict in conflicts:
            if conflict['kind'] == 'rename':
                conflict['resolved'] = False
    active = [r for r in output['entities']['timer_sessions'] if r['status'] in ('running', 'paused') and not r['is_parked']]
    if len(active) > 1:
        key = 'timer_sessions:active:record'
        choice = choices.get(key, {})
        pause_at = timestamp(choice.get('paused_at'))
        selected = next((r for r in active if r['uuid'] == choice.get('value')), None) if pause_at else None
        conflicts.append({'id': key, 'entity': 'timer_sessions', 'field': 'record', 'kind': 'active_timer', 'local': [r for r in active if any(x['uuid'] == r['uuid'] for x in local['entities']['timer_sessions'])], 'incoming': [r for r in active if any(x['uuid'] == r['uuid'] for x in incoming['entities']['timer_sessions'])], 'options': active, 'resolved': selected is not None, 'choice': choice if selected else None})
        if selected:
            for row in active:
                if row is selected:
                    continue
                row['is_parked'] = True
                if row['status'] == 'running':
                    if pause_at < (row['last_resumed_at'] or row['started_at']):
                        raise ValueError('暂停时间早于计时开始')
                    if row['last_resumed_at']:
                        row['active_intervals'].append([row['last_resumed_at'], pause_at])
                    row['paused_at'] = pause_at
                    row['status'] = 'paused'
    validate_references(output)
    normalize_package(output)
    summary = {}
    for name in ORDER:
        before = {identity(name, r): r for r in local['entities'][name]}
        after = {identity(name, r): r for r in output['entities'][name]}
        skipped = 0
        for row in incoming['entities'][name]:
            old = before.get(identity(name, row))
            if old is None and name == 'recurrence_exceptions':
                old = next((x for x in before.values() if exception_key(x) == exception_key(row)), None)
            skipped += old is not None and business(old, name, mode) == business(row, name, mode)
        summary[name] = {'total': len(incoming['entities'][name]), 'create': sum(k not in before for k in after), 'update': sum(k in before and business(r, name, mode) != business(before[k], name, mode) for k, r in after.items()), 'skip': skipped, 'delete': sum(k not in after for k in before), 'conflict': sum(c['entity'] == name for c in conflicts)}
    return {'app': 'riji', 'schema_version': incoming_raw['schema_version'], 'mode': mode, 'token': digest({'local': local, 'incoming': incoming, 'mode': mode, 'choices': choices, 'raw': incoming_raw, 'field_policy': POLICY}), 'conflicts': conflicts, 'effects': effects, 'entities': summary, 'total': sum(r['total'] for r in summary.values()), 'delete_total': sum(r['delete'] for r in summary.values()), 'unresolved': sum(not c['resolved'] for c in conflicts), 'package': output}
