"""Logical JSON export/import shared by desktop and mobile clients."""

from __future__ import annotations

import enum
import uuid as uuid_lib
from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import Date as SADate, DateTime as SADateTime, Enum as SAEnum, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import models
from .recurrence_claims import rebuild_recurrence_claims


APP_ID = "riji"
SCHEMA_VERSION = "0.8.0"
SUPPORTED_SCHEMA_VERSIONS = {"0.6.0", SCHEMA_VERSION}
ENTITY_ORDER = (
    "projects",
    "recurrence_rules",
    "recurrence_exceptions",
    "todos",
    "schedules",
    "daily_logs",
    "log_templates",
    "timer_sessions",
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
    "daily_logs": (models.DailyLog, (
        "log_date", "log_text", "created_at", "updated_at",
    )),
    "log_templates": (models.LogTemplate, (
        "name", "content", "created_at",
    )),
    "timer_sessions": (models.TimerSession, (
        "name", "status", "started_at", "last_resumed_at", "paused_at",
        "paused_seconds", "ended_at", "notes", "created_at", "updated_at",
    )),
}

REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "projects": ("name",),
    "recurrence_rules": ("entity_type", "frequency", "start_date"),
    "recurrence_exceptions": ("entity_type", "recurrence_date"),
    "todos": ("name", "ddl_type", "category", "status"),
    "schedules": ("name", "start_time", "end_time", "category", "nature"),
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
    id_maps = {name: {item.id: item.uuid for item in items} for name, items in rows.items()}
    entities: dict[str, list[dict[str, Any]]] = {}
    for name in ENTITY_ORDER:
        _, fields = SPECS[name]
        entities[name] = [_record(item, fields) for item in rows[name]]

    project_uuids = id_maps["projects"]
    rule_uuids = id_maps["recurrence_rules"]
    todo_uuids = id_maps["todos"]
    schedule_uuids = id_maps["schedules"]

    for source, exported in zip(rows["recurrence_rules"], entities["recurrence_rules"]):
        exported["project_uuid"] = project_uuids.get(source.project_id)
        exported["template_json"] = dict(exported.get("template_json") or {})
        exported["template_json"].pop("project_id", None)
    normalized_exceptions: list[dict[str, Any]] = []
    seen_exception_keys: set[tuple[str, str, str]] = set()
    for source, exported in zip(rows["recurrence_exceptions"], entities["recurrence_exceptions"]):
        rule_uuid = rule_uuids.get(source.recurrence_rule_id)
        if not rule_uuid:
            raise DataPackageError(
                f"无法导出孤立的重复例外：id={source.id}, rule_id={source.recurrence_rule_id}"
            )
        exported["recurrence_rule_uuid"] = rule_uuid
        natural_key = (
            rule_uuid,
            str(exported.get("entity_type") or ""),
            str(exported.get("recurrence_date") or "")[:10],
        )
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
    for source, exported in zip(rows["daily_logs"], entities["daily_logs"]):
        exported["completed_todo_uuids"] = [todo_uuids[todo_id] for todo_id in (source.completed_todo_ids or []) if todo_id in todo_uuids]
    for source, exported in zip(rows["timer_sessions"], entities["timer_sessions"]):
        exported["project_uuid"] = project_uuids.get(source.project_id)
        exported["linked_todo_uuid"] = todo_uuids.get(source.linked_todo_id)
        exported["created_schedule_uuid"] = schedule_uuids.get(source.created_schedule_id)

    return {
        "app": APP_ID,
        "schema_version": SCHEMA_VERSION,
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
        seen_recurrence_keys: set[tuple[str, str, str]] = set()
        normalized_items: list[dict[str, Any]] = []
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
                recurrence_key = (
                    str(item.get("recurrence_rule_uuid") or ""),
                    str(item.get("entity_type") or ""),
                    str(item.get("recurrence_date") or "")[:10],
                )
                if not all(recurrence_key):
                    raise DataPackageError(
                        f"entities.{name}[{index}] 缺少有效的 recurrence_rule_uuid、entity_type 或 recurrence_date"
                    )
                if recurrence_key in seen_recurrence_keys:
                    raise DataPackageError(f"entities.{name} 存在重复的规则日期例外：{recurrence_key}")
                seen_recurrence_keys.add(recurrence_key)
            seen.add(item_uuid)
            normalized_items.append({**item, "uuid": item_uuid})
        normalized_entities[name] = normalized_items
    normalized["entities"] = normalized_entities
    return normalized


def _validate_mode(mode: str) -> str:
    if mode not in {"merge", "replace"}:
        raise DataPackageError("mode 必须是 merge 或 replace")
    return mode


async def preview_package(db: AsyncSession, package: Any, mode: str = "merge") -> dict[str, Any]:
    mode = _validate_mode(mode)
    package = validate_package(package)
    summary: dict[str, dict[str, int]] = {}
    rule_result = await db.execute(select(models.RecurrenceRule.id, models.RecurrenceRule.uuid))
    rule_uuid_by_id = {row[0]: row[1] for row in rule_result.fetchall()}
    for name in ENTITY_ORDER:
        model, _ = SPECS[name]
        existing_result = await db.execute(select(model))
        existing = list(existing_result.scalars().all())
        update_count = 0
        matched_existing_ids: set[int] = set()
        for item in package["entities"][name]:
            matched = next((existing_item for existing_item in existing if existing_item.uuid == item["uuid"]), None)
            is_update = matched is not None
            if name == "daily_logs" and not is_update:
                matched = next((existing_item for existing_item in existing if existing_item.log_date == _parse_date(item.get("log_date"))), None)
                is_update = matched is not None
            if name == "recurrence_exceptions" and not is_update:
                matched = next((
                    existing_item for existing_item in existing
                    if rule_uuid_by_id.get(existing_item.recurrence_rule_id) == item.get("recurrence_rule_uuid")
                    and _json_value(existing_item.entity_type) == item.get("entity_type")
                    and existing_item.recurrence_date == _parse_date(item.get("recurrence_date"))
                ), None)
                is_update = matched is not None
            if matched is not None:
                matched_existing_ids.add(matched.id)
            update_count += int(is_update)
        count = len(package["entities"][name])
        summary[name] = {
            "total": count,
            "create": count - update_count,
            "update": update_count,
            "delete": len(existing) - len(matched_existing_ids) if mode == "replace" else 0,
        }
    return {
        "app": package["app"],
        "schema_version": package["schema_version"],
        "exported_at": package.get("exported_at"),
        "mode": mode,
        "conflict_policy": "replace_local_data" if mode == "replace" else "incoming_package_wins_by_uuid",
        "entities": summary,
        "total": sum(item["total"] for item in summary.values()),
        "delete_total": sum(item["delete"] for item in summary.values()),
    }


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
        if field in item:
            setattr(instance, field, _coerce(model, field, item[field]))


async def _upsert_group(
    db: AsyncSession,
    name: str,
    items: list[dict[str, Any]],
    maps: dict[str, dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], int, int]:
    model, fields = SPECS[name]
    result = await db.execute(select(model).order_by(model.id.asc()))
    existing = list(result.scalars().all())
    by_uuid = {item.uuid: item for item in existing}
    by_date = {item.log_date: item for item in existing} if name == "daily_logs" else {}
    by_recurrence_key: dict[tuple[int, str, date], Any] = {}
    if name == "recurrence_exceptions":
        for existing_item in existing:
            key = (
                existing_item.recurrence_rule_id,
                _json_value(existing_item.entity_type),
                existing_item.recurrence_date,
            )
            by_recurrence_key.setdefault(key, existing_item)
    created = updated = 0
    mapped: dict[str, Any] = {}
    for item in items:
        recurrence_rule_id = None
        recurrence_key = None
        if name == "recurrence_exceptions":
            if maps is None or "recurrence_rules" not in maps:
                raise DataPackageError("导入重复例外前必须先导入重复规则")
            recurrence_rule_id = _resolve(
                maps["recurrence_rules"], item.get("recurrence_rule_uuid"), "重复规则"
            )
            recurrence_key = (
                recurrence_rule_id,
                item.get("entity_type"),
                _parse_date(item.get("recurrence_date")),
            )
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
            if name in ("daily_logs", "recurrence_exceptions") and instance.uuid != item["uuid"]:
                instance.uuid = item["uuid"]
        _apply_fields(instance, model, fields, item)
        if name == "recurrence_exceptions":
            instance.recurrence_rule_id = recurrence_rule_id
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


async def import_package(db: AsyncSession, raw_package: Any, mode: str = "merge") -> dict[str, Any]:
    mode = _validate_mode(mode)
    package = validate_package(raw_package)
    entities = package["entities"]
    maps: dict[str, dict[str, Any]] = {}
    results: dict[str, dict[str, int]] = {}
    try:
        for name in ENTITY_ORDER:
            mapped, created, updated = await _upsert_group(db, name, entities[name], maps)
            maps[name] = mapped
            results[name] = {"created": created, "updated": updated}

        projects = maps["projects"]
        rules = maps["recurrence_rules"]
        todos = maps["todos"]
        schedules = maps["schedules"]
        for item in entities["recurrence_rules"]:
            instance = rules[item["uuid"]]
            instance.project_id = _resolve(projects, item.get("project_uuid"), "项目")
            template = dict(instance.template_json or {})
            template.pop("project_id", None)
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
        for item in entities["daily_logs"]:
            instance = maps["daily_logs"][item["uuid"]]
            instance.completed_todo_ids = [_resolve(todos, todo_uuid, "待办") for todo_uuid in item.get("completed_todo_uuids", [])]
        for item in entities["timer_sessions"]:
            instance = maps["timer_sessions"][item["uuid"]]
            instance.project_id = _resolve(projects, item.get("project_uuid"), "项目")
            instance.linked_todo_id = _resolve(todos, item.get("linked_todo_uuid"), "待办")
            instance.created_schedule_id = _resolve(schedules, item.get("created_schedule_uuid"), "日程")

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
        "schema_version": SCHEMA_VERSION,
        "mode": mode,
        "conflict_policy": "replace_local_data" if mode == "replace" else "incoming_package_wins_by_uuid",
        "entities": results,
        "created": sum(item["created"] for item in results.values()),
        "updated": sum(item["updated"] for item in results.values()),
        "deleted": sum(deleted.values()),
    }
