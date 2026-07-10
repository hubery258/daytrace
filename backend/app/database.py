from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./task_app.db")

# Sync engine for Alembic migrations
sync_engine = create_engine(
    DATABASE_URL.replace("+aiosqlite", ""),
    connect_args={"check_same_thread": False},
)

# Async support for FastAPI
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

async_engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(async_engine, expire_on_commit=False)

Base = declarative_base()


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()
