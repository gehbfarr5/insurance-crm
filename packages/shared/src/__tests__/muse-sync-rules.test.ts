import { describe, expect, it } from 'vitest';
import {
  MUSE_REMINDER_LISTS,
  computeThreeWayDiff,
  formatMuseReminderPayload,
  planCarddavFollowupNote,
  routeReminderCategory,
  sanitizeCustomerForIcloud,
} from '../muse-sync-rules.js';

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

describe('CardDAV Followup Marker & Privacy Fence', () => {
  it('preserves user personal notes and updates idempotently on same id', () => {
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

  it('strips sensitive insurance fields in iCloud privacy fence', () => {
    const sanitized = sanitizeCustomerForIcloud(
      {
        name: '林致远',
        primary_phone: '13800001001',
        phones: [{ value: '13800001001', label: 'mobile', is_primary: true }],
        birthday: '1974-05-18',
        address: '模拟市示范区测试路 88 号',
        company_or_occupation: '模拟精密制造有限公司',
        tags: ['重点经营客户'],
      },
      ['高净值分组'],
    );
    expect(sanitized.groupNames).toEqual(['重点经营客户', '高净值分组']);
    expect(Object.keys(sanitized)).not.toContain('total_premium');
    expect(Object.keys(sanitized)).not.toContain('id_no_masked');
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
