import { z } from 'zod';

export const GENDER_VALUES = ['男', '女', '未知'] as const;
export const BIRTHDAY_SOURCES = ['handwritten_card', 'kjgx', 'icloud', 'manual', 'unknown'] as const;
export const RAPPORT_TAGS = ['friendly', 'neutral', 'cautious', 'paused', 'unassessed'] as const;
export const VISIT_PRIORITIES = ['high', 'medium', 'low'] as const;
export const CUSTOMER_STATUSES = ['active', 'merged', 'archived', 'deleted'] as const;

export const INTERACTION_CHANNELS = [
  'phone',
  'platform_event',
  'wechat',
  'in_person_visit',
  'policy_review',
  'other',
] as const;

export const INTERACTION_OUTCOMES = [
  'connected',
  'no_answer',
  'rejected',
  'invited',
  'attended',
  'followed_up',
] as const;

export const FOLLOWUP_ACTION_TYPES = ['call', 'invite', 'visit', 'policy_review', 'birthday', 'other'] as const;
export const FOLLOWUP_STATUSES = ['open', 'done', 'cancelled'] as const;

export const CAMPAIGN_STAGES = [
  'imported',
  'screened_in',
  'screened_out',
  'invited',
  'attended',
  'round2_qualified',
  'nurture',
  'closed',
] as const;

export const KJGX_JOB_TYPES = ['create_customer', 'update_profile', 'log_visit', 'sync_tags'] as const;
export const KJGX_RISK_LEVELS = ['L1_read', 'L2_profile_write', 'L3_business_submit'] as const;
export const KJGX_APPROVAL_STATUSES = ['draft', 'pending_review', 'approved', 'rejected', 'auto_approved'] as const;
export const KJGX_EXECUTION_STATUSES = [
  'queued',
  'claimed',
  'running',
  'readback_verifying',
  'succeeded',
  'failed',
  'blocked_ota',
  'cancelled',
] as const;

export const PhoneEntrySchema = z.object({
  value: z.string().min(3),
  label: z.string().default('mobile'),
  is_primary: z.boolean().default(false),
});
export type PhoneEntry = z.infer<typeof PhoneEntrySchema>;

export const CustomerSchema = z.object({
  id: z.string(),
  legacy_group_key: z.string().nullable().default(null),
  name: z.string().min(1),
  gender: z.enum(GENDER_VALUES).default('未知'),
  birthday: z.string().nullable().default(null),
  birthday_source: z.enum(BIRTHDAY_SOURCES).default('unknown'),
  age_override: z.number().int().min(0).max(120).nullable().default(null),
  primary_phone: z.string().nullable().default(null),
  phones: z.array(PhoneEntrySchema).default([]),
  address: z.string().nullable().default(null),
  company_or_occupation: z.string().nullable().default(null),
  family_members_count: z.number().int().nullable().default(null),

  id_no_masked: z.string().nullable().default(null),
  id_no_checksum_ok: z.boolean().nullable().default(null),

  kjgx_customer_no: z.string().nullable().default(null),
  kjgx_db_customer_id: z.string().nullable().default(null),
  kjgx_customer_level: z.string().nullable().default(null),
  kjgx_temp_level: z.string().nullable().default(null),
  kjgx_temp_value: z.number().nullable().default(null),
  kjgx_customer_status: z.string().nullable().default(null),
  kjgx_work_status: z.string().nullable().default(null),
  kjgx_asset_index: z.number().nullable().default(null),
  kjgx_kyc_score: z.number().nullable().default(null),
  kjgx_service_num: z.number().int().nullable().default(null),
  kjgx_visit_num: z.number().int().nullable().default(null),
  kjgx_offline_visit_num: z.number().int().nullable().default(null),
  kjgx_metrics_synced_at: z.string().nullable().default(null),

  policy_total: z.number().int().default(0),
  total_premium: z.number().nullable().default(null),
  premium_bucket: z.string().nullable().default(null),
  premium_status: z.string().nullable().default(null),
  premium_source: z.string().nullable().default(null),
  insurer_asset_wan: z.number().nullable().default(null),
  allocatable_quota_wan: z.number().nullable().default(null),

  source_type: z.string().nullable().default(null),
  rapport_tag: z.enum(RAPPORT_TAGS).default('unassessed'),
  visit_priority: z.enum(VISIT_PRIORITIES).nullable().default(null),
  next_followup_at: z.string().nullable().default(null),
  manual_summary: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  data_quality_flags: z.array(z.string()).default([]),
  field_provenance: z.record(z.string(), z.unknown()).default({}),

  status: z.enum(CUSTOMER_STATUSES).default('active'),
  merged_into_id: z.string().nullable().default(null),
  version: z.number().int().min(1).default(1),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable().default(null),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const CreateCustomerInputSchema = z.object({
  name: z.string().min(1),
  gender: z.enum(GENDER_VALUES).optional(),
  birthday: z.string().nullable().optional(),
  birthday_source: z.enum(BIRTHDAY_SOURCES).optional(),
  primary_phone: z.string().nullable().optional(),
  phones: z.array(PhoneEntrySchema).optional(),
  address: z.string().nullable().optional(),
  company_or_occupation: z.string().nullable().optional(),
  family_members_count: z.number().int().nullable().optional(),
  id_no: z.string().nullable().optional(),
  source_type: z.string().default('manual'),
  rapport_tag: z.enum(RAPPORT_TAGS).optional(),
  visit_priority: z.enum(VISIT_PRIORITIES).nullable().optional(),
  manual_summary: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  icloud_group: z.string().optional(),
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerInputSchema>;

export const UpdateCustomerInputSchema = z.object({
  expected_version: z.number().int().min(1),
  name: z.string().min(1).optional(),
  gender: z.enum(GENDER_VALUES).optional(),
  birthday: z.string().nullable().optional(),
  birthday_source: z.enum(BIRTHDAY_SOURCES).optional(),
  primary_phone: z.string().nullable().optional(),
  phones: z.array(PhoneEntrySchema).optional(),
  address: z.string().nullable().optional(),
  company_or_occupation: z.string().nullable().optional(),
  family_members_count: z.number().int().nullable().optional(),
  rapport_tag: z.enum(RAPPORT_TAGS).optional(),
  visit_priority: z.enum(VISIT_PRIORITIES).nullable().optional(),
  next_followup_at: z.string().nullable().optional(),
  manual_summary: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  enqueue_kjgx_writeback: z.boolean().optional(),
});
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerInputSchema>;

export const PolicySchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  policy_no: z.string(),
  insurer: z.string().default('中国太平洋人寿'),
  product_name: z.string().nullable().default(null),
  holder_role: z.enum(['投保人', '被保人', '双身份', '未知']).default('投保人'),
  effective_date: z.string().nullable().default(null),
  annual_premium: z.number().nullable().default(null),
  payment_term: z.string().nullable().default(null),
  policy_status: z.string().nullable().default(null),
  is_orphan_policy: z.boolean().default(false),
  coverage_gap_note: z.string().nullable().default(null),
  source: z.string().default('kjgx_app'),
  version: z.number().int().default(1),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const InteractionSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  campaign_id: z.string().nullable().default(null),
  channel: z.enum(INTERACTION_CHANNELS),
  occurred_at: z.string(),
  outcome: z.enum(INTERACTION_OUTCOMES),
  summary: z.string().min(1),
  attitude_note: z.string().nullable().default(null),
  need_signals: z.array(z.string()).default([]),
  enqueue_kjgx_visit: z.boolean().default(false),
  recorded_by_actor: z.string(),
  created_at: z.string(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

export const CreateInteractionInputSchema = z.object({
  campaign_id: z.string().nullable().optional(),
  channel: z.enum(INTERACTION_CHANNELS),
  occurred_at: z.string().optional(),
  outcome: z.enum(INTERACTION_OUTCOMES),
  summary: z.string().min(1),
  attitude_note: z.string().nullable().optional(),
  need_signals: z.array(z.string()).optional(),
  enqueue_kjgx_visit: z.boolean().optional(),
  followup_title: z.string().optional(),
  followup_due_at: z.string().nullable().optional(),
});
export type CreateInteractionInput = z.infer<typeof CreateInteractionInputSchema>;

export const FollowupSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  interaction_id: z.string().nullable().default(null),
  title: z.string().min(1),
  action_type: z.enum(FOLLOWUP_ACTION_TYPES).default('call'),
  due_at: z.string().nullable().default(null),
  priority: z.enum(VISIT_PRIORITIES).default('medium'),
  status: z.enum(FOLLOWUP_STATUSES).default('open'),
  completed_at: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  icloud_reminder_id: z.string().nullable().default(null),
  icloud_list_id: z.string().nullable().default(null),
  icloud_etag: z.string().nullable().default(null),
  last_synced_payload: z.record(z.string(), z.unknown()).nullable().default(null),
  sync_state: z.enum(['in_sync', 'pending_push', 'conflict', 'unlinked']).default('pending_push'),
  version: z.number().int().default(1),
  created_by_actor: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Followup = z.infer<typeof FollowupSchema>;

export const UpsertFollowupInputSchema = z.object({
  id: z.string().optional(),
  customer_id: z.string(),
  interaction_id: z.string().nullable().optional(),
  title: z.string().min(1),
  action_type: z.enum(FOLLOWUP_ACTION_TYPES).optional(),
  due_at: z.string().nullable().optional(),
  priority: z.enum(VISIT_PRIORITIES).optional(),
  status: z.enum(FOLLOWUP_STATUSES).optional(),
  notes: z.string().nullable().optional(),
  expected_version: z.number().int().min(1).optional(),
});
export type UpsertFollowupInput = z.infer<typeof UpsertFollowupInputSchema>;

export const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  source_name: z.string().nullable().default(null),
  event_date: z.string().nullable().default(null),
  status: z.enum(['draft', 'active', 'completed', 'archived']).default('active'),
  notes: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

export const CampaignMemberSchema = z.object({
  id: z.string(),
  campaign_id: z.string(),
  customer_id: z.string(),
  stage: z.enum(CAMPAIGN_STAGES).default('imported'),
  call_attempts: z.number().int().default(0),
  last_call_at: z.string().nullable().default(null),
  invite_result: z.string().nullable().default(null),
  round2_notes: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CampaignMember = z.infer<typeof CampaignMemberSchema>;

export const ExternalLinkSchema = z.object({
  id: z.string(),
  customer_id: z.string(),
  system: z.enum(['icloud_contact', 'kjgx_app', 'legacy_macserver']),
  external_id: z.string(),
  secondary_key: z.string().nullable().default(null),
  remote_etag: z.string().nullable().default(null),
  last_synced_hash: z.string().nullable().default(null),
  last_synced_payload: z.record(z.string(), z.unknown()).nullable().default(null),
  sync_status: z.enum(['linked', 'pending_push', 'conflict', 'error', 'unlinked']).default('linked'),
  last_synced_at: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ExternalLink = z.infer<typeof ExternalLinkSchema>;

export const KjgxReceiptSchema = z.object({
  assigned_device: z.string(),
  attempts: z.number().int().min(1),
  route_result: z.string(),
  edit_page_seen: z.boolean(),
  customer_name_seen: z.boolean(),
  readback_matched: z.boolean(),
  app_result: z.record(z.string(), z.unknown()).or(z.string()),
  error: z.string().nullable().optional(),
});
export type KjgxReceipt = z.infer<typeof KjgxReceiptSchema>;

export const KjgxFieldDiffItemSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
});
export type KjgxFieldDiffItem = z.infer<typeof KjgxFieldDiffItemSchema>;

export const KjgxWritebackJobSchema = z.object({
  id: z.string(),
  batch_id: z.string().nullable().default(null),
  customer_id: z.string(),
  customer_name: z.string().optional(),
  job_type: z.enum(KJGX_JOB_TYPES),
  risk_level: z.enum(KJGX_RISK_LEVELS).default('L2_profile_write'),
  idempotency_key: z.string(),
  payload_before: z.record(z.string(), z.unknown()).default({}),
  payload_target: z.record(z.string(), z.unknown()),
  field_diff: z.array(KjgxFieldDiffItemSchema).default([]),
  validation_checks: z.record(z.string(), z.unknown()).default({}),
  approval_status: z.enum(KJGX_APPROVAL_STATUSES).default('pending_review'),
  approved_by: z.string().nullable().default(null),
  approved_at: z.string().nullable().default(null),
  execution_status: z.enum(KJGX_EXECUTION_STATUSES).default('queued'),
  assigned_device: z.string().nullable().default(null),
  attempts: z.number().int().default(0),
  max_attempts: z.number().int().default(1),
  stage: z.string().nullable().default(null),
  receipt: KjgxReceiptSchema.nullable().default(null),
  created_by_actor: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type KjgxWritebackJob = z.infer<typeof KjgxWritebackJobSchema>;

export const EnqueueKjgxJobInputSchema = z.object({
  customer_id: z.string(),
  job_type: z.enum(KJGX_JOB_TYPES),
  risk_level: z.enum(KJGX_RISK_LEVELS).optional(),
  idempotency_key: z.string().optional(),
  payload_target: z.record(z.string(), z.unknown()),
  field_diff: z.array(KjgxFieldDiffItemSchema).optional(),
  auto_approve: z.boolean().default(false),
});
export type EnqueueKjgxJobInput = z.infer<typeof EnqueueKjgxJobInputSchema>;

export const SyncConflictSchema = z.object({
  id: z.string(),
  entity_type: z.enum(['customer', 'followup']),
  entity_id: z.string(),
  customer_name: z.string().optional(),
  source_system: z.enum(['icloud_contact', 'icloud_reminder', 'kjgx_app']),
  field_name: z.string(),
  base_value: z.unknown(),
  crm_value: z.unknown(),
  remote_value: z.unknown(),
  remote_etag: z.string().nullable().default(null),
  status: z.enum(['open', 'resolved_keep_crm', 'resolved_take_remote', 'resolved_custom']).default('open'),
  resolved_by: z.string().nullable().default(null),
  resolved_at: z.string().nullable().default(null),
  created_at: z.string(),
});
export type SyncConflict = z.infer<typeof SyncConflictSchema>;

export const ResolveConflictInputSchema = z.object({
  resolution: z.enum(['keep_crm', 'take_remote', 'custom']),
  custom_value: z.unknown().optional(),
});
export type ResolveConflictInput = z.infer<typeof ResolveConflictInputSchema>;

export const ImportStagingItemSchema = z.object({
  id: z.string(),
  batch_id: z.string(),
  source_kind: z.enum(['legacy_812_migration', 'excel_upload', 'family_card_ocr', 'agent_note_extract']),
  source_ref: z.string().nullable().default(null),
  raw_payload: z.record(z.string(), z.unknown()),
  normalized_draft: z.record(z.string(), z.unknown()),
  matched_customer_id: z.string().nullable().default(null),
  match_reason: z.string().nullable().default(null),
  validation_warnings: z.array(z.string()).default([]),
  status: z.enum(['pending_review', 'committed', 'merged', 'rejected']).default('pending_review'),
  reviewed_by: z.string().nullable().default(null),
  reviewed_at: z.string().nullable().default(null),
  created_by_actor: z.string(),
  created_at: z.string(),
});
export type ImportStagingItem = z.infer<typeof ImportStagingItemSchema>;

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  actor_type: z.enum(['human', 'agent', 'sync_daemon', 'kjgx_worker']),
  actor_id: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable().default(null),
  action: z.string(),
  before_state: z.record(z.string(), z.unknown()).nullable().default(null),
  after_state: z.record(z.string(), z.unknown()).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
