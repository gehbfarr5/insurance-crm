import { normalizePhone } from './dedup.js';
import { MUSE_REMINDER_LISTS } from './muse-sync-rules.js';
import type { Customer } from './schemas.js';

export const V14_CLIENT_GROUP_NAME = '客户';

export const V14_CALENDAR_NAMES = {
  work: '工作',
  birthday: '生日 🎉',
} as const;

export const V14_BUSINESS_EMOJI = {
  platform_event: '👥',
  first_visit: '🤝',
  needs_proposal: '📝',
  signing: '✍️',
  policy_service: '🛡️',
  relationship: '☕',
} as const;

export type V14BusinessType = keyof typeof V14_BUSINESS_EMOJI;

export const V14_ATTENDEE_STATUS_LABELS = {
  confirmed: '✅ 已确认',
  invited: '📨 已邀约',
  cancelled: '❌ 已取消参加',
} as const;

export type V14AttendeeStatus = keyof typeof V14_ATTENDEE_STATUS_LABELS;

const SENSITIVE_TITLE_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: '身份证号明文', pattern: /(?<!\d)(?:\d{17}[\dXx]|\d{15})(?!\d)/ },
  { reason: '银行卡号明文', pattern: /(?<!\d)\d{16,19}(?!\d)/ },
  { reason: '保单具体金额明文', pattern: /(?:[¥￥]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:万元|万|元))/ },
  { reason: '精确门牌号明文', pattern: /(?:\d+\s*[栋幢座号楼]\s*\d*\s*(?:单元\s*)?\d+\s*[室户号])/ },
  {
    reason: '敏感病史明文',
    pattern: /(?:癌症|恶性肿瘤|白血病|抑郁症|精神分裂|艾滋|乙肝大三阳|肾衰竭|尿毒症|心梗|脑梗)/,
  },
];

export function stripNameCategoryPrefix(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/^(?:\[(?:客|社|友|亲|保)[:：]?\]|【(?:客|社|友|亲|保)[:：]?】)\s*/u, '')
    .trim();
}

export function isValidIsoDate(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return false;
  const parsed = Date.parse(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === trimmed;
}

export function assertSafeLockscreenTitle(title: string): void {
  const clean = String(title ?? '').trim();
  if (!clean) {
    throw new Error('标题不能为空');
  }
  for (const rule of SENSITIVE_TITLE_PATTERNS) {
    if (rule.pattern.test(clean)) {
      throw new Error(`标题违反 v1.4 安全铁律（禁止外显${rule.reason}）`);
    }
  }
}

export function validateIdGenderMatch(
  gender: Customer['gender'],
  idNo?: string | null,
): { ok: boolean; idGender?: '男' | '女' } {
  const clean = String(idNo ?? '').trim();
  if (!/^\d{17}[\dXx]$/.test(clean)) {
    return { ok: true };
  }
  const digit17 = Number(clean[16]);
  const idGender: '男' | '女' = digit17 % 2 === 1 ? '男' : '女';
  if (gender === '未知') {
    return { ok: true, idGender };
  }
  return { ok: gender === idGender, idGender };
}

export interface V14ContactBaseInfo {
  name: string;
  gender?: Customer['gender'] | null;
  birthday?: string | null;
  phone?: string | null;
  idNo?: string | null;
  homeAddress?: string | null;
  workAddress?: string | null;
}

export interface V14TimelineEntry {
  date: string; // YYYY-MM-DD
  text: string;
}

function cleanSingleLine(val: string | null | undefined): string | null {
  const s = String(val ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/**
 * Format external contact note strictly per v1.4 §1.4:
 * - Fixed base info order (includes 身份证号 when available; omits empty lines)
 * - NO policy counts, premiums, priority, tags, or CRM internal IDs
 * - Exactly 1 blank line separating base info and [YYYY-MM-DD] timeline lines
 */
export function formatV14ContactNote(
  base: V14ContactBaseInfo,
  timeline: V14TimelineEntry[] = [],
): string {
  const baseLines: string[] = [];
  const name = cleanSingleLine(stripNameCategoryPrefix(base.name));
  if (name) baseLines.push(`姓名：${name}`);
  if (base.gender === '男' || base.gender === '女') {
    baseLines.push(`性别：${base.gender}`);
  }
  if (isValidIsoDate(base.birthday)) {
    baseLines.push(`生日：${base.birthday!.trim()}`);
  }
  const phone = cleanSingleLine(base.phone);
  if (phone) baseLines.push(`电话：${phone}`);
  const idNo = cleanSingleLine(base.idNo);
  if (idNo) baseLines.push(`身份证号：${idNo}`);
  const homeAddr = cleanSingleLine(base.homeAddress);
  if (homeAddr) baseLines.push(`住宅地址：${homeAddr}`);
  const workAddr = cleanSingleLine(base.workAddress);
  if (workAddr) baseLines.push(`工作地址：${workAddr}`);

  const seen = new Set<string>();
  const timeLines: string[] = [];
  for (const item of timeline) {
    if (!isValidIsoDate(item.date)) continue;
    const text = cleanSingleLine(item.text);
    if (!text) continue;
    const line = `${item.date.trim()} ${text}`;
    if (!seen.has(line)) {
      seen.add(line);
      timeLines.push(line);
    }
  }

  if (timeLines.length === 0) {
    return baseLines.join('\n');
  }
  if (baseLines.length === 0) {
    return timeLines.join('\n');
  }
  return `${baseLines.join('\n')}\n\n${timeLines.join('\n')}`;
}

const BASE_FIELD_LABELS = [
  { key: 'name' as const, prefix: '姓名：' },
  { key: 'gender' as const, prefix: '性别：' },
  { key: 'birthday' as const, prefix: '生日：' },
  { key: 'phone' as const, prefix: '电话：' },
  { key: 'idNo' as const, prefix: '身份证号：' },
  { key: 'homeAddress' as const, prefix: '住宅地址：' },
  { key: 'workAddress' as const, prefix: '工作地址：' },
];

/**
 * Idempotently merge base info & new dated facts into an existing v1.4 Contact Note.
 * Preserves existing timeline entries and historical custom lines without duplication.
 */
export function mergeV14ContactNote(
  existingNote: string | null | undefined,
  basePatch: V14ContactBaseInfo,
  newEntries: V14TimelineEntry[] = [],
): { note: string; changed: boolean } {
  const normalizedExisting = (existingNote ?? '').replace(/\r\n/g, '\n').trim();
  const parsedBase: Partial<V14ContactBaseInfo> = {};
  const preservedLines: string[] = [];

  if (normalizedExisting) {
    for (const rawLine of normalizedExisting.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let matchedBase = false;
      for (const spec of BASE_FIELD_LABELS) {
        if (line.startsWith(spec.prefix)) {
          const val = line.slice(spec.prefix.length).trim();
          if (val) {
            if (spec.key === 'gender') {
              if (val === '男' || val === '女') parsedBase.gender = val;
            } else {
              parsedBase[spec.key] = val;
            }
          }
          matchedBase = true;
          break;
        }
      }
      if (!matchedBase) {
        preservedLines.push(line);
      }
    }
  }

  const mergedBase: V14ContactBaseInfo = {
    name: cleanSingleLine(stripNameCategoryPrefix(basePatch.name)) ?? parsedBase.name ?? '',
    gender:
      basePatch.gender === '男' || basePatch.gender === '女'
        ? basePatch.gender
        : (parsedBase.gender ?? null),
    birthday: isValidIsoDate(basePatch.birthday) ? basePatch.birthday!.trim() : (parsedBase.birthday ?? null),
    phone: cleanSingleLine(basePatch.phone) ?? parsedBase.phone ?? null,
    idNo: cleanSingleLine(basePatch.idNo) ?? parsedBase.idNo ?? null,
    homeAddress: cleanSingleLine(basePatch.homeAddress) ?? parsedBase.homeAddress ?? null,
    workAddress: cleanSingleLine(basePatch.workAddress) ?? parsedBase.workAddress ?? null,
  };

  const baseBlock = formatV14ContactNote(mergedBase, []);
  const seen = new Set<string>(preservedLines);
  const tailLines = [...preservedLines];

  for (const item of newEntries) {
    if (!isValidIsoDate(item.date)) continue;
    const text = cleanSingleLine(item.text);
    if (!text) continue;
    const formatted = `${item.date.trim()} ${text}`;
    if (!seen.has(formatted)) {
      seen.add(formatted);
      tailLines.push(formatted);
    }
  }

  const finalNote =
    tailLines.length > 0 && baseBlock
      ? `${baseBlock}\n\n${tailLines.join('\n')}`
      : baseBlock || tailLines.join('\n');

  return {
    note: finalNote,
    changed: finalNote !== normalizedExisting,
  };
}

/**
 * Mandatory v1.4 §1.5 three-field readback check: Name + Phone + Note.
 */
export function verifyV14ContactReadback(
  expected: { name: string; phone?: string | null; note: string },
  actual: { name?: string | null; phones?: string[]; note?: string | null },
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const expName = stripNameCategoryPrefix(expected.name).trim();
  const actName = (actual.name ?? '').trim();
  if (expName !== actName) {
    mismatches.push(`姓名不一致（期望「${expName}」，实读「${actName}」）`);
  }

  const expPhone = normalizePhone(expected.phone ?? '');
  if (expPhone) {
    const actPhones = (actual.phones ?? []).map((p) => normalizePhone(p)).filter(Boolean);
    if (!actPhones.includes(expPhone)) {
      mismatches.push(`电话未命中（期望「${expPhone}」，实读 [${actPhones.join(', ')}]）`);
    }
  }

  const expNote = expected.note.replace(/\r\n/g, '\n').trim();
  const actNote = (actual.note ?? '').replace(/\r\n/g, '\n').trim();
  if (expNote !== actNote) {
    mismatches.push('备注内容与预期不一致');
  }

  return { ok: mismatches.length === 0, mismatches };
}

export function formatV14GroupEventTitle(eventName: string, cancelled = false): string {
  const cleanName = cleanSingleLine(eventName);
  if (!cleanName) throw new Error('活动名称不能为空');
  const title = `${cancelled ? '❌' : '✅'} ${V14_BUSINESS_EMOJI.platform_event} ${cleanName}`;
  assertSafeLockscreenTitle(title);
  return title;
}

export function formatV14OneOnOneTitle(opts: {
  businessType: V14BusinessType;
  summary: string;
  customerName: string;
  colleagueName?: string | null;
  cancelled?: boolean;
}): string {
  const cleanSummary = cleanSingleLine(opts.summary);
  const cleanCustomer = cleanSingleLine(stripNameCategoryPrefix(opts.customerName));
  if (!cleanSummary || !cleanCustomer) {
    throw new Error('事项简述和客户姓名不能为空');
  }
  const statusEmoji = opts.cancelled ? '❌' : '✅';
  const bizEmoji = V14_BUSINESS_EMOJI[opts.businessType];
  const colleague = cleanSingleLine(opts.colleagueName);
  const suffix = colleague ? ` (协同:${colleague})` : '';
  const title = `${statusEmoji} ${bizEmoji} ${cleanSummary} - ${cleanCustomer}${suffix}`;
  assertSafeLockscreenTitle(title);
  return title;
}

export function formatV14BirthdayTitle(customerName: string): string {
  const cleanName = cleanSingleLine(stripNameCategoryPrefix(customerName));
  if (!cleanName) throw new Error('客户姓名不能为空');
  const title = `🎂 ${cleanName}的生日`;
  assertSafeLockscreenTitle(title);
  return title;
}

export interface V14GroupAttendee {
  name: string;
  phone?: string | null;
  status: V14AttendeeStatus;
}

export interface V14GroupColleague {
  role: 'lead' | 'support';
  name: string;
  responsibility?: string | null;
}

export interface V14GroupLogItem {
  date: string; // YYYY-MM-DD
  customerName: string;
  fact: string;
}

export interface V14GroupEventDescriptionInput {
  activityName: string;
  entryRequirement?: string | null;
  attendees?: V14GroupAttendee[];
  colleagues?: V14GroupColleague[];
  logs?: V14GroupLogItem[];
}

export function formatV14GroupEventDescription(input: V14GroupEventDescriptionInput): string {
  const sections: string[] = [];

  const actLines = ['活动信息', `活动性质：${cleanSingleLine(input.activityName) ?? ''}`];
  const req = cleanSingleLine(input.entryRequirement);
  if (req) actLines.push(`入场要求：${req}`);
  sections.push(actLines.join('\n'));

  if (input.attendees && input.attendees.length > 0) {
    const blocks = input.attendees.map((a) => {
      const name = cleanSingleLine(stripNameCategoryPrefix(a.name)) ?? '';
      const lines = [`姓名：${name}`];
      const phone = cleanSingleLine(a.phone);
      if (phone) lines.push(`电话：${phone}`);
      lines.push(`客户状态：${V14_ATTENDEE_STATUS_LABELS[a.status]}`);
      return lines.join('\n');
    });
    sections.push(`客户信息\n${blocks.join('\n\n')}`);
  }

  if (input.colleagues && input.colleagues.length > 0) {
    const colLines = ['协同人员'];
    for (const c of input.colleagues) {
      const name = cleanSingleLine(c.name);
      if (!name) continue;
      if (c.role === 'lead') {
        colLines.push(`带队负责人：${name}`);
      } else {
        const resp = cleanSingleLine(c.responsibility);
        colLines.push(`协同服务：${name}${resp ? ` (${resp})` : ''}`);
      }
    }
    if (colLines.length > 1) {
      sections.push(colLines.join('\n'));
    }
  }

  if (input.logs && input.logs.length > 0) {
    const byDate = new Map<string, string[]>();
    for (const item of input.logs) {
      if (!isValidIsoDate(item.date)) continue;
      const cName = cleanSingleLine(stripNameCategoryPrefix(item.customerName));
      const fact = cleanSingleLine(item.fact);
      if (!cName || !fact) continue;
      const d = item.date.trim();
      const entryLine = `${cName}：${fact}`;
      const list = byDate.get(d) ?? [];
      if (!list.includes(entryLine)) list.push(entryLine);
      byDate.set(d, list);
    }
    if (byDate.size > 0) {
      const logChunks: string[] = ['沟通记录'];
      for (const [date, lines] of Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        logChunks.push(`${date}\n${lines.join('\n')}`);
      }
      sections.push(logChunks.join('\n'));
    }
  }

  return sections.join('\n\n');
}

export interface V14OneOnOneDescriptionInput {
  purpose: string;
  location?: string | null;
  customerName: string;
  customerPhone?: string | null;
  contactLinkedNote?: string | null;
  colleagues?: Array<{ name: string; role?: string | null; task?: string | null }>;
  logs?: Array<{ date: string; fact: string }>;
  nextSteps?: string[];
}

export function formatV14OneOnOneDescription(input: V14OneOnOneDescriptionInput): string {
  const sections: string[] = [];

  const meetLines = ['会面信息', `目的：${cleanSingleLine(input.purpose) ?? ''}`];
  const loc = cleanSingleLine(input.location);
  if (loc) meetLines.push(`地点：${loc}`);
  sections.push(meetLines.join('\n'));

  const custName = cleanSingleLine(stripNameCategoryPrefix(input.customerName)) ?? '';
  const phone = cleanSingleLine(input.customerPhone);
  const linkHint = cleanSingleLine(input.contactLinkedNote);
  const custDetailParts = [phone ? `电话：${phone}` : null, linkHint].filter(Boolean);
  const peopleLines = [
    '人员信息',
    `- 客户：${custName}${custDetailParts.length > 0 ? ` (${custDetailParts.join(' | ')})` : ''}`,
  ];
  for (const col of input.colleagues ?? []) {
    const colName = cleanSingleLine(col.name);
    if (!colName) continue;
    const parts = [cleanSingleLine(col.role), cleanSingleLine(col.task)].filter(Boolean);
    peopleLines.push(`- 协同：${colName}${parts.length > 0 ? ` (${parts.join(' | ')})` : ''}`);
  }
  sections.push(peopleLines.join('\n'));

  if (input.logs && input.logs.length > 0) {
    const byDate = new Map<string, string[]>();
    for (const item of input.logs) {
      if (!isValidIsoDate(item.date)) continue;
      const fact = cleanSingleLine(item.fact);
      if (!fact) continue;
      const d = item.date.trim();
      const list = byDate.get(d) ?? [];
      if (!list.includes(fact)) list.push(fact);
      byDate.set(d, list);
    }
    if (byDate.size > 0) {
      const logLines = ['沟通记录'];
      for (const [date, facts] of Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        logLines.push(`${date}\n${facts.join('\n')}`);
      }
      sections.push(logLines.join('\n'));
    }
  }

  const nextClean = (input.nextSteps ?? []).map((s) => cleanSingleLine(s)).filter((s): s is string => Boolean(s));
  if (nextClean.length > 0) {
    sections.push(`后续跟进\n${nextClean.join('\n')}`);
  }

  return sections.join('\n\n');
}

/**
 * Append a dated fact into an existing Calendar event description without duplicating.
 * - Multi-client (group) events prefix with "[客户姓名]："
 * - 1-on-1 events omit the name prefix
 */
export function appendV14CalendarLog(
  existingDescription: string | null | undefined,
  opts: { date: string; fact: string; customerName?: string | null; isMultiClient: boolean },
): { description: string; changed: boolean } {
  if (!isValidIsoDate(opts.date)) {
    throw new Error(`无效日期格式（需 YYYY-MM-DD）：${opts.date}`);
  }
  const fact = cleanSingleLine(opts.fact);
  if (!fact) {
    throw new Error('沟通记录内容不能为空');
  }
  const entryLine = opts.isMultiClient
    ? `${cleanSingleLine(stripNameCategoryPrefix(opts.customerName ?? '')) || '客户'}：${fact}`
    : fact;
  const dateStr = opts.date.trim();
  const normalized = (existingDescription ?? '').replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return {
      description: `沟通记录\n${dateStr}\n${entryLine}`,
      changed: true,
    };
  }

  const lines = normalized.split('\n');
  // Check if exact date + entry already exists
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === dateStr) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() !== '' && !isValidIsoDate(lines[j]!.trim()) && lines[j]!.trim() !== '后续跟进') {
        if (lines[j]!.trim() === entryLine) {
          return { description: normalized, changed: false };
        }
        j++;
      }
      const next = [...lines.slice(0, j), entryLine, ...lines.slice(j)];
      return { description: next.join('\n'), changed: true };
    }
  }

  // Date heading not present yet: insert under 沟通记录 section if present
  const logHeaderIdx = lines.findIndex((l) => l.trim() === '沟通记录');
  if (logHeaderIdx !== -1) {
    let insertIdx = lines.length;
    for (let i = logHeaderIdx + 1; i < lines.length; i++) {
      if (lines[i]!.trim() === '后续跟进') {
        insertIdx = i;
        break;
      }
    }
    const before = lines.slice(0, insertIdx);
    const after = lines.slice(insertIdx);
    while (before.length > 0 && before[before.length - 1] === '') {
      before.pop();
    }
    const combined =
      after.length > 0
        ? [...before, dateStr, entryLine, '', ...after]
        : [...before, dateStr, entryLine];
    return { description: combined.join('\n'), changed: true };
  }

  return {
    description: `${normalized}\n\n沟通记录\n${dateStr}\n${entryLine}`,
    changed: true,
  };
}

/**
 * Upsert an attendee block inside a shared platform event description (v1.4 §2.3(b)).
 * Real status transitions update the attendee's 客户状态 line while preserving existing logs.
 */
export function upsertV14GroupEventAttendee(
  existingDescription: string | null | undefined,
  attendee: V14GroupAttendee,
): { description: string; changed: boolean } {
  const cleanName = cleanSingleLine(stripNameCategoryPrefix(attendee.name));
  if (!cleanName) throw new Error('客户姓名不能为空');
  const cleanPhone = cleanSingleLine(attendee.phone);
  const statusLine = `客户状态：${V14_ATTENDEE_STATUS_LABELS[attendee.status]}`;
  const newBlockLines = [`姓名：${cleanName}`, ...(cleanPhone ? [`电话：${cleanPhone}`] : []), statusLine];
  const newBlock = newBlockLines.join('\n');

  const normalized = (existingDescription ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return { description: `客户信息\n${newBlock}`, changed: true };
  }

  const lines = normalized.split('\n');
  const targetNameLine = `姓名：${cleanName}`;
  const matchIdx = lines.findIndex((l) => l.trim() === targetNameLine);

  if (matchIdx !== -1) {
    let endIdx = matchIdx + 1;
    while (
      endIdx < lines.length &&
      lines[endIdx]!.trim() !== '' &&
      !lines[endIdx]!.trim().startsWith('姓名：') &&
      !['协同人员', '沟通记录', '后续跟进', '活动信息'].includes(lines[endIdx]!.trim())
    ) {
      endIdx++;
    }
    const oldBlock = lines.slice(matchIdx, endIdx).join('\n');
    // Preserve existing phone if patch omitted phone
    let finalBlockLines = [...newBlockLines];
    if (!cleanPhone) {
      const existingPhoneLine = lines.slice(matchIdx, endIdx).find((l) => l.trim().startsWith('电话：'));
      if (existingPhoneLine) {
        finalBlockLines = [`姓名：${cleanName}`, existingPhoneLine.trim(), statusLine];
      }
    }
    const finalBlock = finalBlockLines.join('\n');
    if (oldBlock === finalBlock) {
      return { description: normalized, changed: false };
    }
    const next = [...lines.slice(0, matchIdx), ...finalBlockLines, ...lines.slice(endIdx)];
    return { description: next.join('\n'), changed: true };
  }

  const customerHeaderIdx = lines.findIndex((l) => l.trim() === '客户信息');
  if (customerHeaderIdx !== -1) {
    let insertIdx = lines.length;
    for (let i = customerHeaderIdx + 1; i < lines.length; i++) {
      if (['协同人员', '沟通记录', '后续跟进'].includes(lines[i]!.trim())) {
        insertIdx = i;
        break;
      }
    }
    const before = lines.slice(0, insertIdx);
    const after = lines.slice(insertIdx);
    while (before.length > 0 && before[before.length - 1] === '') {
      before.pop();
    }
    const separator = before.length > customerHeaderIdx + 1 ? [''] : [];
    const combined =
      after.length > 0
        ? [...before, ...separator, ...newBlockLines, '', ...after]
        : [...before, ...separator, ...newBlockLines];
    return { description: combined.join('\n'), changed: true };
  }

  return {
    description: `${normalized}\n\n客户信息\n${newBlock}`,
    changed: true,
  };
}

export interface V14CompanionReminder {
  kind: 'pre_visit' | 'post_visit';
  title: string;
  due_at: string;
  listName: string;
  priority: 'high' | 'medium';
}

/**
 * Generate the 2 standard v1.4 §4.4 companion reminders for an important client visit:
 * 1) 2h before event: "[客户姓名] 检查建议书与确认会面动向"
 * 2) Same day 18:00 (+08:00): "[客户姓名] 回写跟进台账并归档资料"
 */
export function buildV14CompanionReminders(
  customerName: string,
  eventStartIso: string,
): V14CompanionReminder[] {
  const cleanName = cleanSingleLine(stripNameCategoryPrefix(customerName));
  if (!cleanName) throw new Error('客户姓名不能为空');
  const startMs = Date.parse(eventStartIso);
  if (Number.isNaN(startMs)) {
    throw new Error(`无效事件开始时间：${eventStartIso}`);
  }

  const preMs = startMs - 2 * 60 * 60 * 1000;
  // Convert to +08:00 wall-clock string
  const fmtOffset8 = (ms: number): string => {
    const sh = new Date(ms + 8 * 3600_000);
    const yyyy = sh.getUTCFullYear();
    const mm = String(sh.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(sh.getUTCDate()).padStart(2, '0');
    const hh = String(sh.getUTCHours()).padStart(2, '0');
    const mi = String(sh.getUTCMinutes()).padStart(2, '0');
    const ss = String(sh.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
  };

  const startShDate = fmtOffset8(startMs).slice(0, 10);
  const preTitle = `${cleanName} 检查建议书与确认会面动向`;
  const postTitle = `${cleanName} 回写跟进台账并归档资料`;
  assertSafeLockscreenTitle(preTitle);
  assertSafeLockscreenTitle(postTitle);

  return [
    {
      kind: 'pre_visit',
      title: preTitle,
      due_at: fmtOffset8(preMs),
      listName: MUSE_REMINDER_LISTS.work,
      priority: 'high',
    },
    {
      kind: 'post_visit',
      title: postTitle,
      due_at: `${startShDate}T18:00:00+08:00`,
      listName: MUSE_REMINDER_LISTS.work,
      priority: 'medium',
    },
  ];
}

export type WriteGuardChannel = 'contacts' | 'calendar' | 'tasks';

export interface WriteGuardRecord {
  status: 'READY' | 'HALTED_UNKNOWN';
  haltedAt: string | null;
  operation: string | null;
  reason: string | null;
}

export class WriteGuardHaltedError extends Error {
  readonly code = 'WRITE_GUARD_UNKNOWN_HALTED';
  constructor(
    public readonly channel: WriteGuardChannel,
    public readonly record: WriteGuardRecord,
  ) {
    super(
      `通道 ${channel} 处于 UNKNOWN 停写状态（${record.operation ?? 'unknown_op'}：${record.reason ?? '超时/网络中断'}），须完成两次读回对账后方可解除停写`,
    );
    this.name = 'WriteGuardHaltedError';
  }
}

/**
 * Enforces v1.4 §5.2 UNKNOWN stop-write iron law:
 * On timeout or uncertain network failure during a write, halt subsequent writes
 * until two independent readbacks prove VERIFIED_NOT_APPLIED (or ALREADY_APPLIED).
 */
export class V14WriteGuard {
  private readonly states: Record<WriteGuardChannel, WriteGuardRecord> = {
    contacts: { status: 'READY', haltedAt: null, operation: null, reason: null },
    calendar: { status: 'READY', haltedAt: null, operation: null, reason: null },
    tasks: { status: 'READY', haltedAt: null, operation: null, reason: null },
  };

  getSnapshot(): Record<WriteGuardChannel, WriteGuardRecord> {
    return {
      contacts: { ...this.states.contacts },
      calendar: { ...this.states.calendar },
      tasks: { ...this.states.tasks },
    };
  }

  assertReady(channel: WriteGuardChannel): void {
    const rec = this.states[channel];
    if (rec.status === 'HALTED_UNKNOWN') {
      throw new WriteGuardHaltedError(channel, { ...rec });
    }
  }

  markUnknown(channel: WriteGuardChannel, operation: string, reason: string): WriteGuardRecord {
    const rec: WriteGuardRecord = {
      status: 'HALTED_UNKNOWN',
      haltedAt: new Date().toISOString(),
      operation,
      reason,
    };
    this.states[channel] = rec;
    return { ...rec };
  }

  reconcileTwoReadbacks(
    channel: WriteGuardChannel,
    firstReadApplied: boolean,
    secondReadApplied: boolean,
  ): { verdict: 'VERIFIED_NOT_APPLIED' | 'ALREADY_APPLIED' | 'INCONSISTENT_STAY_HALTED'; state: WriteGuardRecord } {
    if (!firstReadApplied && !secondReadApplied) {
      this.states[channel] = { status: 'READY', haltedAt: null, operation: null, reason: null };
      return { verdict: 'VERIFIED_NOT_APPLIED', state: { ...this.states[channel] } };
    }
    if (firstReadApplied && secondReadApplied) {
      this.states[channel] = { status: 'READY', haltedAt: null, operation: null, reason: null };
      return { verdict: 'ALREADY_APPLIED', state: { ...this.states[channel] } };
    }
    return { verdict: 'INCONSISTENT_STAY_HALTED', state: { ...this.states[channel] } };
  }
}
