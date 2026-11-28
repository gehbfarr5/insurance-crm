import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

interface MockGoogleState {
  groups: Array<{ resourceName: string; name: string }>;
  contacts: Map<string, Record<string, unknown>>;
  calendars: Array<{ id: string; summary: string }>;
  events: Map<string, Record<string, unknown>>;
  taskLists: Array<{ id: string; title: string }>;
  tasks: Map<string, Record<string, unknown>>;
  failNextContactWriteTimeout: boolean;
  nextId: number;
}

function createMockGoogleFetch(state: MockGoogleState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const jsonResp = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (url === 'https://oauth2.googleapis.com/token') {
      return jsonResp({ access_token: 'mock-access-token', expires_in: 3600 });
    }

    if (url.startsWith('https://people.googleapis.com/v1/contactGroups')) {
      return jsonResp({ contactGroups: state.groups });
    }

    if (url.startsWith('https://people.googleapis.com/v1/people/me/connections')) {
      return jsonResp({ connections: Array.from(state.contacts.values()) });
    }

    if (url.startsWith('https://people.googleapis.com/v1/people:createContact') && method === 'POST') {
      if (state.failNextContactWriteTimeout) {
        state.failNextContactWriteTimeout = false;
        const err = new Error('The operation timed out (ETIMEDOUT)');
        err.name = 'TimeoutError';
        throw err;
      }
      const payload = JSON.parse(bodyText) as Record<string, unknown>;
      const id = `people/c${++state.nextId}`;
      const names = (payload.names as Array<{ familyName?: string; givenName?: string }>) ?? [];
      const displayName = `${names[0]?.familyName ?? ''}${names[0]?.givenName ?? ''}`;
      const stored = {
        ...payload,
        resourceName: id,
        etag: `etag-${state.nextId}`,
        names: [{ ...names[0], displayName }],
      };
      state.contacts.set(id, stored);
      return jsonResp(stored);
    }

    const updateContactMatch = url.match(/https:\/\/people\.googleapis\.com\/v1\/(people\/[^:?]+):updateContact/);
    if (updateContactMatch && method === 'PATCH') {
      const resourceName = updateContactMatch[1]!;
      const existing = state.contacts.get(resourceName);
      if (!existing) return jsonResp({ error: 'not found' }, 404);
      const payload = JSON.parse(bodyText) as Record<string, unknown>;
      if (payload.etag !== existing.etag) {
        return jsonResp({ error: 'etag mismatch' }, 412);
      }
      const names = (payload.names as Array<{ familyName?: string; givenName?: string }>) ?? [];
      const displayName = `${names[0]?.familyName ?? ''}${names[0]?.givenName ?? ''}`;
      const updated = {
        ...existing,
        ...payload,
        resourceName,
        etag: `etag-${++state.nextId}`,
        names: [{ ...names[0], displayName }],
      };
      state.contacts.set(resourceName, updated);
      return jsonResp(updated);
    }

    const getContactMatch = url.match(/https:\/\/people\.googleapis\.com\/v1\/(people\/[^:?]+)\?/);
    if (getContactMatch && method === 'GET') {
      const rec = state.contacts.get(getContactMatch[1]!);
      return rec ? jsonResp(rec) : jsonResp({ error: 'not found' }, 404);
    }

    if (url === 'https://www.googleapis.com/calendar/v3/users/me/calendarList') {
      return jsonResp({ items: state.calendars });
    }

    const calEventsMatch = url.match(/https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^?]+))?/);
    if (calEventsMatch) {
      const calId = decodeURIComponent(calEventsMatch[1]!);
      const eventId = calEventsMatch[2] ? decodeURIComponent(calEventsMatch[2]) : null;
      if (method === 'GET' && !eventId) {
        const list = Array.from(state.events.values()).filter((e) => e._calId === calId);
        return jsonResp({ items: list });
      }
      if (method === 'GET' && eventId) {
        const ev = state.events.get(eventId);
        return ev ? jsonResp(ev) : jsonResp({ error: 'not found' }, 404);
      }
      if (method === 'POST') {
        const payload = JSON.parse(bodyText) as Record<string, unknown>;
        const id = `evt_${++state.nextId}`;
        const saved = { ...payload, id, etag: `"ev-etag-${state.nextId}"`, _calId: calId };
        state.events.set(id, saved);
        return jsonResp(saved);
      }
      if (method === 'PATCH' && eventId) {
        const existing = state.events.get(eventId);
        if (!existing) return jsonResp({ error: 'not found' }, 404);
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.['If-Match'] !== existing.etag) {
          return jsonResp({ error: 'etag mismatch' }, 412);
        }
        const payload = JSON.parse(bodyText) as Record<string, unknown>;
        const saved = { ...existing, ...payload, etag: `"ev-etag-${++state.nextId}"` };
        state.events.set(eventId, saved);
        return jsonResp(saved);
      }
    }

    if (url.startsWith('https://tasks.googleapis.com/tasks/v1/users/@me/lists')) {
      return jsonResp({ items: state.taskLists });
    }

    const tasksMatch = url.match(/https:\/\/tasks\.googleapis\.com\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^?]+))?/);
    if (tasksMatch) {
      const listId = decodeURIComponent(tasksMatch[1]!);
      const taskId = tasksMatch[2] ? decodeURIComponent(tasksMatch[2]) : null;
      if (method === 'GET' && !taskId) {
        const items = Array.from(state.tasks.values()).filter((t) => t._listId === listId);
        return jsonResp({ items });
      }
      if (method === 'POST') {
        const payload = JSON.parse(bodyText) as Record<string, unknown>;
        const id = `task_${++state.nextId}`;
        const saved = { ...payload, id, etag: `t-etag-${state.nextId}`, _listId: listId };
        state.tasks.set(id, saved);
        return jsonResp(saved);
      }
      if (method === 'PATCH' && taskId) {
        const existing = state.tasks.get(taskId);
        if (!existing) return jsonResp({ error: 'not found' }, 404);
        const payload = JSON.parse(bodyText) as Record<string, unknown>;
        const saved = { ...existing, ...payload, etag: `t-etag-${++state.nextId}` };
        state.tasks.set(taskId, saved);
        return jsonResp(saved);
      }
    }

    return jsonResp({ error: `Unhandled mock Google URL: ${method} ${url}` }, 404);
  }) as typeof fetch;
}

describe('Google Workspace Dual-Track Sync (People + Calendar + Tasks + v1.4 Rules)', () => {
  const state: MockGoogleState = {
    groups: [{ resourceName: 'contactGroups/client-grp-1', name: '客户' }],
    contacts: new Map(),
    calendars: [
      { id: 'cal-work-id', summary: '工作' },
      { id: 'cal-bday-id', summary: '生日 🎉' },
    ],
    events: new Map(),
    taskLists: [
      { id: 'tl-work', title: '工作待办 Work' },
      { id: 'tl-personal', title: '个人生活 Personal' },
      { id: 'tl-shopping', title: '日常采购 Shopping' },
      { id: 'tl-inbox', title: '收集箱 Inbox' },
    ],
    tasks: new Map(),
    failNextContactWriteTimeout: false,
    nextId: 100,
  };

  let handle: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    handle = await buildApp({
      storage: 'memory',
      authMode: 'bearer',
      agentKeys: { antigravity: 'agy-key', muse: 'muse-key' },
      googleSync: {
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
        refreshToken: 'mock-refresh-token',
        enabled: true,
        contactsWriteEnabled: true,
        calendarWriteEnabled: true,
        tasksWriteEnabled: true,
        fetchImpl: createMockGoogleFetch(state),
      },
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('reports live Google status including target calendars, 客户 group, and 4 task lists', async () => {
    const res = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer agy-key' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'crm_google_status', arguments: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.json().result.content[0].text);
    expect(data.enabled).toBe(true);
    expect(data.live_check.ok).toBe(true);
    expect(data.live_check.client_group.name).toBe('客户');
    expect(data.live_check.work_calendar.id).toBe('cal-work-id');
    expect(data.live_check.birthday_calendar.id).toBe('cal-bday-id');
    expect(data.live_check.task_lists.every((x: { found: boolean }) => x.found)).toBe(true);
  });

  it('syncs a customer to Google Contacts with v1.4 note (with id_no, no policies) and 3-field readback', async () => {
    const createCust = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { authorization: 'Bearer agy-key' },
      payload: {
        name: '贵州模拟客户',
        gender: '女',
        birthday: '1988-05-12',
        primary_phone: '13885100001',
        address: '贵阳市云岩区测试路',
        id_no: '52010219880512122X',
      },
    });
    expect(createCust.statusCode).toBe(201);
    const customerId = createCust.json().id as string;

    const previewRes = await handle.app.inject({
      method: 'GET',
      url: `/api/v1/google/contacts/preview?customer_id=${customerId}`,
      headers: { authorization: 'Bearer muse-key' },
    });
    expect(previewRes.statusCode).toBe(200);
    const previewItem = previewRes.json()[0];
    expect(previewItem.has_id_no).toBe(true);
    expect(previewItem.planned_v14_note).toContain('身份证号：52010219880512122X');
    expect(previewItem.planned_v14_note).not.toContain('保单');

    const syncRes = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer muse-key' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'crm_google_contacts_sync', arguments: { customer_id: customerId } },
      },
    });
    expect(syncRes.statusCode).toBe(200);
    const result = JSON.parse(syncRes.json().result.content[0].text);
    expect(result.action).toBe('created');
    expect(result.group).toBe('客户');
    expect(result.readback_verified).toBe(true);
    expect(result.note).toContain('身份证号：52010219880512122X');
  });

  it('creates/updates a v1.4 platform event with ETag guard, attendee status, and companion reminders', async () => {
    const createCust = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { authorization: 'Bearer agy-key' },
      payload: { name: '平台会测试客户', primary_phone: '13885100002' },
    });
    const custId = createCust.json().id as string;

    const createEv = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer muse-key' },
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'crm_google_calendar_upsert_event',
          arguments: {
            mode: 'platform_event',
            activity_name: '周末养老平台会',
            start_iso: '2026-12-06T14:00:00+08:00',
            end_iso: '2026-12-06T16:30:00+08:00',
            entry_requirement: '提前报备名单',
            attendees: [{ name: '平台会测试客户', phone: '13885100002', status: 'invited' }],
            customer_id: custId,
            customer_name: '平台会测试客户',
            log_date: '2026-11-28',
            log_fact: '首次邀约成功',
            create_companion_reminders: true,
          },
        },
      },
    });
    expect(createEv.statusCode).toBe(200);
    const created = JSON.parse(createEv.json().result.content[0].text);
    expect(created.event.summary).toBe('✅ 👥 周末养老平台会');
    expect(created.event.description).toContain('客户状态：📨 已邀约');
    expect(created.event.description).toContain('平台会测试客户：首次邀约成功');
    expect(created.companion_followups).toHaveLength(2);
    expect(created.companion_followups[0].title).toBe('平台会测试客户 检查建议书与确认会面动向');
    expect(created.companion_followups[1].title).toBe('平台会测试客户 回写跟进台账并归档资料');

    // Update with stale ETag must return CONFLICT
    const badUpdate = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer agy-key' },
      payload: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'crm_google_calendar_upsert_event',
          arguments: {
            mode: 'platform_event',
            event_id: created.event.id,
            expected_etag: '"wrong-etag"',
            attendees: [{ name: '平台会测试客户', status: 'confirmed' }],
          },
        },
      },
    });
    expect(badUpdate.json().result.isError).toBe(true);
    expect(JSON.parse(badUpdate.json().result.content[0].text).error).toBe('CONFLICT');

    // Update with matching ETag upgrades attendee status and appends log
    const goodUpdate = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer agy-key' },
      payload: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'crm_google_calendar_upsert_event',
          arguments: {
            mode: 'platform_event',
            event_id: created.event.id,
            expected_etag: created.event.etag,
            attendees: [{ name: '平台会测试客户', status: 'confirmed' }],
            customer_name: '平台会测试客户',
            log_date: '2026-12-06',
            log_fact: '已到场并沟通15分钟',
          },
        },
      },
    });
    const updated = JSON.parse(goodUpdate.json().result.content[0].text);
    expect(updated.event.description).toContain('客户状态：✅ 已确认');
    expect(updated.event.description).toContain('平台会测试客户：已到场并沟通15分钟');
  });

  it('syncs followups to Google Tasks and NEVER recreates a user-deleted task', async () => {
    const firstSync = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer agy-key' },
      payload: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'crm_google_tasks_sync', arguments: {} },
      },
    });
    const r1 = JSON.parse(firstSync.json().result.content[0].text);
    expect(r1.pushed).toBeGreaterThan(0);

    // Simulate user deleting one task in Google Tasks and completing another
    const taskIds = Array.from(state.tasks.keys());
    const deletedId = taskIds[0]!;
    const completedId = taskIds[1]!;
    state.tasks.set(deletedId, { ...state.tasks.get(deletedId)!, deleted: true });
    state.tasks.set(completedId, { ...state.tasks.get(completedId)!, status: 'completed' });
    const countBefore = state.tasks.size;

    const secondSync = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/google/tasks/sync',
      headers: { authorization: 'Bearer agy-key' },
    });
    expect(secondSync.statusCode).toBe(200);
    const r2 = secondSync.json();
    expect(r2.skipped_user_deleted).toBe(1);
    expect(r2.pulled_completed).toBe(1);
    expect(r2.pushed).toBe(0);
    expect(state.tasks.size).toBe(countBefore); // NEVER recreated!
  });

  it('halts contacts writes on UNKNOWN timeout and unlocks only after 2-readback reconciliation', async () => {
    const cRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { authorization: 'Bearer agy-key' },
      payload: { name: '停写测试客户', primary_phone: '13885100099' },
    });
    const custId = cRes.json().id as string;

    state.failNextContactWriteTimeout = true;
    const timeoutRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/google/contacts/sync',
      headers: { authorization: 'Bearer agy-key' },
      payload: { customer_id: custId },
    });
    expect(timeoutRes.statusCode).toBe(503);
    expect(timeoutRes.json().error).toBe('GOOGLE_WRITE_UNKNOWN');

    // Blind retry MUST be blocked by V14WriteGuard
    const blockedRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/google/contacts/sync',
      headers: { authorization: 'Bearer agy-key' },
      payload: { customer_id: custId },
    });
    expect(blockedRes.statusCode).toBe(503);
    expect(blockedRes.json().error).toBe('WRITE_GUARD_UNKNOWN_HALTED');

    // Reconcile with two consistent negative readbacks -> VERIFIED_NOT_APPLIED -> unlocked!
    const recRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/google/guard/reconcile',
      headers: { authorization: 'Bearer agy-key' },
      payload: { channel: 'contacts', first_read_applied: false, second_read_applied: false },
    });
    expect(recRes.statusCode).toBe(200);
    expect(recRes.json().verdict).toBe('VERIFIED_NOT_APPLIED');

    const retryOk = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/google/contacts/sync',
      headers: { authorization: 'Bearer agy-key' },
      payload: { customer_id: custId },
    });
    expect(retryOk.statusCode).toBe(200);
    expect(retryOk.json().action).toBe('created');
  });
});
