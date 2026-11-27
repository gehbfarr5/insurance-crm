import type { CallFilter, DeskSortField } from '@insurance-crm/shared';
import { ArrowDown, ArrowUp, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { ADDRESS_PRESETS, AGE_PRESETS, type DeskFilters, PREMIUM_PRESETS } from '../lib/desk-filters.js';
import { useDialogControl } from '../lib/dialog.js';
import { btn, btnPrimary, chipCls, inputCls, selectCls } from '../lib/ui.js';
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

const CALL_LABELS: Record<CallFilter, string> = {
  all: '全部',
  never_called: '未拨打',
  exclude_7d: '排除近7天',
  exclude_rejected: '排除已拒',
  invited: '已邀约',
};

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
  total,
  onChange,
  onReset,
}: {
  filters: DeskFilters;
  total: number;
  onChange: (patch: Partial<DeskFilters>) => void;
  onReset: () => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { ref, close } = useDialogControl(sheetOpen, () => setSheetOpen(false));
  const sheetTitleId = useId();

  const activeChips: Array<{ key: string; label: string; clear: () => void }> = [];
  if (filters.gender) activeChips.push({ key: 'gender', label: filters.gender, clear: () => onChange({ gender: '' }) });
  if (filters.minAge || filters.maxAge) {
    activeChips.push({
      key: 'age',
      label: `${filters.minAge || '0'}–${filters.maxAge || '不限'}岁`,
      clear: () => onChange({ minAge: '', maxAge: '' }),
    });
  }
  if (filters.minWan || filters.maxWan) {
    activeChips.push({
      key: 'prem',
      label: `${filters.minWan || '0'}–${filters.maxWan || '不限'}万`,
      clear: () => onChange({ minWan: '', maxWan: '' }),
    });
  }
  if (filters.address.trim()) {
    activeChips.push({ key: 'addr', label: filters.address.trim(), clear: () => onChange({ address: '' }) });
  }
  if (filters.callFilter !== 'all') {
    activeChips.push({
      key: 'call',
      label: CALL_LABELS[filters.callFilter],
      clear: () => onChange({ callFilter: 'all' }),
    });
  }

  return (
    <>
      {/* Desktop inline filter bar */}
      <div className="hidden space-y-2.5 border-b border-[var(--card-border)] bg-[var(--card)] px-6 py-3.5 md:block">
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

      {/* Mobile compact search + filter bottom-sheet trigger */}
      <div className="space-y-2 border-b border-[var(--card-border)] bg-[var(--card)] px-3.5 py-2.5 md:hidden">
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">搜索姓名、手机或地址</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--muted-foreground)]"
            />
            <input
              type="search"
              value={filters.query}
              onChange={(e) => onChange({ query: e.target.value })}
              placeholder="搜姓名 / 手机 / 地址"
              className={`${inputCls} h-9 w-full pl-8 text-[14px]`}
            />
          </label>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className={`${btn} h-9 shrink-0 px-3`}
          >
            <SlidersHorizontal className="size-3.5" />
            <span>筛选</span>
            {activeChips.length > 0 && (
              <span className="tnum inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[11px] font-medium text-[color:var(--primary-foreground)]">
                {activeChips.length}
              </span>
            )}
          </button>
        </div>

        {activeChips.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {activeChips.map((ch) => (
              <button
                key={ch.key}
                type="button"
                onClick={ch.clear}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--secondary)] px-2.5 text-[12px] text-[color:var(--foreground)]"
              >
                <span>{ch.label}</span>
                <X className="size-3 text-[color:var(--muted-foreground)]" />
              </button>
            ))}
            <button
              type="button"
              onClick={onReset}
              className="shrink-0 cursor-pointer px-1.5 text-[12px] text-[color:var(--muted-foreground)]"
            >
              清空
            </button>
          </div>
        )}
      </div>

      {/* Mobile Filter Bottom Sheet */}
      <dialog ref={ref} className="bottom-sheet" aria-labelledby={sheetTitleId}>
        <div className="flex flex-col">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--card-border)] bg-[var(--card)] px-4 py-3">
            <h2 id={sheetTitleId} className="text-[15px] font-semibold">
              筛选与排序
            </h2>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onReset} className={btn}>
                <RotateCcw className="size-3.5" />
                重置
              </button>
              <button
                type="button"
                onClick={close}
                aria-label="关闭筛选"
                className="grid size-8 cursor-pointer place-items-center rounded-lg text-[color:var(--muted-foreground)] hover:bg-[var(--secondary)]"
              >
                <X className="size-4" />
              </button>
            </div>
          </header>

          <div className="space-y-4 px-4 py-4">
            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-[color:var(--muted-foreground)]">性别</div>
              <Segmented
                label="性别"
                value={filters.gender}
                options={GENDER_OPTIONS}
                onChange={(v) => onChange({ gender: v })}
              />
            </div>

            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-[color:var(--muted-foreground)]">年龄（周岁）</div>
              <div className="flex items-center gap-2">
                <input
                  aria-label="最小年龄"
                  inputMode="numeric"
                  value={filters.minAge}
                  onChange={(e) => onChange({ minAge: e.target.value.replace(/\D/g, '') })}
                  placeholder="最小"
                  className={`${inputCls} tnum h-9 w-24 text-center text-[14px]`}
                />
                <span className="text-[color:var(--muted-foreground)]">–</span>
                <input
                  aria-label="最大年龄"
                  inputMode="numeric"
                  value={filters.maxAge}
                  onChange={(e) => onChange({ maxAge: e.target.value.replace(/\D/g, '') })}
                  placeholder="最大"
                  className={`${inputCls} tnum h-9 w-24 text-center text-[14px]`}
                />
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {AGE_PRESETS.map((p) => {
                  const active = filters.minAge === p.min && filters.maxAge === p.max;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => (active ? onChange({ minAge: '', maxAge: '' }) : onChange({ minAge: p.min, maxAge: p.max }))}
                      className={chipCls(active)}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-[color:var(--muted-foreground)]">总保费（万元）</div>
              <div className="flex items-center gap-2">
                <input
                  aria-label="最低保费（万）"
                  inputMode="decimal"
                  value={filters.minWan}
                  onChange={(e) => onChange({ minWan: e.target.value.replace(/[^\d.]/g, '') })}
                  placeholder="最低"
                  className={`${inputCls} tnum h-9 w-24 text-center text-[14px]`}
                />
                <span className="text-[color:var(--muted-foreground)]">–</span>
                <input
                  aria-label="最高保费（万）"
                  inputMode="decimal"
                  value={filters.maxWan}
                  onChange={(e) => onChange({ maxWan: e.target.value.replace(/[^\d.]/g, '') })}
                  placeholder="最高"
                  className={`${inputCls} tnum h-9 w-24 text-center text-[14px]`}
                />
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {PREMIUM_PRESETS.map((p) => {
                  const active = filters.minWan === p.min && filters.maxWan === p.max;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => (active ? onChange({ minWan: '', maxWan: '' }) : onChange({ minWan: p.min, maxWan: p.max }))}
                      className={chipCls(active)}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-[color:var(--muted-foreground)]">居住地址</div>
              <input
                aria-label="居住地址关键词"
                value={filters.address}
                onChange={(e) => onChange({ address: e.target.value })}
                placeholder="输入区/小区/街道关键词"
                className={`${inputCls} h-9 w-full text-[14px]`}
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {ADDRESS_PRESETS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => onChange({ address: filters.address === a ? '' : a })}
                    className={chipCls(filters.address === a)}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-[color:var(--muted-foreground)]">外呼防重呼状态</div>
              <div className="flex flex-wrap gap-1.5">
                {CALL_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => onChange({ callFilter: o.value })}
                    className={chipCls(filters.callFilter === o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[12px] font-medium text-[color:var(--muted-foreground)]">排序方式</div>
              <div className="flex items-center gap-2">
                <select
                  value={filters.sortBy}
                  onChange={(e) => onChange({ sortBy: e.target.value as DeskSortField })}
                  className={`${selectCls} h-9 flex-1 text-[14px]`}
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onChange({ sortDir: filters.sortDir === 'desc' ? 'asc' : 'desc' })}
                  className={`${btn} h-9 px-3`}
                >
                  {filters.sortDir === 'desc' ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
                  {filters.sortDir === 'desc' ? '降序' : '升序'}
                </button>
              </div>
            </div>
          </div>

          <footer className="sticky bottom-0 border-t border-[var(--card-border)] bg-[var(--card)] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
            <button type="button" onClick={close} className={`${btnPrimary} h-10 w-full text-[14px]`}>
              查看结果（共 {total} 位）
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
