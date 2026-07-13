from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .database import async_engine, Base
from .routers import logs, schedules, todos, zju


async def ensure_sqlite_schema_compat(conn):
    async def add_missing_columns(table_name: str, columns: dict[str, str]):
        result = await conn.execute(text(f"PRAGMA table_info({table_name})"))
        existing = {row[1] for row in result.fetchall()}
        for column_name, column_sql in columns.items():
            if column_name not in existing:
                await conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}"))

    await add_missing_columns(
        "zju_credentials",
        {
            "username": "username VARCHAR(100) DEFAULT ''",
            "password": "password TEXT DEFAULT ''",
            "pintia_cookie": "pintia_cookie TEXT DEFAULT ''",
            "save_password": "save_password BOOLEAN DEFAULT 0",
            "save_pintia_cookie": "save_pintia_cookie BOOLEAN DEFAULT 0",
            "default_reminder_days": "default_reminder_days INTEGER DEFAULT 1",
            "created_at": "created_at DATETIME",
            "updated_at": "updated_at DATETIME",
        },
    )
    await add_missing_columns(
        "import_batches",
        {
            "source": "source VARCHAR(50)",
            "status": "status VARCHAR(50) DEFAULT 'completed'",
            "summary": "summary JSON DEFAULT '{}'",
            "created_at": "created_at DATETIME",
            "updated_at": "updated_at DATETIME",
        },
    )
    await add_missing_columns(
        "external_items",
        {
            "source": "source VARCHAR(50)",
            "external_id": "external_id VARCHAR(300)",
            "entity_type": "entity_type VARCHAR(50)",
            "local_entity_id": "local_entity_id INTEGER",
            "import_batch_id": "import_batch_id INTEGER",
            "payload": "payload JSON DEFAULT '{}'",
            "created_at": "created_at DATETIME",
            "updated_at": "updated_at DATETIME",
        },
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await ensure_sqlite_schema_compat(conn)
    yield
    await async_engine.dispose()


app = FastAPI(
    title="鏃ヨ抗 API",
    description="涓汉鏁堢巼鍔╂墜 - 寰呭姙 & 鏃ョ▼ & AI 鍒嗘瀽",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(todos.router)
app.include_router(schedules.router)
app.include_router(logs.router)
app.include_router(zju.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}