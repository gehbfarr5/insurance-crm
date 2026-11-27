import type { Customer, Interaction } from '@insurance-crm/shared';
import type { Customer360Response } from '../api.js';
import type { BadgeTone } from './ui.js';

export const OUTCOME_LABEL: Record<string, string> = {
  connected: '已接通',
  no_answer: '未接',
  rejected: '拒绝',
  invited: '已邀约',
  attended: '已到场',
  followed_up: '已跟进',
};

export const OUTCOME_TONE: Record<string, BadgeTone> = {
  connected: 'info',
  no_answer: 'neutral',
  rejected: 'error',
  invited: 'success',
  attended: 'success',
  followed_up: 'info',
};

export const CHANNEL_LABEL: Record<string, string> = {
  phone: '电话',
  platform_event: '平台会',
  wechat: '微信',
  in_person_visit: '上门',
  policy_review: '保单检视',
  other: '备注',
};

export const RAPPORT_LABEL: Record<Customer['rapport_tag'], string> = {
  friendly: '友好',
  neutral: '中性',
  cautious: '谨慎',
  paused: '暂缓',
  unassessed: '未评估',
};

export const RAPPORT_TONE: Record<Customer['rapport_tag'], BadgeTone> = {
  friendly: 'success',
  neutral: 'info',
  cautious: 'warning',
  paused: 'error',
  unassessed: 'neutral',
};

export const PRIORITY_LABEL: Record<NonNullable<Customer['visit_priority']>, string> = {
  high: '重点',
  medium: '常规',
  low: '低优',
};

export function fmtMoney(v: number | null | undefined): string {
  if (v == null || v === 0) return '—';
  return `¥${Math.round(v).toLocaleString('zh-CN')}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) {
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function followupUrgency(iso: string | null | undefined): 'overdue' | 'today' | 'upcoming' | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTomorrow = startOfToday + 86_400_000;
  if (ts < startOfToday) return 'overdue';
  if (ts < startOfTomorrow) return 'today';
  return 'upcoming';
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}个月前`;
}

function stripSyncBlocks(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/\[#CRM-BEGIN\][\s\S]*?\[#CRM-END\]/g, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('[#FUP:'))
    .join('\n')
    .trim();
}

/** Full plaintext customer card (no masking) to paste into MUSE. */
export function buildInfoCard(detail: Customer360Response, age?: number | null): string {
  const c = detail.customer;
  const lines: string[] = ['【客户完整信息卡 · CRM】'];
  const bio = [c.gender !== '未知' ? c.gender : '', age != null ? `${age}岁` : '', c.birthday ?? ''].filter(Boolean);
  lines.push(`姓名：${c.name}${bio.length ? `（${bio.join('，')}）` : ''}`);
  const phones = Array.from(new Set([c.primary_phone, ...c.phones.map((p) => p.value)].filter(Boolean)));
  lines.push(`手机：${phones.join(' / ') || '—'}`);
  lines.push(`身份证：${c.id_no ?? '—'}`);
  lines.push(`地址：${c.address ?? '—'}`);
  if (c.company_or_occupation) lines.push(`单位/职业：${c.company_or_occupation}`);
  lines.push(
    `总保费：${c.total_premium ? fmtMoney(c.total_premium) : '无'}${c.policy_total ? `（${c.policy_total}张保单）` : ''}`,
  );
  if (c.kjgx_customer_no) lines.push(`科技个险编号：${c.kjgx_customer_no}`);
  if (detail.policies.length) {
    lines.push('保单明细：');
    for (const p of detail.policies) {
      lines.push(
        `- ${p.product_name ?? '未命名险种'}｜${p.policy_no}｜年缴 ${fmtMoney(p.annual_premium)}｜${p.holder_role}`,
      );
    }
  }
  const summary = stripSyncBlocks(c.manual_summary);
  if (summary) lines.push(`备注：${summary}`);
  const history = detail.interactions.slice(0, 8);
  if (history.length) {
    lines.push('历史沟通：');
    for (const it of history as Interaction[]) {
      lines.push(
        `- ${it.occurred_at.slice(0, 10)} [${CHANNEL_LABEL[it.channel] ?? it.channel}·${OUTCOME_LABEL[it.outcome] ?? it.outcome}] ${it.summary}`,
      );
    }
  }
  lines.push(`CRM_ID：${c.id}`);
  return lines.join('\n');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
