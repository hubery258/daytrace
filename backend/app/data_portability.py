"""Logical JSON export/import shared by desktop and mobile clients."""

from __future__ import annotations

import enum
import re
import uuid as uuid_lib
import json
import os
from pathlib import Path
import tempfile
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import Date as SADate, DateTime as SADateTime, Enum as SAEnum, delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from . import models
from .recurrence_claims import rebuild_recurrence_claims
from .merge_plan import build_merge_plan, canonical, normalize_package


APP_ID = "riji"
SCHEMA_VERSION = "0.10.0"
SUPPORTED_SCHEMA_VERSIONS = {"0.6.0", "0.8.0", SCHEMA_VERSION}
ENTITY_ORDER = (
    "projects",
    "recurrence_rules",
    "recurrence_exceptions",
    "todos",
    "time_block_categories",
    "schedules",
    "daily_logs",
    "log_templates",
    "timer_sessions",
    "time_blocks",
)

SPECS: dict[str, tuple[type, tuple[str, ...]]] = {
    "projects": (models.Project, (
        "name", "description", "status", "ddl_date", "color", "completed_at",
        "archived_at", "created_at", "updated_at",
    )),
    "recurrence_rules": (models.RecurrenceRule, (
        "entity_type", "template_json", "frequency", "start_date", "end_date",
        "weekdays", "month_day", "status", "created_at", "updated_at",
    )),
    "recurrence_exceptions": (models.RecurrenceException, (
        "entity_type", "recurrence_date", "action", "created_at",
    )),
    "todos": (models.Todo, (
        "name", "position", "ddl_type", "ddl_date", "reminder_days", "category", "status",
        "waiting_reply_person", "notes", "is_completed", "completed_at",
        "recurrence_date", "is_recurrence_exception", "created_at", "updated_at",
    )),
    "schedules": (models.Schedule, (
        "name", "start_time", "end_time", "category", "nature", "relax_suggestion",
        "location", "notes", "is_planned", "recurrence_date",
        "is_recurrence_exception", "created_at", "updated_at",
    )),
    "time_block_categories": (models.TimeBlockCategory, (
        "name", "color", "created_at", "updated_at",
    )),
    "time_blocks": (models.TimeBlock, (
        "block_date", "start_minute", "end_minute", "granularity", "category_id",
        "notes", "source", "coverage_seconds", "created_at", "updated_at",
        "origin_uuid",
    )),
    "daily_logs": (models.DailyLog, (
        "log_date", "log_text", "created_at", "updated_at",
    )),
    "log_templates": (models.LogTemplate, (
        "name", "content", "created_at",
    )),
    "timer_sessions": (models.TimerSession, (
        "name", "status", "started_at", "last_resumed_at", "paused_at",
        "paused_seconds", "active_intervals", "ended_at", "notes", "created_at", "updated_at",
        "is_parked",
    )),
}

REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "projects": ("name",),
    "recurrence_rules": ("entity_type", "frequency", "start_date"),
    "recurrence_exceptions": ("entity_type", "recurrence_date"),
    "todos": ("name", "ddl_type", "category", "status"),
    "schedules": ("name", "start_time", "end_time", "category", "nature"),
    "time_block_categories": ("name", "color"),
    "time_blocks": ("block_date", "start_minute", "end_minute", "granularity", "category_uuid"),
    "daily_logs": ("log_date",),
    "log_templates": ("name",),
    "timer_sessions": ("name", "status", "started_at"),
}


class DataPackageError(ValueError):
    pass


def _json_value(value: Any) -> Any:
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _record(instance: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    result = {"uuid": instance.uuid}
    result.update({field: _json_value(getattr(instance, field)) for field in fields})
    return result


async def _all(db: AsyncSession, model: type) -> list[Any]:
    result = await db.execute(select(model).order_by(model.id.asc()))
    return list(result.scalars().all())


async def export_package(db: AsyncSession) -> dict[str, Any]:
    rows = {name: await _all(db, spec[0]) for name, spec in SPECS.items()}
    references = {
        'recurrence_rules': {'project_id': 'projects'},
        'recurrence_exceptions': {'recurrence_rule_id': 'recurrence_rules'},
        'todos': {'project_id': 'projects', 'recurrence_rule_id': 'recurrence_rules'},
        'schedules': {'project_id': 'projects', 'recurrence_rule_id': 'recurrence_rules', 'linked_todo_ids': 'todos'},
        'time_blocks': {'category_id': 'time_block_categories', 'linked_todo_id': 'todos', 'manual_project_id': 'projects', 'source_timer_id': 'timer_sessions'},
        'daily_logs': {'completed_todo_ids': 'todos'},
        'timer_sessions': {'project_id': 'projects', 'linked_todo_id': 'todos', 'created_schedule_id': 'schedules'},
    }
    local_ids = {name: {row.id for row in items} for name, items in rows.items()}
    for name, fields in references.items():
        for row in rows[name]:
            for field, target in fields.items():
                value = getattr(row, field)
                values = (value or []) if field.endswith('_ids') else ([] if value is None else [value])
                if any(value not in local_ids[target] for value in values):
                    context = f'（计划：{row.name}）' if name == 'schedules' else ''
                    raise DataPackageError(f'本机 {name}.{field} 含断裂关联{context}，请先修复')
    rows["schedules"] = [item for item in rows["schedules"] if item.is_planned]
    rows["recurrence_rules"] = [item for item in rows["recurrence_rules"] if
        item.entity_type != models.RecurrenceEntityType.schedule or
        (item.template_json or {}).get("is_planned", True) is not False]
    id_maps = {name: {item.id: item.uuid for item in items} for name, items in rows.items()}
    entities: dict[str, list[dict[str, Any]]] = {}
    for name in ENTITY_ORDER:
        _, fields = SPECS[name]
        entities[name] = [_record(item, fields) for item in rows[name]]

    project_uuids = id_maps["projects"]
    rule_uuids = id_maps["recurrence_rules"]
    todo_uuids = id_maps["todos"]
    schedule_uuids = id_maps["schedules"]
    category_uuids = id_maps["time_block_categories"]
    timer_uuids = id_maps["timer_sessions"]

    for source, exported in zip(rows["recurrence_rules"], entities["recurrence_rules"]):
        exported["project_uuid"] = project_uuids.get(source.project_id)
        exported["template_json"] = dict(exported.get("template_json") or {})
        exported["template_json"].pop("project_id", None)
        template_ids = exported['template_json'].pop('linked_todo_ids', [])
        exported['template_linked_todo_uuids'] = [todo_uuids[value] for value in template_ids if value in todo_uuids]
        if len(exported['template_linked_todo_uuids']) != len(template_ids):
            raise DataPackageError('重复计划模板含断裂任务关联，请先修复')
    normalized_exceptions: list[dict[str, Any]] = []
    seen_exception_keys: set[tuple[str, str, str]] = set()
    for source, exported in zip(rows["recurrence_exceptions"], entities["recurrence_exceptions"]):
        rule_uuid = rule_uuids.get(source.recurrence_rule_id)
        if not rule_uuid:
            raise DataPackageError(f"无法导出孤立的重复例外：id={source.id}, rule_id={source.recurrence_rule_id}")
        exported["recurrence_rule_uuid"] = rule_uuid
        natural_key = (rule_uuid, str(exported.get("entity_type") or ""), str(exported.get("recurrence_date") or "")[:10])
        if natural_key in seen_exception_keys:
            continue
        seen_exception_keys.add(natural_key)
        normalized_exceptions.append(exported)
    entities["recurrence_exceptions"] = normalized_exceptions
    for source, exported in zip(rows["todos"], entities["todos"]):
        exported["project_uuid"] = project_uuids.get(source.project_id)
        exported["recurrence_rule_uuid"] = rule_uuids.get(source.recurrence_rule_id)
    for source, exported in zip(rows["schedules"], entities["schedules"]):
        exported["project_uuid"] = project_uuids.get(source.project_id)
        exported["recurrence_rule_uuid"] = rule_uuids.get(source.recurrence_rule_id)
        exported["linked_todo_uuids"] = [todo_uuids[todo_id] for todo_id in (source.linked_todo_ids or []) if todo_id in todo_uuids]
    for source, exported in zip(rows["time_blocks"], entities["time_blocks"]):
        exported.pop("category_id", None)
        exported["category_uuid"] = category_uuids.get(source.category_id)
        exported["linked_todo_uuid"] = todo_uuids.get(source.linked_todo_id)
        exported["manual_project_uuid"] = project_uuids.get(source.manual_project_id) if source.linked_todo_id is None else None
        exported["source_timer_uuid"] = timer_uuids.get(source.source_timer_id)
    for source, exported in zip(rows["daily_logs"], entities["daily_logs"]):
        exported["completed_todo_uuids"] = [todo_uuids[todo_id] for todo_id in (source.completed_todo_ids or []) if todo_id in todo_uuids]
    for source, exported in zip(rows["timer_sessions"], entities["timer_sessions"]):
        exported["project_uuid"] = project_uuids.get(source.project_id)
        exported["linked_todo_uuid"] = todo_uuids.get(source.linked_todo_id)
        exported["created_schedule_uuid"] = schedule_uuids.get(source.created_schedule_id)

    export_schema_version = SCHEMA_VERSION if (rows["time_blocks"] or rows["time_block_categories"]) else "0.8.0"
    return {
        "app": APP_ID,
        "schema_version": export_schema_version,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "entities": entities,
    }


def validate_package(package: Any) -> dict[str, Any]:
    if not isinstance(package, dict):
        raise DataPackageError("数据包必须是 JSON 对象")
    if package.get("app") != APP_ID:
        raise DataPackageError("不是日迹数据包")
    if package.get("schema_version") not in SUPPORTED_SCHEMA_VERSIONS:
        supported = "、".join(sorted(SUPPORTED_SCHEMA_VERSIONS))
        raise DataPackageError(f"不支持的 schema_version：{package.get('schema_version')!r}，当前支持 {supported}")
    entities = package.get("entities")
    if not isinstance(entities, dict):
        raise DataPackageError("数据包缺少 entities")
    normalized = dict(package)
    normalized_entities: dict[str, list[dict[str, Any]]] = {}
    for name in ENTITY_ORDER:
        items = entities.get(name, [])
        if not isinstance(items, list):
            raise DataPackageError(f"entities.{name} 必须是数组")
        seen: set[str] = set()
        normalized_items: list[dict[str, Any]] = []
        seen_recurrence_keys: set[tuple[str, str, str]] = set()
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise DataPackageError(f"entities.{name}[{index}] 必须是对象")
            item_uuid = item.get("uuid")
            try:
                item_uuid = str(uuid_lib.UUID(str(item_uuid)))
            except (ValueError, TypeError, AttributeError):
                raise DataPackageError(f"entities.{name}[{index}] 的 uuid 无效") from None
            if item_uuid in seen:
                raise DataPackageError(f"entities.{name} 存在重复 uuid：{item_uuid}")
            missing = [field for field in REQUIRED_FIELDS[name] if field not in item]
            if missing:
                raise DataPackageError(f"entities.{name}[{index}] 缺少字段：{', '.join(missing)}")
            if name == "recurrence_exceptions":
                recurrence_key = (str(item.get("recurrence_rule_uuid") or ""), str(item.get("entity_type") or ""), str(item.get("recurrence_date") or "")[:10])
                if not all(recurrence_key):
                    raise DataPackageError(f"entities.{name}[{index}] 缺少有效的 recurrence_rule_uuid、entity_type 或 recurrence_date")
                if recurrence_key in seen_recurrence_keys:
                    raise DataPackageError(f"entities.{name} 存在重复的规则日期例外：{recurrence_key}")
                seen_recurrence_keys.add(recurrence_key)
            seen.add(item_uuid)
            normalized_items.append({**item, "uuid": item_uuid})
        normalized_entities[name] = [item for item in normalized_items if item.get("is_planned", True)] if name == "schedules" else normalized_items
    normalized_entities["recurrence_rules"] = [item for item in normalized_entities["recurrence_rules"] if
        item.get("entity_type") != "schedule" or
        (item.get("template_json") or {}).get("is_planned", True) is not False]
    for category in normalized_entities["time_block_categories"]:
        if (not isinstance(category["name"], str) or not category["name"].strip() or
                len(category["name"]) > 100 or not isinstance(category["color"], str) or
                not re.fullmatch(r"#[0-9a-fA-F]{6}", category["color"])):
            raise DataPackageError("时间块属性名称或颜色无效")
    names = [item["name"] for item in normalized_entities["time_block_categories"]]
    if len(names) != len(set(names)):
        raise DataPackageError("数据包中的时间块属性名称重复")
    by_day: dict[str, list[tuple[int, int]]] = {}
    for block in normalized_entities["time_blocks"]:
        try:
            parsed_day = _parse_date(block.get("block_date"))
            if parsed_day is None:
                raise ValueError()
            day = str(parsed_day)
            start, end, size = block["start_minute"], block["end_minute"], block["granularity"]
            if not all(type(value) is int for value in (start, end, size)):
                raise ValueError()
            if (size not in (15, 30) or start < 0 or end > 1440 or end - start != size or start % size or
                    block.get("source", "manual") not in ("manual", "timer")):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            raise DataPackageError("时间块日期、范围或粒度无效") from None
        by_day.setdefault(day, []).append((start, end))
    for ranges in by_day.values():
        ordered = sorted(ranges)
        if any(left[1] > right[0] for left, right in zip(ordered, ordered[1:])):
            raise DataPackageError("数据包中的时间块互相重叠")
    normalized["entities"] = normalized_entities
    return normalized


def _validate_mode(mode: str) -> str:
    if mode not in {"merge", "replace"}:
        raise DataPackageError("mode 必须是 merge 或 replace")
    return mode


def _parse_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def _parse_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _coerce(model: type, field: str, value: Any) -> Any:
    column = model.__table__.columns[field]
    if value is None:
        return None
    if isinstance(column.type, SADateTime):
        return _parse_datetime(value)
    if isinstance(column.type, SADate):
        return _parse_date(value)
    if isinstance(column.type, SAEnum) and column.type.enum_class:
        return column.type.enum_class(value)
    return value


def _apply_fields(instance: Any, model: type, fields: tuple[str, ...], item: dict[str, Any]) -> None:
    for field in fields:
        if model is models.RecurrenceRule and field == "template_json":
            continue
        if field in item:
            setattr(instance, field, _coerce(model, field, item[field]))


async def _upsert_group(db: AsyncSession, name: str, items: list[dict[str, Any]], maps: dict[str, dict[str, Any]] | None = None) -> tuple[dict[str, Any], int, int]:
    model, fields = SPECS[name]
    result = await db.execute(select(model).order_by(model.id.asc()))
    existing = list(result.scalars().all())
    by_uuid = {item.uuid: item for item in existing}
    by_date = {item.log_date: item for item in existing} if name == "daily_logs" else {}
    by_name = {item.name: item for item in existing} if name == "time_block_categories" else {}
    by_recurrence_key: dict[tuple[int, str, date], Any] = {}
    if name == "recurrence_exceptions":
        for existing_item in existing:
            key = (existing_item.recurrence_rule_id, _json_value(existing_item.entity_type), existing_item.recurrence_date)
            by_recurrence_key.setdefault(key, existing_item)
    created = updated = 0
    mapped: dict[str, Any] = {}
    for item in items:
        recurrence_rule_id = None
        recurrence_key = None
        if name == "recurrence_exceptions":
            if maps is None or "recurrence_rules" not in maps:
                raise DataPackageError("导入重复例外前必须先导入重复规则")
            recurrence_rule_id = _resolve(maps["recurrence_rules"], item.get("recurrence_rule_uuid"), "重复规则")
            recurrence_key = (recurrence_rule_id, item.get("entity_type"), _parse_date(item.get("recurrence_date")))
        instance = by_uuid.get(item["uuid"])
        if instance is None and name == "daily_logs":
            instance = by_date.get(_parse_date(item.get("log_date")))
        if instance is None and name == "recurrence_exceptions":
            instance = by_recurrence_key.get(recurrence_key)
        if instance is None:
            instance = model(uuid=item["uuid"])
            db.add(instance)
            created += 1
        else:
            updated += 1
            if name in ("time_block_categories", "daily_logs", "recurrence_exceptions") and instance.uuid != item["uuid"]:
                instance.uuid = item["uuid"]
        _apply_fields(instance, model, fields, item)
        if 'updated_at' in item and db.is_modified(instance):
            flag_modified(instance, 'updated_at')
        if name == "recurrence_exceptions":
            instance.recurrence_rule_id = recurrence_rule_id
        if name == "time_blocks":
            instance.category_id = item["category_id"]
        mapped[item["uuid"]] = instance
    await db.flush()
    return mapped, created, updated


def _resolve(mapping: dict[str, Any], item_uuid: Any, label: str) -> int | None:
    if not item_uuid:
        return None
    instance = mapping.get(str(item_uuid))
    if instance is None:
        raise DataPackageError(f"数据包引用了不存在的 {label} UUID：{item_uuid}")
    return instance.id


async def _write_package(db: AsyncSession, raw_package: Any, mode: str = "merge") -> dict[str, Any]:
    mode = _validate_mode(mode)
    package = validate_package(raw_package)
    entities = package["entities"]
    maps: dict[str, dict[str, Any]] = {}
    results: dict[str, dict[str, int]] = {}
    try:
        for name in ENTITY_ORDER:
            if name == "time_blocks":
                for item in entities[name]:
                    item["category_id"] = _resolve(maps["time_block_categories"], item["category_uuid"], "属性")
            mapped, created, updated = await _upsert_group(db, name, entities[name], maps)
            maps[name] = mapped
            results[name] = {"created": created, "updated": updated}

        projects = maps["projects"]
        rules = maps["recurrence_rules"]
        todos = maps["todos"]
        schedules = maps["schedules"]
        for item in entities["recurrence_exceptions"]:
            instance = maps["recurrence_exceptions"][item["uuid"]]
            instance.recurrence_rule_id = _resolve(rules, item.get("recurrence_rule_uuid"), "重复规则")
        blocks = maps["time_blocks"]
        for item in entities["recurrence_rules"]:
            instance = rules[item["uuid"]]
            instance.project_id = _resolve(projects, item.get("project_uuid"), "项目")
            template = dict(item.get("template_json") or {})
            template.pop("project_id", None)
            template.pop('linked_todo_ids', None)
            if item.get('entity_type') == 'schedule':
                template['linked_todo_ids'] = [_resolve(todos, value, '待办') for value in item.get('template_linked_todo_uuids', [])]
            instance.template_json = template
        for item in entities["todos"]:
            instance = todos[item["uuid"]]
            instance.project_id = _resolve(projects, item.get("project_uuid"), "项目")
            instance.recurrence_rule_id = _resolve(rules, item.get("recurrence_rule_uuid"), "重复规则")
        for item in entities["schedules"]:
            instance = schedules[item["uuid"]]
            instance.project_id = _resolve(projects, item.get("project_uuid"), "项目")
            instance.recurrence_rule_id = _resolve(rules, item.get("recurrence_rule_uuid"), "重复规则")
            instance.linked_todo_ids = [_resolve(todos, todo_uuid, "待办") for todo_uuid in item.get("linked_todo_uuids", [])]
        for item in entities["time_blocks"]:
            instance = blocks[item["uuid"]]
            instance.linked_todo_id = _resolve(todos, item.get("linked_todo_uuid"), "待办")
            instance.manual_project_id = None if instance.linked_todo_id else _resolve(projects, item.get("manual_project_uuid"), "项目")
            instance.source_timer_id = _resolve(maps["timer_sessions"], item.get("source_timer_uuid"), "计时")
        for item in entities["daily_logs"]:
            instance = maps["daily_logs"][item["uuid"]]
            instance.completed_todo_ids = [_resolve(todos, todo_uuid, "待办") for todo_uuid in item.get("completed_todo_uuids", [])]
        for item in entities["timer_sessions"]:
            instance = maps["timer_sessions"][item["uuid"]]
            instance.project_id = _resolve(projects, item.get("project_uuid"), "项目")
            instance.linked_todo_id = _resolve(todos, item.get("linked_todo_uuid"), "待办")
            instance.created_schedule_id = _resolve(schedules, item.get("created_schedule_uuid"), "日程") if item.get("created_schedule_uuid") in schedules else None

        # Preserve the reviewed record's metadata; ORM onupdate must not manufacture a new revision
        # while resolving portable UUID associations in a second flush.
        for name in ENTITY_ORDER:
            for item in entities[name]:
                instance = maps[name][item['uuid']]
                if 'updated_at' in item and (db.is_modified(instance) or instance.updated_at != _parse_datetime(item['updated_at'])):
                    instance.updated_at = _parse_datetime(item['updated_at'])
                    flag_modified(instance, 'updated_at')

        deleted: dict[str, int] = {name: 0 for name in ENTITY_ORDER}
        if mode == "replace":
            for name in reversed(ENTITY_ORDER):
                model, _ = SPECS[name]
                keep_ids = {instance.id for instance in maps[name].values()}
                existing_result = await db.execute(select(model.id))
                remove_ids = [item_id for item_id in existing_result.scalars().all() if item_id not in keep_ids]
                if not remove_ids:
                    continue
                if name in ("todos", "schedules"):
                    entity_type = "todo" if name == "todos" else "schedule"
                    await db.execute(delete(models.ExternalItem).where(
                        models.ExternalItem.entity_type == entity_type,
                        models.ExternalItem.local_entity_id.in_(remove_ids),
                    ))
                if name == "recurrence_rules":
                    await db.execute(delete(models.RecurrenceException).where(
                        models.RecurrenceException.recurrence_rule_id.in_(remove_ids),
                    ))
                await db.execute(delete(model).where(model.id.in_(remove_ids)))
                deleted[name] = len(remove_ids)
        await rebuild_recurrence_claims(db)
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {
        "schema_version": "0.8.0" if package.get("schema_version") in {"0.6.0", "0.8.0"} and not entities.get("time_blocks") else SCHEMA_VERSION,
        "mode": mode,
        "conflict_policy": "replace_local_data" if mode == "replace" else "incoming_package_wins_by_uuid",
        "entities": results,
        "created": sum(item["created"] for item in results.values()),
        "updated": sum(item["updated"] for item in results.values()),
        "deleted": sum(deleted.values()),
    }


def save_operation_backup(db: AsyncSession, package: dict, prefix: str = 'before-import') -> str:
    """Persist, fsync and read back a logical snapshot before any mutation."""
    database = db.get_bind().url.database
    if not database or database == ':memory:':
        root = Path(tempfile.gettempdir()) / 'riji-test-backups'
    else:
        root = Path(database).resolve().parent / 'operation-backups'
    target = root / f'{prefix}-{uuid_lib.uuid4()}.json'
    serialized = canonical(package).encode('utf-8')
    try:
        root.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        if target.read_bytes() != serialized or json.loads(target.read_text(encoding='utf-8')) != package:
            raise OSError('操作前副本校验失败')
    except Exception as exc:
        raise DataPackageError('操作前副本未能保存并校验，未执行操作') from exc
    return str(target)


async def preview_package(db: AsyncSession, package: Any, mode: str = 'merge', choices: dict | None = None) -> dict:
    try:
        validate_package(package)
        plan = build_merge_plan(await export_package(db), package, mode, choices)
        return {k: v for k, v in plan.items() if k != 'package'}
    except (ValueError, TypeError, KeyError) as exc:
        raise DataPackageError(str(exc)) from exc


async def import_package(db: AsyncSession, raw_package: Any, mode: str = 'merge', choices: dict | None = None, preview_token: str | None = None) -> dict:
    if not preview_token:
        raise DataPackageError('请先预览并确认当前数据包')
    try:
        # End any read-only preview transaction, then reserve SQLite's writer before re-reading state.
        await db.rollback()
        await db.execute(text('BEGIN IMMEDIATE'))
        validate_package(raw_package)
        local = await export_package(db)
        plan = build_merge_plan(local, raw_package, mode, choices)
        if plan['token'] != preview_token:
            raise DataPackageError('本机数据、数据包或选择已变化，请重新预览')
        if plan['unresolved']:
            raise DataPackageError('还有未解决的冲突，不能执行导入')
        validate_package(plan['package'])
        backup = save_operation_backup(db, local)
        # Temporary names permit identity-preserving category rename swaps under SQLite UNIQUE(name).
        final_names = {r['uuid']: r['name'] for r in plan['package']['entities']['time_block_categories']}
        for row in await _all(db, models.TimeBlockCategory):
            if row.uuid not in final_names or row.name != final_names[row.uuid]:
                row.name = f'__import_{row.uuid}'
        await db.flush()
        if mode == 'merge':
            final_exceptions = {r['uuid']: r for r in plan['package']['entities']['recurrence_exceptions']}
            old_exceptions = {r['uuid']: r for r in local['entities']['recurrence_exceptions']}
            for row in await _all(db, models.RecurrenceException):
                before, after = old_exceptions[row.uuid], final_exceptions.get(row.uuid)
                if after and any(before[k] != after[k] for k in ('recurrence_rule_uuid', 'entity_type', 'recurrence_date')):
                    await db.delete(row)
            await db.flush()
        if mode == 'merge':
            keep = {r['uuid'] for r in plan['package']['entities']['time_blocks']}
            for row in await _all(db, models.TimeBlock):
                if row.uuid not in keep:
                    await db.delete(row)
            await db.flush()
        await _write_package(db, plan['package'], mode)
        summary = plan['entities']
        return {'mode': mode, 'schema_version': plan['schema_version'], 'entities': summary,
                'created': sum(r['create'] for r in summary.values()), 'updated': sum(r['update'] for r in summary.values()),
                'deleted': plan['delete_total'], 'skipped': sum(r['skip'] for r in summary.values()), 'backup_path': backup}
    except Exception:
        await db.rollback()
        raise
