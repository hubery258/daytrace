# 日迹

日迹是一个本地优先的个人效率工具，核心不是把待办简单列出来，而是帮助用户把一天里的计划、执行、实际记录和复盘统计连起来。

当前版本号：**v0.11.0**。v0.10.x 系列已完成实际记录时间块化、时间统计和时间块体验打磨；v0.11.0 增加手动 WebDAV 同步（配置、测试连接、手动上传、手动下载）；v0.8 的 Android 本地单机功能已完成代码与自动化验证，实体机矩阵和签名 release 仍是 v1.0.0 前的发布门槛。

## 当前范围

- 待办：支持 DDL 类型、提醒天数、分类、关注状态、等待答复、备注和重复规则。
- 项目：可以把待办和计划日程归入同一个项目，用于承载更大的任务或目标。
- 计划日程：用于安排未来时间，保留开始/结束时间、性质、关联待办、项目、地点和备注。
- 实际时间块：用于记录已经发生的时间，支持 15/30 分钟粒度、属性与颜色、备注、关联待办或项目。
- 计时：计时结束后按时间块覆盖规则折算为实际记录，并允许在时间块界面手动修正。
- 首页：显示当前计划日程、等待答复、关注中任务、项目和临近 DDL。
- 每日日志：保存完成待办和文字日志，支持日志模板。
- 统计：按属性、待办和项目汇总实际时间块，支持单日、自然周、自然年、自定义范围和已记录时长口径。
- AI：使用用户自己的 OpenAI-compatible API Key 生成待办/计划日程草稿；草稿必须经用户确认后才写入。
- ZJU 集成：只读导入学习任务、Pintia、本科课表和成绩/学分概览。
- 数据迁移：JSON 导出、预览、合并导入和完整恢复；新版数据包为 `schema_version: 0.10.0`，旧 `0.6.0` 包仍可导入并跳过旧实际日程。
- 多端：Web、Windows Electron、Android Capacitor 本地单机版；三端通过 JSON 手动迁移数据，不做实时同步。
- WebDAV 手动同步：使用用户自己的 WebDAV 服务器保存和获取 daytrace-latest.json，支持测试连接、上传预检与确认、下载后走现有导入预览；v0.11.0 不做自动同步、自动合并和时间戳远端备份。

## 数据与隐私

- 默认使用本地 SQLite，本地单机即可运行。
- AI API Key 仅保存在当前设备；Web 使用浏览器本地存储，Android 使用系统安全存储能力。
- 后端不接收用户的 AI API Key。
- JSON 导出覆盖核心个人数据，不包含 AI API Key、ZJU 密码、Pintia Cookie、Session 或 token。
- WebDAV 密码不写入数据包、日志或错误信息：Windows 使用 Electron safeStorage，Android 使用 Android Keystore，Web 默认不记住密码，勾选后用浏览器本地加密存储并提示风险。
- 旧版本 `is_planned=false` 的实际日程不会自动转为时间块；升级时建议先导出备份，再使用 `scripts/clean-v010-legacy-json.py` 清洗旧包后导入。

## 环境要求

- Python 3.11+
- Node.js 20+；构建 Capacitor 8 Android 工程建议 Node.js 22+
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

## 体验版构建

Windows 桌面 portable：

```powershell
.\scripts\build-desktop.ps1
```

Android debug APK，需要 JDK 21、Android SDK Platform 36 和 `ANDROID_HOME`：

```powershell
.\scripts\build-android.ps1 -AndroidSdk "C:\path\to\Android\Sdk" -JavaHome "C:\path\to\jdk-21"
```

构建产物不会提交到 Git。详细的数据目录、导入规则、已知限制和镜像参数见 `docs/build-packaging-guide.md`。

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

## 当前边界

- v1.0.0 前不做账号、多端实时同步和自动云备份。
- v1.0.0 前不做系统级提醒和通知。
- 不做通用脚本市场、自动签到、刷课、自动答题或自动提交。
- AI 不越过用户确认直接创建或修改数据。
- 复杂子任务、多层级项目、看板、甘特图和复杂 RRULE 不进入 v1.0 范围。

## 常用检查

前端生产构建：

```bash
cd frontend
npm.cmd run build
```

前端测试：

```bash
cd frontend
npm.cmd test
```

后端测试：

```bash
cd backend
python -m unittest discover -s tests
```

后端语法检查：

```bash
cd backend
python -m compileall app
```