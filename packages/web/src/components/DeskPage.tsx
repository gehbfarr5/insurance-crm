import type { CallStats, Customer, DeskCustomer, FollowupView } from '@insurance-crm/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiUnauthorizedError, type SyncStatusResponse, api } from '../api.js';
import { DEFAULT_FILTERS, type DeskFilters, loadFilters, saveFilters, toDeskParams } from '../lib/desk-filters.js';
import { buildInfoCard, copyText, RAPPORT_LABEL } from '../lib/format.js';
import { pushToast } from '../lib/toast-bus.js';
import { btn } from '../lib/ui.js';
import { CustomerDrawer } from './CustomerDrawer.js';
import { DeskCardList } from './DeskCardList.js';
import { DeskTable, type QuickOutcome } from './DeskTable.js';
import { FilterBar } from './FilterBar.js';

const PAGE_SIZE = 50;
const REJECT_REASONS = ['没空', '在外地', '暂不考虑', '不需要'] as const;
const OUTCOME_TEXT: Record<QuickOutcome, string> = {
  no_answer: '未接',
  rejected: '拒绝',
  invited: '已邀约',
};

type StatSnapshot = Pick<
  CallStats,
  'call_count' | 'last_call_at' | 'last_call_outcome' | 'last_call_summary' | 'ever_rejected' | 'ever_invited'
>;

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
  const [viewCounts, setViewCounts] = useState<Record<FollowupView, number> | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [drawerTick, setDrawerTick] = useState(0);
  const [selected, setSelected] = useState<DeskCustomer | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dialedRef = useRef<{ customer: DeskCustomer; at: number } | null>(null);
  const reqRef = useRef(0);

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
        if (res.view_counts) setViewCounts(res.view_counts);
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
    }, 180);
    return () => window.clearTimeout(t);
  }, [filters, offset, reloadKey, onUnauthorized]);

  const patchFilters = useCallback((patch: Partial<DeskFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setOffset(0);
  }, []);

  const revert = useCallback((id: string, snap: StatSnapshot) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...snap } : x)));
  }, []);

  const commitCall = useCallback(
    async (c: DeskCustomer, outcome: QuickOutcome, snap: StatSnapshot, reason?: string) => {
      try {
        await api.logCall(c.id, outcome, summaryFor(outcome, reason));
        setDrawerTick((t) => t + 1);
      } catch (err) {
        revert(c.id, snap);
        onToast(`记录失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [revert, onToast],
  );

  const copyInfoCard = useCallback(
    async (c: DeskCustomer) => {
      try {
        const detail = await api.getCustomer360(c.id);
        const ok = await copyText(buildInfoCard(detail, c.age));
        if (!ok) onToast('复制失败，请在详情中手动复制');
      } catch (err) {
        onToast(err instanceof Error ? err.message : String(err));
      }
    },
    [onToast],
  );

  const quickLog = useCallback(
    (c: DeskCustomer, outcome: QuickOutcome) => {
      const current = items.find((x) => x.id === c.id) ?? c;
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
      if (outcome === 'invited') void copyInfoCard(c);

      pushToast({
        text: `${c.name} · ${OUTCOME_TEXT[outcome]}`,
        note: outcome === 'invited' ? '信息卡已复制，可发给 MUSE' : undefined,
        durationMs: 5000,
        reasonChips: outcome === 'rejected' ? REJECT_REASONS : undefined,
        onReason: (reason) => void commitCall(c, outcome, snapshot, reason),
        onUndo: () => revert(c.id, snapshot),
        onExpire: () => void commitCall(c, outcome, snapshot),
      });
    },
    [items, copyInfoCard, commitCall, revert],
  );

  const updateCustomerField = useCallback(
    async (
      c: DeskCustomer,
      patch: Partial<Pick<Customer, 'rapport_tag' | 'visit_priority' | 'next_followup_at'>>,
      successText?: string,
    ) => {
      const prevRow = items.find((x) => x.id === c.id) ?? c;
      setItems((curr) => curr.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
      try {
        const updated = await api.updateCustomer(c.id, { expected_version: prevRow.version, ...patch });
        setItems((curr) => curr.map((x) => (x.id === c.id ? { ...x, ...updated } : x)));
        setDrawerTick((t) => t + 1);
        setReloadKey((k) => k + 1);
        if (successText) onToast(successText);
      } catch (err) {
        setItems((curr) => curr.map((x) => (x.id === c.id ? prevRow : x)));
        onToast(`更新失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [items, onToast],
  );

  const handleChangeStage = useCallback(
    (c: DeskCustomer, tag: Customer['rapport_tag']) => {
      if (c.rapport_tag === tag) return;
      void updateCustomerField(c, { rapport_tag: tag }, `${c.name} 已设为「${RAPPORT_LABEL[tag]}」`);
    },
    [updateCustomerField],
  );

  // Post-call return loop: after tapping tel: and returning to the browser, offer 1-tap logging
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const d = dialedRef.current;
      if (!d) return;
      const elapsed = Date.now() - d.at;
      dialedRef.current = null;
      if (elapsed >= 800 && elapsed <= 30 * 60_000) {
        pushToast({
          id: `dial-${d.customer.id}`,
          text: '',
          durationMs: 0,
          dialCustomer: d.customer,
          onDialResult: (cust, o) => quickLog(cust, o),
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [quickLog]);

  const handleDial = (c: DeskCustomer) => {
    dialedRef.current = { customer: c, at: Date.now() };
  };

  const deleteCustomer = useCallback(
    (c: DeskCustomer) => {
      const prevItems = items;
      const prevTotal = total;
      setDrawerOpen(false);
      setItems((curr) => curr.filter((x) => x.id !== c.id));
      setTotal((t) => Math.max(0, t - 1));
      pushToast({
        text: `已删除客户「${c.name}」`,
        durationMs: 5000,
        onUndo: () => {
          setItems(prevItems);
          setTotal(prevTotal);
        },
        onExpire: () => {
          void api
            .deleteCustomer(c.id)
            .then(() => setReloadKey((k) => k + 1))
            .catch((err: unknown) => {
              setItems(prevItems);
              setTotal(prevTotal);
              onToast(err instanceof Error ? err.message : '删除客户失败');
            });
        },
      });
    },
    [items, total, onToast],
  );

  const openDrawer = (c: DeskCustomer) => {
    setSelected(c);
    setDrawerOpen(true);
  };

  const drawerCustomer = selected ? (items.find((x) => x.id === selected.id) ?? selected) : null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="flex min-h-[calc(100dvh-3rem)] flex-col bg-[var(--background)] md:h-[calc(100dvh-3rem)] md:bg-[var(--card)]">
      <FilterBar
        filters={filters}
        total={total}
        viewCounts={viewCounts}
        onChange={patchFilters}
        onReset={() => patchFilters({ ...DEFAULT_FILTERS })}
      />
      {error && (
        <div role="alert" className="border-b border-[var(--card-border)] px-4 py-2 text-[color:var(--error)] md:px-6">
          加载失败：{error}
        </div>
      )}
      {loading && items.length === 0 ? (
        <div className="grid flex-1 place-items-center py-20 text-[color:var(--muted-foreground)]">加载中…</div>
      ) : (
        <>
          <DeskTable
            items={items}
            loading={loading}
            onOpen={openDrawer}
            onQuick={quickLog}
            onDial={handleDial}
            onChangeStage={handleChangeStage}
          />
          <DeskCardList items={items} loading={loading} onOpen={openDrawer} onQuick={quickLog} onDial={handleDial} />
        </>
      )}
      <footer className="mt-auto flex items-center justify-between border-t border-[var(--card-border)] bg-[var(--card)] px-4 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5 text-[13px] text-[color:var(--muted-foreground)] md:px-6 md:py-2.5">
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
        onDial={handleDial}
        onUpdateField={updateCustomerField}
        onDeleteCustomer={deleteCustomer}
        sync={syncStatus}
        onToast={onToast}
        onChanged={() => setReloadKey((k) => k + 1)}
        refreshSignal={drawerTick}
      />
    </div>
  );
}
