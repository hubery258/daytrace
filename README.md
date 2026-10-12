# 日迹

日迹是一个本地优先的个人效率工具，核心不是把待办简单列出来，而是帮助用户把一天里的计划、执行、实际记录和复盘统计连起来。

当前版本号：**v0.11.3**。保留 v0.11.2 的显示名称、计划参考层和首页日程改进；v0.11.3 重新设计手动设备数据合并：完成优先、字段冲突选择、实际时间冲突区间选择、日志整理及事务写入。实体机矩阵和签名 release 仍是 v1.0.0 前的发布门槛。

v0.11.3 专项复查补齐了拆分时间块的双向版本识别、本机关联断裂检查和重复例外 UUID 优先更新；旧预览在数据包、选择、模式或本地数据变化后禁止执行。Windows portable 与 Android debug APK 已重新打包，包含全部复查修复；构建校验值见 release/build-info-0.11.3.json。

## 当前范围

v0.11.3 上传故障修复：历史计划的关联任务已被删除时，上传预检、确认上传和 JSON 导出现在返回可读的完整性错误，显示受影响计划名称，不再返回 Internal Server Error。在设置的“数据导入导出”点击“检查计划失效关联”，可直接查看所有受影响计划的名称、日期和清理范围，确认后仅清除已不存在的任务关联。操作先保存并校验修复前记录副本，预览过期或副本失败则不写入；不删除计划、不改变有效关联、正文或实际时间记录。该修复副本不含凭据，是记录追溯文件，不是可导入的整库备份。

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
- 数据迁移：JSON 与 WebDAV 下载共用预览、冲突选择和确认。新版数据包为 `schema_version: 0.10.0`，接受合法 `0.6.0` / `0.8.0` 旧包并跳过旧实际日程，保留重复规则例外。合并不传播删除或取消完成；恢复按备份还原完成状态。本机 WebDAV 凭据不进入数据包，也不被导入清空。
- 多端：Web、Windows Electron、Android Capacitor 本地单机版；三端通过 JSON 手动迁移数据，不做实时同步。
- WebDAV 手动汇总：下载并合并后上传结果，再让另一设备导入。只传输文件，不做账号、自动同步、后台队列或自动传播删除；保留 ETag 条件上传保护。

## 数据与隐私

- 默认使用本地 SQLite，本地单机即可运行。
- AI API Key 仅保存在当前设备；Web 使用浏览器本地存储，Android 使用系统安全存储能力。
- 后端不接收用户的 AI API Key。
- JSON 导出覆盖核心个人数据，不包含 AI API Key、ZJU 密码、Pintia Cookie、Session 或 token。
- WebDAV 密码不写入数据包、日志或错误信息；勾选记住时保存在当前设备 SQLite，未勾选时仅保留在当前会话。旧平台密码存储只用于一次迁移。
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
