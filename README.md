# Insurance Advisor CRM (`insurance-crm`)

> **所属体系**：[保险规划师自主工作系统 (`insurance-autonomous-work-system`)](https://github.com/gehbfarr5/insurance-autonomous-work-system) —— **领域 A（客户经营）** 个人自建客户库与多端外呼中枢。  
> **当前版本**：`v1.0.0`（详见 [CHANGELOG.md](./CHANGELOG.md)）

兼容**多端（Mac / Windows / iPhone）**、**多 AI Agent（Streamable HTTP MCP）**、**iPhone 原生通讯录 & 提醒事项双向同步（复用 MUSE 路由规范）**，以及**太保科技个险单账号核验与回写优先流水线**的自建保险客户管理中枢。

> **公开仓库安全边界**：本仓库**绝不包含**任何真实客户姓名、手机号、身份证号、保单明细、Apple ID、Tailscale 真实域名、私钥或本地生产数据库快照。所有内置演示数据与测试用例均采用 100% 虚构样本。

---

## 核心能力（v1.0.0）

1. **一库居中 + 11 张 PostgreSQL 16 表**
   - 完整承接历史客户去重汇总字段与保单资产快照；身份证采用应用层 `AES-256-GCM` 加密 + `HMAC-SHA256` 摘要查重，鉴权后面向顾问与 MCP 工具提供受控明文读取。
   - 严格区分**人工体感观察（`rapport_tag`）**、**科技个险指标快照**与**仅追加沟通时间轴（`interactions`）**；客户与沟通记录均支持软删除/可审计删除。
2. **筛客外呼工作台 + 无确认 5 秒 Undo 交互**
   - 主界面聚焦 **「筛客外呼」** 与 **「同步与回写」** 两个高频视图，支持性别、年龄、保费、地址、外呼防重呼多维筛选与排序。
   - 桌面端采用紧凑数据表与右侧详情抽屉；移动端（`< 768px`）切换为大触控卡片列表与底部抽屉（`bottom-sheet`）。
   - 支持 `tel:` 一键直拨与挂断返回速记提示、一键复制完整 MUSE 信息卡；所有快捷外呼标记及客户/沟通记录删除均采用**底部居中 Top-Layer 5 秒「撤销」Toast**，不弹窗二次打断。
3. **复用既有 MUSE Agent 同步规范**（详见 [docs/muse-sync-contract.md](./docs/muse-sync-contract.md)）
   - **Reminders 路由 v1.0**：支持 `收集箱 Inbox` / `工作待办 Work` / `个人生活 Personal` / `日常采购 Shopping` 四类列表自动路由（CRM 跟进默认写入 `工作待办 Work`）。
   - **CardDAV 原生分组 & 幂等备注**：强制使用 iCloud 原生分组与 `[#FUP:<id>] YYYY-MM-DD | <kind> | <status>` 标记块，保留用户手写备注不被覆盖。
   - **3-Way Diff 防覆盖 + 隐私隔离墙**：基于 `BASE` 快照与 `expected_etag` 做三方比对，并发修改写入冲突队列人工仲裁；严禁将身份证、保费、保单明细写入 iCloud。
4. **科技个险单账号核验与回写优先队列（Writeback-First）**
   - 顶部状态胶囊支持实时查看科技个险连接状态并在需要时完成图形/短信验证码登录核验。
   - 修改资料或登记拜访后生成 `field_diff` 预览；人工批准后由串行执行器认领，内置 **L0 OTA Bundle Hash 熔断门禁**与**写后强制回读核验**。
5. **多 Agent Streamable HTTP MCP（`/crm-mcp`）**
   - 按每个 Agent 独立 Bearer Access Key 识别身份并记录 `audit_logs`，暴露 16 个高阶业务工具，写入强制校验 `expected_version` 乐观锁。

---

## 目录结构

```text
insurance-crm/
├── packages/
│   ├── shared/          # Zod Schema、MUSE 同步/路由引擎、3-Way Diff、去重与校验工具
│   ├── server/          # Fastify 5 API、16 工具 MCP、Drizzle PG16 Schema、iCloud/KJGX 服务
│   └── web/             # React 19 + Vite + Tailwind CSS PWA（桌面 + iPhone 自适应）
├── docker/              # 首尔云主机双容器部署（crm-postgres + crm-app）
├── scripts/             # 历史客户 Excel 迁移脚本 & PostgreSQL 加密备份脚本
├── docs/                # 架构与 Schema 规范、MUSE 同步复用契约
└── CHANGELOG.md         # SemVer 版本变更记录
```

---

## 本地零依赖快速启动（内存演示模式）

无需安装本地 PostgreSQL 即可使用虚构演示数据完整体验全栈交互：

```bash
pnpm install
pnpm test    # 39 项单元测试（13 shared + 26 server）
pnpm build

# 终端 1：启动后端 API + 16 工具 MCP（内存演示库，免登录鉴权）
pnpm dev:server

# 终端 2：启动 React 前端（自动代理 /api 与 /crm-mcp）
pnpm dev:web
```

浏览器打开 `http://localhost:5173` 即可体验；也可直接请求 `http://localhost:3100/crm-mcp` 调用 MCP `tools/list`。

---

## 版本管理与发布流程

1. 遵循 SemVer（`MAJOR.MINOR.PATCH`），同步更新根目录 `package.json` 的 `version` 与 `CHANGELOG.md`。
2. 提交并打 Annotated Tag 推送到 GitHub：
   ```bash
   git tag -a vX.Y.Z -m "release: vX.Y.Z"
   git push origin main --tags
   ```
3. 生产部署（首尔 Docker 双容器）：
   ```bash
   docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml --env-file .env up -d --build --no-deps crm-app
   ```
