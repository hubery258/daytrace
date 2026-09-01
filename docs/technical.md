# 日迹技术文档

## 架构概览

日迹当前采用前后端分离架构：

- 前端：React + Vite。
- 后端：FastAPI + SQLAlchemy。
- 数据库：SQLite。
- Web / Docker 部署：Docker Compose，可运行前端 Nginx 静态服务和后端 FastAPI 服务。
- 桌面端体验版：Electron + FastAPI sidecar + SQLite。
- Android v0.8：Capacitor + WebView + 设备内 SQLite + 最小原生安全存储/HTTP 插件。

MVP 以本地单机可持续使用为目标。v1.0.0 前不引入账号体系和多端同步；后续如果进入多设备同步，再评估账号系统、远端数据库、同步协议和冲突处理策略。

### v0.8 Android 数据与安全边界

- `frontend/src/api/capabilities.js` 定义 65 条能力契约；`clientCore.js` 绑定 Web/FastAPI 与 Android/SQLite 双适配器。
- Android 数据层按 projects/todos/schedules/recurrence/support/portability/zju 拆分，未知路径返回显式 501，正常功能不得空成功。
- 移动数据库采用有版本迁移；重复实例使用 `rule_uuid + entity_type + recurrence_date` claim 保证幂等，同时保留历史重复行不做破坏性迁移。
- ZJU password、Pintia Cookie 与 AI Key 使用 AndroidKeyStore 支持的加密存储；Capacitor 日志关闭，Cookie 只在原生内存会话中存在。
- JSON 备份不包含凭据、AI Key、ZJU 缓存、导入映射或计时 claim；replace/merge 在事务中执行，replace 前先生成并读回校验本机安全备份。
- Android Manifest 同时禁用旧版备份并为 Android 12+ 配置 data extraction 排除规则；FileProvider 仅共享应用缓存。
- 原生网络只允许 HTTPS，不覆盖系统证书与 hostname 校验，不允许 HTTPS 降级到 HTTP。

## 前端

位置：`frontend/`

主要技术：

- React 18。
- React Router。
- Vite。
- 手写 CSS。

主要页面：

- `HomePage.jsx`：首页，展示当前日程、等待答复、关注任务、项目和临近 DDL。
- `SchedulePage.jsx`：日程页，展示计划日程和实际记录的共轴对照。
- `TodoSummaryPage.jsx`：待办汇总页。
- `ProjectListPage.jsx` / `ProjectDetailPage.jsx`：项目列表和项目详情。
- `TimerPage.jsx`：计时页，结束计时后生成实际记录。
- `DailySummaryPage.jsx`：今日总结和 AI 分析。
- `SettingsPage.jsx`：AI 配置；v0.7 起承载页面/模块开关。
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

- `projects`：项目。
- `todos`：待办。
- `schedules`：计划日程和实际记录。
- `daily_logs`：每日总结。
- `log_templates`：日志模板。
- `timer_sessions`：计时会话。
- `recurrence_rules`：重复任务和重复日程规则。

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
- AI 输出效率分析、复盘建议和待办/日程草稿。
- AI 草稿必须经用户确认后才写入待办或日程。
- AI 不生成项目草稿，不越过用户确认直接修改数据库。

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


## 桌面端与 Android 体验版

v0.6.x 已完成多端体验版验证：

- Windows 桌面端采用 Electron 启动前端窗口，并拉起本地 FastAPI sidecar。
- 桌面端 sidecar 使用随机回环端口，前端与 API 同源；Electron 退出时结束 sidecar。
- 桌面端 SQLite 数据位于 Electron `userData` 目录下的 `data/riji.db`。
- Android 端采用 Capacitor + WebView，使用本地 SQLite 数据层，不在 Android 中长期运行 Python/FastAPI。
- Android 与桌面端目前使用独立本地数据，通过 JSON 手动迁移，不做实时同步。

v0.7.x 已在不改变多端基础架构的前提下，完成 React 全站视觉统一、品牌资产接入和基于 `localStorage` 的页面/模块展示配置。

## 数据导入导出

v0.6.x 已支持基础 JSON 导入导出，用于手动迁移和未来同步模型验证：

- 导出核心个人数据：项目、待办、日程、每日总结、日志模板、计时会话和重复规则。
- 导入前展示预览，校验 `app: riji`；当前导出 `schema_version: 0.8.0`，兼容导入 `0.6.0`。
- 导入采用按 UUID 合并的原子流程；相同 UUID 以导入包为准，未出现在包中的本地数据保留。
- 日程关联待办、项目归属、完成待办等关系在 JSON 中使用 UUID，写入本机数据库时再映射为本地整数 ID。
- AI API Key、ZJU 密码、Pintia Cookie、session、token 和 ZJU 缓存默认不导出。

v0.8.x 应在此基础上升级为正式级备份、恢复、兼容检查和恢复指引；v1.1.x 再考虑账号同步、冲突解决和后台同步队列。

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
- JSON 导入导出已经能验证基础迁移，但 v0.8 仍需要补正式备份、恢复失败处理和升级兼容检查。
- 页面/模块开关是本地展示配置，不影响底层数据，也不承担权限隔离职责；隐藏路由仍可通过直接地址访问。
- ZJU client 较集中，后续可以按 Courses、ZDBK、成绩、课表拆分。
