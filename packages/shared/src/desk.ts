import type { Customer, Interaction } from './schemas.js';

export const CALL_FILTERS = ['all', 'never_called', 'exclude_7d', 'exclude_rejected', 'invited'] as const;
export type CallFilter = (typeof CALL_FILTERS)[number];

export const DESK_SORT_FIELDS = ['premium', 'age', 'call_count', 'last_call_at'] as const;
export type DeskSortField = (typeof DESK_SORT_FIELDS)[number];

/** Aggregated phone-call stats used to avoid dialing the same customer repeatedly. */
export interface CallStats {
  call_count: number;
  last_call_at: string | null;
  last_call_outcome: Interaction['outcome'] | null;
  last_call_summary: string | null;
  ever_rejected: boolean;
  ever_invited: boolean;
}

export const EMPTY_CALL_STATS: CallStats = {
  call_count: 0,
  last_call_at: null,
  last_call_outcome: null,
  last_call_summary: null,
  ever_rejected: false,
  ever_invited: false,
};

/** Customer row for the outbound-call desk (plaintext phone/ID, age and call stats included). */
export type DeskCustomer = Customer & CallStats & { age: number | null; id_no: string | null };

export interface DeskResponse {
  items: DeskCustomer[];
  total: number;
  limit: number;
  offset: number;
}

export function ageFromBirthday(
  birthday: string | null | undefined,
  ageOverride?: number | null,
  now: Date = new Date(),
): number | null {
  if (ageOverride != null) return ageOverride;
  if (!birthday) return null;
  const m = birthday.trim().match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!(year >= 1900 && year <= now.getFullYear()) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  let age = now.getFullYear() - year;
  const nowMonth = now.getMonth() + 1;
  if (nowMonth < month || (nowMonth === month && now.getDate() < day)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

export function aggregateCallStats(
  rows: Array<{ customer_id: string; occurred_at: string; outcome: Interaction['outcome']; summary: string }>,
): Map<string, CallStats> {
  const sorted = [...rows].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  const out = new Map<string, CallStats>();
  for (const row of sorted) {
    const cur = out.get(row.customer_id);
    if (!cur) {
      out.set(row.customer_id, {
        call_count: 1,
        last_call_at: row.occurred_at,
        last_call_outcome: row.outcome,
        last_call_summary: row.summary,
        ever_rejected: row.outcome === 'rejected',
        ever_invited: row.outcome === 'invited',
      });
      continue;
    }
    cur.call_count += 1;
    if (row.outcome === 'rejected') cur.ever_rejected = true;
    if (row.outcome === 'invited') cur.ever_invited = true;
  }
  return out;
}
