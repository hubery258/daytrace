from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from .. import crud, models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/timer", tags=["timer"])


def _ensure_active_timer(timer: Optional[models.TimerSession]) -> models.TimerSession:
    if not timer:
        raise HTTPException(status_code=404, detail="没有进行中的计时")
    return timer


@router.get("/current", response_model=Optional[schemas.TimerOut])
async def current_timer(db: AsyncSession = Depends(get_db)):
    return await crud.get_current_timer(db)


@router.post("/start", response_model=schemas.TimerOut, status_code=201)
async def start_timer(data: schemas.TimerStart, db: AsyncSession = Depends(get_db)):
    current = await crud.get_current_timer(db)
    if current:
        raise HTTPException(status_code=409, detail="同一时间只允许一个进行中的计时")
    return await crud.start_timer(db, data)


@router.put("/current", response_model=schemas.TimerOut)
async def update_current_timer(data: schemas.TimerUpdate, db: AsyncSession = Depends(get_db)):
    timer = _ensure_active_timer(await crud.get_current_timer(db))
    return await crud.update_timer_details(db, timer, data)


@router.post("/pause", response_model=schemas.TimerOut)
async def pause_timer(db: AsyncSession = Depends(get_db)):
    timer = _ensure_active_timer(await crud.get_current_timer(db))
    if timer.status != models.TimerStatus.running:
        raise HTTPException(status_code=400, detail="当前计时不在运行状态")
    return await crud.pause_timer(db, timer)


@router.post("/resume", response_model=schemas.TimerOut)
async def resume_timer(db: AsyncSession = Depends(get_db)):
    timer = _ensure_active_timer(await crud.get_current_timer(db))
    if timer.status != models.TimerStatus.paused:
        raise HTTPException(status_code=400, detail="当前计时不在暂停状态")
    return await crud.resume_timer(db, timer)


@router.post("/finish", response_model=schemas.TimerOut)
async def finish_timer(db: AsyncSession = Depends(get_db)):
    timer = _ensure_active_timer(await crud.get_current_timer(db))
    return await crud.finish_timer(db, timer)


@router.post("/cancel", response_model=schemas.TimerOut)
async def cancel_timer(db: AsyncSession = Depends(get_db)):
    timer = _ensure_active_timer(await crud.get_current_timer(db))
    return await crud.cancel_timer(db, timer)


@router.post("/{timer_id}/schedule", response_model=schemas.TimerOut)
async def attach_schedule(timer_id: int, data: schemas.TimerAttachSchedule, db: AsyncSession = Depends(get_db)):
    timer = await crud.get_timer(db, timer_id)
    if not timer:
        raise HTTPException(status_code=404, detail="计时会话不存在")
    if timer.status != models.TimerStatus.completed:
        raise HTTPException(status_code=400, detail="只能为已结束的计时关联日程")
    return await crud.attach_timer_schedule(db, timer, data.schedule_id)


@router.get("/recent", response_model=List[schemas.TimerOut])
async def recent_timers(limit: int = Query(10, ge=1, le=50), db: AsyncSession = Depends(get_db)):
    return await crud.get_recent_timers(db, limit=limit)
