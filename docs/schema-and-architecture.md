# 系统架构与 PostgreSQL 16 Schema 规范

> 本文件为公开仓库脱敏架构说明，所有示例终端地址、账号与演示数据均为占位符/虚构样本，不含任何真实客户信息或生产密钥。

---

## 1. 整体架构（一库居中 · 多端访问 · 回写优先）

```text
  Mac / Windows / iPhone (PWA)            5+ AI Agents (Streamable HTTP MCP)
               │                                           │
               │ HTTPS REST (/api/v1/*)                    │ OAuth 2.1 / Bearer (/crm-mcp)
               └───────────────────┬───────────────────────┘
                                   ▼
                 ┌───────────────────────────────────┐
                 │  crm-app (Node 22 + TS + Fastify) │
                 │  • 统一领域服务 + Zod 契约         │
                 │  • 16 个多 Agent MCP 工具          │
                 │  • 3-Way iCloud 双向同步守护       │
                 │  • 科技个险回写队列与 OTA 门禁     │
                 └────────┬──────────────┬───────────┘
                          │              │
                          ▼              ▼
             crm-postgres (PG16)    同机 apple-icloud-mcp
             11 张业务与治理表       (Contacts & Reminders)
                          ▲
                          │ 串行 Poll / 回执校验 (L0 Hash 门禁 + 强制回读)
             ┌────────────┴───────────────────────────┐
             │  科技个险执行器 (Pixel 3a / 云端 Android) │
             └────────────────────────────────────────┘
```

---

## 2. 11 张 PostgreSQL 16 核心表职责总览

完整建表 DDL 见 [0000_initial_schema.sql](../packages/server/drizzle/0000_initial_schema.sql)，Drizzle 映射见 [schema.ts](../packages/server/src/db/schema.ts)。

1. **`customers`**：客户主档、身份证应用层 AES-256-GCM 密文 + HMAC-SHA256 去重摘要、科技个险只读指标快照、财富 30 资产字段、人工体感标签（不做算法打分）、字段级溯源（`field_provenance`）与乐观锁（`version`）。
2. **`policies`**：客户名下保单明细、孤儿单标记与人工保障缺口笔记。
3. **`campaigns`**：平台会 / 主管名单活动批次。
4. **`interactions`**：仅追加（Append-only）的沟通时间轴，永不覆盖历史，也不覆盖主档资料。
5. **`followups`**：下一步跟进任务，双向绑定 Apple Reminders（默认路由至 `工作待办 Work`）。
6. **`campaign_members`**：平台会两轮筛查漏斗状态机（`imported -> screened_in -> invited -> attended -> round2_qualified / nurture / closed`）。
7. **`external_links`**：CRM 与 iCloud Contacts / 科技个险 / 历史系统的映射桥，保存 `remote_etag` 与 `last_synced_payload`（三方比对 `BASE`）。
8. **`kjgx_writeback_jobs`**：科技个险回写任务队列（第一优先级），含 `field_diff`、人审状态、`L0 OTA Hash` 门禁、`max_attempts = 1` 失败闭锁及结构化回执（`route_result`, `edit_page_seen`, `customer_name_seen`, `readback_matched`）。
9. **`sync_conflicts`**：iCloud / 科技个险双向同步冲突仲裁队列表。
10. **`import_staging`**：Excel/WPS、家庭卡 OCR 与 Agent 语音抽取草稿暂存箱，确认去重后才落正式表。
11. **`audit_logs`**：记录人类端与各独立 Agent（按独立 Access Key 识别）的操作前后状态审计日志。

---

## 3. 16 个多 Agent MCP 工具（`POST /crm-mcp`）

- **只读检索（7 项）**：`crm_search_customers`、`crm_get_customer_360`、`crm_list_campaigns`、`crm_filter_candidates`、`crm_list_followups`、`crm_list_conflicts`、`crm_kjgx_job_status`
- **受控写入（6 项）**：`crm_create_customer`、`crm_update_customer`（强制 `expected_version`）、`crm_log_interaction`、`crm_upsert_followup`、`crm_update_campaign_member`、`crm_stage_import_draft`
- **同步与回写（3 项）**：`crm_sync_icloud_preview`、`crm_sync_icloud_apply`、`crm_kjgx_enqueue_writeback`
