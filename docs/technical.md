# 日迹技术文档

## 架构概览

日迹当前采用前后端分离架构：

- 前端：React + Vite。
- 后端：FastAPI + SQLAlchemy。
- 数据库：SQLite。
- 部署：Docker Compose，可运行前端 Nginx 静态服务和后端 FastAPI 服务。

MVP 以本地单机可持续使用为目标，后续如果进入多设备同步，再评估账号系统、远端数据库和同步策略。

## 前端

位置：`frontend/`

主要技术：

- React 18。
- React Router。
- Vite。
- 手写 CSS。

主要页面：

- `HomePage.jsx`：首页，展示当前日程、等待答复、关注任务和临近 DDL。
- `SchedulePage.jsx`：日程页，展示计划日程和实际记录的共轴对照。
- `TodoSummaryPage.jsx`：待办汇总页。
- `DailySummaryPage.jsx`：今日总结和 AI 分析。
- `SettingsPage.jsx`：AI 配置。
- `ZjuPage.jsx`：ZJU 集成。

## 后端

位置：`backend/`

主要技术：

- FastAPI。
- SQLAlchemy async。
- Pydantic。
- SQLite。

主要模块：

- `app/main.py`：FastAPI 入口、CORS、数据库初始化。
- `app/models.py`：数据库模型。
- `app/schemas.py`：API 数据契约。
- `app/crud.py`：通用 CRUD。
- `app/routers/todos.py`：待办接口。
- `app/routers/schedules.py`：日程接口。
- `app/routers/logs.py`：日志和模板接口。
- `app/routers/zju.py`：ZJU 集成接口。
- `app/zju_client.py`：ZJU 外部系统访问和数据标准化。

## 数据模型

核心表：

- `todos`：待办。
- `schedules`：计划日程和实际记录。
- `daily_logs`：每日总结。
- `log_templates`：日志模板。

ZJU 相关表：

- `zju_credentials`：本地保存的 ZJU 凭据状态。
- `zju_calendar_caches`：校历缓存。
- `zju_grade_snapshots`：成绩快照缓存。
- `import_batches`：导入批次。
- `external_items`：外部数据和本地实体的映射。

## AI 集成

AI 分析目前由前端直接调用 OpenAI-compatible Chat Completions API：

- API Key 存在浏览器 `localStorage`。
- API Base、模型名和 Prompt 由设置页维护。
- 后端不接收用户的 AI Key。

当前约定：

- AI 只读取用户提供的待办、日程和日志上下文。
- AI 输出效率分析和建议。
- AI 不直接写入待办或日程。

## ZJU 集成

ZJU 集成通过后端访问外部系统，并将外部数据标准化后返回前端预览或写入本地数据库。

当前能力：

- 学在浙大学习任务读取。
- Pintia 任务读取。
- 本科课表读取、展开和导入日程。
- 本科成绩读取、GPA/学分计算和本地缓存。

安全边界：

- 不输出密码、Cookie、session、token。
- 不提供自动签到、刷课、自动答题、自动提交等能力。
- 不做任意脚本运行入口。

## 部署与运行

本地开发：

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

```bash
cd frontend
npm install
npm run dev
```

Docker 长期自用模式：

```bash
docker compose up -d
```

开发模式：

```bash
docker compose -f docker-compose.dev.yml up -d
```

## 常用检查

前端构建：

```bash
cd frontend
npm.cmd run build
```

后端语法检查：

```bash
cd backend
python -m compileall app
```

## 已知技术债

- 后端 `main.py` 的 OpenAPI 标题和描述存在编码乱码。
- 关注中待办最多 3 个的规则需要确认后端是否完全兜底。
- 今日总结页需要确认是否真正使用设置页保存的模型名。
- SQLite 迁移仍是轻量兼容逻辑，未来表结构继续增长时应评估正式迁移工具。
- ZJU client 较集中，后续可以按 Courses、ZDBK、成绩、课表拆分。
