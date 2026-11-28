# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 语义化版本规范，每次正式上线或结构性迭代均更新本文件并打 Git Annotated Tag（`vX.Y.Z`）。

## [1.2.2] - 2026-11-28

补齐多 Agent Streamable HTTP MCP（`/crm-mcp`）协议兼容性与完整档案明文身份证读取，并依据用户确认的 v1.4 统一写入规范移除旧隐私墙约束、确立 Google 套件双线同步蓝图。

### Changed
- **Streamable HTTP MCP 完整协议兼容（`packages/server/src/routes/mcp.ts`）**：新增 `GET /crm-mcp -> 405`（附 `Allow: POST, DELETE`）、`DELETE /crm-mcp -> 204`、`ping -> {}` 与通用 `notifications/* -> 202`，确保 Antigravity（T3 Code）、MUSE 等标准 MCP 客户端稳定连接。
- **`crm_get_customer_360` 补齐受控明文 `id_no` 返回（`packages/server/src/routes/mcp.ts`）**：与 REST `GET /api/v1/customers/:id` 保持一致，经独立 Agent Bearer Key 鉴权后直接返回完整身份证号，彻底消除人工「复制完整信息卡」中转。
- **同步与写入规范对齐 v1.4 与 Google 套件双线方向（`docs/muse-sync-contract.md` / `README.md`）**：移除历史旧文档中的隐私隔离墙表述，正式固化联系人备注含身份证号（不含保单与 CRM 内部字段）、`客户` 原生分组、日历双模板与 Emoji 规范、提醒四列表路由与伴生提醒、以及 UNKNOWN 停写对账铁律。

## [1.2.1] - 2026-11-28

优化移动端客户详情抽屉顶部操作按钮排布，消除按钮孤立折行。

### Changed
- **详情抽屉移动端双排操作区（`CustomerDrawer.tsx`）**：`<768px` 移动端将「复制完整信息卡」独立置于第一排占满整行，「写入通讯录」「编辑」「删除」等距排入第二排，避免删除按钮孤立换行；同步精简按钮文案为「复制完整信息卡」（去掉括号说明）。

## [1.2.0] - 2026-11-28

确立「晴空海蓝」主题色与浅化按钮体系，修复外呼记录自然日显示偏差与时区边界，并优化桌面端列表常显快捷操作与斑马纹可读性。

### Changed
- **「晴空海蓝」主题色与全局浅化按钮体系（`index.css` / `lib/ui.ts` / 全站组件）**：引入 `light-dark(#3b6fd8, #5b8ef4)` 主色及 `--primary-soft-*` / `--btn-*` 分层 token，页面主按钮与激活控件统一使用主题色，行内 `邀约 ✓` 与次级操作按钮整体浅化降噪。
- **外呼时间自然日规范与悬停完整时间戳（`lib/format.ts` / `DeskTable.tsx`）**：重写 `relTime()` 按当地自然日零点切分显示 `今天 HH:mm`、`昨天 HH:mm`、`MM-DD HH:mm` 与跨年 `YYYY-MM-DD`，并用 `<time title>` 提供悬停完整 `YYYY-MM-DD HH:mm`。
- **时区边界修复（`CustomerDrawer.tsx` / `docker/docker-compose.yml`）**：客户详情「下次跟进」日期选择器改用本地日历与 `09:00` 本地时间往返转换，容器环境补充 `TZ=${TZ:-Asia/Shanghai}` 使服务端视图边界与本地时间一致。
- **快捷操作常显左对齐与桌面端斑马纹（`DeskTable.tsx` / `index.css`）**：取消行悬停才显露快捷操作，改为常显并左对齐且固定阶段下拉宽度对齐纵列；桌面端表格与通用 `.zebra-rows` 启用全局 CSS 斑马纹（手机端卡片保持不变）。

## [1.1.0] - 2026-11-28

对标 Twenty / Linear 现代效率工具体系，完成工作台视觉规范、克制动效体系、快捷视图与跟进时间轴升级。

### Changed
- **Design Tokens 与明暗双主题重做（`index.css` / `lib/ui.ts`）**：重构 `light-dark(...)` 双主题色板（浅灰画布 `#f8f9fa` / 深炭灰 `#111215` 搭配 `1px` 极细边框），去除多余重阴影，统一柔和浅底语义徽章（`badgeCls`）。
- **克制动效体系（`Motion.tsx` / `App.tsx` / `index.css`）**：移除高频弹簧弹跳（`spring`），统一使用 `120ms~180ms` + `cubic-bezier(0.2, 0, 0, 1)` 减速曲线，并新增 `Collapsible` 折叠过渡。
- **工作台顶部视图与折叠筛选栏（`FilterBar.tsx` / `DeskPage.tsx`）**：顶部新增「全部 / 今日待跟进 / 已逾期 / 重点跟进」快捷视图切换与实时计数角标，高级筛选条件默认折叠收纳。
- **高密度客户列表与悬停快捷操作（`DeskTable.tsx` / `DeskCardList.tsx`）**：新增「阶段 / 下次跟进」列（逾期与今日到期高亮提示），将速记与行内改阶段收敛为行悬停平滑浮现操作区。
- **Twenty 式客户详情抽屉与时间轴（`CustomerDrawer.tsx`）**：新增头部阶段/重点跟进切换与下次跟进日期选择器、支持 `Cmd/Ctrl + Enter` 的快捷写跟进框、扁平双列核心资料表，以及合并 `interactions` 与 `followups` 的倒序跟进时间轴。
- **后端工作台视图过滤（`shared/src/desk.ts` / `server/src/services/desk.ts` / `routes/api.ts`）**：`GET /api/v1/desk/customers` 新增 `view` 筛选参数并返回 `view_counts` 统计计数。

## [1.0.0] - 2026-11-27

首个完整生产版本，作为 [保险规划师自主工作系统 (`insurance-autonomous-work-system`)](https://github.com/gehbfarr5/insurance-autonomous-work-system) **领域 A（客户经营）** 的个人自建客户库与多端外呼中枢正式部署上线。

### Added
- **筛客外呼工作台（Desktop + Mobile）**：支持多维筛选（关键词、性别、年龄、总保费、居住地址、外呼防重呼状态、排序）、桌面紧凑表格与手机端卡片列表自适应切换。
- **外呼闭环与 MUSE 协同**：`tel:` 一键直拨 + `visibilitychange` 挂断返回速记弹窗；一键复制完整信息卡（含 18 位明文身份证与完整保单明细，供 MUSE 录入详细沟通）。
- **无确认弹窗 + 底部 Top-Layer Undo Toast**：统一使用原生 `popover="manual"` + 活动弹窗内动态 Portal，5 秒倒计时支持鼠标悬停与键盘聚焦暂停；所有快捷外呼、删除客户、删除沟通记录均通过底部居中「撤销」反悔。
- **软删除接口与审计**：新增 `DELETE /api/v1/customers/:id` 与 `DELETE /api/v1/interactions/:id`，保留审计日志并支持安全过滤。
- **科技个险单账号核验与回写优先队列**：顶部状态胶囊接入短信/图形验证码登录核验、L0 OTA 指纹门禁与回读核验闭环。
- **UI/无障碍精简（对标 `gemini-frontend-design` & `modern-web-guidance`）**：收拢桌面筛选栏下拉档位、统一 3 档字号（`13px`/`14px`/`16px`）、`dialog::backdrop` 防穿透滚动、`@media (pointer: coarse)` 44px 触控热区与全面屏 `viewport-fit=cover` 安全区适配。

## [0.1.0] - 2026-11-24

- 初始化 M1 基线：PostgreSQL 16 11 表 Schema、AES-256-GCM 身份证保险库、iCloud CardDAV/Reminders 3-Way Diff 双向同步、16 工具 `/crm-mcp` Streamable HTTP 接口、Docker 双容器生产架构。
