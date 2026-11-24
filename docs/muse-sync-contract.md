# MUSE Agent & iCloud 双向同步复用规范

> 本文档固化自既有生产验证的 **MUSE Reminders Routing v1.0** 与 **CardDAV 客户跟进合约**，作为 `insurance-crm` 双向同步引擎（`packages/shared/src/muse-sync-rules.ts`）的权威工程契约。

---

## 1. Apple Reminders 列表规划与路由规则（复用 MUSE v1.0）

### 1.1 四大标准列表（命名格式：`中文 + 空格 + 英文`）

| 列表显示名称 | 英文键 | 定位与职责 | 默认状态 |
| :--- | :--- | :--- | :--- |
| **`收集箱 Inbox`** | `inbox` | 语意模糊、跨领域或待分类的全局兜底列表 | 系统默认列表 |
| **`工作待办 Work`** | `work` | 客户拜访、保单检视、平台会邀约、方案沟通、回访及跨 Agent 协作 | **CRM 跟进默认目标** |
| **`个人生活 Personal`** | `personal` | 家庭事务、个人健康、账单、出行安排 | 个人私域 |
| **`日常采购 Shopping`** | `shopping` | 日用消费品补货、超市采购清单 | 购物清单 |

### 1.2 四级路由判定顺序

1. **显式指定优先**：若指令中明确指明目标列表（如“放到工作待办”“记入采购清单”），强制路由至该列表。
2. **业务与生活实体匹配**：
   - 包含 `客户 / 保单 / 拜访 / 方案 / 合同 / 签约 / 回访 / 投保 / 理赔 / 平台会 / 保单检视` → `工作待办 Work`。
   - 包含 `买 / 采购 / 补货 / 囤` 且宾语为日常消费品 → `日常采购 Shopping`。
   - 包含 `家庭 / 父母 / 孩子 / 就医 / 体检 / 水电 / 机票 / 酒店` → `个人生活 Personal`。
3. **上下文继承（CRM 场景默认）**：CRM 创建的客户跟进事项（`followups`）无论文案是否含关键词，**默认路由至 `工作待办 Work`**。
4. **泛化兜底**：无法归类的独立提醒写入 `收集箱 Inbox`，并在备注中附加 `[待分类]`。

### 1.3 Reminders 字段写入规范

- **Title**：动宾结构、简洁明确（如 `回访周明芳：确认养老补充方案`）。
- **Due Date**：精确 ISO 8601 时间（如 `2026-11-25T15:00:00+08:00`），仅指定日期时保留日期，未指定留空。
- **Priority**：普通为 `None`（0），含紧急/重要语义设为 `High`（1）。
- **Notes**：包含可追溯来源与上下文摘要（例如 `来源: CRM 双向同步 (Work)\n客户编号: G0104-DEMO`）。

---

## 2. iCloud Contacts（CardDAV）同步规则

1. **原生分组原则**：必须通过 iCloud CardDAV 原生分组工具（`contacts_groups_list` / `contacts_groups_add_members` / `contacts_create_in_groups`）维护分组（如“重点经营客户”“已参加平台会”）；**严禁**使用联系人备注、姓名前缀或特殊标签模拟分组。
2. **唯一身份与 ETag 乐观锁**：
   - 修改前必须重读最新状态并携带 `expected_etag`。
   - 遇到 `CONFLICT`（ETag 不匹配）或搜索结果截断/重名时，**立即中止自动覆盖**，转入三方比对（3-Way Diff）。
3. **幂等跟进标记（保留个人手写备注）**：
   - 沿用 `[#FUP:<id>] YYYY-MM-DD | <kind> | <status>` 标记块格式。
   - 写入前先解析原备注，仅新增或原地更新对应 `id` 行；**绝不清空或覆盖用户在标记块外手写的私人备注**。

---

## 3. 三方比对（3-Way Diff）与隐私隔离墙

### 3.1 `BASE` vs `CRM` vs `iPhone/iCloud`

- `external_links.last_synced_payload` 与 `followups.last_synced_payload` 保存上次对齐成功时的 `BASE` 快照。
- **仅 CRM 变更**：携带 `expected_etag` 推向 iCloud 并刷新 `BASE`。
- **仅 iPhone 变更**：拉取更新至 CRM、写 `audit_logs`、刷新 `BASE`（如改了手机号/地址，顺手生成一条待审核的科技个险回写草稿）。
- **双方同时修改同一字段**：写入 `sync_conflicts` 表，等待操作台 1-Click 仲裁（保留 CRM / 采用 iPhone）。
- **删除保护（Soft Unlink）**：iPhone 端删除卡片或提醒时，**绝不硬删除 CRM 客户主档**，仅将同步状态置为 `unlinked` 并提示确认。

### 3.2 严格隐私隔离墙（Privacy Fence）

| 允许进入 iCloud Contacts | **严禁进入 iCloud Contacts / Reminders** |
| :--- | :--- |
| 姓名、手机号数组、出生日期（`YYYY-MM-DD` / `--MM-DD`）、地址、公司/职业、原生联系人分组、受控 `[#FUP:...]` 摘要行 | 身份证号明文/密文、保单号与保单明细、保费与资产指数、健康/核保情况、`rapport_tag`（人工性格/体感标签） |
