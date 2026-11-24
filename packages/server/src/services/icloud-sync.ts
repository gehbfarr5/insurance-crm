import {
  type Customer,
  type Followup,
  type ResolveConflictInput,
  computeThreeWayDiff,
  formatMuseReminderPayload,
  normalizePhone,
  planCarddavFollowupNote,
  sanitizeCustomerForIcloud,
} from '@insurance-crm/shared';
import type { CardDavContactPatch, CardDavContactRecord, CardDavTransport } from './carddav-client.js';
import { type ActorContext, ConflictError, type CrmStore, NotFoundError } from './store.js';

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
  cardDav?: CardDavTransport;
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

  get status() {
    return {
      contacts_write_enabled: this.contactsWriteEnabled,
      reminders_write_enabled: this.remindersWriteEnabled,
      carddav_connected: Boolean(this.opts.cardDav),
      transport_mode: this.opts.cardDav
        ? ('direct_carddav' as const)
        : this.transport.isLive
          ? ('live_mcp' as const)
          : ('dry_snapshot' as const),
    };
  }

  private async loadCardDavLookup(): Promise<{
    byHref: Map<string, CardDavContactRecord>;
    byPhone: Map<string, CardDavContactRecord>;
  } | null> {
    if (!this.opts.cardDav) return null;
    try {
      const cards = await this.opts.cardDav.listContacts();
      const byHref = new Map<string, CardDavContactRecord>();
      const byPhone = new Map<string, CardDavContactRecord>();
      for (const rec of cards) {
        byHref.set(rec.href, rec);
        for (const p of rec.parsed.phones) {
          if (p && !byPhone.has(p)) byPhone.set(p, rec);
        }
      }
      return { byHref, byPhone };
    } catch {
      return null;
    }
  }

  private matchCardRecord(
    customerPhones: string[],
    linkedExternalId: string | undefined,
    lookup: { byHref: Map<string, CardDavContactRecord>; byPhone: Map<string, CardDavContactRecord> } | null,
  ): CardDavContactRecord | null {
    if (!lookup) return null;
    if (linkedExternalId) {
      const hit = lookup.byHref.get(linkedExternalId);
      if (hit) return hit;
    }
    for (const rawPhone of customerPhones) {
      const norm = normalizePhone(rawPhone);
      if (norm) {
        const hit = lookup.byPhone.get(norm);
        if (hit) return hit;
      }
    }
    return null;
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

    const [allLinks, allFollowups, openConflicts, cardLookup] = await Promise.all([
      this.store.listExternalLinks(customerId),
      this.store.listFollowups({ status: 'open', customer_id: customerId }),
      this.store.listConflicts('open'),
      this.loadCardDavLookup(),
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

      const remote: Record<string, unknown> = { ...base };
      const cardMatch = this.matchCardRecord(sanitized.phones, link?.external_id, cardLookup);
      if (cardMatch) {
        remote.fullName = cardMatch.parsed.fn ?? remote.fullName;
        if (cardMatch.parsed.phones.length > 0) {
          remote.phones = cardMatch.parsed.phones;
        }
        remote.birthday = cardMatch.parsed.birthday ?? remote.birthday ?? null;
        remote.address = cardMatch.parsed.address ?? remote.address ?? null;
        remote.company = cardMatch.parsed.company ?? remote.company ?? null;
        if (typeof cardMatch.parsed.note === 'string') {
          remote.note = cardMatch.parsed.note;
        }
      } else if (this.transport.isLive && link?.external_id) {
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

      const normalizedCrmPhones = sanitized.phones.map((p) => normalizePhone(p) || p);
      const crmComparable: Record<string, unknown> = {
        fullName: sanitized.fullName,
        phones: normalizedCrmPhones,
        birthday: sanitized.birthday,
        address: sanitized.address,
        company: sanitized.company,
      };
      const baseNormalized: Record<string, unknown> = {
        ...base,
        phones: Array.isArray(base.phones)
          ? (base.phones as string[]).map((p) => normalizePhone(p) || p)
          : base.phones,
      };
      const diff = computeThreeWayDiff(baseNormalized, crmComparable, remote, CONTACT_SYNC_FIELDS);

      const custFollowups = allFollowups.filter((f: Followup) => f.customer_id === c.id);
      const primaryFollowup = custFollowups[0];
      const pendingReminders = custFollowups.map((f) =>
        formatMuseReminderPayload(f, c.name, c.legacy_group_key),
      );

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
        contact_link_status: link?.sync_status ?? (cardMatch ? 'matched_by_phone' : 'unlinked'),
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
      createMissing?: boolean;
      limit?: number;
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

    const clampLimit = Math.min(Math.max(Number.isFinite(params.limit) ? Math.trunc(params.limit!) : 10, 1), 50);
    const previews = await this.previewSync(params.customerId, clampLimit);
    const cardLookup = await this.loadCardDavLookup();

    const createdCustomers: string[] = [];
    const pushedCustomers: string[] = [];
    const pulledCustomers: string[] = [];
    const createdConflicts: string[] = [];
    const unlinkedCustomers: string[] = [];
    const skippedUnmatched: string[] = [];

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

      const links = await this.store.listExternalLinks(item.customer_id);
      const link = links.find((l) => l.system === 'icloud_contact');
      const baseNote = typeof link?.last_synced_payload?.note === 'string' ? link.last_synced_payload.note : null;
      const needsNoteUpdate = Boolean(item.planned_followup_note && baseNote !== item.planned_followup_note);
      const needsPush = Object.keys(item.diff.toPushToRemote).length > 0 || !link || needsNoteUpdate;

      if (!needsPush) continue;

      const normalizedPhones = item.sanitized_payload.phones.map((p) => normalizePhone(p) || p);
      const syncedPayloadSnapshot: Record<string, unknown> = {
        fullName: item.sanitized_payload.fullName,
        phones: normalizedPhones,
        birthday: item.sanitized_payload.birthday,
        address: item.sanitized_payload.address,
        company: item.sanitized_payload.company,
        note: item.planned_followup_note,
      };

      if (this.opts.cardDav) {
        let cardRec = this.matchCardRecord(item.sanitized_payload.phones, link?.external_id, cardLookup);
        if (!cardRec && link?.external_id) {
          cardRec = await this.opts.cardDav.getCard(link.external_id);
        }

        if (cardRec) {
          const patch: CardDavContactPatch = {};
          if ('fullName' in item.diff.toPushToRemote) patch.fullName = item.sanitized_payload.fullName;
          if ('phones' in item.diff.toPushToRemote) patch.phones = item.sanitized_payload.phones;
          if ('birthday' in item.diff.toPushToRemote) patch.birthday = item.sanitized_payload.birthday;
          if ('address' in item.diff.toPushToRemote) patch.address = item.sanitized_payload.address;
          if ('company' in item.diff.toPushToRemote) patch.company = item.sanitized_payload.company;

          try {
            const updated = await this.opts.cardDav.updateCardSurgical(
              cardRec.href,
              cardRec.etag,
              cardRec.rawVcard,
              patch,
              item.planned_followup_note,
            );
            await this.store.upsertExternalLink({
              customer_id: item.customer_id,
              system: 'icloud_contact',
              external_id: updated.href,
              secondary_key: cardRec.parsed.uid,
              remote_etag: updated.etag,
              last_synced_hash: null,
              last_synced_payload: syncedPayloadSnapshot,
              sync_status: 'linked',
              last_synced_at: new Date().toISOString(),
            });
            pushedCustomers.push(item.customer_id);
          } catch (err) {
            if (err instanceof ConflictError) {
              const created = await this.store.createConflict({
                entity_type: 'customer',
                entity_id: item.customer_id,
                customer_name: item.customer_name,
                source_system: 'icloud_contact',
                field_name: 'carddav_etag',
                base_value: link?.remote_etag ?? null,
                crm_value: item.planned_followup_note,
                remote_value: cardRec.etag,
                remote_etag: cardRec.etag,
                status: 'open',
              });
              createdConflicts.push(created.id);
              continue;
            }
            if (err instanceof NotFoundError) {
              if (link) {
                await this.store.upsertExternalLink({ ...link, sync_status: 'unlinked' });
              }
              unlinkedCustomers.push(item.customer_id);
              continue;
            }
            throw err;
          }
        } else if (params.customerId || params.createMissing) {
          const createdCard = await this.opts.cardDav.createCard(
            item.sanitized_payload,
            item.planned_followup_note,
          );
          await this.store.upsertExternalLink({
            customer_id: item.customer_id,
            system: 'icloud_contact',
            external_id: createdCard.href,
            secondary_key: createdCard.uid,
            remote_etag: createdCard.etag,
            last_synced_hash: null,
            last_synced_payload: syncedPayloadSnapshot,
            sync_status: 'linked',
            last_synced_at: new Date().toISOString(),
          });
          createdCustomers.push(item.customer_id);
          pushedCustomers.push(item.customer_id);
        } else {
          skippedUnmatched.push(item.customer_id);
        }
        continue;
      }

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
          last_synced_payload: syncedPayloadSnapshot,
          sync_status: 'linked',
          last_synced_at: new Date().toISOString(),
        });
      }
      pushedCustomers.push(item.customer_id);
    }

    return {
      resolved_conflicts: resolved,
      created_customers: createdCustomers,
      pushed_customers: pushedCustomers,
      pulled_customers: pulledCustomers,
      created_conflicts: createdConflicts,
      unlinked_customers: unlinkedCustomers,
      skipped_unmatched: skippedUnmatched,
      mode: this.opts.cardDav
        ? 'live_carddav'
        : this.transport.isLive
          ? 'live_mcp'
          : 'dry_snapshot',
    };
  }
}
