from contextlib import asynccontextmanager
import uuid
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles
from sqlalchemy import text

from .database import async_engine, Base
from .routers import data_portability, logs, projects, recurrence, schedules, timer, todos, zju

class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            return await super().get_response("index.html", scope)
        if response.status_code == 404:
            return await super().get_response("index.html", scope)
        return response



async def ensure_sqlite_schema_compat(conn):
    async def add_missing_columns(table_name: str, columns: dict[str, str]):
        result = await conn.execute(text(f"PRAGMA table_info({table_name})"))
        existing = {row[1] for row in result.fetchall()}
        for column_name, column_sql in columns.items():
            if column_name not in existing:
                await conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_sql}"))

    await add_missing_columns(
        "projects",
        {"uuid": "uuid VARCHAR(36)"},
    )
    await add_missing_columns(
        "todos",
        {
            "uuid": "uuid VARCHAR(36)",
            "project_id": "project_id INTEGER",
            "recurrence_rule_id": "recurrence_rule_id INTEGER",
            "recurrence_date": "recurrence_date DATE",
            "is_recurrence_exception": "is_recurrence_exception BOOLEAN DEFAULT 0",
        },
    )
    await add_missing_columns(
        "schedules",
        {
            "uuid": "uuid VARCHAR(36)",
            "project_id": "project_id INTEGER",
            "recurrence_rule_id": "recurrence_rule_id INTEGER",
            "recurrence_date": "recurrence_date DATE",
            "is_recurrence_exception": "is_recurrence_exception BOOLEAN DEFAULT 0",
        },
    )
    await add_missing_columns(
        "recurrence_rules",
        {"uuid": "uuid VARCHAR(36)"},
    )
    await add_missing_columns(
        "timer_sessions",
        {
            "uuid": "uuid VARCHAR(36)",
            "name": "name VARCHAR(200) DEFAULT ''",
            "status": "status VARCHAR(20) DEFAULT 'running'",
            "project_id": "project_id INTEGER",
            "linked_todo_id": "linked_todo_id INTEGER",
            "started_at": "started_at DATETIME",
            "last_resumed_at": "last_resumed_at DATETIME",
            "paused_at": "paused_at DATETIME",
            "paused_seconds": "paused_seconds INTEGER DEFAULT 0",
            "ended_at": "ended_at DATETIME",
            "created_schedule_id": "created_schedule_id INTEGER",
            "notes": "notes TEXT DEFAULT ''",
            "created_at": "created_at DATETIME",
            "updated_at": "updated_at DATETIME",
        },
    )
    await add_missing_columns("daily_logs", {"uuid": "uuid VARCHAR(36)"})
    await add_missing_columns("log_templates", {"uuid": "uuid VARCHAR(36)"})
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



    uuid_tables = (
        "projects",
        "todos",
        "schedules",
        "daily_logs",
        "log_templates",
        "timer_sessions",
        "recurrence_rules",
    )
    for table_name in uuid_tables:
        result = await conn.execute(text(f"SELECT id FROM {table_name} WHERE uuid IS NULL OR uuid = ''"))
        for row in result.fetchall():
            await conn.execute(
                text(f"UPDATE {table_name} SET uuid = :uuid WHERE id = :id"),
                {"uuid": str(uuid.uuid4()), "id": row[0]},
            )
        await conn.execute(
            text(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_{table_name}_uuid ON {table_name}(uuid)")
        )

@asynccontextmanager
async def lifespan(app: FastAPI):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await ensure_sqlite_schema_compat(conn)
    yield
    await async_engine.dispose()


app = FastAPI(
    title="日迹 API",
    description="个人效率助手 - 待办 & 日程 & 项目 & AI 分析",
    version="0.7.5",
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
app.include_router(timer.router)
app.include_router(projects.router)
app.include_router(recurrence.router)
app.include_router(logs.router)
app.include_router(data_portability.router)
app.include_router(zju.router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


frontend_dir = os.environ.get("RIJI_FRONTEND_DIR")
if frontend_dir and (Path(frontend_dir) / "index.html").is_file():
    app.mount("/", SPAStaticFiles(directory=frontend_dir, html=True), name="frontend")
