# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 语义化版本规范，每次正式上线或结构性迭代均更新本文件并打 Git Annotated Tag（`vX.Y.Z`）。

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
