# Insurance Advisor CRM (`insurance-crm`)

兼容**多端（Mac / Windows / iPhone PWA）**、**多 AI Agent（Streamable HTTP MCP）**、**iPhone 原生通讯录 & 提醒事项双向同步（复用 MUSE 路由规范）**，以及**太保科技个险回写优先流水线**的自建保险客户管理中枢。

> **公开仓库安全边界**：本仓库**绝不包含**任何真实客户姓名、手机号、身份证号、保单明细、Apple ID、Tailscale 真实域名、私钥或本地生产数据库快照。所有内置演示数据与测试用例均采用 100% 虚构样本。

---

## 核心能力（M1 基线）

1. **一库居中 + 11 张 PostgreSQL 16 表**
   - 完整承接旧版去重汇总 42 字段与财富 30 资产字段；身份证采用应用层 `AES-256-GCM` 加密 + `HMAC-SHA256` 摘要查重。
   - 严格区分**人工体感观察（`rapport_tag`）**、**科技个险指标快照**与**仅追加沟通时间轴（`interactions`）**。
2. **复用既有 MUSE Agent 同步规范**（详见 [docs/muse-sync-contract.md](./docs/muse-sync-contract.md)）
   - **Reminders 路由 v1.0**：支持 `收集箱 Inbox` / `工作待办 Work` / `个人生活 Personal` / `日常采购 Shopping` 四类列表自动路由（CRM 跟进默认写入 `工作待办 Work`）。
   - **CardDAV 原生分组 & 幂等备注**：强制使用 iCloud 原生分组与 `[#FUP:<id>] YYYY-MM-DD | <kind> | <status>` 标记块，保留用户手写备注不被覆盖。
   - **3-Way Diff 防覆盖 + 隐私隔离墙**：基于 `BASE` 快照与 `expected_etag` 做三方比对，并发修改写入冲突队列人工仲裁；严禁将身份证、保费、保单明细写入 iCloud。
3. **科技个险回写优先队列（Writeback-First）**
   - 多端或 Agent 修改资料/登记拜访后生成 `field_diff` 预览；人工批准后由串行执行器认领。
   - 内置 **L0 OTA Bundle Hash 熔断门禁**（不匹配即标 `blocked_ota`）与**写后强制回读核验**（`readback_matched === true` 才算成功，`max_attempts = 1` 失败闭锁）。
4. **多 Agent Streamable HTTP MCP（`/crm-mcp`）**
   - 按每个 Agent 独立 Bearer Access Key 识别身份并记录 `audit_logs`，暴露 16 个高阶业务工具，写入强制校验 `expected_version` 乐观锁。
5. **多设备 Web / PWA（React 19 + Vite + Tailwind CSS）**
   - 5 个高频页面：**今日工作台**、**客户与筛客（两轮筛查）**、**客户 360° 档案**、**同步中心（科技个险回写 + iPhone 冲突仲裁）**、**导入草稿箱**，支持桌面表格与 390px 手机卡片自适应切换。

---

## 目录结构

```text
insurance-crm/
├── packages/
│   ├── shared/          # Zod Schema、MUSE 同步/路由引擎、3-Way Diff、去重与校验工具
│   ├── server/          # Fastify 5 API、16 工具 MCP、Drizzle PG16 Schema、iCloud/KJGX 服务
│   └── web/             # React 19 + Vite + Tailwind CSS PWA（桌面 + iPhone 自适应）
├── docker/              # 首尔云主机双容器部署（crm-postgres + crm-app）
├── scripts/             # 历史 812 客户 Excel 迁移脚本 & PostgreSQL 加密备份脚本
└── docs/                # 架构与 Schema 规范、MUSE 同步复用契约
```

---

## 本地零依赖快速启动（内存演示模式）

无需安装本地 PostgreSQL 即可使用虚构演示数据完整体验全栈交互：

```bash
pnpm install
pnpm test
pnpm build

# 终端 1：启动后端 API + 16 工具 MCP（内存演示库，免登录鉴权）
pnpm dev:server

# 终端 2：启动 React PWA 前端（自动代理 /api 与 /crm-mcp）
pnpm dev:web
```

浏览器打开 `http://localhost:5173`，即可体验全部 5 个视图；也可直接请求 `http://localhost:3100/crm-mcp` 调用 MCP `tools/list`。

---

## 生产部署（首尔 Docker 双容器）

1. 复制 `.env.example` 为 `.env`，生成真实 32-byte 加密密钥并配置各 Agent 独立 Access Key 与 `ICLOUD_*` 凭据。
2. 启动容器：
   ```bash
   docker compose -f docker/docker-compose.yml --env-file .env up -d --build
   ```
3. 通过迁移脚本做历史客户干跑校验（仅输出脱敏统计摘要）与正式导入：
   ```bash
   node scripts/migrate-legacy-xlsx.mjs --input /path/to/summary.xlsx --dry-run
   ```
4. 配置每日加密备份定时任务调用 `scripts/backup-pg-encrypted.sh`。
