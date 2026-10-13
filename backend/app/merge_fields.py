"""Shared policy: omit legacy fields from conflicts, preserve local values on merge.

Portable records keep these fields for new records, export and backup restore.
"""
import copy
import json
from pathlib import Path

POLICY = json.loads(Path(__file__).with_name('merge_field_policy.json').read_text(encoding='utf-8'))


def _matches(rule, entity, row):
    return rule['entity'] == entity and all(row.get(key) == value for key, value in rule.get('when', {}).items())


def conflict_record(entity, row):
    result = copy.deepcopy(row)
    for rule in POLICY:
        if _matches(rule, entity, row):
            target = result.get(rule['container'], {}) if 'container' in rule else result
            for field in rule['fields']:
                target.pop(field, None)
    return result


def preserve_local_fields(entity, selected, local):
    result = copy.deepcopy(selected)
    for rule in POLICY:
        # A rule changing from/to a todo template must retain its business fields.
        if _matches(rule, entity, local) and _matches(rule, entity, selected):
            source = local.get(rule['container'], {}) if 'container' in rule else local
            target = result.setdefault(rule['container'], {}) if 'container' in rule else result
            for field in rule['fields']:
                if field in source:
                    target[field] = copy.deepcopy(source[field])
                else:
                    target.pop(field, None)
    return result
