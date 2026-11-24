import {
  boolean,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const customers = pgTable('customers', {
  id: uuid('id').defaultRandom().primaryKey(),
  legacy_group_key: text('legacy_group_key').unique(),
  name: text('name').notNull(),
  gender: text('gender').notNull().default('未知'),
  birthday: date('birthday', { mode: 'string' }),
  birthday_source: text('birthday_source').notNull().default('unknown'),
  age_override: smallint('age_override'),
  primary_phone: text('primary_phone'),
  phones: jsonb('phones').$type<Array<{ value: string; label: string; is_primary: boolean }>>().notNull().default([]),
  address: text('address'),
  company_or_occupation: text('company_or_occupation'),
  family_members_count: smallint('family_members_count'),

  id_no_encrypted: bytea('id_no_encrypted'),
  id_no_masked: text('id_no_masked'),
  id_no_hmac: text('id_no_hmac'),
  id_no_checksum_ok: boolean('id_no_checksum_ok'),

  kjgx_customer_no: text('kjgx_customer_no'),
  kjgx_db_customer_id: text('kjgx_db_customer_id'),
  kjgx_customer_level: text('kjgx_customer_level'),
  kjgx_temp_level: text('kjgx_temp_level'),
  kjgx_temp_value: numeric('kjgx_temp_value', { precision: 8, scale: 2 }),
  kjgx_customer_status: text('kjgx_customer_status'),
  kjgx_work_status: text('kjgx_work_status'),
  kjgx_asset_index: numeric('kjgx_asset_index', { precision: 8, scale: 2 }),
  kjgx_kyc_score: numeric('kjgx_kyc_score', { precision: 8, scale: 2 }),
  kjgx_service_num: integer('kjgx_service_num'),
  kjgx_visit_num: integer('kjgx_visit_num'),
  kjgx_offline_visit_num: integer('kjgx_offline_visit_num'),
  kjgx_metrics_synced_at: timestamp('kjgx_metrics_synced_at', { withTimezone: true }),

  policy_total: integer('policy_total').notNull().default(0),
  total_premium: numeric('total_premium', { precision: 14, scale: 2 }),
  premium_bucket: text('premium_bucket'),
  premium_status: text('premium_status'),
  premium_source: text('premium_source'),
  insurer_asset_wan: numeric('insurer_asset_wan', { precision: 12, scale: 2 }),
  allocatable_quota_wan: numeric('allocatable_quota_wan', { precision: 12, scale: 2 }),

  source_type: text('source_type'),
  rapport_tag: text('rapport_tag').notNull().default('unassessed'),
  visit_priority: text('visit_priority'),
  next_followup_at: timestamp('next_followup_at', { withTimezone: true }),
  manual_summary: text('manual_summary'),
  tags: text('tags').array().notNull().default([]),
  data_quality_flags: text('data_quality_flags').array().notNull().default([]),
  field_provenance: jsonb('field_provenance').$type<Record<string, unknown>>().notNull().default({}),

  status: text('status').notNull().default('active'),
  merged_into_id: uuid('merged_into_id'),
  version: integer('version').notNull().default(1),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    policy_no: text('policy_no').notNull(),
    insurer: text('insurer').notNull().default('中国太平洋人寿'),
    product_name: text('product_name'),
    holder_role: text('holder_role').notNull().default('投保人'),
    effective_date: date('effective_date', { mode: 'string' }),
    annual_premium: numeric('annual_premium', { precision: 12, scale: 2 }),
    payment_term: text('payment_term'),
    policy_status: text('policy_status'),
    is_orphan_policy: boolean('is_orphan_policy').notNull().default(false),
    coverage_gap_note: text('coverage_gap_note'),
    source: text('source').notNull().default('kjgx_app'),
    kjgx_raw_snapshot: jsonb('kjgx_raw_snapshot').$type<Record<string, unknown>>().notNull().default({}),
    version: integer('version').notNull().default(1),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('policies_customer_policy_uq').on(t.customer_id, t.policy_no)],
);

export const campaigns = pgTable('campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  source_name: text('source_name'),
  event_date: timestamp('event_date', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const interactions = pgTable('interactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  customer_id: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  campaign_id: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  channel: text('channel').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  outcome: text('outcome').notNull(),
  summary: text('summary').notNull(),
  attitude_note: text('attitude_note'),
  need_signals: text('need_signals').array().notNull().default([]),
  enqueue_kjgx_visit: boolean('enqueue_kjgx_visit').notNull().default(false),
  recorded_by_actor: text('recorded_by_actor').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const followups = pgTable('followups', {
  id: uuid('id').defaultRandom().primaryKey(),
  customer_id: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  interaction_id: uuid('interaction_id').references(() => interactions.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  action_type: text('action_type').notNull().default('call'),
  due_at: timestamp('due_at', { withTimezone: true }),
  priority: text('priority').notNull().default('medium'),
  status: text('status').notNull().default('open'),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  notes: text('notes'),

  icloud_reminder_id: text('icloud_reminder_id').unique(),
  icloud_list_id: text('icloud_list_id'),
  icloud_etag: text('icloud_etag'),
  last_synced_payload: jsonb('last_synced_payload').$type<Record<string, unknown>>(),
  sync_state: text('sync_state').notNull().default('pending_push'),

  version: integer('version').notNull().default(1),
  created_by_actor: text('created_by_actor').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const campaignMembers = pgTable(
  'campaign_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaign_id: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull().default('imported'),
    call_attempts: integer('call_attempts').notNull().default(0),
    last_call_at: timestamp('last_call_at', { withTimezone: true }),
    invite_result: text('invite_result'),
    round2_notes: text('round2_notes'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('campaign_members_uq').on(t.campaign_id, t.customer_id)],
);

export const externalLinks = pgTable(
  'external_links',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customer_id: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    system: text('system').notNull(),
    external_id: text('external_id').notNull(),
    secondary_key: text('secondary_key'),
    remote_etag: text('remote_etag'),
    last_synced_hash: text('last_synced_hash'),
    last_synced_payload: jsonb('last_synced_payload').$type<Record<string, unknown>>(),
    sync_status: text('sync_status').notNull().default('linked'),
    last_synced_at: timestamp('last_synced_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('external_links_system_ext_uq').on(t.system, t.external_id)],
);

export const kjgxWritebackJobs = pgTable('kjgx_writeback_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  batch_id: text('batch_id'),
  customer_id: uuid('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  job_type: text('job_type').notNull(),
  risk_level: text('risk_level').notNull().default('L2_profile_write'),
  idempotency_key: text('idempotency_key').notNull().unique(),
  payload_before: jsonb('payload_before').$type<Record<string, unknown>>().notNull().default({}),
  payload_target: jsonb('payload_target').$type<Record<string, unknown>>().notNull(),
  field_diff: jsonb('field_diff').$type<Array<{ field: string; before: string; after: string }>>().notNull().default([]),
  validation_checks: jsonb('validation_checks').$type<Record<string, unknown>>().notNull().default({}),
  approval_status: text('approval_status').notNull().default('pending_review'),
  approved_by: text('approved_by'),
  approved_at: timestamp('approved_at', { withTimezone: true }),
  execution_status: text('execution_status').notNull().default('queued'),
  assigned_device: text('assigned_device'),
  attempts: integer('attempts').notNull().default(0),
  max_attempts: integer('max_attempts').notNull().default(1),
  stage: text('stage'),
  receipt: jsonb('receipt').$type<Record<string, unknown> | null>(),
  created_by_actor: text('created_by_actor').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const syncConflicts = pgTable('sync_conflicts', {
  id: uuid('id').defaultRandom().primaryKey(),
  entity_type: text('entity_type').notNull(),
  entity_id: uuid('entity_id').notNull(),
  source_system: text('source_system').notNull(),
  field_name: text('field_name').notNull(),
  base_value: jsonb('base_value'),
  crm_value: jsonb('crm_value'),
  remote_value: jsonb('remote_value'),
  remote_etag: text('remote_etag'),
  status: text('status').notNull().default('open'),
  resolved_by: text('resolved_by'),
  resolved_at: timestamp('resolved_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const importStaging = pgTable('import_staging', {
  id: uuid('id').defaultRandom().primaryKey(),
  batch_id: text('batch_id').notNull(),
  source_kind: text('source_kind').notNull(),
  source_ref: text('source_ref'),
  raw_payload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull(),
  normalized_draft: jsonb('normalized_draft').$type<Record<string, unknown>>().notNull(),
  matched_customer_id: uuid('matched_customer_id').references(() => customers.id, { onDelete: 'set null' }),
  match_reason: text('match_reason'),
  validation_warnings: text('validation_warnings').array().notNull().default([]),
  status: text('status').notNull().default('pending_review'),
  reviewed_by: text('reviewed_by'),
  reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
  created_by_actor: text('created_by_actor').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  actor_type: text('actor_type').notNull(),
  actor_id: text('actor_id').notNull(),
  entity_type: text('entity_type').notNull(),
  entity_id: uuid('entity_id'),
  action: text('action').notNull(),
  before_state: jsonb('before_state').$type<Record<string, unknown> | null>(),
  after_state: jsonb('after_state').$type<Record<string, unknown> | null>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
