from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from .. import models, schemas
from ..database import get_db

router = APIRouter(prefix="/api/time-blocks", tags=["time-blocks"])

async def output(db, blocks):
    ids = {b.linked_todo_id for b in blocks if b.linked_todo_id}
    todos = {}
    if ids:
        result = await db.execute(select(models.Todo).where(models.Todo.id.in_(ids)))
        todos = {t.id: t for t in result.scalars()}
    return [schemas.TimeBlockOut.model_validate({
        **{c.name: getattr(b, c.name) for c in models.TimeBlock.__table__.columns},
        "project_id": todos[b.linked_todo_id].project_id if b.linked_todo_id in todos else b.manual_project_id,
    }) for b in blocks]

@router.get("/categories", response_model=list[schemas.TimeBlockCategoryOut])
async def categories(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(models.TimeBlockCategory).order_by(models.TimeBlockCategory.id))
    return list(result.scalars())

@router.post("/categories", response_model=schemas.TimeBlockCategoryOut, status_code=201)
async def create_category(data: schemas.TimeBlockCategoryCreate, db: AsyncSession = Depends(get_db)):
    name = data.name.strip()
    if not name:
        raise HTTPException(422, '属性名称不能为空')
    result = await db.execute(select(models.TimeBlockCategory).where(models.TimeBlockCategory.name == name))
    if result.first():
        raise HTTPException(409, "属性名称已存在")
    item = models.TimeBlockCategory(name=name, color=data.color)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item

@router.put("/categories/{category_id}", response_model=schemas.TimeBlockCategoryOut)
async def update_category(category_id: int, data: schemas.TimeBlockCategoryCreate, db: AsyncSession = Depends(get_db)):
    item = await db.get(models.TimeBlockCategory, category_id)
    if not item:
        raise HTTPException(404, "属性分类不存在")
    if not data.name.strip():
        raise HTTPException(422, '属性名称不能为空')
    result = await db.execute(select(models.TimeBlockCategory).where(
        models.TimeBlockCategory.name == data.name.strip(), models.TimeBlockCategory.id != category_id))
    if result.first():
        raise HTTPException(409, "属性名称已存在")
    item.name, item.color = data.name.strip(), data.color
    await db.commit()
    await db.refresh(item)
    return item

@router.delete("/categories/{category_id}", status_code=204)
async def delete_category(category_id: int, db: AsyncSession = Depends(get_db)):
    item = await db.get(models.TimeBlockCategory, category_id)
    if not item:
        raise HTTPException(404, "属性分类不存在")
    result = await db.execute(select(models.TimeBlock.id).where(models.TimeBlock.category_id == category_id).limit(1))
    if result.first():
        raise HTTPException(409, "该属性已有时间块，不能删除")
    await db.delete(item)
    await db.commit()

@router.get("/", response_model=list[schemas.TimeBlockOut])
async def list_blocks(date_from: date = Query(...), date_to: Optional[date] = Query(None),
                      db: AsyncSession = Depends(get_db)):
    end = date_to or date_from
    if end < date_from or (end - date_from).days > 45:
        raise HTTPException(422, "日期范围无效或超过 45 天")
    result = await db.execute(select(models.TimeBlock).where(
        models.TimeBlock.block_date >= date_from, models.TimeBlock.block_date <= end,
    ).order_by(models.TimeBlock.block_date, models.TimeBlock.start_minute))
    return await output(db, list(result.scalars()))

@router.put("/range", response_model=list[schemas.TimeBlockOut])
async def replace_range(data: schemas.TimeBlockReplace, db: AsyncSession = Depends(get_db)):
    for block in data.blocks:
        if not await db.get(models.TimeBlockCategory, block.category_id):
            raise HTTPException(422, "属性分类不存在")
        if block.linked_todo_id is not None and not await db.get(models.Todo, block.linked_todo_id):
            raise HTTPException(422, "关联待办不存在")
        if block.linked_todo_id is None and block.manual_project_id is not None and not await db.get(models.Project, block.manual_project_id):
            raise HTTPException(422, "关联项目不存在")
    result = await db.execute(select(models.TimeBlock).where(
        models.TimeBlock.block_date == data.block_date,
        models.TimeBlock.start_minute < data.end_minute,
        models.TimeBlock.end_minute > data.start_minute))
    for old in result.scalars().all():
        await db.delete(old)
        for start, end in ((old.start_minute, min(old.end_minute, data.start_minute)),
                           (max(old.start_minute, data.end_minute), old.end_minute)):
            for minute in range(start, end, 15):
                if minute + 15 <= end:
                    db.add(models.TimeBlock(block_date=old.block_date, start_minute=minute,
                        end_minute=minute + 15, granularity=15, category_id=old.category_id,
                        notes=old.notes, linked_todo_id=old.linked_todo_id,
                        manual_project_id=old.manual_project_id, source=old.source,
                        source_timer_id=old.source_timer_id,
                        coverage_seconds=min(old.coverage_seconds or 0, 900) if old.coverage_seconds is not None else None))
    for item in data.blocks:
        db.add(models.TimeBlock(block_date=data.block_date, **item.model_dump()))
    await db.commit()
    return await list_blocks(data.block_date, data.block_date, db)

class TimerConversion(BaseModel):
    category_id: int
    granularity: int

@router.post("/from-timer/{timer_id}", response_model=list[schemas.TimeBlockOut])
async def from_timer(timer_id: int, data: TimerConversion, db: AsyncSession = Depends(get_db)):
    if data.granularity not in (15, 30):
        raise HTTPException(422, "粒度必须为 15 或 30 分钟")
    if not await db.get(models.TimeBlockCategory, data.category_id):
        raise HTTPException(422, "属性分类不存在")
    timer = await db.get(models.TimerSession, timer_id)
    if not timer or timer.status != models.TimerStatus.completed:
        raise HTTPException(422, "只能折算已结束的计时")
    intervals = timer.active_intervals or []
    if not intervals and timer.paused_seconds:
        raise HTTPException(422, '旧计时缺少暂停分段，无法准确折算；可在日程页手动补录')
    if not intervals and timer.started_at and timer.ended_at:
        intervals = [[timer.started_at.isoformat(), timer.ended_at.isoformat()]]
    coverage = {}
    for raw_start, raw_end in intervals:
        start, end = datetime.fromisoformat(raw_start), datetime.fromisoformat(raw_end)
        day = start.date()
        while day <= end.date():
            day_start = datetime.combine(day, datetime.min.time())
            first = max(0, int(((start - day_start).total_seconds() // 60) // data.granularity) * data.granularity)
            last = min(1440, int(((end - day_start).total_seconds() / 60 + data.granularity - 1) // data.granularity) * data.granularity)
            for minute in range(first, last, data.granularity):
                slot_start = day_start + timedelta(minutes=minute)
                slot_end = slot_start + timedelta(minutes=data.granularity)
                seconds = max(0, int((min(end, slot_end) - max(start, slot_start)).total_seconds()))
                if seconds:
                    coverage[(day, minute)] = coverage.get((day, minute), 0) + seconds
            day += timedelta(days=1)
    candidates = [(day, minute, seconds) for (day, minute), seconds in coverage.items()
                  if seconds * 2 >= data.granularity * 60]
    for day, minute, seconds in sorted(candidates):
        result = await db.execute(select(models.TimeBlock).where(
            models.TimeBlock.block_date == day,
            models.TimeBlock.start_minute < minute + data.granularity,
            models.TimeBlock.end_minute > minute))
        competing = list(result.scalars())
        if any(b.source != "timer" or (b.coverage_seconds or 0) >= seconds for b in competing):
            continue
        for b in competing:
            await db.delete(b)
            for start, end in ((b.start_minute, min(b.end_minute, minute)),
                               (max(b.start_minute, minute + data.granularity), b.end_minute)):
                for fragment in range(start, end, 15):
                    if fragment + 15 <= end:
                        db.add(models.TimeBlock(
                            block_date=day, start_minute=fragment, end_minute=fragment + 15,
                            granularity=15, category_id=b.category_id, notes=b.notes,
                            linked_todo_id=b.linked_todo_id, manual_project_id=b.manual_project_id,
                            source=b.source, source_timer_id=b.source_timer_id,
                            coverage_seconds=min(b.coverage_seconds or 0, 900)))
        db.add(models.TimeBlock(block_date=day, start_minute=minute,
            end_minute=minute + data.granularity, granularity=data.granularity,
            category_id=data.category_id, notes=timer.name + (' · ' + timer.notes if timer.notes else ''),
            linked_todo_id=timer.linked_todo_id,
            manual_project_id=None if timer.linked_todo_id else timer.project_id,
            source="timer", source_timer_id=timer.id, coverage_seconds=seconds))
        await db.flush()
    await db.commit()
    if not candidates:
        return []
    days = [day for day, _, _ in candidates]
    result = await db.execute(select(models.TimeBlock).where(
        models.TimeBlock.block_date >= min(days),
        models.TimeBlock.block_date <= max(days),
        models.TimeBlock.source_timer_id == timer.id,
    ).order_by(models.TimeBlock.block_date, models.TimeBlock.start_minute))
    return await output(db, list(result.scalars()))
