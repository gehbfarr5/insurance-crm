import crypto from 'node:crypto';
import {
  type AuditLogEntry,
  type Campaign,
  type CampaignMember,
  type CreateCustomerInput,
  type CreateInteractionInput,
  type Customer,
  type ExternalLink,
  type Followup,
  type ImportStagingItem,
  type Interaction,
  type KjgxFieldDiffItem,
  type KjgxWritebackJob,
  type Policy,
  type ResolveConflictInput,
  type SyncConflict,
  type UpdateCustomerInput,
  type UpsertFollowupInput,
  normalizePhone,
} from '@insurance-crm/shared';
import { and, desc, eq, gte, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { IdVault } from '../crypto/id-vault.js';
import type { DbClient } from '../db/client.js';
import {
  auditLogs,
  campaignMembers,
  campaigns,
  customers,
  externalLinks,
  followups,
  importStaging,
  interactions,
  kjgxWritebackJobs,
  policies,
  syncConflicts,
} from '../db/schema.js';
import { buildDemoSeed } from './seed-demo.js';

export class ConflictError extends Error {
  readonly code = 'CONFLICT';
  readonly latest?: unknown;
  constructor(message: string, latest?: unknown) {
    super(message);
    this.name = 'ConflictError';
    this.latest = latest;
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  readonly code = 'INVALID_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface SearchCustomersParams {
  query?: string;
  tags?: string[];
  min_premium?: number;
  rapport_tag?: string;
  has_quality_flag?: boolean;
  source_type?: string;
  limit?: number;
}

export interface FilterCandidatesParams {
  campaign_id?: string;
  min_premium?: number;
  max_age?: number;
  gender?: string;
  stage?: string;
  exclude_paused?: boolean;
  limit?: number;
}

export interface Customer360 {
  customer: Customer;
  policies: Policy[];
  interactions: Interaction[];
  followups: Followup[];
  external_links: ExternalLink[];
  pending_jobs: KjgxWritebackJob[];
  open_conflicts: SyncConflict[];
}

export interface ActorContext {
  actorType: 'human' | 'agent' | 'sync_daemon' | 'kjgx_worker';
  actorId: string;
}

export interface CrmStore {
  searchCustomers(params: SearchCustomersParams): Promise<{ customers: Customer[]; total: number; truncated: boolean }>;
  getCustomer360(customerId: string): Promise<Customer360>;
  createCustomer(
    input: CreateCustomerInput,
    actor: ActorContext,
  ): Promise<{ created: true; customer: Customer } | { created: false; duplicates: Customer[] }>;
  updateCustomer(customerId: string, input: UpdateCustomerInput, actor: ActorContext): Promise<Customer>;
  logInteraction(
    customerId: string,
    input: CreateInteractionInput,
    actor: ActorContext,
  ): Promise<{ interaction: Interaction; followup?: Followup; kjgx_job?: KjgxWritebackJob }>;

  listFollowups(params?: { status?: string; customer_id?: string }): Promise<Followup[]>;
  upsertFollowup(input: UpsertFollowupInput, actor: ActorContext): Promise<Followup>;

  listCampaigns(): Promise<Array<Campaign & { members: Array<CampaignMember & { customer_name: string }> }>>;
  filterCandidates(params: FilterCandidatesParams): Promise<Array<{ customer: Customer; member?: CampaignMember }>>;
  updateCampaignMember(
    campaignId: string,
    customerId: string,
    patch: { stage?: CampaignMember['stage']; invite_result?: string | null; round2_notes?: string | null },
    actor: ActorContext,
  ): Promise<CampaignMember>;

  listExternalLinks(customerId?: string): Promise<ExternalLink[]>;
  upsertExternalLink(
    link: Omit<ExternalLink, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<ExternalLink>;

  listKjgxJobs(params?: { customer_id?: string; execution_status?: string; approval_status?: string }): Promise<KjgxWritebackJob[]>;
  getKjgxJob(jobId: string): Promise<KjgxWritebackJob | null>;
  enqueueKjgxJob(
    input: {
      customer_id: string;
      job_type: KjgxWritebackJob['job_type'];
      risk_level?: KjgxWritebackJob['risk_level'];
      idempotency_key: string;
      payload_before?: Record<string, unknown>;
      payload_target: Record<string, unknown>;
      field_diff?: KjgxFieldDiffItem[];
      validation_checks?: Record<string, unknown>;
      auto_approve?: boolean;
    },
    actor: ActorContext,
  ): Promise<KjgxWritebackJob>;
  updateKjgxJob(jobId: string, patch: Partial<KjgxWritebackJob>, actor: ActorContext): Promise<KjgxWritebackJob>;

  listConflicts(status?: string): Promise<SyncConflict[]>;
  createConflict(
    conflict: Omit<SyncConflict, 'id' | 'created_at' | 'resolved_by' | 'resolved_at'>,
  ): Promise<SyncConflict>;
  resolveConflict(conflictId: string, input: ResolveConflictInput, actor: ActorContext): Promise<SyncConflict>;

  listStaging(status?: string): Promise<ImportStagingItem[]>;
  stageImportDraft(
    input: {
      batch_id?: string;
      source_kind: ImportStagingItem['source_kind'];
      source_ref?: string | null;
      raw_payload?: Record<string, unknown>;
      normalized_draft: Record<string, unknown>;
      validation_warnings?: string[];
    },
    actor: ActorContext,
  ): Promise<ImportStagingItem>;
  commitStaging(stagingId: string, actor: ActorContext): Promise<{ staging: ImportStagingItem; customer: Customer }>;
  rejectStaging(stagingId: string, actor: ActorContext): Promise<ImportStagingItem>;

  listAuditLogs(limit?: number): Promise<AuditLogEntry[]>;
  appendAudit(entry: Omit<AuditLogEntry, 'id' | 'created_at'>): Promise<AuditLogEntry>;
  getDashboard(): Promise<{
    stats: {
      total_customers: number;
      hnw_customers: number;
      pending_kjgx_jobs: number;
      open_conflicts: number;
      pending_staging: number;
    };
    followups: Array<Followup & { customer_name: string }>;
    pending_jobs: KjgxWritebackJob[];
    recent_audit: AuditLogEntry[];
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function computeDiff(beforeObj: Record<string, unknown>, afterObj: Record<string, unknown>, labels: Record<string, string>): KjgxFieldDiffItem[] {
  const diffs: KjgxFieldDiffItem[] = [];
  for (const [k, label] of Object.entries(labels)) {
    if (k in afterObj && afterObj[k] !== beforeObj[k]) {
      diffs.push({
        field: label,
        before: String(beforeObj[k] ?? '(空)'),
        after: String(afterObj[k] ?? '(空)'),
      });
    }
  }
  return diffs;
}

// ============================================================================
// IN-MEMORY DEMO STORE (Zero external dependencies, runs anywhere)
// ============================================================================
export class InMemoryDemoStore implements CrmStore {
  private customers: Customer[];
  private idVaultMap = new Map<string, { encrypted: Buffer; hmac: string | null }>();
  private policies: Policy[];
  private campaigns: Campaign[];
  private campaignMembers: CampaignMember[];
  private interactions: Interaction[];
  private followups: Followup[];
  private externalLinks: ExternalLink[];
  private kjgxJobs: KjgxWritebackJob[];
  private conflicts: SyncConflict[];
  private stagingItems: ImportStagingItem[];
  private auditLogs: AuditLogEntry[];

  constructor(private readonly vault: IdVault) {
    const seed = buildDemoSeed();
    this.customers = seed.customers;
    this.policies = seed.policies;
    this.campaigns = seed.campaigns;
    this.campaignMembers = seed.campaignMembers;
    this.interactions = seed.interactions;
    this.followups = seed.followups;
    this.externalLinks = seed.externalLinks;
    this.kjgxJobs = seed.kjgxJobs;
    this.conflicts = seed.conflicts;
    this.stagingItems = seed.stagingItems;
    this.auditLogs = seed.auditLogs;
  }

  async searchCustomers(params: SearchCustomersParams) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    let list = this.customers.filter((c) => c.status === 'active' && !c.deleted_at);
    if (params.query?.trim()) {
      const q = params.query.trim().toLowerCase();
      list = list.filter((c) =>
        [c.name, c.primary_phone, c.address, c.source_type, c.manual_summary, ...(c.tags ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
    }
    if (params.tags?.length) {
      list = list.filter((c) => params.tags!.every((t) => c.tags.includes(t)));
    }
    if (params.min_premium != null) {
      list = list.filter((c) => (c.total_premium ?? 0) >= params.min_premium!);
    }
    if (params.rapport_tag) {
      list = list.filter((c) => c.rapport_tag === params.rapport_tag);
    }
    if (params.has_quality_flag) {
      list = list.filter((c) => c.data_quality_flags.length > 0);
    }
    if (params.source_type) {
      list = list.filter((c) => c.source_type === params.source_type);
    }
    return {
      customers: list.slice(0, limit),
      total: list.length,
      truncated: list.length > limit,
    };
  }

  async getCustomer360(customerId: string): Promise<Customer360> {
    const customer = this.customers.find((c) => c.id === customerId && !c.deleted_at);
    if (!customer) throw new NotFoundError(`Customer ${customerId} not found`);
    return {
      customer,
      policies: this.policies.filter((p) => p.customer_id === customerId),
      interactions: this.interactions
        .filter((i) => i.customer_id === customerId)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
        .slice(0, 20),
      followups: this.followups.filter((f) => f.customer_id === customerId),
      external_links: this.externalLinks.filter((l) => l.customer_id === customerId),
      pending_jobs: this.kjgxJobs.filter(
        (j) => j.customer_id === customerId && j.execution_status !== 'succeeded' && j.execution_status !== 'cancelled',
      ),
      open_conflicts: this.conflicts.filter((c) => c.entity_id === customerId && c.status === 'open'),
    };
  }

  async createCustomer(input: CreateCustomerInput, actor: ActorContext) {
    const phoneNorm = input.primary_phone ? normalizePhone(input.primary_phone) : null;
    const sealed = input.id_no ? this.vault.seal(input.id_no) : null;

    const duplicates = this.customers.filter((c) => {
      if (c.status !== 'active' || c.deleted_at) return false;
      if (phoneNorm && c.primary_phone === phoneNorm) return true;
      if (sealed?.hmac && this.idVaultMap.get(c.id)?.hmac === sealed.hmac) return true;
      return false;
    });
    if (duplicates.length > 0) {
      return { created: false as const, duplicates };
    }

    const ts = nowIso();
    const id = crypto.randomUUID();
    const customer: Customer = {
      id,
      legacy_group_key: null,
      name: input.name.trim(),
      gender: input.gender ?? '未知',
      birthday: input.birthday ?? null,
      birthday_source: input.birthday_source ?? 'unknown',
      age_override: null,
      primary_phone: phoneNorm,
      phones: input.phones?.length
        ? input.phones
        : phoneNorm
          ? [{ value: phoneNorm, label: 'mobile', is_primary: true }]
          : [],
      address: input.address ?? null,
      company_or_occupation: input.company_or_occupation ?? null,
      family_members_count: input.family_members_count ?? null,
      id_no_masked: sealed?.masked ?? null,
      id_no_checksum_ok: sealed?.checksumOk ?? null,
      kjgx_customer_no: null,
      kjgx_db_customer_id: null,
      kjgx_customer_level: null,
      kjgx_temp_level: null,
      kjgx_temp_value: null,
      kjgx_customer_status: null,
      kjgx_work_status: null,
      kjgx_asset_index: null,
      kjgx_kyc_score: null,
      kjgx_service_num: null,
      kjgx_visit_num: null,
      kjgx_offline_visit_num: null,
      kjgx_metrics_synced_at: null,
      policy_total: 0,
      total_premium: null,
      premium_bucket: null,
      premium_status: null,
      premium_source: null,
      insurer_asset_wan: null,
      allocatable_quota_wan: null,
      source_type: input.source_type ?? 'manual',
      rapport_tag: input.rapport_tag ?? 'unassessed',
      visit_priority: input.visit_priority ?? null,
      next_followup_at: null,
      manual_summary: input.manual_summary ?? null,
      tags: input.tags ?? (input.icloud_group ? [input.icloud_group] : []),
      data_quality_flags: [],
      field_provenance: { created_by: actor.actorId },
      status: 'active',
      merged_into_id: null,
      version: 1,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    };

    if (sealed) {
      this.idVaultMap.set(id, { encrypted: sealed.encrypted, hmac: sealed.hmac });
    }
    this.customers.unshift(customer);
    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'customer',
      entity_id: id,
      action: `新建客户 ${customer.name}`,
      before_state: null,
      after_state: { name: customer.name, primary_phone: customer.primary_phone },
      metadata: {},
    });
    return { created: true as const, customer };
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput, actor: ActorContext): Promise<Customer> {
    const idx = this.customers.findIndex((c) => c.id === customerId && !c.deleted_at);
    if (idx === -1) throw new NotFoundError(`Customer ${customerId} not found`);
    const existing = this.customers[idx]!;
    if (existing.version !== input.expected_version) {
      throw new ConflictError(
        `Version mismatch: expected ${input.expected_version}, actual ${existing.version}`,
        existing,
      );
    }

    const before: Record<string, unknown> = {
      name: existing.name,
      primary_phone: existing.primary_phone,
      address: existing.address,
      birthday: existing.birthday,
      company_or_occupation: existing.company_or_occupation,
    };

    const nextPhone = input.primary_phone !== undefined ? normalizePhone(input.primary_phone) || null : existing.primary_phone;
    const updated: Customer = {
      ...existing,
      name: input.name ?? existing.name,
      gender: input.gender ?? existing.gender,
      birthday: input.birthday !== undefined ? input.birthday : existing.birthday,
      birthday_source: input.birthday_source ?? existing.birthday_source,
      primary_phone: nextPhone,
      phones:
        input.phones ??
        (nextPhone && !existing.phones.some((p) => p.value === nextPhone)
          ? [{ value: nextPhone, label: 'mobile', is_primary: true }]
          : existing.phones),
      address: input.address !== undefined ? input.address : existing.address,
      company_or_occupation:
        input.company_or_occupation !== undefined ? input.company_or_occupation : existing.company_or_occupation,
      family_members_count:
        input.family_members_count !== undefined ? input.family_members_count : existing.family_members_count,
      rapport_tag: input.rapport_tag ?? existing.rapport_tag,
      visit_priority: input.visit_priority !== undefined ? input.visit_priority : existing.visit_priority,
      next_followup_at: input.next_followup_at !== undefined ? input.next_followup_at : existing.next_followup_at,
      manual_summary: input.manual_summary !== undefined ? input.manual_summary : existing.manual_summary,
      tags: input.tags ?? existing.tags,
      field_provenance: {
        ...existing.field_provenance,
        last_updated_by: actor.actorId,
        last_updated_at: nowIso(),
      },
      version: existing.version + 1,
      updated_at: nowIso(),
    };
    this.customers[idx] = updated;

    const after: Record<string, unknown> = {
      name: updated.name,
      primary_phone: updated.primary_phone,
      address: updated.address,
      birthday: updated.birthday,
      company_or_occupation: updated.company_or_occupation,
    };

    const diffs = computeDiff(before, after, {
      name: '姓名',
      primary_phone: '手机',
      address: '联系地址',
      birthday: '出生日期',
      company_or_occupation: '职业/单位',
    });

    if (input.enqueue_kjgx_writeback && diffs.length > 0) {
      await this.enqueueKjgxJob(
        {
          customer_id: updated.id,
          job_type: updated.kjgx_customer_no ? 'update_profile' : 'create_customer',
          idempotency_key: `profile-${updated.id}-v${updated.version}`,
          payload_before: before,
          payload_target: after,
          field_diff: diffs,
          validation_checks: {
            phone_valid: Boolean(updated.primary_phone),
            identity_matched: Boolean(updated.kjgx_customer_no || updated.primary_phone),
          },
        },
        actor,
      );
    }

    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'customer',
      entity_id: updated.id,
      action: `更新客户 ${updated.name} (v${updated.version})`,
      before_state: before,
      after_state: after,
      metadata: {},
    });

    return updated;
  }

  async logInteraction(customerId: string, input: CreateInteractionInput, actor: ActorContext) {
    const customer = this.customers.find((c) => c.id === customerId && !c.deleted_at);
    if (!customer) throw new NotFoundError(`Customer ${customerId} not found`);

    const ts = nowIso();
    const interaction: Interaction = {
      id: crypto.randomUUID(),
      customer_id: customerId,
      campaign_id: input.campaign_id ?? null,
      channel: input.channel,
      occurred_at: input.occurred_at ?? ts,
      outcome: input.outcome,
      summary: input.summary.trim(),
      attitude_note: input.attitude_note ?? null,
      need_signals: input.need_signals ?? [],
      enqueue_kjgx_visit: input.enqueue_kjgx_visit ?? false,
      recorded_by_actor: actor.actorId,
      created_at: ts,
    };
    this.interactions.unshift(interaction);

    let followup: Followup | undefined;
    if (input.followup_title?.trim()) {
      followup = await this.upsertFollowup(
        {
          customer_id: customerId,
          interaction_id: interaction.id,
          title: input.followup_title.trim(),
          due_at: input.followup_due_at ?? null,
          priority: 'high',
          status: 'open',
        },
        actor,
      );
    }

    let kjgxJob: KjgxWritebackJob | undefined;
    if (input.enqueue_kjgx_visit) {
      kjgxJob = await this.enqueueKjgxJob(
        {
          customer_id: customerId,
          job_type: 'log_visit',
          idempotency_key: `visit-${interaction.id}`,
          payload_target: {
            customer_no: customer.kjgx_customer_no,
            channel: input.channel,
            outcome: input.outcome,
            visit_note: interaction.summary,
          },
          field_diff: [{ field: '拜访备注', before: '(追加)', after: interaction.summary.slice(0, 60) }],
          validation_checks: {
            identity_matched: Boolean(customer.kjgx_customer_no || customer.kjgx_db_customer_id),
            phone_valid: Boolean(customer.primary_phone),
          },
        },
        actor,
      );
    }

    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'interaction',
      entity_id: interaction.id,
      action: `新增 ${customer.name} 沟通记录 (${input.channel})`,
      before_state: null,
      after_state: { summary: interaction.summary, outcome: interaction.outcome },
      metadata: { customer_id: customerId },
    });

    return { interaction, followup, kjgx_job: kjgxJob };
  }

  async listFollowups(params?: { status?: string; customer_id?: string }): Promise<Followup[]> {
    return this.followups.filter((f) => {
      if (params?.status && f.status !== params.status) return false;
      if (params?.customer_id && f.customer_id !== params.customer_id) return false;
      return true;
    });
  }

  async upsertFollowup(input: UpsertFollowupInput, actor: ActorContext): Promise<Followup> {
    const customer = this.customers.find((c) => c.id === input.customer_id && !c.deleted_at);
    if (!customer) throw new NotFoundError(`Customer ${input.customer_id} not found`);
    const ts = nowIso();

    if (input.id) {
      const idx = this.followups.findIndex((f) => f.id === input.id);
      if (idx === -1) throw new NotFoundError(`Followup ${input.id} not found`);
      const existing = this.followups[idx]!;
      if (input.expected_version != null && existing.version !== input.expected_version) {
        throw new ConflictError(`Followup version mismatch`, existing);
      }
      const nextStatus = input.status ?? existing.status;
      const updated: Followup = {
        ...existing,
        title: input.title ?? existing.title,
        action_type: input.action_type ?? existing.action_type,
        due_at: input.due_at !== undefined ? input.due_at : existing.due_at,
        priority: input.priority ?? existing.priority,
        status: nextStatus,
        completed_at: nextStatus === 'done' ? existing.completed_at ?? ts : null,
        notes: input.notes !== undefined ? input.notes : existing.notes,
        sync_state: 'pending_push',
        version: existing.version + 1,
        updated_at: ts,
      };
      this.followups[idx] = updated;
      return updated;
    }

    const created: Followup = {
      id: crypto.randomUUID(),
      customer_id: input.customer_id,
      interaction_id: input.interaction_id ?? null,
      title: input.title.trim(),
      action_type: input.action_type ?? 'call',
      due_at: input.due_at ?? null,
      priority: input.priority ?? 'medium',
      status: input.status ?? 'open',
      completed_at: input.status === 'done' ? ts : null,
      notes: input.notes ?? null,
      icloud_reminder_id: null,
      icloud_list_id: '工作待办 Work',
      icloud_etag: null,
      last_synced_payload: null,
      sync_state: 'pending_push',
      version: 1,
      created_by_actor: actor.actorId,
      created_at: ts,
      updated_at: ts,
    };
    this.followups.unshift(created);
    return created;
  }

  async listCampaigns() {
    return this.campaigns.map((camp) => ({
      ...camp,
      members: this.campaignMembers
        .filter((m) => m.campaign_id === camp.id)
        .map((m) => ({
          ...m,
          customer_name: this.customers.find((c) => c.id === m.customer_id)?.name ?? '-',
        })),
    }));
  }

  async filterCandidates(params: FilterCandidatesParams) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const results: Array<{ customer: Customer; member?: CampaignMember }> = [];

    for (const c of this.customers) {
      if (c.status !== 'active' || c.deleted_at) continue;
      if (params.min_premium != null && (c.total_premium ?? 0) < params.min_premium) continue;
      if (params.gender && c.gender !== params.gender) continue;
      if (params.exclude_paused && c.rapport_tag === 'paused') continue;
      if (params.max_age != null && (c.age_override ?? 0) > params.max_age) continue;

      const member = params.campaign_id
        ? this.campaignMembers.find((m) => m.campaign_id === params.campaign_id && m.customer_id === c.id)
        : this.campaignMembers.find((m) => m.customer_id === c.id);

      if (params.stage && member?.stage !== params.stage) continue;
      results.push({ customer: c, member });
      if (results.length >= limit) break;
    }
    return results;
  }

  async updateCampaignMember(
    campaignId: string,
    customerId: string,
    patch: { stage?: CampaignMember['stage']; invite_result?: string | null; round2_notes?: string | null },
    actor: ActorContext,
  ): Promise<CampaignMember> {
    const ts = nowIso();
    const idx = this.campaignMembers.findIndex(
      (m) => m.campaign_id === campaignId && m.customer_id === customerId,
    );
    if (idx === -1) {
      const created: CampaignMember = {
        id: crypto.randomUUID(),
        campaign_id: campaignId,
        customer_id: customerId,
        stage: patch.stage ?? 'imported',
        call_attempts: 0,
        last_call_at: null,
        invite_result: patch.invite_result ?? null,
        round2_notes: patch.round2_notes ?? null,
        created_at: ts,
        updated_at: ts,
      };
      this.campaignMembers.push(created);
      return created;
    }
    const existing = this.campaignMembers[idx]!;
    const updated: CampaignMember = {
      ...existing,
      stage: patch.stage ?? existing.stage,
      invite_result: patch.invite_result !== undefined ? patch.invite_result : existing.invite_result,
      round2_notes: patch.round2_notes !== undefined ? patch.round2_notes : existing.round2_notes,
      updated_at: ts,
    };
    this.campaignMembers[idx] = updated;
    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'campaign_member',
      entity_id: updated.id,
      action: `更新活动漏斗阶段为 ${updated.stage}`,
      before_state: { stage: existing.stage },
      after_state: { stage: updated.stage },
      metadata: { campaign_id: campaignId, customer_id: customerId },
    });
    return updated;
  }

  async listExternalLinks(customerId?: string): Promise<ExternalLink[]> {
    return customerId ? this.externalLinks.filter((l) => l.customer_id === customerId) : [...this.externalLinks];
  }

  async upsertExternalLink(link: Omit<ExternalLink, 'id' | 'created_at' | 'updated_at'>): Promise<ExternalLink> {
    const ts = nowIso();
    const idx = this.externalLinks.findIndex(
      (l) => l.system === link.system && l.external_id === link.external_id,
    );
    if (idx !== -1) {
      const updated: ExternalLink = { ...this.externalLinks[idx]!, ...link, updated_at: ts };
      this.externalLinks[idx] = updated;
      return updated;
    }
    const created: ExternalLink = { ...link, id: crypto.randomUUID(), created_at: ts, updated_at: ts };
    this.externalLinks.push(created);
    return created;
  }

  async listKjgxJobs(params?: { customer_id?: string; execution_status?: string; approval_status?: string }) {
    return this.kjgxJobs.filter((j) => {
      if (params?.customer_id && j.customer_id !== params.customer_id) return false;
      if (params?.execution_status && j.execution_status !== params.execution_status) return false;
      if (params?.approval_status && j.approval_status !== params.approval_status) return false;
      return true;
    });
  }

  async getKjgxJob(jobId: string): Promise<KjgxWritebackJob | null> {
    return this.kjgxJobs.find((j) => j.id === jobId) ?? null;
  }

  async enqueueKjgxJob(
    input: {
      customer_id: string;
      job_type: KjgxWritebackJob['job_type'];
      risk_level?: KjgxWritebackJob['risk_level'];
      idempotency_key: string;
      payload_before?: Record<string, unknown>;
      payload_target: Record<string, unknown>;
      field_diff?: KjgxFieldDiffItem[];
      validation_checks?: Record<string, unknown>;
      auto_approve?: boolean;
    },
    actor: ActorContext,
  ): Promise<KjgxWritebackJob> {
    const existing = this.kjgxJobs.find((j) => j.idempotency_key === input.idempotency_key);
    if (existing) return existing;

    const customer = this.customers.find((c) => c.id === input.customer_id);
    if (!customer) throw new NotFoundError(`Customer ${input.customer_id} not found`);

    const ts = nowIso();
    const job: KjgxWritebackJob = {
      id: crypto.randomUUID(),
      batch_id: `batch-${ts.slice(0, 10)}`,
      customer_id: input.customer_id,
      customer_name: customer.name,
      job_type: input.job_type,
      risk_level: input.risk_level ?? 'L2_profile_write',
      idempotency_key: input.idempotency_key,
      payload_before: input.payload_before ?? {},
      payload_target: input.payload_target,
      field_diff: input.field_diff ?? [],
      validation_checks: input.validation_checks ?? {},
      approval_status: input.auto_approve ? 'auto_approved' : 'pending_review',
      approved_by: input.auto_approve ? actor.actorId : null,
      approved_at: input.auto_approve ? ts : null,
      execution_status: 'queued',
      assigned_device: null,
      attempts: 0,
      max_attempts: 1,
      stage: input.auto_approve ? 'queued_for_worker' : 'awaiting_approval',
      receipt: null,
      created_by_actor: actor.actorId,
      created_at: ts,
      updated_at: ts,
    };
    this.kjgxJobs.unshift(job);
    return job;
  }

  async updateKjgxJob(jobId: string, patch: Partial<KjgxWritebackJob>, actor: ActorContext): Promise<KjgxWritebackJob> {
    const idx = this.kjgxJobs.findIndex((j) => j.id === jobId);
    if (idx === -1) throw new NotFoundError(`KJGX job ${jobId} not found`);
    const existing = this.kjgxJobs[idx]!;
    const updated: KjgxWritebackJob = { ...existing, ...patch, updated_at: nowIso() };
    this.kjgxJobs[idx] = updated;
    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'kjgx_writeback_jobs',
      entity_id: jobId,
      action: `更新回写任务状态: ${updated.approval_status}/${updated.execution_status}`,
      before_state: { approval_status: existing.approval_status, execution_status: existing.execution_status },
      after_state: { approval_status: updated.approval_status, execution_status: updated.execution_status },
      metadata: {},
    });
    return updated;
  }

  async listConflicts(status?: string): Promise<SyncConflict[]> {
    return status ? this.conflicts.filter((c) => c.status === status) : [...this.conflicts];
  }

  async createConflict(
    conflict: Omit<SyncConflict, 'id' | 'created_at' | 'resolved_by' | 'resolved_at'>,
  ): Promise<SyncConflict> {
    const created: SyncConflict = {
      ...conflict,
      id: crypto.randomUUID(),
      resolved_by: null,
      resolved_at: null,
      created_at: nowIso(),
    };
    this.conflicts.unshift(created);
    return created;
  }

  async resolveConflict(conflictId: string, input: ResolveConflictInput, actor: ActorContext): Promise<SyncConflict> {
    const idx = this.conflicts.findIndex((c) => c.id === conflictId);
    if (idx === -1) throw new NotFoundError(`Conflict ${conflictId} not found`);
    const cf = this.conflicts[idx]!;
    const ts = nowIso();
    const resolvedStatus: SyncConflict['status'] =
      input.resolution === 'keep_crm'
        ? 'resolved_keep_crm'
        : input.resolution === 'take_remote'
          ? 'resolved_take_remote'
          : 'resolved_custom';

    const chosenValue =
      input.resolution === 'keep_crm'
        ? cf.crm_value
        : input.resolution === 'take_remote'
          ? cf.remote_value
          : input.custom_value;

    if (cf.entity_type === 'customer') {
      const cust = this.customers.find((c) => c.id === cf.entity_id);
      if (cust) {
        if (input.resolution !== 'keep_crm' && cf.field_name in cust) {
          (cust as Record<string, unknown>)[cf.field_name] = chosenValue;
          cust.version += 1;
          cust.updated_at = ts;
        }
        const link = this.externalLinks.find((l) => l.customer_id === cust.id && l.system === cf.source_system);
        if (link) {
          link.sync_status = 'linked';
          link.last_synced_at = ts;
          link.last_synced_payload = { ...(link.last_synced_payload ?? {}), [cf.field_name]: chosenValue };
        }
      }
    }

    const updated: SyncConflict = {
      ...cf,
      status: resolvedStatus,
      resolved_by: actor.actorId,
      resolved_at: ts,
    };
    this.conflicts[idx] = updated;

    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'sync_conflicts',
      entity_id: conflictId,
      action: `仲裁同步冲突 (${cf.field_name}): ${resolvedStatus}`,
      before_state: { crm: cf.crm_value, remote: cf.remote_value },
      after_state: { chosen: chosenValue },
      metadata: {},
    });
    return updated;
  }

  async listStaging(status?: string): Promise<ImportStagingItem[]> {
    return status ? this.stagingItems.filter((s) => s.status === status) : [...this.stagingItems];
  }

  async stageImportDraft(
    input: {
      batch_id?: string;
      source_kind: ImportStagingItem['source_kind'];
      source_ref?: string | null;
      raw_payload?: Record<string, unknown>;
      normalized_draft: Record<string, unknown>;
      validation_warnings?: string[];
    },
    actor: ActorContext,
  ): Promise<ImportStagingItem> {
    const draftPhone = normalizePhone(String(input.normalized_draft.primary_phone ?? input.normalized_draft.phone ?? ''));
    const matched = draftPhone
      ? this.customers.find((c) => c.primary_phone === draftPhone && !c.deleted_at)
      : undefined;

    const item: ImportStagingItem = {
      id: crypto.randomUUID(),
      batch_id: input.batch_id ?? `batch-${nowIso().slice(0, 10)}`,
      source_kind: input.source_kind,
      source_ref: input.source_ref ?? null,
      raw_payload: input.raw_payload ?? {},
      normalized_draft: input.normalized_draft,
      matched_customer_id: matched?.id ?? null,
      match_reason: matched ? 'phone_exact' : 'new_candidate',
      validation_warnings: input.validation_warnings ?? [],
      status: 'pending_review',
      reviewed_by: null,
      reviewed_at: null,
      created_by_actor: actor.actorId,
      created_at: nowIso(),
    };
    this.stagingItems.unshift(item);
    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'import_staging',
      entity_id: item.id,
      action: `暂存导入草稿 (${input.source_kind})`,
      before_state: null,
      after_state: { match_reason: item.match_reason },
      metadata: {},
    });
    return item;
  }

  async commitStaging(stagingId: string, actor: ActorContext) {
    const idx = this.stagingItems.findIndex((s) => s.id === stagingId);
    if (idx === -1) throw new NotFoundError(`Staging item ${stagingId} not found`);
    const item = this.stagingItems[idx]!;
    const draft = item.normalized_draft;
    let customer: Customer;

    if (item.matched_customer_id) {
      const existing = this.customers.find((c) => c.id === item.matched_customer_id);
      if (!existing) throw new NotFoundError(`Matched customer ${item.matched_customer_id} missing`);
      if (typeof draft.note === 'string' && draft.note.trim()) {
        await this.logInteraction(
          existing.id,
          { channel: 'other', outcome: 'followed_up', summary: draft.note.trim() },
          actor,
        );
      }
      customer = existing;
      item.status = 'merged';
    } else {
      const res = await this.createCustomer(
        {
          name: String(draft.name ?? '未命名客户'),
          gender: (draft.gender as Customer['gender']) ?? '未知',
          birthday: typeof draft.birthday === 'string' ? draft.birthday : null,
          birthday_source:
            (draft.birthday_source as Customer['birthday_source']) ??
            (item.source_kind === 'family_card_ocr' ? 'handwritten_card' : 'manual'),
          primary_phone: String(draft.primary_phone ?? draft.phone ?? '') || null,
          address: typeof draft.address === 'string' ? draft.address : null,
          source_type: item.source_kind,
        },
        actor,
      );
      customer = res.created ? res.customer : res.duplicates[0]!;
      item.status = 'committed';
    }
    item.reviewed_by = actor.actorId;
    item.reviewed_at = nowIso();
    return { staging: item, customer };
  }

  async rejectStaging(stagingId: string, actor: ActorContext): Promise<ImportStagingItem> {
    const idx = this.stagingItems.findIndex((s) => s.id === stagingId);
    if (idx === -1) throw new NotFoundError(`Staging item ${stagingId} not found`);
    const item = this.stagingItems[idx]!;
    item.status = 'rejected';
    item.reviewed_by = actor.actorId;
    item.reviewed_at = nowIso();
    return item;
  }

  async listAuditLogs(limit = 30): Promise<AuditLogEntry[]> {
    return this.auditLogs.slice(0, limit);
  }

  async appendAudit(entry: Omit<AuditLogEntry, 'id' | 'created_at'>): Promise<AuditLogEntry> {
    const created: AuditLogEntry = {
      ...entry,
      id: crypto.randomUUID(),
      created_at: nowIso(),
    };
    this.auditLogs.unshift(created);
    return created;
  }

  async getDashboard() {
    const active = this.customers.filter((c) => c.status === 'active' && !c.deleted_at);
    const pendingJobs = this.kjgxJobs.filter((j) => j.approval_status === 'pending_review');
    const openConflicts = this.conflicts.filter((c) => c.status === 'open');
    const pendingStaging = this.stagingItems.filter((s) => s.status === 'pending_review');
    const followupsWithCust = this.followups.map((f) => ({
      ...f,
      customer_name: this.customers.find((c) => c.id === f.customer_id)?.name ?? '-',
    }));
    return {
      stats: {
        total_customers: active.length,
        hnw_customers: active.filter((c) => (c.total_premium ?? 0) >= 100000).length,
        pending_kjgx_jobs: pendingJobs.length,
        open_conflicts: openConflicts.length,
        pending_staging: pendingStaging.length,
      },
      followups: followupsWithCust,
      pending_jobs: this.kjgxJobs.slice(0, 5),
      recent_audit: this.auditLogs.slice(0, 10),
    };
  }
}

// ============================================================================
// POSTGRESQL 16 PRODUCTION STORE (Drizzle ORM)
// ============================================================================
function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function mapCustomerRow(r: typeof customers.$inferSelect): Customer {
  return {
    id: r.id,
    legacy_group_key: r.legacy_group_key,
    name: r.name,
    gender: (r.gender as Customer['gender']) ?? '未知',
    birthday: r.birthday,
    birthday_source: (r.birthday_source as Customer['birthday_source']) ?? 'unknown',
    age_override: r.age_override,
    primary_phone: r.primary_phone,
    phones: r.phones ?? [],
    address: r.address,
    company_or_occupation: r.company_or_occupation,
    family_members_count: r.family_members_count,
    id_no_masked: r.id_no_masked,
    id_no_checksum_ok: r.id_no_checksum_ok,
    kjgx_customer_no: r.kjgx_customer_no,
    kjgx_db_customer_id: r.kjgx_db_customer_id,
    kjgx_customer_level: r.kjgx_customer_level,
    kjgx_temp_level: r.kjgx_temp_level,
    kjgx_temp_value: toNum(r.kjgx_temp_value),
    kjgx_customer_status: r.kjgx_customer_status,
    kjgx_work_status: r.kjgx_work_status,
    kjgx_asset_index: toNum(r.kjgx_asset_index),
    kjgx_kyc_score: toNum(r.kjgx_kyc_score),
    kjgx_service_num: r.kjgx_service_num,
    kjgx_visit_num: r.kjgx_visit_num,
    kjgx_offline_visit_num: r.kjgx_offline_visit_num,
    kjgx_metrics_synced_at: r.kjgx_metrics_synced_at?.toISOString() ?? null,
    policy_total: r.policy_total,
    total_premium: toNum(r.total_premium),
    premium_bucket: r.premium_bucket,
    premium_status: r.premium_status,
    premium_source: r.premium_source,
    insurer_asset_wan: toNum(r.insurer_asset_wan),
    allocatable_quota_wan: toNum(r.allocatable_quota_wan),
    source_type: r.source_type,
    rapport_tag: (r.rapport_tag as Customer['rapport_tag']) ?? 'unassessed',
    visit_priority: (r.visit_priority as Customer['visit_priority']) ?? null,
    next_followup_at: r.next_followup_at?.toISOString() ?? null,
    manual_summary: r.manual_summary,
    tags: r.tags ?? [],
    data_quality_flags: r.data_quality_flags ?? [],
    field_provenance: r.field_provenance ?? {},
    status: (r.status as Customer['status']) ?? 'active',
    merged_into_id: r.merged_into_id,
    version: r.version,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    deleted_at: r.deleted_at?.toISOString() ?? null,
  };
}

function mapFollowupRow(r: typeof followups.$inferSelect): Followup {
  return {
    id: r.id,
    customer_id: r.customer_id,
    interaction_id: r.interaction_id,
    title: r.title,
    action_type: (r.action_type as Followup['action_type']) ?? 'call',
    due_at: r.due_at?.toISOString() ?? null,
    priority: (r.priority as Followup['priority']) ?? 'medium',
    status: (r.status as Followup['status']) ?? 'open',
    completed_at: r.completed_at?.toISOString() ?? null,
    notes: r.notes,
    icloud_reminder_id: r.icloud_reminder_id,
    icloud_list_id: r.icloud_list_id,
    icloud_etag: r.icloud_etag,
    last_synced_payload: r.last_synced_payload ?? null,
    sync_state: (r.sync_state as Followup['sync_state']) ?? 'pending_push',
    version: r.version,
    created_by_actor: r.created_by_actor,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

function mapJobRow(r: typeof kjgxWritebackJobs.$inferSelect, customerName?: string): KjgxWritebackJob {
  return {
    id: r.id,
    batch_id: r.batch_id,
    customer_id: r.customer_id,
    customer_name: customerName,
    job_type: r.job_type as KjgxWritebackJob['job_type'],
    risk_level: r.risk_level as KjgxWritebackJob['risk_level'],
    idempotency_key: r.idempotency_key,
    payload_before: r.payload_before ?? {},
    payload_target: r.payload_target,
    field_diff: r.field_diff ?? [],
    validation_checks: r.validation_checks ?? {},
    approval_status: r.approval_status as KjgxWritebackJob['approval_status'],
    approved_by: r.approved_by,
    approved_at: r.approved_at?.toISOString() ?? null,
    execution_status: r.execution_status as KjgxWritebackJob['execution_status'],
    assigned_device: r.assigned_device,
    attempts: r.attempts,
    max_attempts: r.max_attempts,
    stage: r.stage,
    receipt: (r.receipt as KjgxWritebackJob['receipt']) ?? null,
    created_by_actor: r.created_by_actor,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export class PostgresStore implements CrmStore {
  constructor(
    private readonly db: DbClient,
    private readonly vault: IdVault,
  ) {}

  async searchCustomers(params: SearchCustomersParams) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const conds = [eq(customers.status, 'active'), isNull(customers.deleted_at)];
    if (params.query?.trim()) {
      const q = `%${params.query.trim()}%`;
      conds.push(
        or(
          ilike(customers.name, q),
          ilike(customers.primary_phone, q),
          ilike(customers.address, q),
          ilike(customers.manual_summary, q),
        )!,
      );
    }
    if (params.min_premium != null) {
      conds.push(gte(customers.total_premium, String(params.min_premium)));
    }
    if (params.rapport_tag) conds.push(eq(customers.rapport_tag, params.rapport_tag));
    if (params.source_type) conds.push(eq(customers.source_type, params.source_type));
    if (params.has_quality_flag) {
      conds.push(sql`cardinality(${customers.data_quality_flags}) > 0`);
    }
    const whereClause = and(...conds);
    const [countRows, rows] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int` }).from(customers).where(whereClause),
      this.db
        .select()
        .from(customers)
        .where(whereClause)
        .orderBy(desc(customers.total_premium))
        .limit(limit),
    ]);

    const total = countRows[0]?.count ?? rows.length;
    return {
      customers: rows.map(mapCustomerRow),
      total,
      truncated: total > rows.length,
    };
  }

  async getCustomer360(customerId: string): Promise<Customer360> {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deleted_at)));
    if (!row) throw new NotFoundError(`Customer ${customerId} not found`);

    const [pols, ints, fus, links, jobs, cfs] = await Promise.all([
      this.db.select().from(policies).where(eq(policies.customer_id, customerId)),
      this.db
        .select()
        .from(interactions)
        .where(eq(interactions.customer_id, customerId))
        .orderBy(desc(interactions.occurred_at))
        .limit(20),
      this.db.select().from(followups).where(eq(followups.customer_id, customerId)),
      this.db.select().from(externalLinks).where(eq(externalLinks.customer_id, customerId)),
      this.db
        .select()
        .from(kjgxWritebackJobs)
        .where(and(eq(kjgxWritebackJobs.customer_id, customerId), ne(kjgxWritebackJobs.execution_status, 'cancelled'))),
      this.db
        .select()
        .from(syncConflicts)
        .where(and(eq(syncConflicts.entity_id, customerId), eq(syncConflicts.status, 'open'))),
    ]);

    return {
      customer: mapCustomerRow(row),
      policies: pols.map((p) => ({
        id: p.id,
        customer_id: p.customer_id,
        policy_no: p.policy_no,
        insurer: p.insurer,
        product_name: p.product_name,
        holder_role: (p.holder_role as Policy['holder_role']) ?? '投保人',
        effective_date: p.effective_date,
        annual_premium: toNum(p.annual_premium),
        payment_term: p.payment_term,
        policy_status: p.policy_status,
        is_orphan_policy: p.is_orphan_policy,
        coverage_gap_note: p.coverage_gap_note,
        source: p.source,
        version: p.version,
        created_at: p.created_at.toISOString(),
        updated_at: p.updated_at.toISOString(),
      })),
      interactions: ints.map((i) => ({
        id: i.id,
        customer_id: i.customer_id,
        campaign_id: i.campaign_id,
        channel: i.channel as Interaction['channel'],
        occurred_at: i.occurred_at.toISOString(),
        outcome: i.outcome as Interaction['outcome'],
        summary: i.summary,
        attitude_note: i.attitude_note,
        need_signals: i.need_signals ?? [],
        enqueue_kjgx_visit: i.enqueue_kjgx_visit,
        recorded_by_actor: i.recorded_by_actor,
        created_at: i.created_at.toISOString(),
      })),
      followups: fus.map(mapFollowupRow),
      external_links: links.map((l) => ({
        id: l.id,
        customer_id: l.customer_id,
        system: l.system as ExternalLink['system'],
        external_id: l.external_id,
        secondary_key: l.secondary_key,
        remote_etag: l.remote_etag,
        last_synced_hash: l.last_synced_hash,
        last_synced_payload: l.last_synced_payload ?? null,
        sync_status: l.sync_status as ExternalLink['sync_status'],
        last_synced_at: l.last_synced_at?.toISOString() ?? null,
        created_at: l.created_at.toISOString(),
        updated_at: l.updated_at.toISOString(),
      })),
      pending_jobs: jobs.map((j) => mapJobRow(j, row.name)),
      open_conflicts: cfs.map((c) => ({
        id: c.id,
        entity_type: c.entity_type as SyncConflict['entity_type'],
        entity_id: c.entity_id,
        customer_name: row.name,
        source_system: c.source_system as SyncConflict['source_system'],
        field_name: c.field_name,
        base_value: c.base_value,
        crm_value: c.crm_value,
        remote_value: c.remote_value,
        remote_etag: c.remote_etag,
        status: c.status as SyncConflict['status'],
        resolved_by: c.resolved_by,
        resolved_at: c.resolved_at?.toISOString() ?? null,
        created_at: c.created_at.toISOString(),
      })),
    };
  }

  async createCustomer(input: CreateCustomerInput, actor: ActorContext) {
    const phoneNorm = input.primary_phone ? normalizePhone(input.primary_phone) || null : null;
    const sealed = input.id_no ? this.vault.seal(input.id_no) : null;

    const dupConds = [];
    if (phoneNorm) dupConds.push(eq(customers.primary_phone, phoneNorm));
    if (sealed?.hmac) dupConds.push(eq(customers.id_no_hmac, sealed.hmac));
    if (dupConds.length > 0) {
      const dups = await this.db
        .select()
        .from(customers)
        .where(and(eq(customers.status, 'active'), isNull(customers.deleted_at), or(...dupConds)!));
      if (dups.length > 0) {
        return { created: false as const, duplicates: dups.map(mapCustomerRow) };
      }
    }

    const [inserted] = await this.db
      .insert(customers)
      .values({
        name: input.name.trim(),
        gender: input.gender ?? '未知',
        birthday: input.birthday ?? null,
        birthday_source: input.birthday_source ?? 'unknown',
        primary_phone: phoneNorm,
        phones: input.phones?.length
          ? input.phones
          : phoneNorm
            ? [{ value: phoneNorm, label: 'mobile', is_primary: true }]
            : [],
        address: input.address ?? null,
        company_or_occupation: input.company_or_occupation ?? null,
        family_members_count: input.family_members_count ?? null,
        id_no_encrypted: sealed?.encrypted ?? null,
        id_no_masked: sealed?.masked ?? null,
        id_no_hmac: sealed?.hmac ?? null,
        id_no_checksum_ok: sealed?.checksumOk ?? null,
        source_type: input.source_type ?? 'manual',
        rapport_tag: input.rapport_tag ?? 'unassessed',
        visit_priority: input.visit_priority ?? null,
        manual_summary: input.manual_summary ?? null,
        tags: input.tags ?? (input.icloud_group ? [input.icloud_group] : []),
        field_provenance: { created_by: actor.actorId },
      })
      .returning();

    const mapped = mapCustomerRow(inserted!);
    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'customer',
      entity_id: mapped.id,
      action: `新建客户 ${mapped.name}`,
      before_state: null,
      after_state: { name: mapped.name, primary_phone: mapped.primary_phone },
      metadata: {},
    });
    return { created: true as const, customer: mapped };
  }

  async updateCustomer(customerId: string, input: UpdateCustomerInput, actor: ActorContext): Promise<Customer> {
    const [existing] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deleted_at)));
    if (!existing) throw new NotFoundError(`Customer ${customerId} not found`);

    const before: Record<string, unknown> = {
      name: existing.name,
      primary_phone: existing.primary_phone,
      address: existing.address,
      birthday: existing.birthday,
      company_or_occupation: existing.company_or_occupation,
    };

    const nextPhone = input.primary_phone !== undefined ? normalizePhone(input.primary_phone) || null : existing.primary_phone;
    const [updatedRow] = await this.db
      .update(customers)
      .set({
        name: input.name ?? existing.name,
        gender: input.gender ?? existing.gender,
        birthday: input.birthday !== undefined ? input.birthday : existing.birthday,
        birthday_source: input.birthday_source ?? existing.birthday_source,
        primary_phone: nextPhone,
        phones: input.phones ?? existing.phones,
        address: input.address !== undefined ? input.address : existing.address,
        company_or_occupation:
          input.company_or_occupation !== undefined ? input.company_or_occupation : existing.company_or_occupation,
        family_members_count:
          input.family_members_count !== undefined ? input.family_members_count : existing.family_members_count,
        rapport_tag: input.rapport_tag ?? existing.rapport_tag,
        visit_priority: input.visit_priority !== undefined ? input.visit_priority : existing.visit_priority,
        next_followup_at:
          input.next_followup_at !== undefined
            ? input.next_followup_at
              ? new Date(input.next_followup_at)
              : null
            : existing.next_followup_at,
        manual_summary: input.manual_summary !== undefined ? input.manual_summary : existing.manual_summary,
        tags: input.tags ?? existing.tags,
        field_provenance: { ...existing.field_provenance, last_updated_by: actor.actorId, last_updated_at: nowIso() },
        version: sql`${customers.version} + 1`,
      })
      .where(and(eq(customers.id, customerId), eq(customers.version, input.expected_version)))
      .returning();

    if (!updatedRow) {
      const [latest] = await this.db.select().from(customers).where(eq(customers.id, customerId));
      throw new ConflictError(`Version mismatch on customer ${customerId}`, latest ? mapCustomerRow(latest) : undefined);
    }

    const updated = mapCustomerRow(updatedRow);
    const after: Record<string, unknown> = {
      name: updated.name,
      primary_phone: updated.primary_phone,
      address: updated.address,
      birthday: updated.birthday,
      company_or_occupation: updated.company_or_occupation,
    };

    const diffs = computeDiff(before, after, {
      name: '姓名',
      primary_phone: '手机',
      address: '联系地址',
      birthday: '出生日期',
      company_or_occupation: '职业/单位',
    });

    if (input.enqueue_kjgx_writeback && diffs.length > 0) {
      await this.enqueueKjgxJob(
        {
          customer_id: updated.id,
          job_type: updated.kjgx_customer_no ? 'update_profile' : 'create_customer',
          idempotency_key: `profile-${updated.id}-v${updated.version}`,
          payload_before: before,
          payload_target: after,
          field_diff: diffs,
          validation_checks: { phone_valid: Boolean(updated.primary_phone) },
        },
        actor,
      );
    }

    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'customer',
      entity_id: updated.id,
      action: `更新客户 ${updated.name} (v${updated.version})`,
      before_state: before,
      after_state: after,
      metadata: {},
    });
    return updated;
  }

  async logInteraction(customerId: string, input: CreateInteractionInput, actor: ActorContext) {
    const [cust] = await this.db.select().from(customers).where(eq(customers.id, customerId));
    if (!cust) throw new NotFoundError(`Customer ${customerId} not found`);

    const [row] = await this.db
      .insert(interactions)
      .values({
        customer_id: customerId,
        campaign_id: input.campaign_id ?? null,
        channel: input.channel,
        occurred_at: input.occurred_at ? new Date(input.occurred_at) : new Date(),
        outcome: input.outcome,
        summary: input.summary.trim(),
        attitude_note: input.attitude_note ?? null,
        need_signals: input.need_signals ?? [],
        enqueue_kjgx_visit: input.enqueue_kjgx_visit ?? false,
        recorded_by_actor: actor.actorId,
      })
      .returning();

    const interaction: Interaction = {
      id: row!.id,
      customer_id: row!.customer_id,
      campaign_id: row!.campaign_id,
      channel: row!.channel as Interaction['channel'],
      occurred_at: row!.occurred_at.toISOString(),
      outcome: row!.outcome as Interaction['outcome'],
      summary: row!.summary,
      attitude_note: row!.attitude_note,
      need_signals: row!.need_signals ?? [],
      enqueue_kjgx_visit: row!.enqueue_kjgx_visit,
      recorded_by_actor: row!.recorded_by_actor,
      created_at: row!.created_at.toISOString(),
    };

    let followup: Followup | undefined;
    if (input.followup_title?.trim()) {
      followup = await this.upsertFollowup(
        {
          customer_id: customerId,
          interaction_id: interaction.id,
          title: input.followup_title.trim(),
          due_at: input.followup_due_at ?? null,
          priority: 'high',
          status: 'open',
        },
        actor,
      );
    }

    let kjgxJob: KjgxWritebackJob | undefined;
    if (input.enqueue_kjgx_visit) {
      kjgxJob = await this.enqueueKjgxJob(
        {
          customer_id: customerId,
          job_type: 'log_visit',
          idempotency_key: `visit-${interaction.id}`,
          payload_target: {
            customer_no: cust.kjgx_customer_no,
            channel: input.channel,
            outcome: input.outcome,
            visit_note: interaction.summary,
          },
          field_diff: [{ field: '拜访备注', before: '(追加)', after: interaction.summary.slice(0, 60) }],
          validation_checks: { identity_matched: Boolean(cust.kjgx_customer_no || cust.kjgx_db_customer_id) },
        },
        actor,
      );
    }

    return { interaction, followup, kjgx_job: kjgxJob };
  }

  async listFollowups(params?: { status?: string; customer_id?: string }): Promise<Followup[]> {
    const conds = [];
    if (params?.status) conds.push(eq(followups.status, params.status));
    if (params?.customer_id) conds.push(eq(followups.customer_id, params.customer_id));
    const rows = conds.length
      ? await this.db.select().from(followups).where(and(...conds))
      : await this.db.select().from(followups);
    return rows.map(mapFollowupRow);
  }

  async upsertFollowup(input: UpsertFollowupInput, actor: ActorContext): Promise<Followup> {
    if (input.id) {
      const [existing] = await this.db.select().from(followups).where(eq(followups.id, input.id));
      if (!existing) throw new NotFoundError(`Followup ${input.id} not found`);
      const nextStatus = input.status ?? existing.status;
      const conds = [eq(followups.id, input.id)];
      if (input.expected_version != null) conds.push(eq(followups.version, input.expected_version));
      const [updated] = await this.db
        .update(followups)
        .set({
          title: input.title ?? existing.title,
          action_type: input.action_type ?? existing.action_type,
          due_at: input.due_at !== undefined ? (input.due_at ? new Date(input.due_at) : null) : existing.due_at,
          priority: input.priority ?? existing.priority,
          status: nextStatus,
          completed_at: nextStatus === 'done' ? existing.completed_at ?? new Date() : null,
          notes: input.notes !== undefined ? input.notes : existing.notes,
          sync_state: 'pending_push',
          version: sql`${followups.version} + 1`,
        })
        .where(and(...conds))
        .returning();
      if (!updated) throw new ConflictError('Followup version mismatch');
      return mapFollowupRow(updated);
    }

    const [created] = await this.db
      .insert(followups)
      .values({
        customer_id: input.customer_id,
        interaction_id: input.interaction_id ?? null,
        title: input.title.trim(),
        action_type: input.action_type ?? 'call',
        due_at: input.due_at ? new Date(input.due_at) : null,
        priority: input.priority ?? 'medium',
        status: input.status ?? 'open',
        completed_at: input.status === 'done' ? new Date() : null,
        notes: input.notes ?? null,
        icloud_list_id: '工作待办 Work',
        sync_state: 'pending_push',
        created_by_actor: actor.actorId,
      })
      .returning();
    return mapFollowupRow(created!);
  }

  async listCampaigns() {
    const camps = await this.db.select().from(campaigns);
    const members = await this.db.select().from(campaignMembers);
    const custRows = await this.db.select({ id: customers.id, name: customers.name }).from(customers);
    const nameMap = new Map(custRows.map((c) => [c.id, c.name]));

    return camps.map((c) => ({
      id: c.id,
      name: c.name,
      source_name: c.source_name,
      event_date: c.event_date?.toISOString() ?? null,
      status: c.status as Campaign['status'],
      notes: c.notes,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
      members: members
        .filter((m) => m.campaign_id === c.id)
        .map((m) => ({
          id: m.id,
          campaign_id: m.campaign_id,
          customer_id: m.customer_id,
          stage: m.stage as CampaignMember['stage'],
          call_attempts: m.call_attempts,
          last_call_at: m.last_call_at?.toISOString() ?? null,
          invite_result: m.invite_result,
          round2_notes: m.round2_notes,
          created_at: m.created_at.toISOString(),
          updated_at: m.updated_at.toISOString(),
          customer_name: nameMap.get(m.customer_id) ?? '-',
        })),
    }));
  }

  async filterCandidates(params: FilterCandidatesParams) {
    const res = await this.searchCustomers({
      min_premium: params.min_premium,
      limit: params.limit,
    });
    const members = await this.db.select().from(campaignMembers);
    const out: Array<{ customer: Customer; member?: CampaignMember }> = [];
    for (const c of res.customers) {
      if (params.gender && c.gender !== params.gender) continue;
      if (params.exclude_paused && c.rapport_tag === 'paused') continue;
      if (params.max_age != null && (c.age_override ?? 0) > params.max_age) continue;
      const m = members.find(
        (x) => x.customer_id === c.id && (!params.campaign_id || x.campaign_id === params.campaign_id),
      );
      if (params.stage && m?.stage !== params.stage) continue;
      out.push({
        customer: c,
        member: m
          ? {
              id: m.id,
              campaign_id: m.campaign_id,
              customer_id: m.customer_id,
              stage: m.stage as CampaignMember['stage'],
              call_attempts: m.call_attempts,
              last_call_at: m.last_call_at?.toISOString() ?? null,
              invite_result: m.invite_result,
              round2_notes: m.round2_notes,
              created_at: m.created_at.toISOString(),
              updated_at: m.updated_at.toISOString(),
            }
          : undefined,
      });
    }
    return out;
  }

  async updateCampaignMember(
    campaignId: string,
    customerId: string,
    patch: { stage?: CampaignMember['stage']; invite_result?: string | null; round2_notes?: string | null },
    actor: ActorContext,
  ): Promise<CampaignMember> {
    const [existing] = await this.db
      .select()
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaign_id, campaignId), eq(campaignMembers.customer_id, customerId)));

    const row = existing
      ? (
          await this.db
            .update(campaignMembers)
            .set({
              stage: patch.stage ?? existing.stage,
              invite_result: patch.invite_result !== undefined ? patch.invite_result : existing.invite_result,
              round2_notes: patch.round2_notes !== undefined ? patch.round2_notes : existing.round2_notes,
            })
            .where(eq(campaignMembers.id, existing.id))
            .returning()
        )[0]!
      : (
          await this.db
            .insert(campaignMembers)
            .values({
              campaign_id: campaignId,
              customer_id: customerId,
              stage: patch.stage ?? 'imported',
              invite_result: patch.invite_result ?? null,
              round2_notes: patch.round2_notes ?? null,
            })
            .returning()
        )[0]!;

    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'campaign_member',
      entity_id: row.id,
      action: `更新活动漏斗阶段为 ${row.stage}`,
      before_state: null,
      after_state: { stage: row.stage },
      metadata: { campaign_id: campaignId, customer_id: customerId },
    });

    return {
      id: row.id,
      campaign_id: row.campaign_id,
      customer_id: row.customer_id,
      stage: row.stage as CampaignMember['stage'],
      call_attempts: row.call_attempts,
      last_call_at: row.last_call_at?.toISOString() ?? null,
      invite_result: row.invite_result,
      round2_notes: row.round2_notes,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }

  async listExternalLinks(customerId?: string): Promise<ExternalLink[]> {
    const rows = customerId
      ? await this.db.select().from(externalLinks).where(eq(externalLinks.customer_id, customerId))
      : await this.db.select().from(externalLinks);
    return rows.map((l) => ({
      id: l.id,
      customer_id: l.customer_id,
      system: l.system as ExternalLink['system'],
      external_id: l.external_id,
      secondary_key: l.secondary_key,
      remote_etag: l.remote_etag,
      last_synced_hash: l.last_synced_hash,
      last_synced_payload: l.last_synced_payload ?? null,
      sync_status: l.sync_status as ExternalLink['sync_status'],
      last_synced_at: l.last_synced_at?.toISOString() ?? null,
      created_at: l.created_at.toISOString(),
      updated_at: l.updated_at.toISOString(),
    }));
  }

  async upsertExternalLink(link: Omit<ExternalLink, 'id' | 'created_at' | 'updated_at'>): Promise<ExternalLink> {
    const [row] = await this.db
      .insert(externalLinks)
      .values({
        customer_id: link.customer_id,
        system: link.system,
        external_id: link.external_id,
        secondary_key: link.secondary_key,
        remote_etag: link.remote_etag,
        last_synced_hash: link.last_synced_hash,
        last_synced_payload: link.last_synced_payload,
        sync_status: link.sync_status,
        last_synced_at: link.last_synced_at ? new Date(link.last_synced_at) : null,
      })
      .onConflictDoUpdate({
        target: [externalLinks.system, externalLinks.external_id],
        set: {
          remote_etag: link.remote_etag,
          last_synced_hash: link.last_synced_hash,
          last_synced_payload: link.last_synced_payload,
          sync_status: link.sync_status,
          last_synced_at: link.last_synced_at ? new Date(link.last_synced_at) : null,
        },
      })
      .returning();

    return {
      id: row!.id,
      customer_id: row!.customer_id,
      system: row!.system as ExternalLink['system'],
      external_id: row!.external_id,
      secondary_key: row!.secondary_key,
      remote_etag: row!.remote_etag,
      last_synced_hash: row!.last_synced_hash,
      last_synced_payload: row!.last_synced_payload ?? null,
      sync_status: row!.sync_status as ExternalLink['sync_status'],
      last_synced_at: row!.last_synced_at?.toISOString() ?? null,
      created_at: row!.created_at.toISOString(),
      updated_at: row!.updated_at.toISOString(),
    };
  }

  private async loadCustomerNameMap(ids: string[]): Promise<Map<string, string>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (uniq.length === 0) return new Map();
    const rows = await this.db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, uniq));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async listKjgxJobs(params?: { customer_id?: string; execution_status?: string; approval_status?: string }) {
    const conds = [];
    if (params?.customer_id) conds.push(eq(kjgxWritebackJobs.customer_id, params.customer_id));
    if (params?.execution_status) conds.push(eq(kjgxWritebackJobs.execution_status, params.execution_status));
    if (params?.approval_status) conds.push(eq(kjgxWritebackJobs.approval_status, params.approval_status));
    const rows = conds.length
      ? await this.db.select().from(kjgxWritebackJobs).where(and(...conds)).orderBy(desc(kjgxWritebackJobs.created_at))
      : await this.db.select().from(kjgxWritebackJobs).orderBy(desc(kjgxWritebackJobs.created_at));
    const nameMap = await this.loadCustomerNameMap(rows.map((r) => r.customer_id));
    return rows.map((r) => mapJobRow(r, nameMap.get(r.customer_id)));
  }

  async getKjgxJob(jobId: string): Promise<KjgxWritebackJob | null> {
    const [row] = await this.db.select().from(kjgxWritebackJobs).where(eq(kjgxWritebackJobs.id, jobId));
    return row ? mapJobRow(row) : null;
  }

  async enqueueKjgxJob(
    input: {
      customer_id: string;
      job_type: KjgxWritebackJob['job_type'];
      risk_level?: KjgxWritebackJob['risk_level'];
      idempotency_key: string;
      payload_before?: Record<string, unknown>;
      payload_target: Record<string, unknown>;
      field_diff?: KjgxFieldDiffItem[];
      validation_checks?: Record<string, unknown>;
      auto_approve?: boolean;
    },
    actor: ActorContext,
  ): Promise<KjgxWritebackJob> {
    const [existing] = await this.db
      .select()
      .from(kjgxWritebackJobs)
      .where(eq(kjgxWritebackJobs.idempotency_key, input.idempotency_key));
    if (existing) return mapJobRow(existing);

    const [row] = await this.db
      .insert(kjgxWritebackJobs)
      .values({
        batch_id: `batch-${nowIso().slice(0, 10)}`,
        customer_id: input.customer_id,
        job_type: input.job_type,
        risk_level: input.risk_level ?? 'L2_profile_write',
        idempotency_key: input.idempotency_key,
        payload_before: input.payload_before ?? {},
        payload_target: input.payload_target,
        field_diff: input.field_diff ?? [],
        validation_checks: input.validation_checks ?? {},
        approval_status: input.auto_approve ? 'auto_approved' : 'pending_review',
        approved_by: input.auto_approve ? actor.actorId : null,
        approved_at: input.auto_approve ? new Date() : null,
        execution_status: 'queued',
        max_attempts: 1,
        stage: input.auto_approve ? 'queued_for_worker' : 'awaiting_approval',
        created_by_actor: actor.actorId,
      })
      .returning();
    return mapJobRow(row!);
  }

  async updateKjgxJob(jobId: string, patch: Partial<KjgxWritebackJob>, actor: ActorContext): Promise<KjgxWritebackJob> {
    const [row] = await this.db
      .update(kjgxWritebackJobs)
      .set({
        approval_status: patch.approval_status,
        approved_by: patch.approved_by,
        approved_at: patch.approved_at ? new Date(patch.approved_at) : undefined,
        execution_status: patch.execution_status,
        assigned_device: patch.assigned_device,
        attempts: patch.attempts,
        stage: patch.stage,
        receipt: patch.receipt as Record<string, unknown> | null | undefined,
      })
      .where(eq(kjgxWritebackJobs.id, jobId))
      .returning();
    if (!row) throw new NotFoundError(`KJGX job ${jobId} not found`);

    await this.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'kjgx_writeback_jobs',
      entity_id: jobId,
      action: `更新回写任务状态: ${row.approval_status}/${row.execution_status}`,
      before_state: null,
      after_state: { approval_status: row.approval_status, execution_status: row.execution_status },
      metadata: {},
    });
    return mapJobRow(row);
  }

  async listConflicts(status?: string): Promise<SyncConflict[]> {
    const rows = status
      ? await this.db.select().from(syncConflicts).where(eq(syncConflicts.status, status))
      : await this.db.select().from(syncConflicts);
    const nameMap = await this.loadCustomerNameMap(
      rows.filter((c) => c.entity_type === 'customer').map((c) => c.entity_id),
    );
    return rows.map((c) => ({
      id: c.id,
      entity_type: c.entity_type as SyncConflict['entity_type'],
      entity_id: c.entity_id,
      customer_name: c.entity_type === 'customer' ? nameMap.get(c.entity_id) : undefined,
      source_system: c.source_system as SyncConflict['source_system'],
      field_name: c.field_name,
      base_value: c.base_value,
      crm_value: c.crm_value,
      remote_value: c.remote_value,
      remote_etag: c.remote_etag,
      status: c.status as SyncConflict['status'],
      resolved_by: c.resolved_by,
      resolved_at: c.resolved_at?.toISOString() ?? null,
      created_at: c.created_at.toISOString(),
    }));
  }

  async createConflict(
    conflict: Omit<SyncConflict, 'id' | 'created_at' | 'resolved_by' | 'resolved_at'>,
  ): Promise<SyncConflict> {
    const [row] = await this.db
      .insert(syncConflicts)
      .values({
        entity_type: conflict.entity_type,
        entity_id: conflict.entity_id,
        source_system: conflict.source_system,
        field_name: conflict.field_name,
        base_value: conflict.base_value ?? null,
        crm_value: conflict.crm_value ?? null,
        remote_value: conflict.remote_value ?? null,
        remote_etag: conflict.remote_etag ?? null,
        status: conflict.status,
      })
      .returning();
    return {
      id: row!.id,
      entity_type: row!.entity_type as SyncConflict['entity_type'],
      entity_id: row!.entity_id,
      source_system: row!.source_system as SyncConflict['source_system'],
      field_name: row!.field_name,
      base_value: row!.base_value,
      crm_value: row!.crm_value,
      remote_value: row!.remote_value,
      remote_etag: row!.remote_etag,
      status: row!.status as SyncConflict['status'],
      resolved_by: row!.resolved_by,
      resolved_at: row!.resolved_at?.toISOString() ?? null,
      created_at: row!.created_at.toISOString(),
    };
  }

  async resolveConflict(conflictId: string, input: ResolveConflictInput, actor: ActorContext): Promise<SyncConflict> {
    const [cf] = await this.db.select().from(syncConflicts).where(eq(syncConflicts.id, conflictId));
    if (!cf) throw new NotFoundError(`Conflict ${conflictId} not found`);

    const resolvedStatus: SyncConflict['status'] =
      input.resolution === 'keep_crm'
        ? 'resolved_keep_crm'
        : input.resolution === 'take_remote'
          ? 'resolved_take_remote'
          : 'resolved_custom';

    const chosenValue =
      input.resolution === 'keep_crm'
        ? cf.crm_value
        : input.resolution === 'take_remote'
          ? cf.remote_value
          : input.custom_value;

    if (cf.entity_type === 'customer' && input.resolution !== 'keep_crm') {
      if (cf.field_name === 'address') {
        await this.db
          .update(customers)
          .set({ address: String(chosenValue ?? ''), version: sql`${customers.version} + 1` })
          .where(eq(customers.id, cf.entity_id));
      } else if (cf.field_name === 'primary_phone') {
        await this.db
          .update(customers)
          .set({ primary_phone: String(chosenValue ?? ''), version: sql`${customers.version} + 1` })
          .where(eq(customers.id, cf.entity_id));
      }
    }

    const [updated] = await this.db
      .update(syncConflicts)
      .set({ status: resolvedStatus, resolved_by: actor.actorId, resolved_at: new Date() })
      .where(eq(syncConflicts.id, conflictId))
      .returning();

    return {
      id: updated!.id,
      entity_type: updated!.entity_type as SyncConflict['entity_type'],
      entity_id: updated!.entity_id,
      source_system: updated!.source_system as SyncConflict['source_system'],
      field_name: updated!.field_name,
      base_value: updated!.base_value,
      crm_value: updated!.crm_value,
      remote_value: updated!.remote_value,
      remote_etag: updated!.remote_etag,
      status: updated!.status as SyncConflict['status'],
      resolved_by: updated!.resolved_by,
      resolved_at: updated!.resolved_at?.toISOString() ?? null,
      created_at: updated!.created_at.toISOString(),
    };
  }

  async listStaging(status?: string): Promise<ImportStagingItem[]> {
    const rows = status
      ? await this.db.select().from(importStaging).where(eq(importStaging.status, status))
      : await this.db.select().from(importStaging);
    return rows.map((s) => ({
      id: s.id,
      batch_id: s.batch_id,
      source_kind: s.source_kind as ImportStagingItem['source_kind'],
      source_ref: s.source_ref,
      raw_payload: s.raw_payload,
      normalized_draft: s.normalized_draft,
      matched_customer_id: s.matched_customer_id,
      match_reason: s.match_reason,
      validation_warnings: s.validation_warnings ?? [],
      status: s.status as ImportStagingItem['status'],
      reviewed_by: s.reviewed_by,
      reviewed_at: s.reviewed_at?.toISOString() ?? null,
      created_by_actor: s.created_by_actor,
      created_at: s.created_at.toISOString(),
    }));
  }

  async stageImportDraft(
    input: {
      batch_id?: string;
      source_kind: ImportStagingItem['source_kind'];
      source_ref?: string | null;
      raw_payload?: Record<string, unknown>;
      normalized_draft: Record<string, unknown>;
      validation_warnings?: string[];
    },
    actor: ActorContext,
  ): Promise<ImportStagingItem> {
    const draftPhone = normalizePhone(String(input.normalized_draft.primary_phone ?? input.normalized_draft.phone ?? ''));
    let matchedId: string | null = null;
    if (draftPhone) {
      const [m] = await this.db.select({ id: customers.id }).from(customers).where(eq(customers.primary_phone, draftPhone));
      matchedId = m?.id ?? null;
    }

    const [row] = await this.db
      .insert(importStaging)
      .values({
        batch_id: input.batch_id ?? `batch-${nowIso().slice(0, 10)}`,
        source_kind: input.source_kind,
        source_ref: input.source_ref ?? null,
        raw_payload: input.raw_payload ?? {},
        normalized_draft: input.normalized_draft,
        matched_customer_id: matchedId,
        match_reason: matchedId ? 'phone_exact' : 'new_candidate',
        validation_warnings: input.validation_warnings ?? [],
        created_by_actor: actor.actorId,
      })
      .returning();

    return {
      id: row!.id,
      batch_id: row!.batch_id,
      source_kind: row!.source_kind as ImportStagingItem['source_kind'],
      source_ref: row!.source_ref,
      raw_payload: row!.raw_payload,
      normalized_draft: row!.normalized_draft,
      matched_customer_id: row!.matched_customer_id,
      match_reason: row!.match_reason,
      validation_warnings: row!.validation_warnings ?? [],
      status: row!.status as ImportStagingItem['status'],
      reviewed_by: row!.reviewed_by,
      reviewed_at: row!.reviewed_at?.toISOString() ?? null,
      created_by_actor: row!.created_by_actor,
      created_at: row!.created_at.toISOString(),
    };
  }

  async commitStaging(stagingId: string, actor: ActorContext) {
    const [row] = await this.db.select().from(importStaging).where(eq(importStaging.id, stagingId));
    if (!row) throw new NotFoundError(`Staging ${stagingId} not found`);

    const draft = row.normalized_draft;
    let customer: Customer;
    let nextStatus: ImportStagingItem['status'] = 'committed';

    if (row.matched_customer_id) {
      const [existing] = await this.db.select().from(customers).where(eq(customers.id, row.matched_customer_id));
      if (!existing) throw new NotFoundError('Matched customer missing');
      customer = mapCustomerRow(existing);
      nextStatus = 'merged';
    } else {
      const res = await this.createCustomer(
        {
          name: String(draft.name ?? '未命名客户'),
          primary_phone: String(draft.primary_phone ?? draft.phone ?? '') || null,
          birthday: typeof draft.birthday === 'string' ? draft.birthday : null,
          address: typeof draft.address === 'string' ? draft.address : null,
          source_type: row.source_kind,
        },
        actor,
      );
      customer = res.created ? res.customer : res.duplicates[0]!;
    }

    const [updated] = await this.db
      .update(importStaging)
      .set({ status: nextStatus, reviewed_by: actor.actorId, reviewed_at: new Date() })
      .where(eq(importStaging.id, stagingId))
      .returning();

    return {
      staging: {
        id: updated!.id,
        batch_id: updated!.batch_id,
        source_kind: updated!.source_kind as ImportStagingItem['source_kind'],
        source_ref: updated!.source_ref,
        raw_payload: updated!.raw_payload,
        normalized_draft: updated!.normalized_draft,
        matched_customer_id: updated!.matched_customer_id,
        match_reason: updated!.match_reason,
        validation_warnings: updated!.validation_warnings ?? [],
        status: updated!.status as ImportStagingItem['status'],
        reviewed_by: updated!.reviewed_by,
        reviewed_at: updated!.reviewed_at?.toISOString() ?? null,
        created_by_actor: updated!.created_by_actor,
        created_at: updated!.created_at.toISOString(),
      },
      customer,
    };
  }

  async rejectStaging(stagingId: string, actor: ActorContext): Promise<ImportStagingItem> {
    const [updated] = await this.db
      .update(importStaging)
      .set({ status: 'rejected', reviewed_by: actor.actorId, reviewed_at: new Date() })
      .where(eq(importStaging.id, stagingId))
      .returning();
    if (!updated) throw new NotFoundError(`Staging ${stagingId} not found`);
    return {
      id: updated.id,
      batch_id: updated.batch_id,
      source_kind: updated.source_kind as ImportStagingItem['source_kind'],
      source_ref: updated.source_ref,
      raw_payload: updated.raw_payload,
      normalized_draft: updated.normalized_draft,
      matched_customer_id: updated.matched_customer_id,
      match_reason: updated.match_reason,
      validation_warnings: updated.validation_warnings ?? [],
      status: updated.status as ImportStagingItem['status'],
      reviewed_by: updated.reviewed_by,
      reviewed_at: updated.reviewed_at?.toISOString() ?? null,
      created_by_actor: updated.created_by_actor,
      created_at: updated.created_at.toISOString(),
    };
  }

  async listAuditLogs(limit = 30): Promise<AuditLogEntry[]> {
    const rows = await this.db.select().from(auditLogs).orderBy(desc(auditLogs.created_at)).limit(limit);
    return rows.map((a) => ({
      id: a.id,
      actor_type: a.actor_type as AuditLogEntry['actor_type'],
      actor_id: a.actor_id,
      entity_type: a.entity_type,
      entity_id: a.entity_id,
      action: a.action,
      before_state: a.before_state,
      after_state: a.after_state,
      metadata: a.metadata ?? {},
      created_at: a.created_at.toISOString(),
    }));
  }

  async appendAudit(entry: Omit<AuditLogEntry, 'id' | 'created_at'>): Promise<AuditLogEntry> {
    const [row] = await this.db
      .insert(auditLogs)
      .values({
        actor_type: entry.actor_type,
        actor_id: entry.actor_id,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id ?? null,
        action: entry.action,
        before_state: entry.before_state ?? null,
        after_state: entry.after_state ?? null,
        metadata: entry.metadata ?? {},
      })
      .returning();
    return {
      id: row!.id,
      actor_type: row!.actor_type as AuditLogEntry['actor_type'],
      actor_id: row!.actor_id,
      entity_type: row!.entity_type,
      entity_id: row!.entity_id,
      action: row!.action,
      before_state: row!.before_state,
      after_state: row!.after_state,
      metadata: row!.metadata ?? {},
      created_at: row!.created_at.toISOString(),
    };
  }

  async getDashboard() {
    const [allCust, allFu, allJobs, openCfs, pendingStg, recentAudit] = await Promise.all([
      this.db.select().from(customers).where(and(eq(customers.status, 'active'), isNull(customers.deleted_at))),
      this.listFollowups(),
      this.listKjgxJobs(),
      this.listConflicts('open'),
      this.listStaging('pending_review'),
      this.listAuditLogs(10),
    ]);
    const nameMap = new Map(allCust.map((c) => [c.id, c.name]));
    return {
      stats: {
        total_customers: allCust.length,
        hnw_customers: allCust.filter((c) => Number(c.total_premium ?? 0) >= 100000).length,
        pending_kjgx_jobs: allJobs.filter((j) => j.approval_status === 'pending_review').length,
        open_conflicts: openCfs.length,
        pending_staging: pendingStg.length,
      },
      followups: allFu.map((f) => ({ ...f, customer_name: nameMap.get(f.customer_id) ?? '-' })),
      pending_jobs: allJobs.slice(0, 5),
      recent_audit: recentAudit,
    };
  }
}
