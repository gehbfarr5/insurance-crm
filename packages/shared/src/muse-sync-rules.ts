import type { Customer, Followup, Interaction, Policy } from './schemas.js';

export const CRM_DOSSIER_BEGIN = '[#CRM-BEGIN]';
export const CRM_DOSSIER_END = '[#CRM-END]';

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

const RAPPORT_LABELS: Record<Customer['rapport_tag'], string> = {
  friendly: '顺畅友好',
  neutral: '中性待观察',
  cautious: '谨慎需留心',
  paused: '暂缓投入',
  unassessed: '待初筛',
};

const PRIORITY_LABELS: Record<NonNullable<Customer['visit_priority']>, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const CHANNEL_LABELS: Record<Interaction['channel'], string> = {
  phone: '电话',
  platform_event: '平台会',
  wechat: '微信',
  in_person_visit: '面访',
  policy_review: '保单检视',
  other: '其他',
};

const OUTCOME_LABELS: Record<Interaction['outcome'], string> = {
  connected: '接通',
  no_answer: '未接',
  rejected: '婉拒',
  invited: '已邀约',
  attended: '已到场',
  followed_up: '已跟进',
};

function sanitizeDossierText(raw: string | null | undefined, maxLen = 200): string {
  return String(raw ?? '')
    .replace(/\[#CRM-BEGIN\]/g, '(CRM-BEGIN)')
    .replace(/\[#CRM-END\]/g, '(CRM-END)')
    .replace(/\[#FUP:/g, '(FUP:')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export interface IcloudDossierInput {
  customer: Customer;
  decryptedIdNo?: string | null;
  policies?: Policy[];
  recentInteractions?: Interaction[];
}

export function formatIcloudCrmDossierLines(input: IcloudDossierInput): string[] {
  const { customer: c, decryptedIdNo, policies, recentInteractions } = input;
  const lines: string[] = [];

  const idValue = sanitizeDossierText(decryptedIdNo ?? c.id_no_masked, 64);
  if (idValue) {
    lines.push(`身份证: ${idValue}${c.id_no_checksum_ok === false ? ' (校验异常)' : ''}`);
  }

  const baseParts = [
    c.gender && c.gender !== '未知' ? c.gender : null,
    c.age_override != null ? `${c.age_override}岁` : null,
    c.family_members_count != null ? `家庭${c.family_members_count}人` : null,
    c.source_type ? `来源:${sanitizeDossierText(c.source_type, 40)}` : null,
    c.legacy_group_key ? `编号:${sanitizeDossierText(c.legacy_group_key, 40)}` : null,
  ].filter((x): x is string => Boolean(x));
  if (baseParts.length > 0) {
    lines.push(`基础: ${baseParts.join(' | ')}`);
  }

  const tagParts = [
    c.tags.length > 0 ? c.tags.map((t) => sanitizeDossierText(t, 40)).filter(Boolean).join('、') : null,
    `体感:${RAPPORT_LABELS[c.rapport_tag]}`,
    c.visit_priority ? `优先:${PRIORITY_LABELS[c.visit_priority]}` : null,
  ].filter((x): x is string => Boolean(x));
  if (tagParts.length > 0) {
    lines.push(`标签: ${tagParts.join(' | ')}`);
  }

  const policyCount = Math.max(c.policy_total ?? 0, policies?.length ?? 0);
  const premiumMeta = [c.premium_bucket, c.premium_status]
    .map((v) => sanitizeDossierText(v, 30))
    .filter(Boolean)
    .join('/');
  const assetParts = [
    policyCount > 0 ? `保单${policyCount}张` : null,
    c.total_premium != null ? `总保费¥${Math.round(c.total_premium).toLocaleString('en-US')}` : null,
    premiumMeta || null,
    c.insurer_asset_wan != null ? `我司资产${c.insurer_asset_wan}万` : null,
    c.allocatable_quota_wan != null ? `可配额度${c.allocatable_quota_wan}万` : null,
  ].filter((x): x is string => Boolean(x));
  if (assetParts.length > 0) {
    lines.push(`保费资产: ${assetParts.join(' | ')}`);
  }

  const hasVisitCounts =
    c.kjgx_service_num != null || c.kjgx_visit_num != null || c.kjgx_offline_visit_num != null;
  const kjgxStatus = [c.kjgx_customer_status, c.kjgx_work_status]
    .map((v) => sanitizeDossierText(v, 30))
    .filter(Boolean)
    .join('/');
  const kjgxParts = [
    c.kjgx_customer_no ? `客号${sanitizeDossierText(c.kjgx_customer_no, 40)}` : null,
    c.kjgx_db_customer_id ? `DB:${sanitizeDossierText(c.kjgx_db_customer_id, 40)}` : null,
    c.kjgx_customer_level ? `等级${sanitizeDossierText(c.kjgx_customer_level, 30)}` : null,
    c.kjgx_temp_value != null || c.kjgx_temp_level
      ? `客温${c.kjgx_temp_value ?? '-'}${c.kjgx_temp_level ? `(${sanitizeDossierText(c.kjgx_temp_level, 20)})` : ''}`
      : null,
    kjgxStatus ? `状态${kjgxStatus}` : null,
    c.kjgx_asset_index != null ? `资产指数${c.kjgx_asset_index}` : null,
    c.kjgx_kyc_score != null ? `KYC${c.kjgx_kyc_score}` : null,
    hasVisitCounts
      ? `服务${c.kjgx_service_num ?? 0}/拜访${c.kjgx_visit_num ?? 0}/面访${c.kjgx_offline_visit_num ?? 0}`
      : null,
  ].filter((x): x is string => Boolean(x));
  if (kjgxParts.length > 0) {
    lines.push(`科技个险: ${kjgxParts.join(' | ')}`);
  }

  if (policies && policies.length > 0) {
    lines.push('保单明细:');
    const shown = policies.slice(0, 15);
    for (const p of shown) {
      const pName = sanitizeDossierText(p.product_name, 80);
      const pNo = sanitizeDossierText(p.policy_no, 60);
      const itemParts = [
        pName || pNo,
        p.holder_role,
        p.annual_premium != null ? `¥${Math.round(p.annual_premium).toLocaleString('en-US')}` : null,
        p.policy_status ? sanitizeDossierText(p.policy_status, 30) : null,
        p.payment_term ? sanitizeDossierText(p.payment_term, 30) : null,
        p.coverage_gap_note ? `缺口:${sanitizeDossierText(p.coverage_gap_note, 80)}` : null,
        pName && pNo ? `单号:${pNo}` : null,
      ].filter((x): x is string => Boolean(x));
      if (itemParts.length > 0) {
        lines.push(`- ${itemParts.join(' | ')}`);
      }
    }
    if (policies.length > 15) {
      lines.push(`- ...等共${policies.length}张保单`);
    }
  }

  if (c.manual_summary?.trim()) {
    const cleanSummary = sanitizeDossierText(c.manual_summary, 300);
    if (cleanSummary) {
      lines.push(`人工备注: ${cleanSummary}`);
    }
  }

  if (recentInteractions && recentInteractions.length > 0) {
    const shownInts = recentInteractions.slice(0, 3);
    lines.push('近期沟通:');
    for (const it of shownInts) {
      const dateStr = it.occurred_at.slice(0, 10);
      const ch = CHANNEL_LABELS[it.channel] ?? it.channel;
      const out = OUTCOME_LABELS[it.outcome] ?? it.outcome;
      const summary = sanitizeDossierText(it.summary, 120);
      const attitude = it.attitude_note?.trim() ? ` (态度:${sanitizeDossierText(it.attitude_note, 60)})` : '';
      lines.push(`- ${dateStr} [${ch}/${out}] ${summary}${attitude}`);
    }
  }

  if (c.data_quality_flags?.length) {
    const flags = c.data_quality_flags.map((f) => sanitizeDossierText(f, 60)).filter(Boolean);
    if (flags.length > 0) {
      lines.push(`质量复核: ${flags.join('、')}`);
    }
  }

  return lines;
}

export function planCarddavCrmDossierNote(
  existingNote: string | null | undefined,
  dossierLines: string[],
  followupEntry?: CarddavFollowupEntry | null,
): { note: string; changed: boolean } {
  const normalizedExisting = existingNote ? existingNote.replace(/\r\n/g, '\n') : '';
  const cleanLines = dossierLines
    .map((l) => sanitizeDossierText(l, 400))
    .filter(Boolean);
  const blockLines = cleanLines.length > 0 ? [CRM_DOSSIER_BEGIN, ...cleanLines, CRM_DOSSIER_END] : [];

  const rawLines = normalizedExisting ? normalizedExisting.split('\n') : [];
  const beginIdx = rawLines.findIndex((l) => l.trim() === CRM_DOSSIER_BEGIN);
  const endIdx =
    beginIdx !== -1 ? rawLines.findIndex((l, i) => i > beginIdx && l.trim() === CRM_DOSSIER_END) : -1;

  let nextLines: string[];
  if (beginIdx !== -1 && endIdx !== -1) {
    nextLines = [...rawLines.slice(0, beginIdx), ...blockLines, ...rawLines.slice(endIdx + 1)];
  } else if (blockLines.length > 0) {
    const firstFupIdx = rawLines.findIndex((l) => l.startsWith('[#FUP:'));
    if (firstFupIdx !== -1) {
      nextLines = [...rawLines.slice(0, firstFupIdx), ...blockLines, ...rawLines.slice(firstFupIdx)];
    } else {
      const prefix = [...rawLines];
      while (prefix.length > 0 && prefix[prefix.length - 1] === '') {
        prefix.pop();
      }
      nextLines = [...prefix, ...blockLines];
    }
  } else {
    nextLines = rawLines;
  }

  const afterDossier = nextLines.join('\n');
  const finalNote = followupEntry ? planCarddavFollowupNote(afterDossier, followupEntry).note : afterDossier;
  return {
    note: finalNote,
    changed: finalNote !== normalizedExisting,
  };
}

/**
 * Full iCloud Contact payload (privacy fence removed per user authorization).
 * Core vCard fields + full CRM insurance dossier metadata are included while
 * user handwritten notes in iPhone Contacts NOTE remain preserved outside markers.
 */
export interface SanitizedIcloudContact {
  fullName: string;
  phones: string[];
  birthday: string | null;
  address: string | null;
  company: string | null;
  groupNames: string[];
  idNo?: string | null;
  gender?: Customer['gender'];
  sourceType?: string | null;
  rapportTag?: Customer['rapport_tag'];
  policyTotal?: number;
  totalPremium?: number | null;
  insurerAssetWan?: number | null;
  allocatableQuotaWan?: number | null;
  kjgxCustomerNo?: string | null;
  kjgxCustomerLevel?: string | null;
  kjgxTempValue?: number | null;
  kjgxTempLevel?: string | null;
  manualSummary?: string | null;
  policiesCount?: number;
}

export type IcloudContactPayload = SanitizedIcloudContact;

export function buildIcloudContactPayload(
  customer: Partial<Customer> &
    Pick<
      Customer,
      'name' | 'primary_phone' | 'phones' | 'birthday' | 'address' | 'company_or_occupation' | 'tags'
    >,
  opts?: {
    decryptedIdNo?: string | null;
    extraGroups?: string[];
    policies?: Policy[];
  },
): IcloudContactPayload {
  const phoneSet = new Set<string>();
  if (customer.primary_phone) phoneSet.add(customer.primary_phone);
  for (const p of customer.phones ?? []) {
    if (p.value) phoneSet.add(p.value);
  }
  const groupSet = new Set<string>([...(customer.tags ?? []), ...(opts?.extraGroups ?? [])].filter(Boolean));
  return {
    fullName: customer.name,
    phones: Array.from(phoneSet),
    birthday: customer.birthday ?? null,
    address: customer.address ?? null,
    company: customer.company_or_occupation ?? null,
    groupNames: Array.from(groupSet),
    idNo: opts?.decryptedIdNo ?? customer.id_no_masked ?? null,
    gender: customer.gender,
    sourceType: customer.source_type ?? null,
    rapportTag: customer.rapport_tag,
    policyTotal: customer.policy_total,
    totalPremium: customer.total_premium ?? null,
    insurerAssetWan: customer.insurer_asset_wan ?? null,
    allocatableQuotaWan: customer.allocatable_quota_wan ?? null,
    kjgxCustomerNo: customer.kjgx_customer_no ?? null,
    kjgxCustomerLevel: customer.kjgx_customer_level ?? null,
    kjgxTempValue: customer.kjgx_temp_value ?? null,
    kjgxTempLevel: customer.kjgx_temp_level ?? null,
    manualSummary: customer.manual_summary ?? null,
    policiesCount: opts?.policies?.length ?? customer.policy_total ?? 0,
  };
}

export function sanitizeCustomerForIcloud(
  customer: Partial<Customer> &
    Pick<
      Customer,
      'name' | 'primary_phone' | 'phones' | 'birthday' | 'address' | 'company_or_occupation' | 'tags'
    >,
  extraGroups: string[] = [],
  opts?: {
    decryptedIdNo?: string | null;
    policies?: Policy[];
  },
): SanitizedIcloudContact {
  return buildIcloudContactPayload(customer, {
    extraGroups,
    decryptedIdNo: opts?.decryptedIdNo,
    policies: opts?.policies,
  });
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
