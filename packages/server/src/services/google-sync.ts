import crypto from 'node:crypto';
import {
  type Customer,
  type Followup,
  MUSE_REMINDER_LISTS,
  V14_CALENDAR_NAMES,
  V14_CLIENT_GROUP_NAME,
  type V14AttendeeStatus,
  type V14BusinessType,
  V14WriteGuard,
  type WriteGuardChannel,
  appendV14CalendarLog,
  assertSafeLockscreenTitle,
  buildV14CompanionReminders,
  formatV14BirthdayTitle,
  formatV14ContactNote,
  formatV14GroupEventDescription,
  formatV14GroupEventTitle,
  formatV14OneOnOneDescription,
  formatV14OneOnOneTitle,
  mergeV14ContactNote,
  normalizePhone,
  routeReminderCategory,
  stripNameCategoryPrefix,
  upsertV14GroupEventAttendee,
  verifyV14ContactReadback,
} from '@insurance-crm/shared';
import { type ActorContext, ConflictError, type CrmStore, NotFoundError, ValidationError } from './store.js';

export class GoogleWriteLockedError extends Error {
  readonly code = 'GOOGLE_WRITE_LOCKED';
  constructor(channel: string) {
    super(`Google ${channel} 写入闸门未开启（当前仅允许只读预览，不修改 Google 远端数据）`);
    this.name = 'GoogleWriteLockedError';
  }
}

export class GoogleWriteUnknownError extends Error {
  readonly code = 'GOOGLE_WRITE_UNKNOWN';
  constructor(
    public readonly channel: WriteGuardChannel,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleWriteUnknownError';
  }
}

export interface GoogleSyncOptions {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  enabled?: boolean;
  contactsWriteEnabled?: boolean;
  calendarWriteEnabled?: boolean;
  tasksWriteEnabled?: boolean;
  workCalendarName?: string;
  birthdayCalendarName?: string;
  clientGroupName?: string;
  fetchImpl?: typeof fetch;
}

interface GooglePerson {
  resourceName: string;
  etag?: string;
  names?: Array<{ displayName?: string; familyName?: string; givenName?: string }>;
  phoneNumbers?: Array<{ value?: string; type?: string }>;
  biographies?: Array<{ value?: string; contentType?: string }>;
  birthdays?: Array<{ date?: { year?: number; month?: number; day?: number } }>;
  addresses?: Array<{ formattedValue?: string; type?: string }>;
  memberships?: Array<{ contactGroupMembership?: { contactGroupResourceName?: string } }>;
}

interface GoogleContactGroup {
  resourceName: string;
  name: string;
  groupType?: string;
  memberCount?: number;
}

export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  accessRole?: string;
  timeZone?: string;
  primary?: boolean;
}

export interface GoogleCalendarEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  htmlLink?: string;
}

export interface GoogleTaskList {
  id: string;
  title: string;
}

interface GoogleTaskItem {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
  deleted?: boolean;
  updated?: string;
  etag?: string;
}

function splitChineseName(fullName: string): { familyName: string; givenName: string } {
  const clean = stripNameCategoryPrefix(fullName).trim();
  if (!clean) return { familyName: '', givenName: '' };
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) {
    return { familyName: parts[0]!, givenName: parts.slice(1).join(' ') };
  }
  const chars = Array.from(clean);
  if (chars.length >= 2 && /[\u4e00-\u9fff]/.test(clean)) {
    return { familyName: chars[0]!, givenName: chars.slice(1).join('') };
  }
  return { familyName: clean, givenName: '' };
}

function parseIsoBirthday(raw: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return null;
  const [y, m, d] = raw.trim().split('-').map(Number);
  if (!y || !m || !d) return null;
  return { year: y, month: m, day: d };
}

function sha256Short(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function isUncertainWriteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  if (err instanceof TypeError) return true;
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|fetch failed|HTTP 5\d\d/i.test(err.message);
}

export class GoogleSyncService {
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly refreshToken: string | null;
  private readonly _enabled: boolean;
  private readonly _contactsWriteEnabled: boolean;
  private readonly _calendarWriteEnabled: boolean;
  private readonly _tasksWriteEnabled: boolean;
  private readonly workCalendarName: string;
  private readonly birthdayCalendarName: string;
  private readonly clientGroupName: string;
  private readonly fetchFn: typeof fetch;
  private readonly writeGuard = new V14WriteGuard();

  private cachedAccessToken: string | null = null;
  private cachedAccessTokenExpiresAt = 0;

  constructor(
    private readonly store: CrmStore,
    opts: GoogleSyncOptions = {},
  ) {
    const clean = (v?: string) => {
      const s = v?.trim() ?? '';
      return s && s !== 'replace-me' ? s : null;
    };
    this.clientId = clean(opts.clientId);
    this.clientSecret = clean(opts.clientSecret);
    this.refreshToken = clean(opts.refreshToken);
    this._enabled = opts.enabled === true;
    this._contactsWriteEnabled = opts.contactsWriteEnabled === true;
    this._calendarWriteEnabled = opts.calendarWriteEnabled === true;
    this._tasksWriteEnabled = opts.tasksWriteEnabled === true;
    this.workCalendarName = opts.workCalendarName?.trim() || V14_CALENDAR_NAMES.work;
    this.birthdayCalendarName = opts.birthdayCalendarName?.trim() || V14_CALENDAR_NAMES.birthday;
    this.clientGroupName = opts.clientGroupName?.trim() || V14_CLIENT_GROUP_NAME;
    this.fetchFn = opts.fetchImpl ?? fetch;
  }

  get isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  get enabled(): boolean {
    return this._enabled && this.isConfigured;
  }

  get contactsWriteEnabled(): boolean {
    return this.enabled && this._contactsWriteEnabled;
  }

  get calendarWriteEnabled(): boolean {
    return this.enabled && this._calendarWriteEnabled;
  }

  get tasksWriteEnabled(): boolean {
    return this.enabled && this._tasksWriteEnabled;
  }

  reconcileWriteGuard(
    channel: WriteGuardChannel,
    firstReadApplied: boolean,
    secondReadApplied: boolean,
  ) {
    return this.writeGuard.reconcileTwoReadbacks(channel, firstReadApplied, secondReadApplied);
  }

  private async getAccessToken(): Promise<string> {
    if (!this.isConfigured) {
      throw new ValidationError('Google OAuth 凭据未配置（需要 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN）');
    }
    if (this.cachedAccessToken && Date.now() < this.cachedAccessTokenExpiresAt) {
      return this.cachedAccessToken;
    }
    const body = new URLSearchParams({
      client_id: this.clientId!,
      client_secret: this.clientSecret!,
      refresh_token: this.refreshToken!,
      grant_type: 'refresh_token',
    });
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google OAuth token refresh failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const payload = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error('Google OAuth token response missing access_token');
    }
    this.cachedAccessToken = payload.access_token;
    const ttlSec = Math.max(60, (payload.expires_in ?? 3600) - 60);
    this.cachedAccessTokenExpiresAt = Date.now() + ttlSec * 1000;
    return this.cachedAccessToken;
  }

  private async googleJson<T>(
    url: string,
    init: RequestInit = {},
    timeoutMs = 15_000,
  ): Promise<{ status: number; data: T }> {
    const token = await this.getAccessToken();
    const res = await this.fetchFn(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 412 || res.status === 409) {
      const txt = await res.text().catch(() => '');
      throw new ConflictError(`Google 远端 ETag 冲突（HTTP ${res.status}），已拒绝强行覆盖：${txt.slice(0, 160)}`);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Google API HTTP ${res.status} (${url.split('?')[0]}): ${txt.slice(0, 200)}`);
    }
    if (res.status === 204) {
      return { status: 204, data: {} as T };
    }
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  // ==================== Status ====================

  async getStatus() {
    const base = {
      configured: this.isConfigured,
      enabled: this.enabled,
      write_gates: {
        contacts: this.contactsWriteEnabled,
        calendar: this.calendarWriteEnabled,
        tasks: this.tasksWriteEnabled,
      },
      write_guard: this.writeGuard.getSnapshot(),
      expected_targets: {
        client_contact_group: this.clientGroupName,
        work_calendar: this.workCalendarName,
        birthday_calendar: this.birthdayCalendarName,
        task_lists: Object.values(MUSE_REMINDER_LISTS),
      },
    };
    if (!this.isConfigured) {
      return { ...base, live_check: null };
    }

    try {
      const [groups, calendars, taskLists] = await Promise.all([
        this.listContactGroups(),
        this.listCalendars(),
        this.listTaskLists(),
      ]);
      const clientGroup = groups.find((g) => g.name === this.clientGroupName) ?? null;
      const workCal = calendars.find((c) => c.summary === this.workCalendarName) ?? null;
      const birthdayCal = calendars.find((c) => c.summary === this.birthdayCalendarName) ?? null;
      const matchedLists = Object.values(MUSE_REMINDER_LISTS).map((name) => {
        const hit = taskLists.find((l) => l.title === name);
        return { name, found: Boolean(hit), id: hit?.id ?? null };
      });
      return {
        ...base,
        live_check: {
          ok: true,
          client_group: clientGroup ? { resourceName: clientGroup.resourceName, name: clientGroup.name } : null,
          work_calendar: workCal ? { id: workCal.id, summary: workCal.summary } : null,
          birthday_calendar: birthdayCal ? { id: birthdayCal.id, summary: birthdayCal.summary } : null,
          task_lists: matchedLists,
        },
      };
    } catch (err) {
      return {
        ...base,
        live_check: {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  // ==================== Contacts (People API v1) ====================

  async listContactGroups(): Promise<GoogleContactGroup[]> {
    const { data } = await this.googleJson<{ contactGroups?: GoogleContactGroup[] }>(
      'https://people.googleapis.com/v1/contactGroups?pageSize=200',
    );
    return data.contactGroups ?? [];
  }

  private async listAllGoogleContacts(): Promise<GooglePerson[]> {
    const out: GooglePerson[] = [];
    let pageToken: string | undefined;
    const fields = 'names,phoneNumbers,biographies,birthdays,addresses,memberships,metadata';
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ personFields: fields, pageSize: '1000' });
      if (pageToken) qs.set('pageToken', pageToken);
      const { data } = await this.googleJson<{ connections?: GooglePerson[]; nextPageToken?: string }>(
        `https://people.googleapis.com/v1/people/me/connections?${qs.toString()}`,
      );
      out.push(...(data.connections ?? []));
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return out;
  }

  private async buildV14CustomerNoteBundle(customer: Customer) {
    const [idMap, interactionsMap] = await Promise.all([
      this.store.getDecryptedIdMap([customer.id]),
      this.store.listRecentInteractionsByCustomerIds([customer.id], 20),
    ]);
    const decryptedIdNo = idMap.get(customer.id) ?? null;
    const interactions = interactionsMap.get(customer.id) ?? [];
    const timeline = [...interactions]
      .reverse()
      .map((it) => ({
        date: it.occurred_at.slice(0, 10),
        text: it.summary,
      }));
    const baseInfo = {
      name: customer.name,
      gender: customer.gender,
      birthday: customer.birthday,
      phone: customer.primary_phone ?? customer.phones[0]?.value ?? null,
      idNo: decryptedIdNo,
      homeAddress: customer.address,
      workAddress: null,
    };
    const plannedNote = formatV14ContactNote(baseInfo, timeline);
    return { baseInfo, timeline, plannedNote, decryptedIdNo };
  }

  async previewContactsSync(filter: { customerId?: string; query?: string; limit?: number } = {}) {
    let customers: Customer[] = [];
    if (filter.customerId) {
      const detail = await this.store.getCustomer360(filter.customerId);
      customers = [detail.customer];
    } else {
      const res = await this.store.searchCustomers({
        query: filter.query,
        limit: Math.min(filter.limit ?? 20, 50),
      });
      customers = res.customers;
    }

    const remoteContacts = this.isConfigured ? await this.listAllGoogleContacts().catch(() => null) : null;
    const links = await this.store.listExternalLinks();
    const linkByCustomer = new Map(
      links.filter((l) => l.system === 'google_contact').map((l) => [l.customer_id, l]),
    );

    const items = [];
    for (const c of customers) {
      const bundle = await this.buildV14CustomerNoteBundle(c);
      const normPhones = [c.primary_phone, ...c.phones.map((p) => p.value)]
        .map((p) => normalizePhone(p ?? ''))
        .filter(Boolean);
      const link = linkByCustomer.get(c.id);

      let matchStatus: 'linked' | 'phone_unique' | 'phone_ambiguous' | 'new' | 'offline_preview' = 'offline_preview';
      let matchedResourceName: string | null = link?.external_id ?? null;
      let mergedNote = bundle.plannedNote;

      if (remoteContacts) {
        const byLink = link ? remoteContacts.find((p) => p.resourceName === link.external_id) : undefined;
        if (byLink) {
          matchStatus = 'linked';
          matchedResourceName = byLink.resourceName;
          const existingNote = byLink.biographies?.[0]?.value ?? '';
          mergedNote = mergeV14ContactNote(existingNote, bundle.baseInfo, bundle.timeline).note;
        } else {
          const phoneHits = remoteContacts.filter((p) =>
            (p.phoneNumbers ?? []).some((pn) => {
              const np = normalizePhone(pn.value ?? '');
              return np && normPhones.includes(np);
            }),
          );
          if (phoneHits.length === 1) {
            matchStatus = 'phone_unique';
            matchedResourceName = phoneHits[0]!.resourceName;
            const existingNote = phoneHits[0]!.biographies?.[0]?.value ?? '';
            mergedNote = mergeV14ContactNote(existingNote, bundle.baseInfo, bundle.timeline).note;
          } else if (phoneHits.length > 1) {
            matchStatus = 'phone_ambiguous';
          } else {
            matchStatus = 'new';
          }
        }
      }

      items.push({
        customer_id: c.id,
        customer_name: stripNameCategoryPrefix(c.name),
        phone: bundle.baseInfo.phone,
        has_id_no: Boolean(bundle.decryptedIdNo),
        target_group: this.clientGroupName,
        match_status: matchStatus,
        matched_resource_name: matchedResourceName,
        write_gate_status: this.contactsWriteEnabled ? 'enabled' : 'locked_preview_only',
        planned_v14_note: mergedNote,
      });
    }

    return items;
  }

  async syncContactToGoogle(
    customerId: string,
    actor: ActorContext,
    opts: { createMissing?: boolean } = {},
  ) {
    if (!this.contactsWriteEnabled) {
      throw new GoogleWriteLockedError('Contacts');
    }
    this.writeGuard.assertReady('contacts');

    const detail = await this.store.getCustomer360(customerId);
    const c = detail.customer;
    const bundle = await this.buildV14CustomerNoteBundle(c);
    const normPhones = [c.primary_phone, ...c.phones.map((p) => p.value)]
      .map((p) => normalizePhone(p ?? ''))
      .filter(Boolean);

    const [groups, remoteContacts, links] = await Promise.all([
      this.listContactGroups(),
      this.listAllGoogleContacts(),
      this.store.listExternalLinks(customerId),
    ]);

    const clientGroup = groups.find((g) => g.name === this.clientGroupName);
    if (!clientGroup) {
      throw new ValidationError(
        `Google 通讯录未找到原生标签组「${this.clientGroupName}」（按 v1.4 §1.3 规范，未确认前不自动新建分组）`,
      );
    }

    const existingLink = links.find((l) => l.system === 'google_contact');
    let targetPerson: GooglePerson | undefined = existingLink
      ? remoteContacts.find((p) => p.resourceName === existingLink.external_id)
      : undefined;

    if (!targetPerson && normPhones.length > 0) {
      const phoneHits = remoteContacts.filter((p) =>
        (p.phoneNumbers ?? []).some((pn) => {
          const np = normalizePhone(pn.value ?? '');
          return np && normPhones.includes(np);
        }),
      );
      if (phoneHits.length > 1) {
        throw new ConflictError(
          `按电话在 Google 通讯录命中 ${phoneHits.length} 条记录，按 v1.4 §1.2 规则停止盲写，请人工核对`,
        );
      }
      if (phoneHits.length === 1) {
        const hit = phoneHits[0]!;
        const hitName = (hit.names?.[0]?.displayName ?? '').trim();
        const crmName = stripNameCategoryPrefix(c.name);
        if (hitName && hitName !== crmName) {
          throw new ConflictError(
            `电话命中的 Google 联系人姓名为「${hitName}」，与 CRM「${crmName}」不一致，按 v1.4 规则停止盲写`,
          );
        }
        targetPerson = hit;
      }
    }

    if (!targetPerson && opts.createMissing === false) {
      throw new NotFoundError(`Google 通讯录未找到客户「${c.name}」，且 createMissing=false`);
    }

    const cleanName = stripNameCategoryPrefix(c.name);
    const { familyName, givenName } = splitChineseName(cleanName);
    const uniquePhones = Array.from(
      new Set([c.primary_phone, ...c.phones.map((p) => p.value)].filter((x): x is string => Boolean(x?.trim()))),
    );
    const birthdayObj = parseIsoBirthday(c.birthday);
    const existingNote = targetPerson?.biographies?.[0]?.value ?? '';
    const merged = mergeV14ContactNote(existingNote, bundle.baseInfo, bundle.timeline);

    const existingMemberships = (targetPerson?.memberships ?? [])
      .map((m) => m.contactGroupMembership?.contactGroupResourceName)
      .filter((x): x is string => Boolean(x));
    const membershipSet = new Set<string>([...existingMemberships, clientGroup.resourceName]);

    const personBody: Record<string, unknown> = {
      names: [{ familyName, givenName }],
      phoneNumbers: uniquePhones.map((value) => ({ value, type: 'mobile' })),
      biographies: [{ value: merged.note, contentType: 'TEXT_PLAIN' }],
      memberships: Array.from(membershipSet).map((contactGroupResourceName) => ({
        contactGroupMembership: { contactGroupResourceName },
      })),
    };
    if (birthdayObj) {
      personBody.birthdays = [{ date: birthdayObj }];
    }
    if (c.address?.trim()) {
      personBody.addresses = [{ formattedValue: c.address.trim(), type: 'home' }];
    }

    const fields = 'names,phoneNumbers,biographies,birthdays,addresses,memberships,metadata';
    let written: GooglePerson;
    let action: 'created' | 'updated';
    try {
      if (targetPerson) {
        action = 'updated';
        const updateFields = [
          'names',
          'phoneNumbers',
          'biographies',
          'memberships',
          ...(birthdayObj ? ['birthdays'] : []),
          ...(c.address?.trim() ? ['addresses'] : []),
        ].join(',');
        const res = await this.googleJson<GooglePerson>(
          `https://people.googleapis.com/v1/${targetPerson.resourceName}:updateContact?updatePersonFields=${updateFields}&personFields=${fields}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ ...personBody, etag: targetPerson.etag }),
          },
        );
        written = res.data;
      } else {
        action = 'created';
        const res = await this.googleJson<GooglePerson>(
          `https://people.googleapis.com/v1/people:createContact?personFields=${fields}`,
          {
            method: 'POST',
            body: JSON.stringify(personBody),
          },
        );
        written = res.data;
      }
    } catch (err) {
      if (isUncertainWriteError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        this.writeGuard.markUnknown('contacts', `google_contact_${targetPerson ? 'update' : 'create'}`, msg);
        throw new GoogleWriteUnknownError('contacts', `Google 联系人写入超时/中断，已触发 UNKNOWN 停写：${msg}`);
      }
      throw err;
    }

    // Mandatory v1.4 §1.5 three-field readback check (Name + Phone + Note)
    const { data: readback } = await this.googleJson<GooglePerson>(
      `https://people.googleapis.com/v1/${written.resourceName}?personFields=names,phoneNumbers,biographies,metadata`,
    );
    const readName =
      readback.names?.[0]?.displayName ??
      `${readback.names?.[0]?.familyName ?? ''}${readback.names?.[0]?.givenName ?? ''}`.trim();
    const readPhones = (readback.phoneNumbers ?? []).map((p) => p.value ?? '').filter(Boolean);
    const readNote = readback.biographies?.[0]?.value ?? '';
    const verification = verifyV14ContactReadback(
      { name: cleanName, phone: uniquePhones[0] ?? null, note: merged.note },
      { name: readName, phones: readPhones, note: readNote },
    );

    await this.store.upsertExternalLink({
      customer_id: c.id,
      system: 'google_contact',
      external_id: written.resourceName,
      secondary_key: clientGroup.resourceName,
      remote_etag: readback.etag ?? written.etag ?? null,
      last_synced_hash: sha256Short(merged.note),
      last_synced_payload: {
        name: cleanName,
        phones: uniquePhones,
        group: this.clientGroupName,
        note_hash: sha256Short(merged.note),
      },
      sync_status: verification.ok ? 'linked' : 'error',
      last_synced_at: new Date().toISOString(),
    });

    await this.store.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'customer',
      entity_id: c.id,
      action: `google_contact_${action}`,
      before_state: existingNote ? { note_hash: sha256Short(existingNote) } : null,
      after_state: {
        resource_name: written.resourceName,
        readback_ok: verification.ok,
        mismatches: verification.mismatches,
      },
      metadata: { group: this.clientGroupName },
    });

    return {
      action,
      customer_id: c.id,
      resource_name: written.resourceName,
      etag: readback.etag ?? written.etag ?? null,
      group: this.clientGroupName,
      readback_verified: verification.ok,
      readback_mismatches: verification.mismatches,
      note: merged.note,
    };
  }

  // ==================== Calendar (Calendar API v3) ====================

  async listCalendars(): Promise<GoogleCalendarInfo[]> {
    const { data } = await this.googleJson<{ items?: GoogleCalendarInfo[] }>(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    );
    return data.items ?? [];
  }

  private async resolveCalendarByName(calendarName: string): Promise<GoogleCalendarInfo> {
    const calendars = await this.listCalendars();
    const hit = calendars.find((c) => c.summary === calendarName);
    if (!hit) {
      throw new NotFoundError(
        `Google 日历未找到目标日历「${calendarName}」（按 v1.4 §2.1 禁止回退猜测默认日历）`,
      );
    }
    return hit;
  }

  async listCalendarEvents(opts: {
    calendarTarget?: 'work' | 'birthday';
    calendarId?: string;
    timeMin?: string;
    timeMax?: string;
    query?: string;
    maxResults?: number;
  }) {
    const targetName = opts.calendarTarget === 'birthday' ? this.birthdayCalendarName : this.workCalendarName;
    const cal = opts.calendarId
      ? { id: opts.calendarId, summary: targetName }
      : await this.resolveCalendarByName(targetName);

    const qs = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(opts.maxResults ?? 50, 250)),
    });
    if (opts.timeMin) qs.set('timeMin', opts.timeMin);
    if (opts.timeMax) qs.set('timeMax', opts.timeMax);
    if (opts.query?.trim()) qs.set('q', opts.query.trim());

    const { data } = await this.googleJson<{ items?: GoogleCalendarEvent[] }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${qs.toString()}`,
    );
    return {
      calendar_id: cal.id,
      calendar_name: cal.summary,
      events: data.items ?? [],
    };
  }

  async upsertCalendarEvent(
    input: {
      mode: 'platform_event' | 'one_on_one' | 'birthday';
      eventId?: string;
      expectedEtag?: string;
      cancelled?: boolean;
      // Platform event / 1-on-1 timing
      startIso?: string;
      endIso?: string;
      location?: string;
      // Platform event fields
      activityName?: string;
      entryRequirement?: string;
      attendees?: Array<{ name: string; phone?: string | null; status: V14AttendeeStatus }>;
      // 1-on-1 fields
      businessType?: V14BusinessType;
      summaryText?: string;
      customerId?: string;
      customerName?: string;
      customerPhone?: string;
      colleagueName?: string;
      purpose?: string;
      nextSteps?: string[];
      // Log append
      logDate?: string;
      logFact?: string;
      // Birthday fields
      solarBirthdayDate?: string; // YYYY-MM-DD
      // Companion reminders
      createCompanionReminders?: boolean;
    },
    actor: ActorContext,
  ) {
    if (!this.calendarWriteEnabled) {
      throw new GoogleWriteLockedError('Calendar');
    }
    this.writeGuard.assertReady('calendar');

    const isBirthday = input.mode === 'birthday';
    const cal = await this.resolveCalendarByName(isBirthday ? this.birthdayCalendarName : this.workCalendarName);

    let title: string;
    let bodyPayload: Record<string, unknown>;

    let existingEvent: GoogleCalendarEvent | null = null;
    if (input.eventId) {
      if (!input.expectedEtag) {
        throw new ValidationError('修改已有日历事件必须提供 expectedEtag（v1.4 §2.1 防覆盖要求）');
      }
      const res = await this.googleJson<GoogleCalendarEvent>(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(input.eventId)}`,
      );
      existingEvent = res.data;
    }

    if (isBirthday) {
      if (!input.customerName || !input.solarBirthdayDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.solarBirthdayDate)) {
        throw new ValidationError('生日日程需要 customerName 与公历日期 solarBirthdayDate (YYYY-MM-DD)');
      }
      title = formatV14BirthdayTitle(input.customerName);
      const nextDay = new Date(Date.parse(`${input.solarBirthdayDate}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      bodyPayload = {
        summary: title,
        start: { date: input.solarBirthdayDate },
        end: { date: nextDay },
      };
    } else {
      if (!existingEvent && (!input.startIso || !input.endIso)) {
        throw new ValidationError('新建业务日程必须提供带时区偏移的 startIso 与 endIso（如 2026-12-05T14:00:00+08:00）');
      }
      if (input.startIso && !/[+-]\d{2}:\d{2}|Z$/.test(input.startIso)) {
        throw new ValidationError('startIso 必须显式包含时区偏移（例如 +08:00）');
      }
      if (input.endIso && !/[+-]\d{2}:\d{2}|Z$/.test(input.endIso)) {
        throw new ValidationError('endIso 必须显式包含时区偏移（例如 +08:00）');
      }

      if (input.mode === 'platform_event') {
        const actName = input.activityName?.trim() || existingEvent?.summary?.replace(/^[✅❌]\s*👥\s*/u, '').trim() || '';
        title = formatV14GroupEventTitle(actName, Boolean(input.cancelled));

        let description = existingEvent?.description ?? '';
        if (!existingEvent) {
          description = formatV14GroupEventDescription({
            activityName: actName,
            entryRequirement: input.entryRequirement,
            attendees: input.attendees,
            logs:
              input.logDate && input.logFact && input.customerName
                ? [{ date: input.logDate, customerName: input.customerName, fact: input.logFact }]
                : [],
          });
        } else {
          for (const att of input.attendees ?? []) {
            description = upsertV14GroupEventAttendee(description, att).description;
          }
          if (input.logDate && input.logFact && input.customerName) {
            description = appendV14CalendarLog(description, {
              date: input.logDate,
              customerName: input.customerName,
              fact: input.logFact,
              isMultiClient: true,
            }).description;
          }
        }

        bodyPayload = {
          summary: title,
          description,
          ...(input.location ? { location: input.location } : {}),
          ...(input.startIso ? { start: { dateTime: input.startIso, timeZone: 'Asia/Shanghai' } } : {}),
          ...(input.endIso ? { end: { dateTime: input.endIso, timeZone: 'Asia/Shanghai' } } : {}),
        };
      } else {
        if (!input.customerName) {
          throw new ValidationError('一对一拜访日程需要 customerName');
        }
        title = formatV14OneOnOneTitle({
          businessType: input.businessType ?? 'first_visit',
          summary: input.summaryText ?? input.purpose ?? '客户拜访',
          customerName: input.customerName,
          colleagueName: input.colleagueName,
          cancelled: Boolean(input.cancelled),
        });

        let description = existingEvent?.description ?? '';
        if (!existingEvent) {
          description = formatV14OneOnOneDescription({
            purpose: input.purpose ?? input.summaryText ?? '客户沟通',
            location: input.location,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            contactLinkedNote: 'Google 通讯录已关联',
            colleagues: input.colleagueName ? [{ name: input.colleagueName }] : [],
            logs: input.logDate && input.logFact ? [{ date: input.logDate, fact: input.logFact }] : [],
            nextSteps: input.nextSteps,
          });
        } else if (input.logDate && input.logFact) {
          description = appendV14CalendarLog(description, {
            date: input.logDate,
            fact: input.logFact,
            isMultiClient: false,
          }).description;
        }

        bodyPayload = {
          summary: title,
          description,
          ...(input.location ? { location: input.location } : {}),
          ...(input.startIso ? { start: { dateTime: input.startIso, timeZone: 'Asia/Shanghai' } } : {}),
          ...(input.endIso ? { end: { dateTime: input.endIso, timeZone: 'Asia/Shanghai' } } : {}),
        };
      }
    }

    assertSafeLockscreenTitle(title);

    let saved: GoogleCalendarEvent;
    try {
      if (input.eventId) {
        const res = await this.googleJson<GoogleCalendarEvent>(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(input.eventId)}`,
          {
            method: 'PATCH',
            headers: { 'If-Match': input.expectedEtag! },
            body: JSON.stringify(bodyPayload),
          },
        );
        saved = res.data;
      } else {
        const res = await this.googleJson<GoogleCalendarEvent>(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events`,
          {
            method: 'POST',
            body: JSON.stringify(bodyPayload),
          },
        );
        saved = res.data;
      }
    } catch (err) {
      if (isUncertainWriteError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        this.writeGuard.markUnknown('calendar', `google_calendar_${input.eventId ? 'update' : 'create'}`, msg);
        throw new GoogleWriteUnknownError('calendar', `Google 日历写入超时/中断，已触发 UNKNOWN 停写：${msg}`);
      }
      throw err;
    }

    // Mandatory readback verification
    const { data: readback } = await this.googleJson<GoogleCalendarEvent>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(saved.id)}`,
    );

    const createdFollowups: Followup[] = [];
    if (
      input.createCompanionReminders &&
      !isBirthday &&
      input.customerId &&
      input.customerName &&
      (input.startIso || readback.start?.dateTime)
    ) {
      const startRef = input.startIso ?? readback.start!.dateTime!;
      const specs = buildV14CompanionReminders(input.customerName, startRef);
      for (const spec of specs) {
        const fu = await this.store.upsertFollowup(
          {
            customer_id: input.customerId,
            title: spec.title,
            action_type: 'visit',
            due_at: spec.due_at,
            priority: spec.priority,
            notes: `来源: 日历伴生提醒 | 日历事件: ${readback.summary ?? title} (${readback.id})`,
          },
          actor,
        );
        createdFollowups.push(fu);
      }
    }

    await this.store.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'calendar_event',
      entity_id: input.customerId ?? null,
      action: input.eventId ? 'google_calendar_updated' : 'google_calendar_created',
      before_state: existingEvent ? { etag: existingEvent.etag, summary: existingEvent.summary } : null,
      after_state: {
        calendar_id: cal.id,
        event_id: readback.id,
        etag: readback.etag,
        summary: readback.summary,
        companion_followups: createdFollowups.length,
      },
      metadata: { mode: input.mode },
    });

    return {
      calendar_id: cal.id,
      calendar_name: cal.summary,
      event: readback,
      readback_verified: readback.summary === title,
      companion_followups: createdFollowups,
    };
  }

  // ==================== Tasks (Google Tasks API v1) ====================

  async listTaskLists(): Promise<GoogleTaskList[]> {
    const { data } = await this.googleJson<{ items?: GoogleTaskList[] }>(
      'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100',
    );
    return data.items ?? [];
  }

  async syncFollowupsToGoogleTasks(actor: ActorContext) {
    if (!this.tasksWriteEnabled) {
      throw new GoogleWriteLockedError('Tasks');
    }
    this.writeGuard.assertReady('tasks');

    const [taskLists, allFollowups, allLinks] = await Promise.all([
      this.listTaskLists(),
      this.store.listFollowups(),
      this.store.listExternalLinks(),
    ]);

    const listByTitle = new Map(taskLists.map((l) => [l.title, l]));
    const workList = listByTitle.get(MUSE_REMINDER_LISTS.work);
    if (!workList) {
      throw new ValidationError(
        `Google Tasks 缺少目标列表「${MUSE_REMINDER_LISTS.work}」（按 v1.4 §4.2 规则，未确认前绝不自动新建列表）`,
      );
    }

    // Load remote tasks per matched v1.0 list (including completed & deleted to honor never-recreate!)
    const remoteByListId = new Map<string, Map<string, GoogleTaskItem>>();
    for (const listName of Object.values(MUSE_REMINDER_LISTS)) {
      const tl = listByTitle.get(listName);
      if (!tl) continue;
      const { data } = await this.googleJson<{ items?: GoogleTaskItem[] }>(
        `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tl.id)}/tasks?showCompleted=true&showHidden=true&showDeleted=true&maxResults=100`,
      );
      remoteByListId.set(tl.id, new Map((data.items ?? []).map((t) => [t.id, t])));
    }

    // Track followup->google_task mapping inside external_links (system='google_task', secondary_key=followup.id)
    const linkByFollowupId = new Map(
      allLinks
        .filter((l) => l.system === 'google_task' && l.secondary_key)
        .map((l) => [l.secondary_key!, l]),
    );

    const customerCache = new Map<string, Customer>();
    let pushed = 0;
    let updated = 0;
    let pulledCompleted = 0;
    let skippedUserDeleted = 0;
    const errors: string[] = [];

    for (const fu of allFollowups) {
      let cust = customerCache.get(fu.customer_id);
      if (!cust) {
        try {
          const d = await this.store.getCustomer360(fu.customer_id);
          cust = d.customer;
          customerCache.set(cust.id, cust);
        } catch {
          continue;
        }
      }

      const category = routeReminderCategory(fu.title, undefined, true);
      const targetList = listByTitle.get(MUSE_REMINDER_LISTS[category]) ?? workList;
      const remoteTasks = remoteByListId.get(targetList.id) ?? new Map<string, GoogleTaskItem>();
      const existingLink = linkByFollowupId.get(fu.id);

      const cleanTitle = fu.title.includes(stripNameCategoryPrefix(cust.name))
        ? fu.title.trim()
        : `${stripNameCategoryPrefix(cust.name)} ${fu.title.trim()}`;
      try {
        assertSafeLockscreenTitle(cleanTitle);
      } catch (err) {
        errors.push(`跳过不安全标题 (${fu.id}): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const taskNotes = [
        `来源: CRM Google 双线同步 (${targetList.title})`,
        `客户: ${stripNameCategoryPrefix(cust.name)}`,
        `FollowupID: ${fu.id}`,
        ...(fu.notes?.trim() ? [`备注: ${fu.notes.trim()}`] : []),
      ].join('\n');

      // Existing linked task: pull completion or honor user deletion!
      if (existingLink) {
        if (existingLink.sync_status === 'unlinked') {
          skippedUserDeleted++;
          continue;
        }
        const remote = remoteTasks.get(existingLink.external_id);
        if (!remote || remote.deleted === true) {
          // v1.4 §4.4 #4: User deleted the reminder -> NEVER recreate!
          await this.store.upsertExternalLink({
            customer_id: fu.customer_id,
            system: 'google_task',
            external_id: existingLink.external_id,
            secondary_key: fu.id,
            remote_etag: remote?.etag ?? existingLink.remote_etag,
            last_synced_hash: existingLink.last_synced_hash,
            last_synced_payload: { ...(existingLink.last_synced_payload ?? {}), user_deleted: true },
            sync_status: 'unlinked',
            last_synced_at: new Date().toISOString(),
          });
          if (fu.status === 'open') {
            await this.store.upsertFollowup(
              {
                id: fu.id,
                customer_id: fu.customer_id,
                title: fu.title,
                status: 'cancelled',
                expected_version: fu.version,
              },
              actor,
            );
          }
          skippedUserDeleted++;
          continue;
        }

        if (remote.status === 'completed' && fu.status === 'open') {
          await this.store.upsertFollowup(
            {
              id: fu.id,
              customer_id: fu.customer_id,
              title: fu.title,
              status: 'done',
              expected_version: fu.version,
            },
            actor,
          );
          pulledCompleted++;
          continue;
        }

        const desiredStatus = fu.status === 'done' ? 'completed' : 'needsAction';
        const desiredHash = sha256Short(`${cleanTitle}|${taskNotes}|${fu.due_at ?? ''}|${desiredStatus}`);
        if (existingLink.last_synced_hash !== desiredHash) {
          try {
            const { data: patched } = await this.googleJson<GoogleTaskItem>(
              `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(targetList.id)}/tasks/${encodeURIComponent(existingLink.external_id)}`,
              {
                method: 'PATCH',
                body: JSON.stringify({
                  id: existingLink.external_id,
                  title: cleanTitle,
                  notes: taskNotes,
                  status: desiredStatus,
                  ...(fu.due_at ? { due: new Date(fu.due_at).toISOString() } : {}),
                }),
              },
            );
            await this.store.upsertExternalLink({
              customer_id: fu.customer_id,
              system: 'google_task',
              external_id: patched.id,
              secondary_key: fu.id,
              remote_etag: patched.etag ?? null,
              last_synced_hash: desiredHash,
              last_synced_payload: { list_id: targetList.id, title: cleanTitle, status: desiredStatus },
              sync_status: 'linked',
              last_synced_at: new Date().toISOString(),
            });
            updated++;
          } catch (err) {
            if (isUncertainWriteError(err)) {
              const msg = err instanceof Error ? err.message : String(err);
              this.writeGuard.markUnknown('tasks', `google_task_update:${fu.id}`, msg);
              throw new GoogleWriteUnknownError('tasks', `Google Tasks 更新超时/中断，已触发 UNKNOWN 停写：${msg}`);
            }
            errors.push(`${fu.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        continue;
      }

      // New open followup -> push to Google Tasks
      if (fu.status !== 'open') continue;
      const desiredHash = sha256Short(`${cleanTitle}|${taskNotes}|${fu.due_at ?? ''}|needsAction`);
      try {
        const { data: created } = await this.googleJson<GoogleTaskItem>(
          `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(targetList.id)}/tasks`,
          {
            method: 'POST',
            body: JSON.stringify({
              title: cleanTitle,
              notes: taskNotes,
              status: 'needsAction',
              ...(fu.due_at ? { due: new Date(fu.due_at).toISOString() } : {}),
            }),
          },
        );
        await this.store.upsertExternalLink({
          customer_id: fu.customer_id,
          system: 'google_task',
          external_id: created.id,
          secondary_key: fu.id,
          remote_etag: created.etag ?? null,
          last_synced_hash: desiredHash,
          last_synced_payload: { list_id: targetList.id, title: cleanTitle, status: 'needsAction' },
          sync_status: 'linked',
          last_synced_at: new Date().toISOString(),
        });
        pushed++;
      } catch (err) {
        if (isUncertainWriteError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          this.writeGuard.markUnknown('tasks', `google_task_create:${fu.id}`, msg);
          throw new GoogleWriteUnknownError('tasks', `Google Tasks 写入超时/中断，已触发 UNKNOWN 停写：${msg}`);
        }
        errors.push(`${fu.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      pushed,
      updated,
      pulled_completed: pulledCompleted,
      skipped_user_deleted: skippedUserDeleted,
      errors,
    };
  }
}
