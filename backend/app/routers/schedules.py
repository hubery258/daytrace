from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional, List

from ..database import get_db
from .. import crud, schemas

router = APIRouter(prefix="/api/schedules", tags=["schedules"])


@router.post("/", response_model=schemas.ScheduleOut, status_code=201)
async def create_schedule(data: schemas.ScheduleCreate, db: AsyncSession = Depends(get_db)):
    return await crud.create_schedule(db, data)


@router.get("/", response_model=List[schemas.ScheduleOut])
async def list_schedules(
    is_planned: Optional[bool] = Query(None),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    return await crud.get_schedules(db, is_planned=is_planned, date_from=date_from, date_to=date_to)


@router.get("/current", response_model=Optional[schemas.ScheduleOut])
async def current_schedule(db: AsyncSession = Depends(get_db)):
    return await crud.get_current_schedule(db)


@router.get("/week", response_model=List[schemas.ScheduleOut])
async def week_schedules(
    start_date: datetime = Query(..., description="周起始日期"),
    db: AsyncSession = Depends(get_db),
):
    """获取指定周的所有日程（周一到周日）。"""
    end_date = start_date + timedelta(days=7)
    return await crud.get_schedules(db, date_from=start_date, date_to=end_date)


@router.get("/{schedule_id}", response_model=schemas.ScheduleOut)
async def get_schedule(schedule_id: int, db: AsyncSession = Depends(get_db)):
    schedule = await crud.get_schedule(db, schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="日程不存在")
    return schedule


@router.put("/{schedule_id}", response_model=schemas.ScheduleOut)
async def update_schedule(schedule_id: int, data: schemas.ScheduleUpdate, db: AsyncSession = Depends(get_db)):
    schedule = await crud.update_schedule(db, schedule_id, data)
    if not schedule:
        raise HTTPException(status_code=404, detail="日程不存在")
    return schedule


@router.delete("/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: int, db: AsyncSession = Depends(get_db)):
    ok = await crud.delete_schedule(db, schedule_id)
    if not ok:
        raise HTTPException(status_code=404, detail="日程不存在")
