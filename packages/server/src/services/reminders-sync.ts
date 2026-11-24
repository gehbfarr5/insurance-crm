import { type Customer, type Followup, formatMuseReminderPayload } from '@insurance-crm/shared';
import { IcloudWriteLockedError } from './icloud-sync.js';
import { type ActorContext, type CrmStore, ValidationError } from './store.js';

export interface RemindersSyncOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  writeEnabled?: boolean;
  fetchImpl?: typeof fetch;
}

export class RemindersSyncService {
  private readonly bridgeUrl: string | null;
  private readonly bridgeToken: string | null;
  private readonly _writeEnabled: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly store: CrmStore,
    opts: RemindersSyncOptions = {},
  ) {
    const rawUrl = opts.bridgeUrl?.trim().replace(/\/+$/, '') ?? '';
    const rawToken = opts.bridgeToken?.trim() ?? '';
    this.bridgeUrl = rawUrl || null;
    this.bridgeToken = rawToken && rawToken !== 'replace-me' ? rawToken : null;
    this._writeEnabled = opts.writeEnabled === true;
    this.fetchFn = opts.fetchImpl ?? fetch;
  }

  get isConfigured(): boolean {
    return Boolean(this.bridgeUrl && this.bridgeToken);
  }

  get writeEnabled(): boolean {
    return this._writeEnabled;
  }

  private async callBridge(
    path: string,
    init: RequestInit = {},
    timeoutMs = 15_000,
  ): Promise<Response> {
    if (!this.bridgeUrl || !this.bridgeToken) {
      throw new ValidationError('PyiCloud Reminders bridge is not configured');
    }
    return this.fetchFn(`${this.bridgeUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.bridgeToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async getStatus(): Promise<Record<string, unknown>> {
    if (!this.isConfigured) {
      return {
        configured: false,
        engine: 'none',
        macserver_dependency: false,
        shortcut_sync_available: true,
        write_enabled: this._writeEnabled,
      };
    }

    try {
      const healthRes = await this.callBridge('/health');
      const listsRes = await this.callBridge('/lists');
      if (!healthRes.ok || !listsRes.ok) {
        return {
          configured: true,
          ok: false,
          macserver_dependency: false,
          shortcut_sync_available: true,
          write_enabled: this._writeEnabled,
          error: `Bridge HTTP health=${healthRes.status} lists=${listsRes.status}`,
        };
      }
      const bridge = (await healthRes.json()) as Record<string, unknown>;
      const listsPayload = (await listsRes.json()) as { lists?: unknown[] };
      return {
        configured: true,
        macserver_dependency: false,
        shortcut_sync_available: true,
        write_enabled: this._writeEnabled,
        bridge,
        active_lists: listsPayload.lists ?? [],
      };
    } catch (err) {
      return {
        configured: true,
        ok: false,
        macserver_dependency: false,
        shortcut_sync_available: true,
        write_enabled: this._writeEnabled,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async pushFollowup(
    followup: Followup,
    customer: Pick<Customer, 'name' | 'legacy_group_key'>,
    actor: ActorContext,
  ): Promise<{ synced: boolean; skipped?: boolean; followup?: Followup; error?: string }> {
    if (!this.isConfigured || !this._writeEnabled) {
      return { synced: false, skipped: true };
    }

    try {
      const payload = formatMuseReminderPayload(followup, customer.name, customer.legacy_group_key);
      const priority = payload.priority === 'High' ? 1 : 0;

      if (!followup.icloud_reminder_id && followup.status === 'open') {
        const res = await this.callBridge('/reminders', {
          method: 'POST',
          body: JSON.stringify({
            list_title: payload.listName,
            title: payload.title,
            desc: payload.notes,
            due_date: payload.dueDate,
            priority,
          }),
        });
        const data = (await res.json()) as { id?: string; list_title?: string; message?: string; error?: string };
        if (!res.ok || !data.id) {
          return { synced: false, error: data.message ?? data.error ?? `HTTP ${res.status}` };
        }
        const updated = await this.store.upsertFollowup(
          {
            id: followup.id,
            customer_id: followup.customer_id,
            title: followup.title,
            icloud_reminder_id: data.id,
            icloud_list_id: data.list_title ?? payload.listName,
            sync_state: 'in_sync',
            expected_version: followup.version,
          },
          actor,
        );
        return { synced: true, followup: updated };
      }

      if (followup.icloud_reminder_id && followup.status === 'cancelled') {
        const res = await this.callBridge(`/reminders/${encodeURIComponent(followup.icloud_reminder_id)}`, {
          method: 'DELETE',
        });
        if (!res.ok && res.status !== 404) {
          const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          return { synced: false, error: data.message ?? data.error ?? `HTTP ${res.status}` };
        }
        const updated = await this.store.upsertFollowup(
          {
            id: followup.id,
            customer_id: followup.customer_id,
            title: followup.title,
            icloud_reminder_id: null,
            sync_state: 'in_sync',
            expected_version: followup.version,
          },
          actor,
        );
        return { synced: true, followup: updated };
      }

      if (followup.icloud_reminder_id) {
        const res = await this.callBridge(`/reminders/${encodeURIComponent(followup.icloud_reminder_id)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: payload.title,
            desc: payload.notes,
            completed: followup.status === 'done',
            priority,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          return { synced: false, error: data.message ?? data.error ?? `HTTP ${res.status}` };
        }
        const updated = await this.store.upsertFollowup(
          {
            id: followup.id,
            customer_id: followup.customer_id,
            title: followup.title,
            sync_state: 'in_sync',
            expected_version: followup.version,
          },
          actor,
        );
        return { synced: true, followup: updated };
      }

      return { synced: false, skipped: true };
    } catch (err) {
      return { synced: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async syncAll(actor: ActorContext): Promise<{
    ok: boolean;
    mode: 'pyicloud_cloudkit';
    pushed: number;
    updated: number;
    pulled_completed: number;
    errors: string[];
  }> {
    if (!this.isConfigured) {
      throw new ValidationError('PyiCloud Reminders bridge is not configured');
    }
    if (!this._writeEnabled) {
      throw new IcloudWriteLockedError('iCloud 提醒事项写入闸门已锁定');
    }

    const allFollowups = await this.store.listFollowups();
    const customerCache = new Map<string, Customer>();
    const search = await this.store.searchCustomers({ limit: 500 });
    for (const c of search.customers) customerCache.set(c.id, c);

    const resolveCustomer = async (customerId: string): Promise<Customer | null> => {
      const hit = customerCache.get(customerId);
      if (hit) return hit;
      try {
        const d = await this.store.getCustomer360(customerId);
        customerCache.set(d.customer.id, d.customer);
        return d.customer;
      } catch {
        return null;
      }
    };

    let pushed = 0;
    let updated = 0;
    let pulledCompleted = 0;
    const errors: string[] = [];

    for (const f of allFollowups) {
      const shouldPush = f.sync_state === 'pending_push' || (f.status === 'open' && !f.icloud_reminder_id);
      if (!shouldPush) continue;
      const cust = await resolveCustomer(f.customer_id);
      if (!cust) continue;
      const wasLinked = Boolean(f.icloud_reminder_id);
      const res = await this.pushFollowup(f, cust, actor);
      if (res.synced) {
        if (wasLinked) updated += 1;
        else pushed += 1;
      } else if (res.error) {
        errors.push(`${f.id}: ${res.error}`);
      }
    }

    const refreshedFollowups = await this.store.listFollowups({ status: 'open' });
    const linkedByRemoteId = new Map<string, Followup>();
    const listTitles = new Set<string>(['工作待办 Work']);
    for (const f of refreshedFollowups) {
      if (f.icloud_reminder_id) {
        linkedByRemoteId.set(f.icloud_reminder_id, f);
      }
      if (f.icloud_list_id) {
        listTitles.add(f.icloud_list_id);
      }
    }

    for (const title of listTitles) {
      try {
        const res = await this.callBridge(
          `/reminders?list_title=${encodeURIComponent(title)}&include_completed=true`,
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          errors.push(`pull(${title}): ${data.message ?? data.error ?? `HTTP ${res.status}`}`);
          continue;
        }
        const data = (await res.json()) as {
          reminders?: Array<{ id: string; completed: boolean }>;
        };
        for (const remoteItem of data.reminders ?? []) {
          if (!remoteItem.completed) continue;
          const local = linkedByRemoteId.get(remoteItem.id);
          if (!local || local.status !== 'open') continue;
          await this.store.upsertFollowup(
            {
              id: local.id,
              customer_id: local.customer_id,
              title: local.title,
              status: 'done',
              sync_state: 'in_sync',
              expected_version: local.version,
            },
            { actorType: 'sync_daemon', actorId: 'icloud_reminders_sync' },
          );
          pulledCompleted += 1;
        }
      } catch (err) {
        errors.push(`pull(${title}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      ok: errors.length === 0,
      mode: 'pyicloud_cloudkit',
      pushed,
      updated,
      pulled_completed: pulledCompleted,
      errors,
    };
  }
}
