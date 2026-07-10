from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional, List

from ..database import get_db
from .. import crud, schemas

router = APIRouter(prefix="/api", tags=["logs"])


# ============ DailyLog ============

@router.post("/logs", response_model=schemas.DailyLogOut, status_code=201)
async def create_or_update_log(data: schemas.DailyLogCreate, db: AsyncSession = Depends(get_db)):
    return await crud.upsert_daily_log(db, data)


@router.get("/logs", response_model=List[schemas.DailyLogOut])
async def list_logs(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    return await crud.get_daily_logs(db, date_from=date_from, date_to=date_to)


@router.get("/logs/{log_date}", response_model=schemas.DailyLogOut)
async def get_log(log_date: date, db: AsyncSession = Depends(get_db)):
    log = await crud.get_daily_log_by_date(db, log_date)
    if not log:
        raise HTTPException(status_code=404, detail="该日无日志记录")
    return log


# ============ LogTemplate ============

@router.post("/templates", response_model=schemas.LogTemplateOut, status_code=201)
async def create_template(data: schemas.LogTemplateCreate, db: AsyncSession = Depends(get_db)):
    return await crud.create_log_template(db, data)


@router.get("/templates", response_model=List[schemas.LogTemplateOut])
async def list_templates(db: AsyncSession = Depends(get_db)):
    return await crud.get_log_templates(db)


@router.put("/templates/{template_id}", response_model=schemas.LogTemplateOut)
async def update_template(template_id: int, data: schemas.LogTemplateUpdate, db: AsyncSession = Depends(get_db)):
    template = await crud.update_log_template(db, template_id, data)
    if not template:
        raise HTTPException(status_code=404, detail="模板不存在")
    return template


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(template_id: int, db: AsyncSession = Depends(get_db)):
    ok = await crud.delete_log_template(db, template_id)
    if not ok:
        raise HTTPException(status_code=404, detail="模板不存在")
