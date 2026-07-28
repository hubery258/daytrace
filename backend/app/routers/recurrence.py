from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Optional

from ..database import get_db
from .. import crud, models, schemas

router = APIRouter(prefix="/api/recurrence-rules", tags=["recurrence-rules"])


@router.get("/", response_model=List[schemas.RecurrenceRuleOut])
async def list_recurrence_rules(
    entity_type: Optional[models.RecurrenceEntityType] = Query(None),
    include_archived: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    return await crud.get_recurrence_rules(db, entity_type=entity_type, include_archived=include_archived)


@router.post("/", response_model=schemas.RecurrenceRuleOut, status_code=201)
async def create_recurrence_rule(data: schemas.RecurrenceRuleCreate, db: AsyncSession = Depends(get_db)):
    return await crud.create_recurrence_rule(db, data)


@router.post("/generate", response_model=schemas.RecurrenceGenerateOut)
async def generate_recurrence_instances(data: schemas.RecurrenceGenerateRequest, db: AsyncSession = Depends(get_db)):
    return await crud.generate_recurrence_instances(db, data)


@router.post("/from-todo/{todo_id}/sync", response_model=schemas.TodoOut)
async def sync_recurrence_from_todo(todo_id: int, data: schemas.TodoUpdate, db: AsyncSession = Depends(get_db)):
    todo = await crud.sync_recurrence_from_todo(db, todo_id, data)
    if not todo:
        raise HTTPException(status_code=404, detail="Recurring todo instance not found")
    return todo


@router.post("/from-schedule/{schedule_id}/sync", response_model=schemas.ScheduleOut)
async def sync_recurrence_from_schedule(schedule_id: int, data: schemas.ScheduleUpdate, db: AsyncSession = Depends(get_db)):
    schedule = await crud.sync_recurrence_from_schedule(db, schedule_id, data)
    if not schedule:
        raise HTTPException(status_code=404, detail="Recurring schedule instance not found")
    return schedule


@router.get("/{rule_id}", response_model=schemas.RecurrenceRuleOut)
async def get_recurrence_rule(rule_id: int, db: AsyncSession = Depends(get_db)):
    rule = await crud.get_recurrence_rule(db, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Recurrence rule not found")
    return rule


@router.put("/{rule_id}", response_model=schemas.RecurrenceRuleOut)
async def update_recurrence_rule(rule_id: int, data: schemas.RecurrenceRuleUpdate, db: AsyncSession = Depends(get_db)):
    rule = await crud.update_recurrence_rule(db, rule_id, data)
    if not rule:
        raise HTTPException(status_code=404, detail="Recurrence rule not found")
    return rule


@router.delete("/{rule_id}", status_code=204)
async def delete_recurrence_rule(
    rule_id: int,
    delete_future_instances: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    ok = await crud.delete_recurrence_rule(db, rule_id, delete_future_instances=delete_future_instances)
    if not ok:
        raise HTTPException(status_code=404, detail="Recurrence rule not found")