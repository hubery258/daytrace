"""Remove legacy actual schedules from a v0.6.0 Riji JSON backup.

Usage: python scripts/clean-v010-legacy-json.py old.json [clean.json]
The source file is never modified.
"""
import argparse
import json
from pathlib import Path


def clean(package):
    if not isinstance(package, dict) or package.get("app") != "riji":
        raise ValueError("不是日迹 JSON 数据包")
    if package.get("schema_version") != "0.6.0":
        raise ValueError("此脚本仅清洗 0.6.0 旧数据包")
    entities = package.get("entities")
    if not isinstance(entities, dict):
        raise ValueError("数据包缺少 entities")
    result = json.loads(json.dumps(package, ensure_ascii=False))
    target = result["entities"]
    schedules = target.get("schedules", [])
    if not isinstance(schedules, list):
        raise ValueError("entities.schedules 必须是数组")
    target["schedules"] = [item for item in schedules if item.get("is_planned") is not False]
    removed = len(schedules) - len(target["schedules"])
    kept_uuids = {item.get("uuid") for item in target["schedules"]}
    for timer in target.get("timer_sessions", []):
        if timer.get("created_schedule_uuid") not in kept_uuids:
            timer["created_schedule_uuid"] = None
    rules = target.get("recurrence_rules", [])
    target["recurrence_rules"] = [
        item for item in rules
        if item.get("entity_type") != "schedule" or
        not isinstance(item.get("template_json"), dict) or
        item["template_json"].get("is_planned") is not False
    ]
    removed_rules = len(rules) - len(target["recurrence_rules"])
    return result, removed, removed_rules


def main():
    parser = argparse.ArgumentParser(description="清洗日迹旧实际日程，保留核心数据")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, nargs="?")
    args = parser.parse_args()
    output = args.output or args.source.with_name(args.source.stem + "-v010-clean.json")
    if output.resolve() == args.source.resolve():
        parser.error("输出文件必须不同于源文件")
    package = json.loads(args.source.read_text(encoding="utf-8-sig"))
    cleaned, removed, removed_rules = clean(package)
    output.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已保存 {output}；移除旧实际日程 {removed} 条、旧实际重复规则 {removed_rules} 条。")


if __name__ == "__main__":
    main()
