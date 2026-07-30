# 技术文档

## 前端

- **框架**：React 18+
- **构建工具**：Vite
- **路由**：React Router v6+
- **UI 方案**：待定（可在 Ant Design / shadcn/ui / 纯手写 CSS 中选择）
- **状态管理**：MVP 阶段用 React 内置状态（useState/useContext），后期按需引入 Zustand 或 Redux
- **AI 对接**：前端直接调用用户提供的兼容 OpenAI 格式的 API（或通过后端代理以保护 API Key）

## 后端

- **框架**：Python FastAPI
  - 异步支持好，开箱即用的 OpenAPI 文档
  - 与 myblog 项目技术栈一致，降低维护成本
- **ORM**：SQLAlchemy + Alembic（数据库迁移）
- **验证**：Pydantic（FastAPI 自带）

## 数据库

- **MVP**：SQLite（零配置，单机足够）
- **后期**：如需多设备同步，迁移至 PostgreSQL

## AI 集成方案

- 用户在前端设置页面填入自己的 API Key（兼容 OpenAI 格式）
- 前端发送对话请求时，携带当日待办/日程数据作为 system prompt 的一部分
- API Key 存储在本地（MVP 单机模式），后期迁移至后端安全存储

## 部署

- **MVP**：Docker Compose（前端 Nginx 静态服务 + 后端 FastAPI + SQLite）
- **后期**：后端推至云服务器，前端分配域名，CI/CD 自动化