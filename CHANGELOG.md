# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 语义化版本规范，每次正式上线或结构性迭代均更新本文件并打 Git Annotated Tag（`vX.Y.Z`）。

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
