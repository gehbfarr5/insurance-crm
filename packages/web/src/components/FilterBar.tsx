import type { CallFilter, DeskSortField } from '@insurance-crm/shared';
import { ArrowDown, ArrowUp, RotateCcw, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { ADDRESS_PRESETS, AGE_PRESETS, type DeskFilters, PREMIUM_PRESETS } from '../lib/desk-filters.js';
import { btn, chipCls, inputCls, selectCls } from '../lib/ui.js';
import { Segmented } from './Motion.js';

const GENDER_OPTIONS = [
  { value: '', label: '全部' },
  { value: '女', label: '女' },
  { value: '男', label: '男' },
] as const;

const CALL_OPTIONS: ReadonlyArray<{ value: CallFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'never_called', label: '未拨打' },
  { value: 'exclude_7d', label: '排除近7天' },
  { value: 'exclude_rejected', label: '排除已拒' },
  { value: 'invited', label: '已邀约' },
];

const SORT_OPTIONS: ReadonlyArray<{ value: DeskSortField; label: string }> = [
  { value: 'premium', label: '总保费' },
  { value: 'age', label: '年龄' },
  { value: 'call_count', label: '拨打次数' },
  { value: 'last_call_at', label: '上次拨打' },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[3.2em] shrink-0 text-[12px] text-[color:var(--muted-foreground)]">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function FilterBar({
  filters,
  onChange,
  onReset,
}: {
  filters: DeskFilters;
  onChange: (patch: Partial<DeskFilters>) => void;
  onReset: () => void;
}) {
  return (
    <div className="space-y-2.5 border-b border-[var(--card-border)] bg-[var(--card)] px-6 py-3.5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        <label className="relative block">
          <span className="sr-only">搜索姓名、手机或地址</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--muted-foreground)]"
          />
          <input
            type="search"
            value={filters.query}
            onChange={(e) => onChange({ query: e.target.value })}
            placeholder="姓名 / 手机 / 地址"
            className={`${inputCls} w-64 pl-8`}
          />
        </label>
        <Field label="性别">
          <Segmented
            label="性别"
            value={filters.gender}
            options={GENDER_OPTIONS}
            onChange={(v) => onChange({ gender: v })}
          />
        </Field>
        <Field label="年龄">
          <input
            aria-label="最小年龄"
            inputMode="numeric"
            value={filters.minAge}
            onChange={(e) => onChange({ minAge: e.target.value.replace(/\D/g, '') })}
            placeholder="最小"
            className={`${inputCls} tnum w-14 text-center`}
          />
          <span className="text-[color:var(--muted-foreground)]">–</span>
          <input
            aria-label="最大年龄"
            inputMode="numeric"
            value={filters.maxAge}
            onChange={(e) => onChange({ maxAge: e.target.value.replace(/\D/g, '') })}
            placeholder="最大"
            className={`${inputCls} tnum w-14 text-center`}
          />
          {AGE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              aria-pressed={filters.minAge === p.min && filters.maxAge === p.max}
              onClick={() =>
                filters.minAge === p.min && filters.maxAge === p.max
                  ? onChange({ minAge: '', maxAge: '' })
                  : onChange({ minAge: p.min, maxAge: p.max })
              }
              className={chipCls(filters.minAge === p.min && filters.maxAge === p.max)}
            >
              {p.label}
            </button>
          ))}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
        <Field label="总保费">
          <input
            aria-label="最低保费（万）"
            inputMode="decimal"
            value={filters.minWan}
            onChange={(e) => onChange({ minWan: e.target.value.replace(/[^\d.]/g, '') })}
            placeholder="最低"
            className={`${inputCls} tnum w-16 text-center`}
          />
          <span className="text-[color:var(--muted-foreground)]">–</span>
          <input
            aria-label="最高保费（万）"
            inputMode="decimal"
            value={filters.maxWan}
            onChange={(e) => onChange({ maxWan: e.target.value.replace(/[^\d.]/g, '') })}
            placeholder="最高"
            className={`${inputCls} tnum w-16 text-center`}
          />
          <span className="text-[12px] text-[color:var(--muted-foreground)]">万</span>
          {PREMIUM_PRESETS.map((p) => {
            const active = filters.minWan === p.min && filters.maxWan === p.max;
            return (
              <button
                key={p.label}
                type="button"
                aria-pressed={active}
                onClick={() => (active ? onChange({ minWan: '', maxWan: '' }) : onChange({ minWan: p.min, maxWan: p.max }))}
                className={chipCls(active)}
              >
                {p.label}
              </button>
            );
          })}
        </Field>
        <Field label="地址">
          <input
            aria-label="居住地址关键词"
            value={filters.address}
            onChange={(e) => onChange({ address: e.target.value })}
            placeholder="关键词"
            className={`${inputCls} w-32`}
          />
          {ADDRESS_PRESETS.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={filters.address === a}
              onClick={() => onChange({ address: filters.address === a ? '' : a })}
              className={chipCls(filters.address === a)}
            >
              {a}
            </button>
          ))}
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
        <Field label="外呼">
          <Segmented
            label="外呼状态过滤"
            value={filters.callFilter}
            options={CALL_OPTIONS}
            onChange={(v) => onChange({ callFilter: v })}
          />
        </Field>
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-2 text-[12px] text-[color:var(--muted-foreground)]">
            排序
            <select
              value={filters.sortBy}
              onChange={(e) => onChange({ sortBy: e.target.value as DeskSortField })}
              className={`${selectCls} pr-6`}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onChange({ sortDir: filters.sortDir === 'desc' ? 'asc' : 'desc' })}
            aria-label={filters.sortDir === 'desc' ? '当前降序，点击改为升序' : '当前升序，点击改为降序'}
            className={`${btn} w-8 px-0`}
          >
            {filters.sortDir === 'desc' ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
          </button>
          <button type="button" onClick={onReset} className={btn}>
            <RotateCcw className="size-3.5" />
            重置
          </button>
        </div>
      </div>
    </div>
  );
}
