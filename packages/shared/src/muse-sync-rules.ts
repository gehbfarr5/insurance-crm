import type { Customer, Followup } from './schemas.js';

/**
 * Reused MUSE Agent Reminders Routing v1.0 standard lists.
 */
export const MUSE_REMINDER_LISTS = {
  inbox: '收集箱 Inbox',
  work: '工作待办 Work',
  personal: '个人生活 Personal',
  shopping: '日常采购 Shopping',
} as const;

export type MuseReminderCategory = keyof typeof MUSE_REMINDER_LISTS;

const EXPLICIT_LIST_PATTERNS: Array<[MuseReminderCategory, RegExp]> = [
  ['work', /(?:放到|加到|记在|写入|转到).{0,6}(?:工作待办|工作列表|Work)/i],
  ['personal', /(?:放到|加到|记在|写入|转到).{0,6}(?:个人生活|个人列表|Personal)/i],
  ['shopping', /(?:放到|加到|记在|写入|转到).{0,6}(?:日常采购|采购清单|购物清单|Shopping)/i],
  ['inbox', /(?:放到|加到|记在|写入|转到).{0,6}(?:收集箱|Inbox)/i],
];

const WORK_KEYWORDS =
  /(?:客户|保单|拜访|方案|合同|签约|回访|投保|理赔|理财|开会|周报|复盘|项目|平台会|保单检视|孤儿单|家庭卡)/;
const SHOPPING_KEYWORDS =
  /(?:买|采购|补货|囤).{0,10}(?:牛奶|菜|纸巾|电池|耗材|咖啡|水果|日用|用品|文具|鸡蛋)/;
const PERSONAL_KEYWORDS =
  /(?:家庭|父母|孩子|就医|体检|吃药|配药|运动|健身|水电|燃气|物业|话费|还款|机票|酒店|私聚)/;

/**
 * Determine MUSE Reminders list category per MUSE_REMINDERS_ROUTING_SPECIFICATION v1.0:
 * 1) Explicit list override
 * 2) Entity/keyword classification (Work / Shopping / Personal)
 * 3) Context awareness (CRM context defaults to Work)
 * 4) Generic fallback to Inbox
 */
export function routeReminderCategory(
  text: string,
  explicitList?: MuseReminderCategory | null,
  isCrmContext = true,
): MuseReminderCategory {
  if (explicitList && explicitList in MUSE_REMINDER_LISTS) {
    return explicitList;
  }
  const normalized = String(text ?? '').trim();
  for (const [category, pattern] of EXPLICIT_LIST_PATTERNS) {
    if (pattern.test(normalized)) {
      return category;
    }
  }
  if (WORK_KEYWORDS.test(normalized)) return 'work';
  if (SHOPPING_KEYWORDS.test(normalized)) return 'shopping';
  if (PERSONAL_KEYWORDS.test(normalized)) return 'personal';
  if (isCrmContext) return 'work';
  return 'inbox';
}

export interface MuseReminderPayload {
  listName: string;
  category: MuseReminderCategory;
  title: string;
  dueDate: string | null;
  priority: 'High' | 'None';
  notes: string;
}

/**
 * Format a CRM followup into a MUSE Reminders v1.0 compliant payload.
 */
export function formatMuseReminderPayload(
  followup: Pick<Followup, 'id' | 'title' | 'due_at' | 'priority' | 'notes'>,
  customerName: string,
  legacyKey?: string | null,
): MuseReminderPayload {
  const category = routeReminderCategory(followup.title, undefined, true);
  const listName = MUSE_REMINDER_LISTS[category];
  const cleanTitle = followup.title.includes(customerName)
    ? followup.title.trim()
    : `${followup.title.trim()}（${customerName}）`;
  const priority = followup.priority === 'high' ? 'High' : 'None';
  const noteParts = [
    `来源: CRM 双向同步 (${listName})`,
    `客户: ${customerName}${legacyKey ? ` (${legacyKey})` : ''}`,
    `FollowupID: ${followup.id}`,
  ];
  if (category === 'inbox') {
    noteParts.push('[待分类]');
  }
  if (followup.notes?.trim()) {
    noteParts.push(`摘要: ${followup.notes.trim()}`);
  }
  return {
    listName,
    category,
    title: cleanTitle,
    dueDate: followup.due_at ?? null,
    priority,
    notes: noteParts.join('\n'),
  };
}

/**
 * Reused idempotent [#FUP:<id>] marker protocol from carddav-followup.mjs.
 * Preserves existing personal notes outside the marked line.
 */
export interface CarddavFollowupEntry {
  id: string;
  date: string; // YYYY-MM-DD
  kind: string;
  status: string;
}

function sanitizeMarkerField(value: string, label: string): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed.length > 240 || /[\r\n|]/.test(trimmed)) {
    throw new Error(`Invalid ${label}: must be single-line, <= 240 chars, without '|'`);
  }
  return trimmed;
}

export function planCarddavFollowupNote(
  existingNote: string | null | undefined,
  entry: CarddavFollowupEntry,
): { note: string; changed: boolean } {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(entry.id)) {
    throw new Error('Invalid entry id: must be 3-64 ASCII-safe characters');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || Number.isNaN(Date.parse(`${entry.date}T00:00:00Z`))) {
    throw new Error('Invalid entry date: must be YYYY-MM-DD');
  }
  const kind = sanitizeMarkerField(entry.kind, 'kind');
  const status = sanitizeMarkerField(entry.status, 'status');
  const line = `[#FUP:${entry.id}] ${entry.date} | ${kind} | ${status}`;
  const prefix = `[#FUP:${entry.id}] `;

  const rawLines = existingNote ? existingNote.replace(/\r\n/g, '\n').split('\n') : [];
  const matchIdx = rawLines.findIndex((l) => l.startsWith(prefix));
  if (matchIdx !== -1) {
    if (rawLines[matchIdx] === line) {
      return { note: rawLines.join('\n'), changed: false };
    }
    const next = [...rawLines];
    next[matchIdx] = line;
    return { note: next.join('\n'), changed: true };
  }

  const trimmedExisting = existingNote ? existingNote.replace(/\r\n/g, '\n').trimEnd() : '';
  const combined = trimmedExisting ? `${trimmedExisting}\n${line}` : line;
  return { note: combined, changed: true };
}

/**
 * Sanitized iCloud Contact payload enforcing the strict Privacy Fence.
 * Sensitive insurance fields (id_no, policies, total_premium, rapport_tag, health notes)
 * are NEVER included.
 */
export interface SanitizedIcloudContact {
  fullName: string;
  phones: string[];
  birthday: string | null;
  address: string | null;
  company: string | null;
  groupNames: string[];
}

export function sanitizeCustomerForIcloud(
  customer: Pick<
    Customer,
    'name' | 'primary_phone' | 'phones' | 'birthday' | 'address' | 'company_or_occupation' | 'tags'
  >,
  extraGroups: string[] = [],
): SanitizedIcloudContact {
  const phoneSet = new Set<string>();
  if (customer.primary_phone) phoneSet.add(customer.primary_phone);
  for (const p of customer.phones ?? []) {
    if (p.value) phoneSet.add(p.value);
  }
  const groupSet = new Set<string>([...(customer.tags ?? []), ...extraGroups].filter(Boolean));
  return {
    fullName: customer.name,
    phones: Array.from(phoneSet),
    birthday: customer.birthday ?? null,
    address: customer.address ?? null,
    company: customer.company_or_occupation ?? null,
    groupNames: Array.from(groupSet),
  };
}

export interface ThreeWayDiffResult {
  toPushToRemote: Record<string, unknown>;
  toPullToCrm: Record<string, unknown>;
  conflicts: Array<{
    field: string;
    baseValue: unknown;
    crmValue: unknown;
    remoteValue: unknown;
  }>;
  inSync: boolean;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 3-Way Diff (BASE vs CRM vs REMOTE) preventing silent overwrites on concurrent edits.
 */
export function computeThreeWayDiff(
  base: Record<string, unknown>,
  crm: Record<string, unknown>,
  remote: Record<string, unknown>,
  fields: string[],
): ThreeWayDiffResult {
  const toPushToRemote: Record<string, unknown> = {};
  const toPullToCrm: Record<string, unknown> = {};
  const conflicts: ThreeWayDiffResult['conflicts'] = [];

  for (const field of fields) {
    const b = base[field] ?? null;
    const c = crm[field] ?? null;
    const r = remote[field] ?? null;

    if (stableEqual(c, r)) {
      continue;
    }
    const crmChanged = !stableEqual(c, b);
    const remoteChanged = !stableEqual(r, b);

    if (crmChanged && !remoteChanged) {
      toPushToRemote[field] = c;
    } else if (!crmChanged && remoteChanged) {
      toPullToCrm[field] = r;
    } else if (crmChanged && remoteChanged) {
      conflicts.push({ field, baseValue: b, crmValue: c, remoteValue: r });
    }
  }

  return {
    toPushToRemote,
    toPullToCrm,
    conflicts,
    inSync:
      Object.keys(toPushToRemote).length === 0 &&
      Object.keys(toPullToCrm).length === 0 &&
      conflicts.length === 0,
  };
}
