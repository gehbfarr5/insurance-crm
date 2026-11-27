import type { CallFilter, DeskSortField, FollowupView } from '@insurance-crm/shared';
import type { DeskQueryParams } from '../api.js';

export interface DeskFilters {
  view: FollowupView;
  query: string;
  gender: '' | '男' | '女';
  minAge: string;
  maxAge: string;
  minWan: string;
  maxWan: string;
  address: string;
  callFilter: CallFilter;
  sortBy: DeskSortField;
  sortDir: 'asc' | 'desc';
}

export const DEFAULT_FILTERS: DeskFilters = {
  view: 'all',
  query: '',
  gender: '',
  minAge: '',
  maxAge: '',
  minWan: '',
  maxWan: '',
  address: '',
  callFilter: 'all',
  sortBy: 'premium',
  sortDir: 'desc',
};

const STORAGE_KEY = 'crm_desk_filters_v1';

export function loadFilters(): DeskFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<DeskFilters>) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveFilters(f: DeskFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
  } catch {
    // ignore
  }
}

function numOrUndef(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function toDeskParams(f: DeskFilters, offset: number, limit: number): DeskQueryParams {
  const minWan = numOrUndef(f.minWan);
  const maxWan = numOrUndef(f.maxWan);
  return {
    view: f.view === 'all' ? undefined : f.view,
    query: f.query.trim() || undefined,
    gender: f.gender || undefined,
    min_age: numOrUndef(f.minAge),
    max_age: numOrUndef(f.maxAge),
    min_premium: minWan != null ? Math.round(minWan * 10_000) : undefined,
    max_premium: maxWan != null ? Math.round(maxWan * 10_000) : undefined,
    address_query: f.address.trim() || undefined,
    call_filter: f.callFilter === 'all' ? undefined : f.callFilter,
    sort_by: f.sortBy,
    sort_dir: f.sortDir,
    limit,
    offset,
  };
}

export const AGE_PRESETS = [
  { label: '45–60 岁', min: '45', max: '60' },
  { label: '55–70 岁', min: '55', max: '70' },
  { label: '60 岁以上', min: '60', max: '' },
] as const;

export const PREMIUM_PRESETS = [
  { label: '≥10 万', min: '10', max: '' },
  { label: '5–10 万', min: '5', max: '10' },
  { label: '1–5 万', min: '1', max: '5' },
  { label: '潜客', min: '', max: '0' },
] as const;

export const ADDRESS_PRESETS = ['花果园', '云岩', '南明', '观山湖', '花溪', '白云'] as const;
