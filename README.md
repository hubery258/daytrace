# 日迹

日迹是一个个人效率工具，核心不是“把待办列出来”，而是帮助用户把一天里的计划、执行和复盘连起来。

目前它适合单人本地使用：先规划日程和待办，过程中关注当前最重要的任务，晚上在今日总结里回看完成情况、记录日志，并可用自己的 OpenAI-compatible API Key 生成效率分析和明日建议。

## MVP 范围

- 待办：支持 DDL 类型、提醒天数、分类、关注状态、等待答复状态和备注。
- 日程：支持规划日程和实际记录，共用一条 0-24 点时间轴做左右对照。
- 首页：显示当前日程、等待答复、关注中任务、临近 DDL。
- 今日总结：保存完成待办和日志，并支持 AI 分析。
- 设置：本地保存 API Key、API 地址、模型名和提示词。

暂不进入 MVP 的内容包括：登录同步、手机端/桌面端、ZJU 脚本平台、课程表爬虫、循环任务、复杂子任务、AI 直接修改日程。

## 数据与隐私

- 默认使用 SQLite，本地单机即可运行。
- API Key 仅保存在浏览器 `localStorage`，不会上传到后端。
- MVP 阶段没有登录和多设备同步。

## 环境要求

- Python 3.11+
- Node.js 20+
- 可选：Docker + Docker Compose

## 本地开发运行

### 1. 启动后端

```bash
cd backend

# 首次运行时创建虚拟环境
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

后端地址：`http://localhost:8000`

API 文档：`http://localhost:8000/docs`

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端地址：`http://localhost:5173`

如果 Windows PowerShell 禁止执行 `npm.ps1`，可以改用：

```bash
npm.cmd run dev
```

## Docker Compose 运行

```bash
docker compose up -d
```

默认 compose 偏长期自用模式：

- 前端：`http://localhost:3000`
- 后端：`http://localhost:8000`
- SQLite 数据：`${TASK_DATA_DIR:-./data}/task_app.db`

可以在项目根目录创建本地 `.env` 指定长期使用的数据目录，例如：

```env
TASK_DATA_DIR=D:/cs/task/data
```

这样即使重建镜像或升级版本，只要 `.env` 仍指向同一个目录，Docker 后端都会继续使用同一份 SQLite 数据库。

停止服务：

```bash
docker compose down
```

不要在保留本地数据时使用：

```bash
docker compose down -v
```

如果需要开发模式（前端 Vite 热更新、后端 `--reload`），使用：

```bash
docker compose -f docker-compose.dev.yml up -d
```

开发模式前端地址：`http://localhost:5173`

## 常用检查

前端生产构建：

```bash
cd frontend
npm.cmd run build
```

后端语法检查：

```bash
cd backend
python -m compileall app
```
