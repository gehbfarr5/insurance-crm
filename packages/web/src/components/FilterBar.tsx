import type { CallFilter, DeskSortField, FollowupView } from '@insurance-crm/shared';
import { ArrowDown, ArrowUp, ChevronDown, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { ADDRESS_PRESETS, AGE_PRESETS, type DeskFilters, PREMIUM_PRESETS } from '../lib/desk-filters.js';
import { useDialogControl } from '../lib/dialog.js';
import { btn, btnPrimary, chipCls, inputCls, selectCls } from '../lib/ui.js';
import { Collapsible, Segmented } from './Motion.js';

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
      <span className="w-[3.2em] shrink-0 text-[13px] text-[color:var(--muted-foreground)]">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

export function FilterBar({
  filters,
  total,
  viewCounts,
  onChange,
  onReset,
}: {
  filters: DeskFilters;
  total: number;
  viewCounts?: Record<FollowupView, number>;
  onChange: (patch: Partial<DeskFilters>) => void;
  onReset: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { ref, close } = useDialogControl(sheetOpen, () => setSheetOpen(false));
  const sheetTitleId = useId();

  const viewOptions: ReadonlyArray<{ value: FollowupView; label: string; count?: number }> = [
    { value: 'all', label: '全部', count: viewCounts?.all },
    { value: 'today', label: '今日待跟进', count: viewCounts?.today },
    { value: 'overdue', label: '已逾期', count: viewCounts?.overdue },
    { value: 'priority', label: '重点跟进', count: viewCounts?.priority },
  ];

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
      {/* Desktop compact view-bar + collapsible filter drawer */}
      <div className="hidden border-b border-[var(--card-border)] bg-[var(--card)] md:block">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-2.5">
          <Segmented
            label="跟进视图"
            value={filters.view}
            options={viewOptions}
            onChange={(v) => onChange({ view: v })}
          />

          <div className="flex flex-wrap items-center gap-2">
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
                placeholder="搜索姓名 / 手机 / 地址"
                className={`${inputCls} w-56 pl-8`}
              />
            </label>

            <div className="flex items-center gap-1">
              <select
                aria-label="排序字段"
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
              <button
                type="button"
                onClick={() => onChange({ sortDir: filters.sortDir === 'desc' ? 'asc' : 'desc' })}
                aria-label={filters.sortDir === 'desc' ? '当前降序，点击改为升序' : '当前升序，点击改为降序'}
                className={`${btn} w-8 px-0`}
              >
                {filters.sortDir === 'desc' ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
              </button>
            </div>

            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={`${btn} ${expanded || activeChips.length > 0 ? 'border-[var(--foreground)]/30 bg-[var(--surface-subtle)]' : ''}`}
            >
              <SlidersHorizontal className="size-3.5" />
              <span>筛选</span>
              {activeChips.length > 0 && (
                <span className="tnum inline-flex h-4 min-w-4 items-center justify-center rounded bg-[var(--primary)] px-1 text-[13px] leading-none font-medium text-[color:var(--primary-foreground)]">
                  {activeChips.length}
                </span>
              )}
              <ChevronDown
                className={`size-3.5 text-[color:var(--muted-foreground)] transition-transform duration-180 ease-[cubic-bezier(0.2,0,0,1)] ${
                  expanded ? 'rotate-180' : ''
                }`}
              />
            </button>

            {(activeChips.length > 0 || filters.query || filters.view !== 'all') && (
              <button type="button" onClick={onReset} className={btn}>
                <RotateCcw className="size-3.5" />
                重置
              </button>
            )}
          </div>
        </div>

        {/* Active filter summary chips when advanced drawer is collapsed */}
        {!expanded && activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--card-border)] bg-[var(--surface-subtle)] px-6 py-1.5">
            <span className="text-[13px] text-[color:var(--muted-foreground)]">已选：</span>
            {activeChips.map((ch) => (
              <button
                key={ch.key}
                type="button"
                onClick={ch.clear}
                className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-[13px] text-[color:var(--foreground)] transition-colors duration-120 hover:bg-[var(--hover)]"
              >
                <span>{ch.label}</span>
                <X className="size-3 text-[color:var(--muted-foreground)]" />
              </button>
            ))}
          </div>
        )}

        {/* Collapsible advanced filter drawer */}
        <Collapsible open={expanded}>
          <div className="space-y-2.5 border-t border-[var(--card-border)] bg-[var(--surface-subtle)] px-6 py-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
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
                <select
                  aria-label="年龄预设"
                  value={AGE_PRESETS.find((p) => p.min === filters.minAge && p.max === filters.maxAge)?.label ?? ''}
                  onChange={(e) => {
                    const found = AGE_PRESETS.find((p) => p.label === e.target.value);
                    onChange(found ? { minAge: found.min, maxAge: found.max } : { minAge: '', maxAge: '' });
                  }}
                  className={`${selectCls} pr-6`}
                >
                  <option value="">快捷年龄</option>
                  {AGE_PRESETS.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
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
                <span className="text-[13px] text-[color:var(--muted-foreground)]">万</span>
                <select
                  aria-label="保费预设"
                  value={PREMIUM_PRESETS.find((p) => p.min === filters.minWan && p.max === filters.maxWan)?.label ?? ''}
                  onChange={(e) => {
                    const found = PREMIUM_PRESETS.find((p) => p.label === e.target.value);
                    onChange(found ? { minWan: found.min, maxWan: found.max } : { minWan: '', maxWan: '' });
                  }}
                  className={`${selectCls} pr-6`}
                >
                  <option value="">快捷保费</option>
                  {PREMIUM_PRESETS.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
              <Field label="地址">
                <input
                  aria-label="居住地址关键词"
                  value={filters.address}
                  onChange={(e) => onChange({ address: e.target.value })}
                  placeholder="关键词"
                  className={`${inputCls} w-32`}
                />
                <select
                  aria-label="常用区域"
                  value={ADDRESS_PRESETS.includes(filters.address as (typeof ADDRESS_PRESETS)[number]) ? filters.address : ''}
                  onChange={(e) => onChange({ address: e.target.value })}
                  className={`${selectCls} pr-6`}
                >
                  <option value="">常用区域</option>
                  {ADDRESS_PRESETS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="外呼">
                <Segmented
                  label="外呼状态过滤"
                  value={filters.callFilter}
                  options={CALL_OPTIONS}
                  onChange={(v) => onChange({ callFilter: v })}
                />
              </Field>
            </div>
          </div>
        </Collapsible>
      </div>

      {/* Mobile compact view switcher + search + filter bottom-sheet trigger */}
      <div className="space-y-2 border-b border-[var(--card-border)] bg-[var(--card)] px-3.5 py-2.5 md:hidden">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {viewOptions.map((v) => (
            <button
              key={v.value}
              type="button"
              onClick={() => onChange({ view: v.value })}
              className={chipCls(filters.view === v.value)}
            >
              <span>{v.label}</span>
              {v.count !== undefined && <span className="tnum ml-1 opacity-75">{v.count}</span>}
            </button>
          ))}
        </div>

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
              <span className="tnum inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-[var(--primary)] px-1 text-[13px] font-medium text-[color:var(--primary-foreground)]">
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
                className="touch-action inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2.5 text-[13px] text-[color:var(--foreground)]"
              >
                <span>{ch.label}</span>
                <X className="size-3.5 text-[color:var(--muted-foreground)]" />
              </button>
            ))}
            <button
              type="button"
              onClick={onReset}
              className="touch-action shrink-0 cursor-pointer px-2 text-[13px] text-[color:var(--muted-foreground)]"
            >
              清空
            </button>
          </div>
        )}
      </div>

      {/* Mobile Filter Bottom Sheet */}
      <dialog ref={ref} className="bottom-sheet" aria-labelledby={sheetTitleId}>
        <div className="flex flex-col">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--card-border)] bg-[var(--surface-elevated)] px-4 py-3">
            <h2 id={sheetTitleId} className="text-[16px] font-semibold">
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
                className="touch-icon-hit grid size-8 cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] hover:bg-[var(--hover)]"
              >
                <X className="size-4" />
              </button>
            </div>
          </header>

          <div className="space-y-4 px-4 py-4">
            <div className="space-y-1.5">
              <div className="text-[13px] font-medium text-[color:var(--muted-foreground)]">性别</div>
              <Segmented
                label="性别"
                value={filters.gender}
                options={GENDER_OPTIONS}
                onChange={(v) => onChange({ gender: v })}
              />
            </div>

            <div className="space-y-1.5">
              <div className="text-[13px] font-medium text-[color:var(--muted-foreground)]">年龄（周岁）</div>
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
              <div className="text-[13px] font-medium text-[color:var(--muted-foreground)]">总保费（万元）</div>
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
              <div className="text-[13px] font-medium text-[color:var(--muted-foreground)]">居住地址</div>
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
              <div className="text-[13px] font-medium text-[color:var(--muted-foreground)]">外呼防重呼状态</div>
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
              <div className="text-[13px] font-medium text-[color:var(--muted-foreground)]">排序方式</div>
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

          <footer className="sticky bottom-0 border-t border-[var(--card-border)] bg-[var(--surface-elevated)] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
            <button type="button" onClick={close} className={`${btnPrimary} h-10 w-full text-[14px]`}>
              查看结果（共 {total} 位）
            </button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
