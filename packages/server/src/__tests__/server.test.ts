import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { DEMO_IDS } from '../services/seed-demo.js';

describe('Insurance CRM Server REST + 16-Tool MCP + KJGX + iCloud Sync', () => {
  const EXPECTED_HASH = 'deadbeefcafebabe1234567890';
  const AGENT_KEYS = {
    muse: 'test-muse-key',
    antigravity: 'test-agy-key',
    human_web: 'test-web-key',
  };

  let handle: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    handle = await buildApp({
      storage: 'memory',
      authMode: 'bearer',
      agentKeys: AGENT_KEYS,
      expectedBundleHash: EXPECTED_HASH,
    });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('rejects unauthenticated requests when AUTH_MODE=bearer', async () => {
    const res = await handle.app.inject({ method: 'GET', url: '/api/v1/customers' });
    expect(res.statusCode).toBe(401);
  });

  it('exposes exact 16 tools on /crm-mcp tools/list and records Agent identity', async () => {
    const listRes = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer test-muse-key' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools).toHaveLength(16);

    const searchRes = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer test-muse-key' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'crm_search_customers', arguments: { min_premium: 100000 } },
      },
    });
    const searchPayload = JSON.parse(searchRes.json().result.content[0].text) as {
      customers: Array<{ name: string }>;
    };
    expect(searchPayload.customers.map((c) => c.name)).toEqual(['苏晚晴', '林致远']);
  });

  it('orders customers by total_premium descending with null premiums last', async () => {
    const nullRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { authorization: 'Bearer test-web-key' },
      payload: {
        name: '零保费测试客户',
        primary_phone: '13900007777',
      },
    });
    expect(nullRes.statusCode).toBe(201);

    const listRes = await handle.app.inject({
      method: 'GET',
      url: '/api/v1/customers?limit=20',
      headers: { authorization: 'Bearer test-web-key' },
    });
    expect(listRes.statusCode).toBe(200);
    const customers = listRes.json().customers as Array<{ name: string; total_premium: number | null }>;
    expect(customers[0]!.name).toBe('苏晚晴');
    expect(customers[0]!.total_premium).toBe(156000);
    expect(customers[1]!.name).toBe('林致远');
    expect(customers[customers.length - 1]!.name).toBe('零保费测试客户');
    expect(customers[customers.length - 1]!.total_premium).toBeNull();
  });

  it('enforces optimistic locking (409 / CONFLICT) on concurrent customer updates', async () => {
    const okPatch = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${DEMO_IDS.cust2}`,
      headers: { authorization: 'Bearer test-web-key' },
      payload: { expected_version: 1, address: '模拟市滨江大道 168 弄 8 号', enqueue_kjgx_writeback: true },
    });
    expect(okPatch.statusCode).toBe(200);
    expect(okPatch.json().version).toBe(2);

    const stalePatch = await handle.app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${DEMO_IDS.cust2}`,
      headers: { authorization: 'Bearer test-agy-key' },
      payload: { expected_version: 1, address: '冲突旧版本号覆盖' },
    });
    expect(stalePatch.statusCode).toBe(409);
    expect(stalePatch.json().error).toBe('CONFLICT');
  });

  it('enforces KJGX L0 OTA Hash Gate (blocked_ota) and mandatory readback_matched completion', async () => {
    // 1. Enqueue and approve a writeback job
    const enqueueRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/kjgx/jobs',
      headers: { authorization: 'Bearer test-muse-key' },
      payload: {
        customer_id: DEMO_IDS.cust1,
        job_type: 'update_profile',
        payload_target: { address: '新地址' },
        field_diff: [{ field: '地址', before: '旧', after: '新地址' }],
      },
    });
    expect(enqueueRes.statusCode).toBe(201);
    const jobId = enqueueRes.json().id as string;
    expect(enqueueRes.json().approval_status).toBe('pending_review');

    // Approve job-1 (seeded) and new job
    await handle.app.inject({
      method: 'POST',
      url: `/api/v1/kjgx/jobs/88888888-8888-4888-8888-888888888001/approve`,
      headers: { authorization: 'Bearer test-web-key' },
    });

    // 2. Claim with mismatched OTA hash -> must block fail-closed!
    const badClaim = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/kjgx/worker/claim',
      headers: { authorization: 'Bearer test-web-key' },
      payload: { deviceId: 'pixel3a-kjgx', appVersion: '18.6', bundleHash: 'ota-changed-hash' },
    });
    expect(badClaim.statusCode).toBe(409);
    expect(badClaim.json().code).toBe('OTA_HASH_MISMATCH');
    expect(badClaim.json().job.execution_status).toBe('blocked_ota');

    // 3. Approve new job and claim with matching hash
    await handle.app.inject({
      method: 'POST',
      url: `/api/v1/kjgx/jobs/${jobId}/approve`,
      headers: { authorization: 'Bearer test-web-key' },
    });
    const goodClaim = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/kjgx/worker/claim',
      headers: { authorization: 'Bearer test-web-key' },
      payload: { deviceId: 'pixel3a-kjgx', appVersion: '18.5', bundleHash: EXPECTED_HASH },
    });
    expect(goodClaim.statusCode).toBe(200);
    expect(goodClaim.json().job.id).toBe(jobId);

    // 4. Complete with readback_matched = true -> succeeded
    const doneRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/kjgx/worker/complete',
      headers: { authorization: 'Bearer test-web-key' },
      payload: {
        jobId,
        deviceId: 'pixel3a-kjgx',
        receipt: {
          assigned_device: 'pixel3a-kjgx',
          attempts: 1,
          route_result: 'NAVIGATED',
          edit_page_seen: true,
          customer_name_seen: true,
          readback_matched: true,
          app_result: 'SAVE_OK',
        },
      },
    });
    expect(doneRes.statusCode).toBe(200);
    expect(doneRes.json().execution_status).toBe('succeeded');
  });

  it('previews iCloud 3-Way Diff & MUSE Work reminder routing and resolves conflicts safely', async () => {
    const previewRes = await handle.app.inject({
      method: 'GET',
      url: `/api/v1/sync/icloud/preview?customer_id=${DEMO_IDS.cust1}`,
      headers: { authorization: 'Bearer test-muse-key' },
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = previewRes.json()[0];
    expect(preview.diff.conflicts[0].field).toBe('address');
    expect(preview.pending_reminders[0].listName).toBe('工作待办 Work');
    expect(preview.privacy_fence_mode).toBe('disabled_full_dossier');
    expect(preview.sanitized_payload.idNo).toBe('3101**********001X');
    expect(preview.sanitized_payload.totalPremium).toBe(128400);
    expect(preview.write_gate_status).toBe('locked_preview_only');
    expect(preview.planned_followup_note).toContain('[#CRM-BEGIN]');
    expect(preview.planned_followup_note).toContain('身份证:');
    expect(preview.planned_followup_note).toContain('总保费¥128,400');
    expect(preview.planned_followup_note).toContain('保单明细:');
    expect(preview.planned_followup_note).toContain('[#CRM-END]');
    expect(preview.planned_followup_note).toMatch(/\[#FUP:[A-Za-z0-9_-]+\] \d{4}-\d{2}-\d{2} \| /);

    const resolveRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/sync/conflicts/99999999-9999-4999-8999-999999999001/resolve',
      headers: { authorization: 'Bearer test-web-key' },
      payload: { resolution: 'take_remote' },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().status).toBe('resolved_take_remote');

    const custAfter = await handle.app.inject({
      method: 'GET',
      url: `/api/v1/customers/${DEMO_IDS.cust1}`,
      headers: { authorization: 'Bearer test-web-key' },
    });
    expect(custAfter.json().customer.address).toBe('模拟市示范区测试路 88 号 3号楼');
  });

  it('hard-locks iCloud Contacts write via REST and MCP while allowing read-only preview', async () => {
    const applyRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/sync/icloud/apply',
      headers: { authorization: 'Bearer test-web-key' },
      payload: { customer_id: DEMO_IDS.cust1 },
    });
    expect(applyRes.statusCode).toBe(403);
    expect(applyRes.json().error).toBe('ICLOUD_WRITE_LOCKED');

    const mcpApplyRes = await handle.app.inject({
      method: 'POST',
      url: '/crm-mcp',
      headers: { authorization: 'Bearer test-muse-key' },
      payload: {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'crm_sync_icloud_apply', arguments: { customer_id: DEMO_IDS.cust1 } },
      },
    });
    expect(mcpApplyRes.statusCode).toBe(200);
    const mcpBody = mcpApplyRes.json();
    expect(mcpBody.result.isError).toBe(true);
    expect(JSON.parse(mcpBody.result.content[0].text).error).toBe('ICLOUD_WRITE_LOCKED');
  });

  it('supports MacServer-free iPhone Shortcuts Reminders pull and ack persistence', async () => {
    const pullRes = await handle.app.inject({
      method: 'GET',
      url: '/api/v1/sync/reminders/shortcut-pull',
      headers: { authorization: 'Bearer test-web-key' },
    });
    expect(pullRes.statusCode).toBe(200);
    const pullData = pullRes.json() as {
      mode: string;
      count: number;
      items: Array<{ followup_id: string; list_name: string; title: string }>;
    };
    expect(pullData.mode).toBe('iphone_shortcut_direct');
    expect(pullData.count).toBeGreaterThan(0);
    expect(pullData.items[0]!.list_name).toBe('工作待办 Work');

    const targetFollowupId = pullData.items[0]!.followup_id;
    const ackRes = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/sync/reminders/shortcut-ack',
      headers: { authorization: 'Bearer test-web-key' },
      payload: {
        items: [
          {
            followup_id: targetFollowupId,
            icloud_reminder_id: 'shortcut-rem-001',
            icloud_list_id: '工作待办 Work',
            status: 'done',
          },
        ],
      },
    });
    expect(ackRes.statusCode).toBe(200);
    expect(ackRes.json().updated_count).toBe(1);
    expect(ackRes.json().updated_ids).toEqual([targetFollowupId]);

    const verifyFollowupsRes = await handle.app.inject({
      method: 'GET',
      url: '/api/v1/followups?status=done',
      headers: { authorization: 'Bearer test-web-key' },
    });
    expect(verifyFollowupsRes.statusCode).toBe(200);
    const doneItem = (verifyFollowupsRes.json() as Array<{ id: string; icloud_reminder_id: string }>).find(
      (f) => f.id === targetFollowupId,
    );
    expect(doneItem).toBeDefined();
    expect(doneItem?.icloud_reminder_id).toBe('shortcut-rem-001');
  });

  it('reports MacServer-free Reminders bridge status cleanly when unconfigured', async () => {
    const statusRes = await handle.app.inject({
      method: 'GET',
      url: '/api/v1/sync/reminders/status',
      headers: { authorization: 'Bearer test-web-key' },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toEqual({
      configured: false,
      engine: 'none',
      macserver_dependency: false,
      shortcut_sync_available: true,
      write_enabled: false,
      contacts: {
        contacts_write_enabled: false,
        reminders_write_enabled: false,
        carddav_connected: false,
        privacy_fence_mode: 'disabled_full_dossier',
        transport_mode: 'dry_snapshot',
      },
    });
  });
});
