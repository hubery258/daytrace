from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..data_portability import DataPackageError, export_package, import_package, preview_package
from ..database import get_db


router = APIRouter(prefix="/api/data", tags=["data-portability"])


class ImportRequest(BaseModel):
    package: dict[str, Any]
    mode: str = "merge"


@router.get("/export")
async def export_data(db: AsyncSession = Depends(get_db)):
    return await export_package(db)


@router.post("/import/preview")
async def preview_import(data: ImportRequest, db: AsyncSession = Depends(get_db)):
    if data.mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="导入模式必须是 merge 或 replace")
    try:
        return await preview_package(db, data.package, data.mode)
    except DataPackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/import")
async def commit_import(data: ImportRequest, db: AsyncSession = Depends(get_db)):
    if data.mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="导入模式必须是 merge 或 replace")
    try:
        return await import_package(db, data.package, data.mode)
    except DataPackageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"数据包字段格式错误：{exc}") from exc
