from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional, List

from ..database import get_db
from .. import crud, schemas, models

router = APIRouter(prefix="/api/todos", tags=["todos"])


async def ensure_focusing_limit(
    db: AsyncSession,
    status: Optional[models.TodoStatus],
    exclude_todo_id: Optional[int] = None,
):
    if status != models.TodoStatus.focusing:
        return
    focusing_count = await crud.count_focusing_todos(db, exclude_todo_id=exclude_todo_id)
    if focusing_count >= 3:
        raise HTTPException(status_code=400, detail="正在关注的待办最多只能有 3 个")


@router.post("/", response_model=schemas.TodoOut, status_code=201)
async def create_todo(data: schemas.TodoCreate, db: AsyncSession = Depends(get_db)):
    await ensure_focusing_limit(db, data.status)
    return await crud.create_todo(db, data)


@router.get("/", response_model=List[schemas.TodoOut])
async def list_todos(
    category: Optional[str] = Query(None),
    status: Optional[models.TodoStatus] = Query(None),
    is_completed: Optional[bool] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    return await crud.get_todos(db, category=category, status=status, is_completed=is_completed)


@router.get("/focusing", response_model=List[schemas.TodoOut])
async def list_focusing(db: AsyncSession = Depends(get_db)):
    return await crud.get_focusing_todos(db)


@router.get("/waiting-reply", response_model=List[schemas.TodoOut])
async def list_waiting_reply(db: AsyncSession = Depends(get_db)):
    return await crud.get_waiting_reply_todos(db)


@router.get("/ddl-near", response_model=List[schemas.TodoOut])
async def list_ddl_near(db: AsyncSession = Depends(get_db)):
    return await crud.get_ddl_near_todos(db)


@router.get("/{todo_id}", response_model=schemas.TodoOut)
async def get_todo(todo_id: int, db: AsyncSession = Depends(get_db)):
    todo = await crud.get_todo(db, todo_id)
    if not todo:
        raise HTTPException(status_code=404, detail="待办不存在")
    return todo


@router.put("/{todo_id}", response_model=schemas.TodoOut)
async def update_todo(todo_id: int, data: schemas.TodoUpdate, db: AsyncSession = Depends(get_db)):
    existing = await crud.get_todo(db, todo_id)
    if not existing:
        raise HTTPException(status_code=404, detail="待办不存在")
    next_status = data.status if data.status is not None else existing.status
    next_completed = data.is_completed if data.is_completed is not None else existing.is_completed
    if next_status == models.TodoStatus.focusing and not next_completed:
        await ensure_focusing_limit(db, next_status, exclude_todo_id=todo_id)
    todo = await crud.update_todo(db, todo_id, data)
    return todo


@router.delete("/{todo_id}", status_code=204)
async def delete_todo(todo_id: int, db: AsyncSession = Depends(get_db)):
    ok = await crud.delete_todo(db, todo_id)
    if not ok:
        raise HTTPException(status_code=404, detail="待办不存在")
