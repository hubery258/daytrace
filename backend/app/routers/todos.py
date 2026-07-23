from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional, List

from ..database import get_db
from .. import crud, schemas, models

router = APIRouter(prefix="/api/todos", tags=["todos"])


@router.post("/", response_model=schemas.TodoOut, status_code=201)
async def create_todo(data: schemas.TodoCreate, db: AsyncSession = Depends(get_db)):
    return await crud.create_todo(db, data)


@router.get("/", response_model=List[schemas.TodoOut])
async def list_todos(
    category: Optional[str] = Query(None),
    status: Optional[models.TodoStatus] = Query(None),
    is_completed: Optional[bool] = Query(None),
    project_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    return await crud.get_todos(db, category=category, status=status, is_completed=is_completed, project_id=project_id)


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
    todo = await crud.update_todo(db, todo_id, data)
    if not todo:
        raise HTTPException(status_code=404, detail="待办不存在")
    return todo


@router.delete("/{todo_id}", status_code=204)
async def delete_todo(todo_id: int, db: AsyncSession = Depends(get_db)):
    ok = await crud.delete_todo(db, todo_id)
    if not ok:
        raise HTTPException(status_code=404, detail="待办不存在")
