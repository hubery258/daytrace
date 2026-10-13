from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..data_portability import DataPackageError, export_package, import_package, preview_package
from ..database import get_db
from ..reference_repair import preview_schedule_repair, repair_schedule_links


router = APIRouter(prefix="/api/data", tags=["data-portability"])


class ImportRequest(BaseModel):
    package: dict[str, Any]
    mode: str = "merge"
    choices: dict[str, Any] = {}
    preview_token: str | None = None


class RepairRequest(BaseModel):
    preview_token: str
    confirmed: bool = False


@router.get('/references/schedules')
async def check_schedule_links(db: AsyncSession = Depends(get_db)):
    return await preview_schedule_repair(db)


@router.post('/references/schedules/repair')
async def confirm_schedule_repair(data: RepairRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await repair_schedule_links(db, data.preview_token, data.confirmed)
    except DataPackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.get("/export")
async def export_data(db: AsyncSession = Depends(get_db)):
    try:
        return await export_package(db)
    except DataPackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.post("/import/preview")
async def preview_import(data: ImportRequest, db: AsyncSession = Depends(get_db)):
    if data.mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="导入模式必须是 merge 或 replace")
    try:
        return await preview_package(db, data.package, data.mode, data.choices)
    except DataPackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/import")
async def commit_import(data: ImportRequest, db: AsyncSession = Depends(get_db)):
    if data.mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="导入模式必须是 merge 或 replace")
    try:
        return await import_package(db, data.package, data.mode, data.choices, data.preview_token)
    except DataPackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"数据包字段格式错误：{exc}") from exc
