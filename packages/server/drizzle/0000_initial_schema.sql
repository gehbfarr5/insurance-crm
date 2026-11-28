-- Insurance Advisor CRM — PostgreSQL 16 Initial Schema (11 Tables)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. customers
CREATE TABLE IF NOT EXISTS customers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_group_key       TEXT UNIQUE,
  name                   TEXT NOT NULL,
  gender                 TEXT NOT NULL DEFAULT '未知' CHECK (gender IN ('男', '女', '未知')),
  birthday               DATE,
  birthday_source        TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (birthday_source IN ('handwritten_card', 'kjgx', 'icloud', 'manual', 'unknown')),
  age_override           SMALLINT CHECK (age_override IS NULL OR (age_override BETWEEN 0 AND 120)),
  primary_phone          TEXT,
  phones                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  address                TEXT,
  company_or_occupation  TEXT,
  family_members_count   SMALLINT,

  id_no_encrypted        BYTEA,
  id_no_masked           TEXT,
  id_no_hmac             TEXT,
  id_no_checksum_ok      BOOLEAN,

  kjgx_customer_no       TEXT,
  kjgx_db_customer_id    TEXT,
  kjgx_customer_level    TEXT,
  kjgx_temp_level        TEXT,
  kjgx_temp_value        NUMERIC(8,2),
  kjgx_customer_status   TEXT,
  kjgx_work_status       TEXT,
  kjgx_asset_index       NUMERIC(8,2),
  kjgx_kyc_score         NUMERIC(8,2),
  kjgx_service_num       INT,
  kjgx_visit_num         INT,
  kjgx_offline_visit_num INT,
  kjgx_metrics_synced_at TIMESTAMPTZ,

  policy_total           INT NOT NULL DEFAULT 0,
  total_premium          NUMERIC(14,2),
  premium_bucket         TEXT,
  premium_status         TEXT,
  premium_source         TEXT,
  insurer_asset_wan      NUMERIC(12,2),
  allocatable_quota_wan  NUMERIC(12,2),

  source_type            TEXT,
  rapport_tag            TEXT NOT NULL DEFAULT 'unassessed'
                           CHECK (rapport_tag IN ('friendly', 'neutral', 'cautious', 'paused', 'unassessed')),
  visit_priority         TEXT CHECK (visit_priority IS NULL OR visit_priority IN ('high', 'medium', 'low')),
  next_followup_at       TIMESTAMPTZ,
  manual_summary         TEXT,
  tags                   TEXT[] NOT NULL DEFAULT '{}'::text[],
  data_quality_flags     TEXT[] NOT NULL DEFAULT '{}'::text[],
  field_provenance       JSONB NOT NULL DEFAULT '{}'::jsonb,

  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'merged', 'archived', 'deleted')),
  merged_into_id         UUID REFERENCES customers(id),
  version                INT NOT NULL DEFAULT 1,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at             TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_active_id_hmac
  ON customers (id_no_hmac)
  WHERE id_no_hmac IS NOT NULL AND status = 'active' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_primary_phone ON customers (primary_phone);
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON customers USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_kjgx_no ON customers (kjgx_customer_no);
CREATE INDEX IF NOT EXISTS idx_customers_kjgx_db_id ON customers (kjgx_db_customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_total_premium ON customers (total_premium DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_customers_next_followup ON customers (next_followup_at) WHERE next_followup_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_tags_gin ON customers USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_customers_phones_gin ON customers USING GIN (phones);

DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. policies
CREATE TABLE IF NOT EXISTS policies (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  policy_no          TEXT NOT NULL,
  insurer            TEXT NOT NULL DEFAULT '中国太平洋人寿',
  product_name       TEXT,
  holder_role        TEXT NOT NULL DEFAULT '投保人' CHECK (holder_role IN ('投保人', '被保人', '双身份', '未知')),
  effective_date     DATE,
  annual_premium     NUMERIC(12,2),
  payment_term       TEXT,
  policy_status      TEXT,
  is_orphan_policy   BOOLEAN NOT NULL DEFAULT FALSE,
  coverage_gap_note  TEXT,
  source             TEXT NOT NULL DEFAULT 'kjgx_app',
  kjgx_raw_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
  version            INT NOT NULL DEFAULT 1,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, policy_no)
);

CREATE INDEX IF NOT EXISTS idx_policies_customer ON policies (customer_id);
DROP TRIGGER IF EXISTS trg_policies_updated_at ON policies;
CREATE TRIGGER trg_policies_updated_at
  BEFORE UPDATE ON policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  source_name TEXT,
  event_date  TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON campaigns;
CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. interactions (append-only)
CREATE TABLE IF NOT EXISTS interactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  campaign_id          UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  channel              TEXT NOT NULL CHECK (channel IN ('phone', 'platform_event', 'wechat', 'in_person_visit', 'policy_review', 'other')),
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  outcome              TEXT NOT NULL CHECK (outcome IN ('connected', 'no_answer', 'rejected', 'invited', 'attended', 'followed_up')),
  summary              TEXT NOT NULL,
  attitude_note        TEXT,
  need_signals         TEXT[] NOT NULL DEFAULT '{}'::text[],
  enqueue_kjgx_visit   BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_by_actor    TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interactions_customer_time ON interactions (customer_id, occurred_at DESC);

-- 5. followups (bidirectional with Apple Reminders)
CREATE TABLE IF NOT EXISTS followups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  interaction_id      UUID REFERENCES interactions(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  action_type         TEXT NOT NULL DEFAULT 'call' CHECK (action_type IN ('call', 'invite', 'visit', 'policy_review', 'birthday', 'other')),
  due_at              TIMESTAMPTZ,
  priority            TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  completed_at        TIMESTAMPTZ,
  notes               TEXT,

  icloud_reminder_id  TEXT UNIQUE,
  icloud_list_id      TEXT,
  icloud_etag         TEXT,
  last_synced_payload JSONB,
  sync_state          TEXT NOT NULL DEFAULT 'pending_push'
                        CHECK (sync_state IN ('in_sync', 'pending_push', 'conflict', 'unlinked')),

  version             INT NOT NULL DEFAULT 1,
  created_by_actor    TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_followups_open_due ON followups (status, due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_followups_customer ON followups (customer_id);
DROP TRIGGER IF EXISTS trg_followups_updated_at ON followups;
CREATE TRIGGER trg_followups_updated_at
  BEFORE UPDATE ON followups FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6. campaign_members
CREATE TABLE IF NOT EXISTS campaign_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL DEFAULT 'imported'
                  CHECK (stage IN ('imported', 'screened_in', 'screened_out', 'invited', 'attended', 'round2_qualified', 'nurture', 'closed')),
  call_attempts INT NOT NULL DEFAULT 0,
  last_call_at  TIMESTAMPTZ,
  invite_result TEXT,
  round2_notes  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_members_stage ON campaign_members (campaign_id, stage);
DROP TRIGGER IF EXISTS trg_campaign_members_updated_at ON campaign_members;
CREATE TRIGGER trg_campaign_members_updated_at
  BEFORE UPDATE ON campaign_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 7. external_links
CREATE TABLE IF NOT EXISTS external_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  system              TEXT NOT NULL CHECK (system IN ('icloud_contact', 'kjgx_app', 'legacy_macserver', 'google_contact', 'google_calendar_event', 'google_task')),
  external_id         TEXT NOT NULL,
  secondary_key       TEXT,
  remote_etag         TEXT,
  last_synced_hash    TEXT,
  last_synced_payload JSONB,
  sync_status         TEXT NOT NULL DEFAULT 'linked'
                        CHECK (sync_status IN ('linked', 'pending_push', 'conflict', 'error', 'unlinked')),
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (system, external_id)
);

CREATE INDEX IF NOT EXISTS idx_external_links_customer ON external_links (customer_id, system);
DROP TRIGGER IF EXISTS trg_external_links_updated_at ON external_links;
CREATE TRIGGER trg_external_links_updated_at
  BEFORE UPDATE ON external_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 8. kjgx_writeback_jobs
CREATE TABLE IF NOT EXISTS kjgx_writeback_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           TEXT,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_type           TEXT NOT NULL CHECK (job_type IN ('create_customer', 'update_profile', 'log_visit', 'sync_tags')),
  risk_level         TEXT NOT NULL DEFAULT 'L2_profile_write'
                       CHECK (risk_level IN ('L1_read', 'L2_profile_write', 'L3_business_submit')),
  idempotency_key    TEXT NOT NULL UNIQUE,

  payload_before     JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_target     JSONB NOT NULL,
  field_diff         JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_checks  JSONB NOT NULL DEFAULT '{}'::jsonb,

  approval_status    TEXT NOT NULL DEFAULT 'pending_review'
                       CHECK (approval_status IN ('draft', 'pending_review', 'approved', 'rejected', 'auto_approved')),
  approved_by        TEXT,
  approved_at        TIMESTAMPTZ,
  execution_status   TEXT NOT NULL DEFAULT 'queued'
                       CHECK (execution_status IN ('queued', 'claimed', 'running', 'readback_verifying', 'succeeded', 'failed', 'blocked_ota', 'cancelled')),
  assigned_device    TEXT,
  attempts           INT NOT NULL DEFAULT 0,
  max_attempts       INT NOT NULL DEFAULT 1,
  stage              TEXT,
  receipt            JSONB,

  created_by_actor   TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kjgx_jobs_dispatch
  ON kjgx_writeback_jobs (approval_status, execution_status, created_at);
CREATE INDEX IF NOT EXISTS idx_kjgx_jobs_customer ON kjgx_writeback_jobs (customer_id);
DROP TRIGGER IF EXISTS trg_kjgx_jobs_updated_at ON kjgx_writeback_jobs;
CREATE TRIGGER trg_kjgx_jobs_updated_at
  BEFORE UPDATE ON kjgx_writeback_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 9. sync_conflicts
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('customer', 'followup')),
  entity_id      UUID NOT NULL,
  source_system  TEXT NOT NULL CHECK (source_system IN ('icloud_contact', 'icloud_reminder', 'kjgx_app', 'google_contact', 'google_calendar', 'google_task')),
  field_name     TEXT NOT NULL,
  base_value     JSONB,
  crm_value      JSONB,
  remote_value   JSONB,
  remote_etag    TEXT,
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'resolved_keep_crm', 'resolved_take_remote', 'resolved_custom')),
  resolved_by    TEXT,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open ON sync_conflicts (status, created_at DESC) WHERE status = 'open';

-- 10. import_staging
CREATE TABLE IF NOT EXISTS import_staging (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              TEXT NOT NULL,
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('legacy_812_migration', 'excel_upload', 'family_card_ocr', 'agent_note_extract')),
  source_ref            TEXT,
  raw_payload           JSONB NOT NULL,
  normalized_draft      JSONB NOT NULL,
  matched_customer_id   UUID REFERENCES customers(id) ON DELETE SET NULL,
  match_reason          TEXT,
  validation_warnings   TEXT[] NOT NULL DEFAULT '{}'::text[],
  status                TEXT NOT NULL DEFAULT 'pending_review'
                          CHECK (status IN ('pending_review', 'committed', 'merged', 'rejected')),
  reviewed_by           TEXT,
  reviewed_at           TIMESTAMPTZ,
  created_by_actor      TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_staging_pending ON import_staging (status, created_at DESC) WHERE status = 'pending_review';

-- 11. audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'sync_daemon', 'kjgx_worker')),
  actor_id     TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    UUID,
  action       TEXT NOT NULL,
  before_state JSONB,
  after_state  JSONB,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kjgx_sessions (
  id text PRIMARY KEY,
  session_encrypted bytea NOT NULL,
  devicesn text NOT NULL,
  emp_no_prefix text,
  emp_name text,
  source text NOT NULL DEFAULT 'server_login',
  updated_at timestamptz NOT NULL DEFAULT now()
);
