import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import {
  buildNewVcard,
  type CardDavContactPatch,
  type CardDavContactRecord,
  type CardDavTransport,
  parseVcard,
  patchVcardSurgical,
} from '../services/carddav-client.js';
import { DEMO_IDS } from '../services/seed-demo.js';
import { ConflictError } from '../services/store.js';

class InMemoryMockCardDavTransport implements CardDavTransport {
  readonly cards = new Map<string, CardDavContactRecord>();
  conflictNextUpdate = false;
  private seq = 1;

  async discoverAddressBook(): Promise<string> {
    return 'https://contacts.icloud.com/mock/card/';
  }

  async listContacts(): Promise<CardDavContactRecord[]> {
    return Array.from(this.cards.values()).filter((c) => !c.parsed.isGroup);
  }

  async getCard(href: string): Promise<CardDavContactRecord | null> {
    return this.cards.get(href) ?? null;
  }

  async createCard(sanitized: Parameters<typeof buildNewVcard>[0], note: string | null, uid = `uid-${this.seq++}`) {
    const href = `https://contacts.icloud.com/mock/card/${uid}.vcf`;
    const rawVcard = buildNewVcard(sanitized, note, uid);
    const etag = `"etag-${this.seq++}"`;
    this.cards.set(href, { href, etag, rawVcard, parsed: parseVcard(rawVcard) });
    return { href, etag, uid };
  }

  async updateCardSurgical(
    href: string,
    _expectedEtag: string | null,
    rawVcard: string,
    patch: CardDavContactPatch,
    mergedNote: string | null,
  ) {
    if (this.conflictNextUpdate) {
      this.conflictNextUpdate = false;
      throw new ConflictError('Simulated 412 ETag mismatch');
    }
    const nextVcard = patchVcardSurgical(rawVcard, patch, mergedNote);
    const etag = `"etag-${this.seq++}"`;
    this.cards.set(href, { href, etag, rawVcard: nextVcard, parsed: parseVcard(nextVcard) });
    return { href, etag };
  }

  async deleteCard(href: string): Promise<void> {
    this.cards.delete(href);
  }
}

describe('Direct CardDAV & PyiCloud Reminders Unlocked Integration', () => {
  it('parses and surgically patches vCard preserving PHOTO, X-ABLabel, and personal NOTE', () => {
    const original = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:mock-uid-1',
      'FN:测试联系人',
      'N:测;试联系人;;;',
      'item1.TEL;type=CELL:+86 138-0013-8001',
      'item1.X-ABLabel:私人手机',
      'item2.URL:https://example.com',
      'item2.X-ABLabel:_$!<HomePage>!$_',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==',
      'NOTE:喜欢喝乌龙茶\\n[#FUP:old001] 2026-11-01 | 档案 | 初始',
      'END:VCARD',
    ].join('\r\n');

    const parsed = parseVcard(original);
    expect(parsed.isGroup).toBe(false);
    expect(parsed.phones).toEqual(['13800138001']);
    expect(parsed.note).toContain('喜欢喝乌龙茶');

    const patched = patchVcardSurgical(
      original,
      { company: '示例科技公司' },
      '喜欢喝乌龙茶\n[#FUP:old001] 2026-11-24 | 跟进 | 约周三回访',
    );
    expect(patched).toContain('PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==');
    expect(patched).toContain('item2.URL:https://example.com');
    expect(patched).toContain('item2.X-ABLabel:_$!<HomePage>!$_');
    expect(patched).toContain('ORG:示例科技公司');
    expect(patched).toContain('喜欢喝乌龙茶\\n[#FUP:old001] 2026-11-24 | 跟进 | 约周三回访');
    expect(patched).not.toContain('id_no');

    const groupVcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:grp-1\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nFN:VIP\r\nEND:VCARD\r\n';
    expect(parseVcard(groupVcard).isGroup).toBe(true);
  });

  describe('Unlocked CRM REST + CardDAV + Reminders bridge flow', () => {
    const cardDav = new InMemoryMockCardDavTransport();
    const remoteReminders = new Map<
      string,
      { id: string; list_id: string; list_title: string; title: string; desc: string; completed: boolean; priority: number }
    >();
    let remSeq = 1;

    const mockRemindersFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

      if (url.endsWith('/health') && method === 'GET') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            engine: 'pyicloud-cloudkit',
            macserver_dependency: false,
            authenticated: true,
            trusted: true,
            active_lists_count: 5,
            write_enabled: true,
            cookie_min_remaining_days: 30,
            hsa_trust_remaining_days: 83.2,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/lists') && method === 'GET') {
        return new Response(
          JSON.stringify({
            engine: 'pyicloud-cloudkit',
            lists: [{ list_id: 'List/work', title: '工作待办 Work', count: remoteReminders.size, color: 'blue' }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/reminders') && method === 'POST') {
        const id = `Reminder/mock-${remSeq++}`;
        const rec = {
          id,
          list_id: 'List/work',
          list_title: String(body.list_title ?? '工作待办 Work'),
          title: String(body.title ?? ''),
          desc: String(body.desc ?? ''),
          completed: false,
          priority: Number(body.priority ?? 0),
        };
        remoteReminders.set(id, rec);
        return new Response(JSON.stringify(rec), { status: 201 });
      }
      if (url.includes('/reminders?') && method === 'GET') {
        return new Response(
          JSON.stringify({
            list_id: 'List/work',
            list_title: '工作待办 Work',
            reminders: Array.from(remoteReminders.values()),
          }),
          { status: 200 },
        );
      }
      if (url.includes('/reminders/') && method === 'PATCH') {
        const id = decodeURIComponent(url.split('/reminders/')[1]!);
        const rec = remoteReminders.get(id);
        if (!rec) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
        if (typeof body.completed === 'boolean') rec.completed = body.completed;
        if (typeof body.title === 'string') rec.title = body.title;
        return new Response(JSON.stringify(rec), { status: 200 });
      }
      if (url.includes('/reminders/') && method === 'DELETE') {
        const id = decodeURIComponent(url.split('/reminders/')[1]!);
        remoteReminders.delete(id);
        return new Response(JSON.stringify({ deleted: true, id }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    };

    let handle: Awaited<ReturnType<typeof buildApp>>;

    beforeAll(async () => {
      handle = await buildApp({
        storage: 'memory',
        authMode: 'bearer',
        agentKeys: { human_web: 'test-web-key', muse: 'test-muse-key' },
        icloudContactsWriteEnabled: true,
        icloudRemindersWriteEnabled: true,
        cardDav,
        remindersBridgeUrl: 'http://127.0.0.1:18768',
        remindersBridgeToken: 'mock-bridge-secret',
        remindersFetch: mockRemindersFetch,
      });
    });

    afterAll(async () => {
      await handle.close();
    });

    it('reports unlocked CardDAV & Reminders status and performs single-customer create + update + 412 conflict check', async () => {
      const statusRes = await handle.app.inject({
        method: 'GET',
        url: '/api/v1/sync/reminders/status',
        headers: { authorization: 'Bearer test-web-key' },
      });
      expect(statusRes.statusCode).toBe(200);
      const statusBody = statusRes.json();
      expect(statusBody.configured).toBe(true);
      expect(statusBody.bridge.write_enabled).toBe(true);
      expect(statusBody.contacts.contacts_write_enabled).toBe(true);
      expect(statusBody.contacts.carddav_connected).toBe(true);

      // 1. Create single customer card in CardDAV
      const createApply = await handle.app.inject({
        method: 'POST',
        url: '/api/v1/sync/icloud/apply',
        headers: { authorization: 'Bearer test-web-key' },
        payload: { customer_id: DEMO_IDS.cust2, create_missing: true },
      });
      expect(createApply.statusCode).toBe(200);
      const createData = createApply.json();
      expect(createData.mode).toBe('live_carddav');
      expect(createData.created_customers).toContain(DEMO_IDS.cust2);
      expect(cardDav.cards.size).toBe(1);

      const savedCard = Array.from(cardDav.cards.values())[0]!;
      expect(savedCard.parsed.fn).toBe('周明芳');
      expect(savedCard.parsed.note).toContain('[#FUP:');

      // 2. Simulate 412 conflict on next CardDAV update -> recorded as conflict, zero overwrite
      await handle.store.upsertFollowup(
        { customer_id: DEMO_IDS.cust2, title: '新增跟进校验 ETag 冲突', status: 'open' },
        { actorType: 'human', actorId: 'human_web' },
      );
      cardDav.conflictNextUpdate = true;
      const conflictApply = await handle.app.inject({
        method: 'POST',
        url: '/api/v1/sync/icloud/apply',
        headers: { authorization: 'Bearer test-web-key' },
        payload: { customer_id: DEMO_IDS.cust2 },
      });
      expect(conflictApply.statusCode).toBe(200);
      expect(conflictApply.json().created_conflicts).toHaveLength(1);
    });

    it('auto-pushes followups to CloudKit Reminders on create/complete and pulls remote completion back', async () => {
      // 1. Create followup -> auto-pushed to remoteReminders
      const createRes = await handle.app.inject({
        method: 'POST',
        url: '/api/v1/followups',
        headers: { authorization: 'Bearer test-muse-key' },
        payload: {
          customer_id: DEMO_IDS.cust1,
          title: '保单检视确认方案',
          priority: 'high',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const createdFu = createRes.json() as { id: string; icloud_reminder_id: string; sync_state: string };
      expect(createdFu.icloud_reminder_id).toMatch(/^Reminder\/mock-/);
      expect(createdFu.sync_state).toBe('in_sync');
      expect(remoteReminders.get(createdFu.icloud_reminder_id)?.completed).toBe(false);

      // 2. Complete remotely on iPhone -> CRM pulls completion
      remoteReminders.get(createdFu.icloud_reminder_id)!.completed = true;
      const syncRes = await handle.app.inject({
        method: 'POST',
        url: '/api/v1/sync/reminders/sync',
        headers: { authorization: 'Bearer test-web-key' },
        payload: {},
      });
      expect(syncRes.statusCode).toBe(200);
      expect(syncRes.json().pulled_completed).toBeGreaterThanOrEqual(1);

      const fuList = await handle.store.listFollowups({ customer_id: DEMO_IDS.cust1 });
      const syncedFu = fuList.find((f) => f.id === createdFu.id);
      expect(syncedFu?.status).toBe('done');

      // 3. Reopen via PATCH -> pushes completed=false to CloudKit
      const reopenRes = await handle.app.inject({
        method: 'PATCH',
        url: `/api/v1/followups/${createdFu.id}`,
        headers: { authorization: 'Bearer test-web-key' },
        payload: { status: 'open', expected_version: syncedFu!.version },
      });
      expect(reopenRes.statusCode).toBe(200);
      expect(remoteReminders.get(createdFu.icloud_reminder_id)?.completed).toBe(false);
    });
  });
});
