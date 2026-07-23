from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Optional

from ..database import get_db
from .. import crud, models, schemas

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.post("/", response_model=schemas.ProjectOut, status_code=201)
async def create_project(data: schemas.ProjectCreate, db: AsyncSession = Depends(get_db)):
    return await crud.create_project(db, data)


@router.get("/", response_model=List[schemas.ProjectOut])
async def list_projects(
    status: Optional[models.ProjectStatus] = Query(None),
    include_hidden: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    return await crud.get_projects(db, status=status, include_hidden=include_hidden)


@router.get("/{project_id}", response_model=schemas.ProjectOut)
async def get_project(project_id: int, db: AsyncSession = Depends(get_db)):
    project = await crud.get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    return project


@router.get("/{project_id}/overview", response_model=schemas.ProjectOverview)
async def get_project_overview(project_id: int, db: AsyncSession = Depends(get_db)):
    overview = await crud.get_project_overview(db, project_id)
    if not overview:
        raise HTTPException(status_code=404, detail="项目不存在")
    return overview


@router.put("/{project_id}", response_model=schemas.ProjectOut)
async def update_project(project_id: int, data: schemas.ProjectUpdate, db: AsyncSession = Depends(get_db)):
    project = await crud.update_project(db, project_id, data)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    return project


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: int, db: AsyncSession = Depends(get_db)):
    ok = await crud.delete_project(db, project_id)
    if not ok:
        raise HTTPException(status_code=404, detail="项目不存在")