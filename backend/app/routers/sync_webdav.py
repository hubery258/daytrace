"""Local WebDAV manual sync endpoints (v0.11.0).

These endpoints only exist in the user's own backend (local FastAPI, Electron
sidecar or self-hosted Docker). The Android client implements the same logical
contract locally with native HTTP and never calls this router.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .. import schemas
from ..database import get_db
from ..webdav_client import WebDavError
from ..webdav_sync import (
    download_latest,
    get_or_create_config,
    config_payload,
    get_status,
    preflight_upload,
    save_config,
    test_connection,
    upload_latest,
)


router = APIRouter(prefix="/api/sync/webdav", tags=["webdav-sync"])


def _raise(error: WebDavError) -> None:
    raise HTTPException(status_code=error.http_status, detail=error.to_payload()) from None


@router.get("/config")
async def read_config(db: AsyncSession = Depends(get_db)):
    return config_payload(await get_or_create_config(db))


@router.put("/config")
async def write_config(data: schemas.WebDavConfigIn, db: AsyncSession = Depends(get_db)):
    try:
        return await save_config(db, data)
    except WebDavError as error:
        _raise(error)


@router.post("/test")
async def test(data: schemas.WebDavTestRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await test_connection(db, data)
    except WebDavError as error:
        _raise(error)


@router.post("/upload/preflight")
async def preflight(db: AsyncSession = Depends(get_db)):
    try:
        return await preflight_upload(db)
    except WebDavError as error:
        _raise(error)


@router.post("/upload")
async def upload(data: schemas.WebDavUploadRequest, db: AsyncSession = Depends(get_db)):
    try:
        return await upload_latest(
            db,
            confirmed=data.confirmed,
            expected_remote_etag=data.expected_remote_etag,
            expected_remote_exists=data.expected_remote_exists,
        )
    except WebDavError as error:
        _raise(error)


@router.post("/download")
async def download(db: AsyncSession = Depends(get_db)):
    try:
        return await download_latest(db)
    except WebDavError as error:
        _raise(error)


@router.get("/status")
async def status(db: AsyncSession = Depends(get_db)):
    return await get_status(db)
