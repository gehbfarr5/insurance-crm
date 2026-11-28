import { describe, expect, it } from 'vitest';
import {
  V14_CLIENT_GROUP_NAME,
  V14WriteGuard,
  WriteGuardHaltedError,
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
  stripNameCategoryPrefix,
  upsertV14GroupEventAttendee,
  validateIdGenderMatch,
  verifyV14ContactReadback,
} from '../v14-sync-rules.js';

describe('v1.4 Unified Four-Suite & Google Dual-Track Sync Rules', () => {
  it('strips forbidden category prefixes and enforces lockscreen title sensitivity guard', () => {
    expect(stripNameCategoryPrefix('[客:]张明')).toBe('张明');
    expect(stripNameCategoryPrefix('【社】李华')).toBe('李华');
    expect(stripNameCategoryPrefix('周明芳')).toBe('周明芳');

    expect(() => assertSafeLockscreenTitle('✅ 🤝 初访沟通 - 周明芳')).not.toThrow();
    expect(() => assertSafeLockscreenTitle('周明芳 520102199001011234 核保')).toThrow(/身份证号明文/);
    expect(() => assertSafeLockscreenTitle('拜访周明芳 ¥128000 方案')).toThrow(/保单具体金额明文/);
    expect(() => assertSafeLockscreenTitle('送资料 3栋2单元501室')).toThrow(/精确门牌号明文/);
    expect(() => assertSafeLockscreenTitle('核保沟通 甲状腺恶性肿瘤')).toThrow(/敏感病史明文/);
  });

  it('formats and merges v1.4 contact notes with id_no included and zero policy/CRM clutter', () => {
    expect(V14_CLIENT_GROUP_NAME).toBe('客户');

    const note = formatV14ContactNote(
      {
        name: '[客:]林致远',
        gender: '男',
        birthday: '1984-06-18',
        phone: '13800138000',
        idNo: '520102198406181234',
        homeAddress: '贵阳市观山湖区示例路',
      },
      [
        { date: '2026-11-28', text: '邀约参加周六平台会，已确认出席' },
        { date: '2026-11-28', text: '邀约参加周六平台会，已确认出席' },
      ],
    );

    expect(note).toBe(
      [
        '姓名：林致远',
        '性别：男',
        '生日：1984-06-18',
        '电话：13800138000',
        '身份证号：520102198406181234',
        '住宅地址：贵阳市观山湖区示例路',
        '',
        '2026-11-28 邀约参加周六平台会，已确认出席',
      ].join('\n'),
    );
    expect(note).not.toContain('保单');
    expect(note).not.toContain('总保费');
    expect(note).not.toContain('出生年月日');

    const merged = mergeV14ContactNote(
      note,
      { name: '林致远', workAddress: '贵阳市南明区金融城' },
      [{ date: '2026-11-29', text: '平台会到场交流15分钟，关注养老规划' }],
    );
    expect(merged.changed).toBe(true);
    expect(merged.note).toContain('身份证号：520102198406181234');
    expect(merged.note).toContain('工作地址：贵阳市南明区金融城');
    expect(merged.note).toContain('2026-11-28 邀约参加周六平台会，已确认出席');
    expect(merged.note).toContain('2026-11-29 平台会到场交流15分钟，关注养老规划');

    const idempotent = mergeV14ContactNote(
      merged.note,
      { name: '林致远' },
      [{ date: '2026-11-29', text: '平台会到场交流15分钟，关注养老规划' }],
    );
    expect(idempotent.changed).toBe(false);
  });

  it('verifies 3-field contact readback and ID-gender cross-check without deriving birthday', () => {
    expect(validateIdGenderMatch('男', '520102198406181234')).toEqual({ ok: true, idGender: '男' });
    expect(validateIdGenderMatch('女', '520102198406181234')).toEqual({ ok: false, idGender: '男' });

    const pass = verifyV14ContactReadback(
      { name: '林致远', phone: '138-0013-8000', note: '姓名：林致远' },
      { name: '林致远', phones: ['+86 13800138000'], note: '姓名：林致远' },
    );
    expect(pass.ok).toBe(true);

    const fail = verifyV14ContactReadback(
      { name: '林致远', phone: '13800138000', note: '姓名：林致远' },
      { name: '林致远', phones: ['13900001111'], note: '姓名：林致远' },
    );
    expect(fail.ok).toBe(false);
    expect(fail.mismatches[0]).toContain('电话未命中');
  });

  it('formats v1.4 group & 1-on-1 calendar events and updates attendees/logs idempotently', () => {
    expect(formatV14GroupEventTitle('养老财富说明会')).toBe('✅ 👥 养老财富说明会');
    expect(formatV14GroupEventTitle('养老财富说明会', true)).toBe('❌ 👥 养老财富说明会');
    expect(
      formatV14OneOnOneTitle({
        businessType: 'needs_proposal',
        summary: '养老方案沟通',
        customerName: '周明芳',
        colleagueName: '王主管',
      }),
    ).toBe('✅ 📝 养老方案沟通 - 周明芳 (协同:王主管)');
    expect(formatV14BirthdayTitle('周明芳')).toBe('🎂 周明芳的生日');

    const desc = formatV14GroupEventDescription({
      activityName: '周末养老平台会',
      entryRequirement: '需提前一天报备姓名电话',
      attendees: [{ name: '周明芳', phone: '13800001111', status: 'invited' }],
      colleagues: [{ role: 'lead', name: '王主管' }],
      logs: [{ date: '2026-11-28', customerName: '周明芳', fact: '电话初邀，表示周末有空' }],
    });
    expect(desc).toContain('客户状态：📨 已邀约');
    expect(desc).toContain('周明芳：电话初邀，表示周末有空');

    const updatedAttendee = upsertV14GroupEventAttendee(desc, {
      name: '周明芳',
      status: 'confirmed',
    });
    expect(updatedAttendee.changed).toBe(true);
    expect(updatedAttendee.description).toContain('电话：13800001111');
    expect(updatedAttendee.description).toContain('客户状态：✅ 已确认');

    const addedLog = appendV14CalendarLog(updatedAttendee.description, {
      date: '2026-11-28',
      customerName: '周明芳',
      fact: '补充表示会带配偶同来',
      isMultiClient: true,
    });
    expect(addedLog.changed).toBe(true);
    expect(addedLog.description).toContain('周明芳：补充表示会带配偶同来');

    const dupLog = appendV14CalendarLog(addedLog.description, {
      date: '2026-11-28',
      customerName: '周明芳',
      fact: '补充表示会带配偶同来',
      isMultiClient: true,
    });
    expect(dupLog.changed).toBe(false);

    const oneOnOne = formatV14OneOnOneDescription({
      purpose: '保单检视与保障梳理',
      location: '示例咖啡馆',
      customerName: '林致远',
      customerPhone: '13800138000',
      contactLinkedNote: 'Google 通讯录已关联',
      logs: [{ date: '2026-11-28', fact: '沟通顺畅，希望看重疾加保方案' }],
      nextSteps: ['本周五前准备对比方案'],
    });
    expect(oneOnOne).not.toContain('林致远：沟通顺畅');
    expect(oneOnOne).toContain('沟通顺畅，希望看重疾加保方案');
  });

  it('generates v1.4 companion reminders (2h before & same day 18:00 +08:00)', () => {
    const reminders = buildV14CompanionReminders('周明芳', '2026-12-05T14:30:00+08:00');
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toMatchObject({
      kind: 'pre_visit',
      title: '周明芳 检查建议书与确认会面动向',
      due_at: '2026-12-05T12:30:00+08:00',
      listName: '工作待办 Work',
    });
    expect(reminders[1]).toMatchObject({
      kind: 'post_visit',
      title: '周明芳 回写跟进台账并归档资料',
      due_at: '2026-12-05T18:00:00+08:00',
      listName: '工作待办 Work',
    });
  });

  it('enforces UNKNOWN stop-write iron law and two-readback reconciliation', () => {
    const guard = new V14WriteGuard();
    expect(() => guard.assertReady('calendar')).not.toThrow();

    guard.markUnknown('calendar', 'upsert_event', 'ETIMEDOUT');
    expect(() => guard.assertReady('calendar')).toThrow(WriteGuardHaltedError);
    // Other channels stay independent
    expect(() => guard.assertReady('contacts')).not.toThrow();

    // Inconsistent readbacks stay halted
    const inconsistent = guard.reconcileTwoReadbacks('calendar', true, false);
    expect(inconsistent.verdict).toBe('INCONSISTENT_STAY_HALTED');
    expect(() => guard.assertReady('calendar')).toThrow(WriteGuardHaltedError);

    // Two consistent negative readbacks unlock as VERIFIED_NOT_APPLIED
    const verified = guard.reconcileTwoReadbacks('calendar', false, false);
    expect(verified.verdict).toBe('VERIFIED_NOT_APPLIED');
    expect(() => guard.assertReady('calendar')).not.toThrow();
  });
});
