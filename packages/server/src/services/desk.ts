import {
  type CallFilter,
  CALL_FILTERS,
  DESK_SORT_FIELDS,
  type Customer,
  type DeskCustomer,
  type DeskResponse,
  type DeskSortField,
  EMPTY_CALL_STATS,
  ageFromBirthday,
} from '@insurance-crm/shared';
import type { CrmStore } from './store.js';

export interface DeskQuery {
  query?: string;
  gender?: string;
  min_age?: number;
  max_age?: number;
  min_premium?: number;
  max_premium?: number;
  address_query?: string;
  call_filter?: string;
  sort_by?: string;
  sort_dir?: string;
  limit?: number;
  offset?: number;
}

async function loadAllActiveCustomers(store: CrmStore): Promise<Customer[]> {
  const all: Customer[] = [];
  for (let offset = 0; ; offset += 500) {
    const res = await store.searchCustomers({ limit: 500, offset });
    all.push(...res.customers);
    if (!res.truncated || res.customers.length === 0) break;
  }
  return all;
}

const DAY_MS = 86_400_000;

/**
 * Outbound-call desk query: multi-dimension filtering (gender / age / premium / address /
 * call history) with call-count aggregation and plaintext ID for the authenticated advisor.
 */
export async function queryDesk(store: CrmStore, q: DeskQuery): Promise<DeskResponse> {
  const limit = Math.min(Math.max(Number.isFinite(q.limit) ? Math.trunc(q.limit!) : 50, 1), 200);
  const offset = Math.max(Number.isFinite(q.offset) ? Math.trunc(q.offset!) : 0, 0);
  const callFilter: CallFilter = (CALL_FILTERS as readonly string[]).includes(q.call_filter ?? '')
    ? (q.call_filter as CallFilter)
    : 'all';
  const sortBy: DeskSortField = (DESK_SORT_FIELDS as readonly string[]).includes(q.sort_by ?? '')
    ? (q.sort_by as DeskSortField)
    : 'premium';
  const dir = q.sort_dir === 'asc' ? 1 : -1;
  const now = Date.now();

  const [all, stats] = await Promise.all([loadAllActiveCustomers(store), store.getPhoneCallStats()]);

  const text = q.query?.trim().toLowerCase();
  const textDigits = q.query?.replace(/\D/g, '') ?? '';
  const addr = q.address_query?.trim().toLowerCase();

  const rows = all
    .map((c) => ({
      customer: c,
      stats: stats.get(c.id) ?? EMPTY_CALL_STATS,
      age: ageFromBirthday(c.birthday, c.age_override),
    }))
    .filter(({ customer: c, stats: s, age }) => {
      if (text) {
        const hay = [c.name, c.primary_phone, c.address, c.manual_summary].filter(Boolean).join(' ').toLowerCase();
        const phoneHit = textDigits.length >= 4 && (c.primary_phone ?? '').includes(textDigits);
        if (!hay.includes(text) && !phoneHit) return false;
      }
      if (q.gender === '男' || q.gender === '女') {
        if (c.gender !== q.gender) return false;
      }
      if (q.min_age != null || q.max_age != null) {
        if (age == null) return false;
        if (q.min_age != null && age < q.min_age) return false;
        if (q.max_age != null && age > q.max_age) return false;
      }
      const premium = c.total_premium ?? 0;
      if (q.min_premium != null && premium < q.min_premium) return false;
      if (q.max_premium != null && premium > q.max_premium) return false;
      if (addr && !(c.address ?? '').toLowerCase().includes(addr)) return false;
      switch (callFilter) {
        case 'never_called':
          return s.call_count === 0;
        case 'exclude_7d':
          return !s.last_call_at || now - Date.parse(s.last_call_at) > 7 * DAY_MS;
        case 'exclude_rejected':
          return !s.ever_rejected;
        case 'invited':
          return s.ever_invited;
        default:
          return true;
      }
    });

  const sortValue = (r: (typeof rows)[number]): number | null => {
    switch (sortBy) {
      case 'age':
        return r.age;
      case 'call_count':
        return r.stats.call_count;
      case 'last_call_at':
        return r.stats.last_call_at ? Date.parse(r.stats.last_call_at) : null;
      default:
        return r.customer.total_premium;
    }
  };

  rows.sort((a, b) => {
    const va = sortValue(a);
    const vb = sortValue(b);
    if (va == null && vb == null) {
      // fall through to tie-breakers
    } else if (va == null) {
      return 1;
    } else if (vb == null) {
      return -1;
    } else if (va !== vb) {
      return (va - vb) * dir;
    }
    const pa = a.customer.total_premium ?? -1;
    const pb = b.customer.total_premium ?? -1;
    if (pa !== pb) return pb - pa;
    return a.customer.name.localeCompare(b.customer.name, 'zh-CN');
  });

  const page = rows.slice(offset, offset + limit);
  const idMap = await store.getDecryptedIdMap(page.map((r) => r.customer.id));
  const items: DeskCustomer[] = page.map((r) => ({
    ...r.customer,
    ...r.stats,
    age: r.age,
    id_no: idMap.get(r.customer.id) ?? null,
  }));

  return { items, total: rows.length, limit, offset };
}
