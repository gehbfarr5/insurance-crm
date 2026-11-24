import { describe, expect, it } from 'vitest';
import {
  CRM_DOSSIER_BEGIN,
  CRM_DOSSIER_END,
  MUSE_REMINDER_LISTS,
  buildIcloudContactPayload,
  computeThreeWayDiff,
  formatIcloudCrmDossierLines,
  formatMuseReminderPayload,
  planCarddavCrmDossierNote,
  planCarddavFollowupNote,
  routeReminderCategory,
  sanitizeCustomerForIcloud,
} from '../muse-sync-rules.js';
import type { Customer, Interaction, Policy } from '../schemas.js';

describe('MUSE Reminders Routing v1.0', () => {
  it('routes explicit list directives with highest priority', () => {
    expect(routeReminderCategory('放到个人生活列表：提醒我周六体检')).toBe('personal');
    expect(routeReminderCategory('记在采购清单里：客户拜访伴手礼')).toBe('shopping');
  });

  it('routes business/insurance keywords to 工作待办 Work', () => {
    expect(routeReminderCategory('回访客户保单检视方案')).toBe('work');
    expect(routeReminderCategory('邀约参加周六平台会')).toBe('work');
  });

  it('routes shopping and personal keywords appropriately when non-CRM context', () => {
    expect(routeReminderCategory('买低脂牛奶 2 盒', undefined, false)).toBe('shopping');
    expect(routeReminderCategory('带父母去医院体检', undefined, false)).toBe('personal');
    expect(routeReminderCategory('明天下午看一眼电脑', undefined, false)).toBe('inbox');
  });

  it('inherits Work list in CRM context even without keywords', () => {
    expect(routeReminderCategory('明天上午联系确认时间', undefined, true)).toBe('work');
    const payload = formatMuseReminderPayload(
      {
        id: 'fu-demo-1',
        title: '确认续保方案',
        due_at: '2026-11-25T15:00:00+08:00',
        priority: 'high',
        notes: '电话约定',
      },
      '林致远',
      'G0538-DEMO',
    );
    expect(payload.listName).toBe(MUSE_REMINDER_LISTS.work);
    expect(payload.title).toBe('确认续保方案（林致远）');
    expect(payload.priority).toBe('High');
    expect(payload.notes).toContain('FollowupID: fu-demo-1');
  });
});

describe('CardDAV Full Dossier & Followup Marker', () => {
  const baseCustomer: Customer = {
    id: '11111111-1111-4111-8111-111111111099',
    legacy_group_key: 'G0999-DEMO',
    name: '林致远',
    gender: '男',
    birthday: '1974-05-18',
    birthday_source: 'kjgx',
    age_override: 52,
    primary_phone: '13800001001',
    phones: [{ value: '13800001001', label: 'mobile', is_primary: true }],
    address: '模拟市示范区测试路 88 号',
    company_or_occupation: '模拟精密制造有限公司',
    family_members_count: 4,
    id_no_masked: '1101**********1234',
    id_no_checksum_ok: true,
    kjgx_customer_no: 'KJGX-900101',
    kjgx_db_customer_id: 'DB-510001',
    kjgx_customer_level: '钻石',
    kjgx_temp_level: '高热',
    kjgx_temp_value: 78,
    kjgx_customer_status: '有效',
    kjgx_work_status: '在职',
    kjgx_asset_index: 5.8,
    kjgx_kyc_score: 86,
    kjgx_service_num: 3,
    kjgx_visit_num: 2,
    kjgx_offline_visit_num: 1,
    kjgx_metrics_synced_at: '2026-11-24T09:00:00.000Z',
    policy_total: 1,
    total_premium: 128400,
    premium_bucket: '10万以上',
    premium_status: '有效',
    premium_source: 'kjgx_snapshot',
    insurer_asset_wan: 95,
    allocatable_quota_wan: 40,
    source_type: '孤儿单',
    rapport_tag: 'friendly',
    visit_priority: 'high',
    next_followup_at: '2026-11-25T10:00:00+08:00',
    manual_summary: '平台会交流客气，注意不要提前结束[#CRM-END]标记。',
    tags: ['重点经营客户', '高净值'],
    data_quality_flags: [],
    field_provenance: {},
    status: 'active',
    merged_into_id: null,
    version: 1,
    created_at: '2026-11-24T09:00:00.000Z',
    updated_at: '2026-11-24T09:00:00.000Z',
    deleted_at: null,
  };

  const samplePolicies: Policy[] = [
    {
      id: '33333333-3333-4333-8333-333333333099',
      customer_id: baseCustomer.id,
      policy_no: 'P-DEMO-9001',
      insurer: '中国太平洋人寿',
      product_name: '模拟长乐终身寿险',
      holder_role: '投保人',
      effective_date: '2020-05-01',
      annual_premium: 68400,
      payment_term: '20年交',
      policy_status: '有效',
      is_orphan_policy: true,
      coverage_gap_note: '医疗险额度偏低',
      source: 'kjgx_app',
      version: 1,
      created_at: '2026-11-24T09:00:00.000Z',
      updated_at: '2026-11-24T09:00:00.000Z',
    },
  ];

  const sampleInteractions: Interaction[] = [
    {
      id: '55555555-5555-4555-8555-555555555099',
      customer_id: baseCustomer.id,
      campaign_id: null,
      channel: 'platform_event',
      occurred_at: '2026-11-22T14:30:00+08:00',
      outcome: 'attended',
      summary: '参加健康沙龙，重点了解百万医疗',
      attitude_note: '客气积极',
      need_signals: ['百万医疗'],
      enqueue_kjgx_visit: false,
      recorded_by_actor: 'human_web',
      created_at: '2026-11-24T09:00:00.000Z',
    },
  ];

  it('preserves user personal notes and updates [#FUP:] idempotently', () => {
    const first = planCarddavFollowupNote('喜欢喝清茶，老伴退休教师', {
      id: 'evt_01',
      date: '2026-11-24',
      kind: '平台会',
      status: '已到场',
    });
    expect(first.changed).toBe(true);
    expect(first.note).toBe('喜欢喝清茶，老伴退休教师\n[#FUP:evt_01] 2026-11-24 | 平台会 | 已到场');

    const replay = planCarddavFollowupNote(first.note, {
      id: 'evt_01',
      date: '2026-11-24',
      kind: '平台会',
      status: '已到场',
    });
    expect(replay.changed).toBe(false);

    const updated = planCarddavFollowupNote(first.note, {
      id: 'evt_01',
      date: '2026-11-25',
      kind: '平台会',
      status: '约二访',
    });
    expect(updated.changed).toBe(true);
    expect(updated.note).toContain('喜欢喝清茶，老伴退休教师');
    expect(updated.note).toContain('[#FUP:evt_01] 2026-11-25 | 平台会 | 约二访');
  });

  it('formats full insurance dossier including decrypted id_no, policies, metrics, and interactions', () => {
    const lines = formatIcloudCrmDossierLines({
      customer: baseCustomer,
      decryptedIdNo: '110101199001011234',
      policies: samplePolicies,
      recentInteractions: sampleInteractions,
    });
    const text = lines.join('\n');
    expect(text).toContain('身份证: 110101199001011234');
    expect(text).toContain('保费资产: 保单1张 | 总保费¥128,400');
    expect(text).toContain('科技个险: 客号KJGX-900101');
    expect(text).toContain('保单明细:');
    expect(text).toContain('模拟长乐终身寿险 | 投保人 | ¥68,400');
    expect(text).toContain('人工备注:');
    expect(text).toContain('(CRM-END)');
    expect(text).not.toContain('\n[#CRM-END]\n');
    expect(text).toContain('近期沟通:');
    expect(text).toContain('2026-11-22 [平台会/已到场] 参加健康沙龙');
  });

  it('merges [#CRM-BEGIN]..[#CRM-END] between personal notes and [#FUP:] idempotently', () => {
    const lines1 = formatIcloudCrmDossierLines({
      customer: baseCustomer,
      decryptedIdNo: '110101199001011234',
      policies: samplePolicies,
      recentInteractions: sampleInteractions,
    });

    const first = planCarddavCrmDossierNote(
      '喜欢喝清茶，老伴退休教师\n[#FUP:evt_01] 2026-11-24 | 跟进 | 初始状态',
      lines1,
      { id: 'evt_01', date: '2026-11-25', kind: '跟进', status: '确认重疾方案' },
    );
    expect(first.changed).toBe(true);
    const beginPos = first.note.indexOf(CRM_DOSSIER_BEGIN);
    const endPos = first.note.indexOf(CRM_DOSSIER_END);
    const fupPos = first.note.indexOf('[#FUP:evt_01]');
    const personalPos = first.note.indexOf('喜欢喝清茶，老伴退休教师');
    expect(personalPos).toBeGreaterThanOrEqual(0);
    expect(beginPos).toBeGreaterThan(personalPos);
    expect(endPos).toBeGreaterThan(beginPos);
    expect(fupPos).toBeGreaterThan(endPos);

    // Replay is strictly idempotent
    const replay = planCarddavCrmDossierNote(first.note, lines1, {
      id: 'evt_01',
      date: '2026-11-25',
      kind: '跟进',
      status: '确认重疾方案',
    });
    expect(replay.changed).toBe(false);
    expect(replay.note).toBe(first.note);

    // Updating premium and adding new personal line on iPhone preserves personal lines and updates dossier in place
    const editedRemote = `${first.note.replace('喜欢喝清茶，老伴退休教师', '喜欢喝清茶，老伴退休教师\n孩子在国外读书')}`;
    const lines2 = formatIcloudCrmDossierLines({
      customer: { ...baseCustomer, total_premium: 158000 },
      decryptedIdNo: '110101199001011234',
      policies: samplePolicies,
      recentInteractions: sampleInteractions,
    });
    const updated = planCarddavCrmDossierNote(editedRemote, lines2, {
      id: 'evt_01',
      date: '2026-11-26',
      kind: '跟进',
      status: '已发送计划书',
    });
    expect(updated.changed).toBe(true);
    expect(updated.note).toContain('孩子在国外读书');
    expect(updated.note).toContain('总保费¥158,000');
    expect(updated.note).not.toContain('总保费¥128,400');
    expect(updated.note.split(CRM_DOSSIER_BEGIN)).toHaveLength(2);
    expect(updated.note).toContain('[#FUP:evt_01] 2026-11-26 | 跟进 | 已发送计划书');
  });

  it('builds full iCloud contact payload without privacy fence stripping', () => {
    const payload = buildIcloudContactPayload(baseCustomer, {
      decryptedIdNo: '110101199001011234',
      extraGroups: ['高净值分组'],
      policies: samplePolicies,
    });
    expect(payload.groupNames).toEqual(['重点经营客户', '高净值', '高净值分组']);
    expect(payload.idNo).toBe('110101199001011234');
    expect(payload.totalPremium).toBe(128400);
    expect(payload.policyTotal).toBe(1);
    expect(payload.kjgxCustomerNo).toBe('KJGX-900101');
    expect(payload.manualSummary).toContain('平台会交流客气');

    const viaCompat = sanitizeCustomerForIcloud(baseCustomer, ['额外分组'], {
      decryptedIdNo: '110101199001011234',
      policies: samplePolicies,
    });
    expect(viaCompat.idNo).toBe('110101199001011234');
    expect(viaCompat.totalPremium).toBe(128400);
  });
});

describe('3-Way Diff Engine', () => {
  it('detects CRM-only, iPhone-only, and concurrent conflicts accurately', () => {
    const diff = computeThreeWayDiff(
      { name: '林致远', address: '旧址12号', birthday: '1974-05-18', company: '旧公司' },
      { name: '林致远', address: '测试路88号', birthday: '1974-05-19', company: '新公司' },
      { name: '林致远', address: '测试路88号 3号楼', birthday: '1974-05-18', company: 'iPhone改公司' },
      ['name', 'address', 'birthday', 'company'],
    );
    expect(diff.toPushToRemote).toEqual({ birthday: '1974-05-19' });
    expect(diff.toPullToCrm).toEqual({});
    expect(diff.conflicts.map((c) => c.field)).toEqual(['address', 'company']);
    expect(diff.inSync).toBe(false);
  });

  it('pulls remote-only edits cleanly when CRM unchanged', () => {
    const diff = computeThreeWayDiff(
      { address: '旧址', birthday: '1980-08-22' },
      { address: '旧址', birthday: '1980-08-22' },
      { address: '滨江大道168弄5号', birthday: '1980-08-22' },
      ['address', 'birthday'],
    );
    expect(diff.toPullToCrm).toEqual({ address: '滨江大道168弄5号' });
    expect(diff.conflicts).toHaveLength(0);
  });
});
