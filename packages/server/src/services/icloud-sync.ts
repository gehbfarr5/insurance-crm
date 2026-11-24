import {
  type Customer,
  type Followup,
  type ResolveConflictInput,
  computeThreeWayDiff,
  formatMuseReminderPayload,
  planCarddavFollowupNote,
  sanitizeCustomerForIcloud,
} from '@insurance-crm/shared';
import type { ActorContext, CrmStore } from './store.js';

export class IcloudWriteLockedError extends Error {
  readonly code = 'ICLOUD_WRITE_LOCKED';
  constructor(message = 'iCloud 通讯录写入闸门已锁定（仅允许人工预览，当前禁止向 iCloud 写入）') {
    super(message);
    this.name = 'IcloudWriteLockedError';
  }
}

export interface IcloudSyncOptions {
  contactsWriteEnabled?: boolean;
  remindersWriteEnabled?: boolean;
}

export interface IcloudMcpTransport {
  readonly isLive: boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class NoopIcloudMcpTransport implements IcloudMcpTransport {
  readonly isLive = false;
  async callTool(name: string): Promise<Record<string, unknown>> {
    return { noop: true, tool: name };
  }
}

export class HttpIcloudMcpTransport implements IcloudMcpTransport {
  readonly isLive = true;
  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.bearerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    if (!res.ok) {
      throw new Error(`iCloud MCP HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      result?: { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
      error?: { message?: string };
    };
    if (payload.error) {
      throw new Error(payload.error.message ?? 'iCloud MCP RPC error');
    }
    if (payload.result?.structuredContent) {
      return payload.result.structuredContent;
    }
    const txt = payload.result?.content?.[0]?.text;
    return txt ? (JSON.parse(txt) as Record<string, unknown>) : {};
  }
}

export interface IcloudPreviewItem {
  customer_id: string;
  customer_name: string;
  contact_link_status: string;
  write_gate_status: 'locked_preview_only' | 'enabled';
  planned_followup_note: string | null;
  sanitized_payload: ReturnType<typeof sanitizeCustomerForIcloud>;
  diff: ReturnType<typeof computeThreeWayDiff>;
  pending_reminders: Array<ReturnType<typeof formatMuseReminderPayload>>;
}

const CONTACT_SYNC_FIELDS = ['fullName', 'phones', 'birthday', 'address', 'company'];

const RAPPORT_SAFE_SUMMARY: Record<Customer['rapport_tag'], string> = {
  friendly: '沟通顺畅',
  neutral: '中性待观察',
  cautious: '需留心沟通节奏',
  paused: '暂缓投入',
  unassessed: '待初筛跟进',
};

function sanitizeSingleLine(raw: string | null | undefined, fallback: string, maxLen = 120): string {
  const cleaned = String(raw ?? '')
    .replace(/[\r\n|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function toSafeIsoDate(candidate: string | null | undefined, fallbackDate: string): string {
  const d = String(candidate ?? '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    return d;
  }
  return fallbackDate;
}

function toSafeMarkerId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (cleaned.length >= 3) return cleaned;
  return `crm_${cleaned.padEnd(3, '0')}`;
}

export class IcloudSyncService {
  constructor(
    private readonly store: CrmStore,
    private readonly transport: IcloudMcpTransport = new NoopIcloudMcpTransport(),
    private readonly opts: IcloudSyncOptions = {},
  ) {}

  get contactsWriteEnabled(): boolean {
    return this.opts.contactsWriteEnabled === true;
  }

  get remindersWriteEnabled(): boolean {
    return this.opts.remindersWriteEnabled === true;
  }

  async previewSync(customerId?: string, limit = 20): Promise<IcloudPreviewItem[]> {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 20, 1), 50);
    const targets: Customer[] = [];
    let singleCustomerLatestInteractionAt: string | null = null;
    if (customerId) {
      const detail = await this.store.getCustomer360(customerId);
      targets.push(detail.customer);
      singleCustomerLatestInteractionAt = detail.interactions[0]?.occurred_at ?? null;
    } else {
      const search = await this.store.searchCustomers({ limit: safeLimit });
      targets.push(...search.customers);
    }

    const [allLinks, allFollowups, openConflicts] = await Promise.all([
      this.store.listExternalLinks(customerId),
      this.store.listFollowups({ status: 'open', customer_id: customerId }),
      this.store.listConflicts('open'),
    ]);

    const todayUtc = new Date().toISOString().slice(0, 10);
    const gateStatus: IcloudPreviewItem['write_gate_status'] = this.contactsWriteEnabled
      ? 'enabled'
      : 'locked_preview_only';

    const items: IcloudPreviewItem[] = [];
    for (const c of targets) {
      const sanitized = sanitizeCustomerForIcloud(c);
      const link = allLinks.find((l) => l.customer_id === c.id && l.system === 'icloud_contact');
      const base = (link?.last_synced_payload ?? {}) as Record<string, unknown>;

      // Build remote state: use open conflict remote_value or live read if connected
      const remote: Record<string, unknown> = { ...base };
      if (this.transport.isLive && link?.external_id) {
        try {
          const remoteContact = await this.transport.callTool('contacts_read', { contact_id: link.external_id });
          if (remoteContact && !remoteContact.noop) {
            remote.fullName = (remoteContact.name as { full?: string } | undefined)?.full ?? remote.fullName;
            remote.address = remoteContact.address ?? remote.address;
            remote.birthday = remoteContact.birthday ?? remote.birthday;
            if (typeof remoteContact.note === 'string') {
              remote.note = remoteContact.note;
            }
          }
        } catch {
          // Keep stored snapshot if live read temporarily unavailable
        }
      }

      for (const cf of openConflicts) {
        if (cf.entity_id === c.id && cf.source_system === 'icloud_contact') {
          const mappedField = cf.field_name === 'primary_phone' ? 'phones' : cf.field_name;
          remote[mappedField] = cf.remote_value;
        }
      }

      const crmComparable: Record<string, unknown> = {
        fullName: sanitized.fullName,
        phones: sanitized.phones,
        birthday: sanitized.birthday,
        address: sanitized.address,
        company: sanitized.company,
      };
      const diff = computeThreeWayDiff(base, crmComparable, remote, CONTACT_SYNC_FIELDS);

      const custFollowups = allFollowups.filter((f: Followup) => f.customer_id === c.id);
      const primaryFollowup = custFollowups[0];
      const pendingReminders = custFollowups.map((f) =>
        formatMuseReminderPayload(f, c.name, c.legacy_group_key),
      );

      // Compute single-line [#FUP:<id>] preview preserving existing personal notes and privacy fence
      const existingNote =
        typeof remote.note === 'string'
          ? remote.note
          : typeof base.note === 'string'
            ? base.note
            : null;
      const markerId = toSafeMarkerId(primaryFollowup?.id ?? `crm-${c.id.slice(0, 8)}`);
      const markerDate = toSafeIsoDate(
        primaryFollowup?.due_at ?? singleCustomerLatestInteractionAt ?? c.next_followup_at ?? c.updated_at,
        todayUtc,
      );
      const markerKind = primaryFollowup ? '跟进' : '档案';
      const markerStatus = sanitizeSingleLine(
        primaryFollowup?.title ?? RAPPORT_SAFE_SUMMARY[c.rapport_tag],
        '待初筛跟进',
      );
      const plannedNote = planCarddavFollowupNote(existingNote, {
        id: markerId,
        date: markerDate,
        kind: markerKind,
        status: markerStatus,
      }).note;

      items.push({
        customer_id: c.id,
        customer_name: c.name,
        contact_link_status: link?.sync_status ?? 'unlinked',
        write_gate_status: gateStatus,
        planned_followup_note: plannedNote,
        sanitized_payload: sanitized,
        diff,
        pending_reminders: pendingReminders,
      });
    }
    return items;
  }

  async applySync(
    params: {
      customerId?: string;
      resolutions?: Array<{ conflict_id: string } & ResolveConflictInput>;
      sessionId?: string;
    },
    actor: ActorContext,
  ) {
    if (!this.contactsWriteEnabled) {
      throw new IcloudWriteLockedError();
    }

    const resolved: string[] = [];
    for (const res of params.resolutions ?? []) {
      await this.store.resolveConflict(
        res.conflict_id,
        { resolution: res.resolution, custom_value: res.custom_value },
        actor,
      );
      resolved.push(res.conflict_id);
    }

    const previews = await this.previewSync(params.customerId);
    const pushedCustomers: string[] = [];
    const pulledCustomers: string[] = [];
    const createdConflicts: string[] = [];
    const unlinkedCustomers: string[] = [];

    for (const item of previews) {
      if (item.diff.conflicts.length > 0) {
        const existingOpen = await this.store.listConflicts('open');
        for (const cf of item.diff.conflicts) {
          const alreadyOpen = existingOpen.some(
            (e) => e.entity_id === item.customer_id && e.field_name === cf.field,
          );
          if (!alreadyOpen) {
            const created = await this.store.createConflict({
              entity_type: 'customer',
              entity_id: item.customer_id,
              customer_name: item.customer_name,
              source_system: 'icloud_contact',
              field_name: cf.field,
              base_value: cf.baseValue,
              crm_value: cf.crmValue,
              remote_value: cf.remoteValue,
              remote_etag: null,
              status: 'open',
            });
            createdConflicts.push(created.id);
          }
        }
        continue;
      }

      if (Object.keys(item.diff.toPullToCrm).length > 0) {
        const detail = await this.store.getCustomer360(item.customer_id);
        await this.store.updateCustomer(
          item.customer_id,
          {
            expected_version: detail.customer.version,
            address:
              'address' in item.diff.toPullToCrm
                ? (item.diff.toPullToCrm.address as string | null)
                : undefined,
            birthday:
              'birthday' in item.diff.toPullToCrm
                ? (item.diff.toPullToCrm.birthday as string | null)
                : undefined,
            company_or_occupation:
              'company' in item.diff.toPullToCrm
                ? (item.diff.toPullToCrm.company as string | null)
                : undefined,
          },
          { actorType: 'sync_daemon', actorId: 'icloud_sync' },
        );
        pulledCustomers.push(item.customer_id);
      }

      if (Object.keys(item.diff.toPushToRemote).length > 0) {
        const links = await this.store.listExternalLinks(item.customer_id);
        const link = links.find((l) => l.system === 'icloud_contact');
        if (this.transport.isLive && params.sessionId && link) {
          try {
            await this.transport.callTool('contacts_update', {
              session_id: params.sessionId,
              contact_id: link.external_id,
              expected_etag: link.remote_etag ?? undefined,
              patch: item.diff.toPushToRemote,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('NOT_FOUND')) {
              await this.store.upsertExternalLink({
                ...link,
                sync_status: 'unlinked',
              });
              unlinkedCustomers.push(item.customer_id);
              continue;
            }
            throw err;
          }
        }
        if (link) {
          await this.store.upsertExternalLink({
            ...link,
            last_synced_payload: {
              fullName: item.sanitized_payload.fullName,
              phones: item.sanitized_payload.phones,
              birthday: item.sanitized_payload.birthday,
              address: item.sanitized_payload.address,
              company: item.sanitized_payload.company,
            },
            sync_status: 'linked',
            last_synced_at: new Date().toISOString(),
          });
        }
        pushedCustomers.push(item.customer_id);
      }
    }

    return {
      resolved_conflicts: resolved,
      pushed_customers: pushedCustomers,
      pulled_customers: pulledCustomers,
      created_conflicts: createdConflicts,
      unlinked_customers: unlinkedCustomers,
      mode: this.transport.isLive ? 'live_mcp' : 'dry_snapshot',
    };
  }
}
