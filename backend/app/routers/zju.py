import asyncio
from datetime import datetime
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models, schemas
from ..database import get_db
from ..zju_client import ExternalTodo, ZjuClientError, ZjuCoursesClient, fetch_pintia_todos


router = APIRouter(prefix="/api/zju", tags=["zju"])


async def _get_credential(db: AsyncSession) -> models.ZjuCredential | None:
    result = await db.execute(select(models.ZjuCredential).order_by(models.ZjuCredential.id.asc()).limit(1))
    return result.scalar_one_or_none()


async def _get_or_create_credential(db: AsyncSession) -> models.ZjuCredential:
    credential = await _get_credential(db)
    if credential:
        return credential
    credential = models.ZjuCredential()
    db.add(credential)
    await db.commit()
    await db.refresh(credential)
    return credential


def _credential_out(credential: models.ZjuCredential | None) -> schemas.ZjuCredentialOut:
    if not credential:
        return schemas.ZjuCredentialOut()
    return schemas.ZjuCredentialOut(
        username=credential.username,
        has_password=bool(credential.password),
        has_pintia_cookie=bool(credential.pintia_cookie),
        save_password=credential.save_password,
        save_pintia_cookie=credential.save_pintia_cookie,
        default_reminder_days=credential.default_reminder_days,
    )


def _to_preview(item: ExternalTodo) -> schemas.ExternalTodoPreview:
    return schemas.ExternalTodoPreview(
        source=item.source,
        external_id=item.external_id,
        title=item.title,
        course_name=item.course_name,
        ddl_at=item.ddl_at,
        type=item.type,
        url=item.url,
        raw=item.raw,
    )


def _fetch_external_todos(
    username: str,
    password: str,
    pintia_cookie: str,
    include_pintia: bool,
) -> tuple[list[ExternalTodo], list[str]]:
    items: list[ExternalTodo] = []
    errors: list[str] = []

    try:
        client = ZjuCoursesClient(username, password)
        client.login()
        items.extend(client.get_reliable_todos())
    except ZjuClientError as exc:
        errors.append(str(exc))

    if include_pintia and pintia_cookie.strip():
        try:
            items.extend(fetch_pintia_todos(pintia_cookie))
        except ZjuClientError as exc:
            errors.append(str(exc))

    seen: set[tuple[str, str]] = set()
    deduped: list[ExternalTodo] = []
    for item in items:
        key = (item.source, item.external_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped, errors


async def _mark_existing(db: AsyncSession, items: Iterable[schemas.ExternalTodoPreview]) -> list[schemas.ExternalTodoPreview]:
    output: list[schemas.ExternalTodoPreview] = []
    for item in items:
        result = await db.execute(
            select(models.ExternalItem).where(
                models.ExternalItem.source == item.source,
                models.ExternalItem.external_id == item.external_id,
                models.ExternalItem.entity_type == "todo",
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            item.action = "exists"
            item.reason = "已导入"
            item.imported_todo_id = existing.local_entity_id
        else:
            item.action = "create"
            item.reason = "可导入"
        output.append(item)
    return output


@router.get("/credentials", response_model=schemas.ZjuCredentialOut)
async def get_credentials(db: AsyncSession = Depends(get_db)):
    return _credential_out(await _get_credential(db))


@router.put("/credentials", response_model=schemas.ZjuCredentialOut)
async def save_credentials(data: schemas.ZjuCredentialIn, db: AsyncSession = Depends(get_db)):
    credential = await _get_or_create_credential(db)
    credential.username = data.username.strip()
    credential.password = (data.password or credential.password) if data.save_password else ""
    credential.pintia_cookie = (data.pintia_cookie or credential.pintia_cookie) if data.save_pintia_cookie else ""
    credential.save_password = data.save_password
    credential.save_pintia_cookie = data.save_pintia_cookie
    credential.default_reminder_days = data.default_reminder_days
    credential.updated_at = datetime.now()
    await db.commit()
    await db.refresh(credential)
    return _credential_out(credential)


@router.delete("/credentials/password", response_model=schemas.ZjuCredentialOut)
async def clear_password(db: AsyncSession = Depends(get_db)):
    credential = await _get_or_create_credential(db)
    credential.password = ""
    credential.save_password = False
    credential.updated_at = datetime.now()
    await db.commit()
    await db.refresh(credential)
    return _credential_out(credential)


@router.delete("/credentials/pintia", response_model=schemas.ZjuCredentialOut)
async def clear_pintia_cookie(db: AsyncSession = Depends(get_db)):
    credential = await _get_or_create_credential(db)
    credential.pintia_cookie = ""
    credential.save_pintia_cookie = False
    credential.updated_at = datetime.now()
    await db.commit()
    await db.refresh(credential)
    return _credential_out(credential)


@router.post("/preview", response_model=schemas.ZjuPreviewOut)
async def preview_zju_todos(data: schemas.ZjuPreviewRequest, db: AsyncSession = Depends(get_db)):
    credential = await _get_credential(db)
    username = (data.username if data.username is not None else (credential.username if credential else "")).strip()
    password = (data.password or (credential.password if credential else ""))
    pintia_cookie = (data.pintia_cookie or (credential.pintia_cookie if credential else ""))

    if not username or not password:
        raise HTTPException(status_code=400, detail="请填写 ZJU 学号和密码，或先保存凭据")

    if data.save_credentials:
        credential = await _get_or_create_credential(db)
        credential.username = username
        credential.password = (password or credential.password) if data.save_password else ""
        credential.pintia_cookie = (pintia_cookie or credential.pintia_cookie) if data.save_pintia_cookie else ""
        credential.save_password = data.save_password
        credential.save_pintia_cookie = data.save_pintia_cookie
        credential.default_reminder_days = data.default_reminder_days
        credential.updated_at = datetime.now()
        await db.commit()

    fetched, errors = await asyncio.to_thread(
        _fetch_external_todos,
        username,
        password,
        pintia_cookie or "",
        data.include_pintia,
    )
    preview_items = [_to_preview(item) for item in fetched]
    preview_items = await _mark_existing(db, preview_items)
    return schemas.ZjuPreviewOut(
        items=preview_items,
        errors=errors,
        saved_credentials=data.save_credentials,
    )


def _build_todo_notes(item: schemas.ExternalTodoPreview) -> str:
    lines = [
        "来源：ZJU 集成",
        f"平台：{item.source}",
        f"外部 ID：{item.external_id}",
    ]
    if item.course_name:
        lines.append(f"课程：{item.course_name}")
    if item.type:
        lines.append(f"类型：{item.type}")
    if item.url:
        lines.append(f"链接：{item.url}")
    return "\n".join(lines)


@router.post("/import", response_model=schemas.ZjuImportOut)
async def import_zju_todos(data: schemas.ZjuImportRequest, db: AsyncSession = Depends(get_db)):
    batch = models.ImportBatch(source="zju", status="completed", summary={})
    db.add(batch)
    await db.flush()

    created_ids: list[int] = []
    skipped_count = 0
    imported_keys: set[tuple[str, str]] = set()

    for item in data.items:
        key = (item.source, item.external_id)
        if item.action == "exists" or key in imported_keys:
            skipped_count += 1
            continue
        imported_keys.add(key)

        result = await db.execute(
            select(models.ExternalItem).where(
                models.ExternalItem.source == item.source,
                models.ExternalItem.external_id == item.external_id,
                models.ExternalItem.entity_type == "todo",
            )
        )
        if result.scalar_one_or_none():
            skipped_count += 1
            continue

        todo_name = f"[{item.course_name}] {item.title}" if item.course_name else item.title
        todo = models.Todo(
            name=todo_name[:200],
            ddl_type=models.DDLType.hard if item.ddl_at else models.DDLType.none,
            ddl_date=item.ddl_at,
            reminder_days=data.reminder_days if item.ddl_at else None,
            category="课程" if item.ddl_at else "计划箱",
            status=models.TodoStatus.not_focusing,
            notes=_build_todo_notes(item),
            is_completed=False,
        )
        db.add(todo)
        await db.flush()

        db.add(
            models.ExternalItem(
                source=item.source,
                external_id=item.external_id,
                entity_type="todo",
                local_entity_id=todo.id,
                import_batch_id=batch.id,
                payload=item.model_dump(mode="json"),
            )
        )
        created_ids.append(todo.id)

    batch.summary = {"created_count": len(created_ids), "skipped_count": skipped_count}
    await db.commit()
    return schemas.ZjuImportOut(
        batch_id=batch.id,
        created_count=len(created_ids),
        skipped_count=skipped_count,
        todo_ids=created_ids,
    )


@router.post("/undo-last", response_model=schemas.ZjuUndoOut)
async def undo_last_import(db: AsyncSession = Depends(get_db)):
    batch_result = await db.execute(
        select(models.ImportBatch)
        .where(models.ImportBatch.source == "zju", models.ImportBatch.status == "completed")
        .order_by(models.ImportBatch.created_at.desc())
        .limit(1)
    )
    batch = batch_result.scalar_one_or_none()
    if not batch:
        return schemas.ZjuUndoOut(batch_id=None, deleted_count=0, skipped_count=0)

    item_result = await db.execute(
        select(models.ExternalItem).where(
            models.ExternalItem.import_batch_id == batch.id,
            models.ExternalItem.entity_type == "todo",
        )
    )
    external_items = list(item_result.scalars().all())
    deleted_count = 0
    skipped_count = 0
    for external_item in external_items:
        todo = await db.get(models.Todo, external_item.local_entity_id)
        if todo and not todo.is_completed:
            await db.delete(todo)
            deleted_count += 1
        else:
            skipped_count += 1
        await db.delete(external_item)

    batch.status = "undone"
    batch.summary = {**(batch.summary or {}), "undo_deleted_count": deleted_count, "undo_skipped_count": skipped_count}
    batch.updated_at = datetime.now()
    await db.commit()
    return schemas.ZjuUndoOut(batch_id=batch.id, deleted_count=deleted_count, skipped_count=skipped_count)

