import type { CallStats, DeskCustomer } from '@insurance-crm/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiUnauthorizedError, type SyncStatusResponse, api } from '../api.js';
import { buildInfoCard, copyText } from '../lib/format.js';
import { DEFAULT_FILTERS, type DeskFilters, loadFilters, saveFilters, toDeskParams } from '../lib/desk-filters.js';
import { btn } from '../lib/ui.js';
import { CallToasts, PENDING_MS, type PendingView } from './CallToasts.js';
import { CustomerDrawer } from './CustomerDrawer.js';
import { DeskTable, type QuickOutcome } from './DeskTable.js';
import { FilterBar } from './FilterBar.js';

const PAGE_SIZE = 50;

type StatSnapshot = Pick<
  CallStats,
  'call_count' | 'last_call_at' | 'last_call_outcome' | 'last_call_summary' | 'ever_rejected' | 'ever_invited'
>;

interface Pending {
  customer: DeskCustomer;
  outcome: QuickOutcome;
  snapshot: StatSnapshot;
  timer: number;
  reason?: string;
}

function summaryFor(o: QuickOutcome, reason?: string): string {
  if (o === 'no_answer') return '未接';
  if (o === 'rejected') return reason ? `拒绝：${reason}` : '拒绝';
  return '邀约成功（详细沟通由 MUSE 记录）';
}

function pickStats(c: DeskCustomer): StatSnapshot {
  return {
    call_count: c.call_count,
    last_call_at: c.last_call_at,
    last_call_outcome: c.last_call_outcome,
    last_call_summary: c.last_call_summary,
    ever_rejected: c.ever_rejected,
    ever_invited: c.ever_invited,
  };
}

export function DeskPage({
  syncStatus,
  onToast,
  onUnauthorized,
}: {
  syncStatus: SyncStatusResponse | null;
  onToast: (msg: string) => void;
  onUnauthorized: () => void;
}) {
  const [filters, setFilters] = useState<DeskFilters>(loadFilters);
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<DeskCustomer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<DeskCustomer | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingView, setPendingView] = useState<PendingView[]>([]);
  const reqRef = useRef(0);
  const pendingRef = useRef(new Map<string, Pending>());

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  useEffect(() => {
    const reqId = ++reqRef.current;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await api.getDeskCustomers(toDeskParams(filters, offset, PAGE_SIZE));
        if (reqId !== reqRef.current) return;
        setItems(res.items);
        setTotal(res.total);
        setError(null);
      } catch (err) {
        if (reqId !== reqRef.current) return;
        if (err instanceof ApiUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (reqId === reqRef.current) setLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(t);
  }, [filters, offset, reloadKey, onUnauthorized]);

  const patchFilters = useCallback((patch: Partial<DeskFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
  }, []);

  const syncView = () => {
    setPendingView(
      Array.from(pendingRef.current.entries()).map(([key, p]) => ({
        key,
        name: p.customer.name,
        outcome: p.outcome,
        note: p.outcome === 'invited' ? '信息卡已复制，可直接发给 MUSE' : undefined,
      })),
    );
  };

  const revert = (id: string, snap: StatSnapshot) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...snap } : x)));
  };

  const commit = async (key: string) => {
    const p = pendingRef.current.get(key);
    if (!p) return;
    window.clearTimeout(p.timer);
    pendingRef.current.delete(key);
    syncView();
    try {
      await api.logCall(p.customer.id, p.outcome, summaryFor(p.outcome, p.reason));
    } catch (err) {
      revert(p.customer.id, p.snapshot);
      onToast(`记录失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const undo = (key: string) => {
    const p = pendingRef.current.get(key);
    if (!p) return;
    window.clearTimeout(p.timer);
    pendingRef.current.delete(key);
    revert(p.customer.id, p.snapshot);
    syncView();
  };

  const setReason = (key: string, reason: string) => {
    const p = pendingRef.current.get(key);
    if (!p) return;
    p.reason = reason;
    void commit(key);
  };

  const copyInfoCard = async (c: DeskCustomer) => {
    try {
      const detail = await api.getCustomer360(c.id);
      const ok = await copyText(buildInfoCard(detail, c.age));
      onToast(ok ? `已复制「${c.name}」完整信息卡，可直接发给 MUSE` : '复制失败，请在详情中手动复制');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  };

  const quickLog = (c: DeskCustomer, outcome: QuickOutcome) => {
    const current = items.find((x) => x.id === c.id) ?? c;
    const key = `${c.id}-${Date.now()}`;
    const snapshot = pickStats(current);
    setItems((prev) =>
      prev.map((x) =>
        x.id === c.id
          ? {
              ...x,
              call_count: x.call_count + 1,
              last_call_at: new Date().toISOString(),
              last_call_outcome: outcome,
              last_call_summary: summaryFor(outcome),
              ever_rejected: x.ever_rejected || outcome === 'rejected',
              ever_invited: x.ever_invited || outcome === 'invited',
            }
          : x,
      ),
    );
    const timer = window.setTimeout(() => void commit(key), PENDING_MS);
    pendingRef.current.set(key, { customer: c, outcome, snapshot, timer });
    syncView();
    if (outcome === 'invited') void copyInfoCard(c);
  };

  // Flush un-committed quick logs if the tab is closed during the undo window.
  useEffect(() => {
    const flush = () => {
      for (const p of pendingRef.current.values()) {
        window.clearTimeout(p.timer);
        void api.logCall(p.customer.id, p.outcome, summaryFor(p.outcome, p.reason), true).catch(() => undefined);
      }
      pendingRef.current.clear();
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const openDrawer = (c: DeskCustomer) => {
    setSelected(c);
    setDrawerOpen(true);
  };

  const drawerCustomer = selected ? (items.find((x) => x.id === selected.id) ?? selected) : null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col bg-[var(--card)]">
      <FilterBar filters={filters} onChange={patchFilters} onReset={() => patchFilters({ ...DEFAULT_FILTERS })} />
      {error && (
        <div role="alert" className="border-b border-[var(--card-border)] px-6 py-2 text-[color:var(--error)]">
          加载失败：{error}
        </div>
      )}
      {loading && items.length === 0 ? (
        <div className="grid flex-1 place-items-center text-[color:var(--muted-foreground)]">加载中…</div>
      ) : (
        <DeskTable
          items={items}
          loading={loading}
          onOpen={openDrawer}
          onQuick={quickLog}
          onCopyPhone={(c) => {
            if (!c.primary_phone) return;
            void copyText(c.primary_phone).then((ok) => onToast(ok ? `已复制 ${c.primary_phone}` : '复制失败'));
          }}
        />
      )}
      <footer className="flex items-center justify-between border-t border-[var(--card-border)] px-6 py-2.5 text-[12.5px] text-[color:var(--muted-foreground)]">
        <span className="tnum">
          共 {total} 位{total > 0 && ` · 第 ${from}–${to} 位`}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={`${btn} w-8 px-0`}
            aria-label="上一页"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            className={`${btn} w-8 px-0`}
            aria-label="下一页"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </footer>

      <CustomerDrawer
        customer={drawerCustomer}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onQuick={quickLog}
        sync={syncStatus}
        onToast={onToast}
        onChanged={() => setReloadKey((k) => k + 1)}
      />
      <CallToasts pending={pendingView} onUndo={undo} onReason={setReason} />
    </div>
  );
}
