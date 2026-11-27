import type { DeskCustomer } from '@insurance-crm/shared';
import { Star } from 'lucide-react';
import { fmtMoney } from '../lib/format.js';
import { CallSummary, DialLink, FollowupStageCell, QuickActions, type QuickOutcome } from './DeskTable.js';

export function DeskCardList({
  items,
  loading,
  onOpen,
  onQuick,
  onDial,
}: {
  items: DeskCustomer[];
  loading: boolean;
  onOpen: (c: DeskCustomer) => void;
  onQuick: (c: DeskCustomer, o: QuickOutcome) => void;
  onDial: (c: DeskCustomer) => void;
}) {
  return (
    <div
      className={`space-y-2.5 px-3.5 py-3 md:hidden ${loading ? 'opacity-60 transition-opacity duration-120' : 'transition-opacity duration-120'}`}
      aria-busy={loading}
    >
      {items.map((c) => {
        const bio = [c.gender !== '未知' ? c.gender : '', c.age != null ? `${c.age}岁` : ''].filter(Boolean).join(' · ');
        return (
          <article
            key={c.id}
            onClick={() => onOpen(c)}
            className="cursor-pointer space-y-2.5 rounded-lg border border-[var(--card-border)] bg-[var(--card)] p-3.5 transition-colors duration-120 active:bg-[var(--hover)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[16px] font-semibold text-[color:var(--foreground)]">{c.name}</span>
                  {c.visit_priority === 'high' && (
                    <Star
                      aria-label="重点跟进"
                      className="size-3.5 shrink-0 fill-[var(--warning)] text-[color:var(--warning)]"
                    />
                  )}
                  {bio && <span className="tnum shrink-0 text-[13px] text-[color:var(--muted-foreground)]">{bio}</span>}
                </div>
                <p className="mt-0.5 truncate text-[13px] text-[color:var(--muted-foreground)]">
                  {c.address || '未填写居住地址'}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <div className="tnum text-[14px] font-semibold text-[color:var(--foreground)]">
                  {fmtMoney(c.total_premium)}
                </div>
                {c.policy_total > 0 && (
                  <div className="tnum text-[13px] text-[color:var(--muted-foreground)]">{c.policy_total} 张保单</div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <FollowupStageCell c={c} />
              <CallSummary c={c} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--card-border)] pt-2.5">
              <DialLink customer={c} onDial={onDial} />
              <QuickActions onQuick={(o) => onQuick(c, o)} />
            </div>
          </article>
        );
      })}
      {items.length === 0 && !loading && (
        <div className="py-16 text-center text-[color:var(--muted-foreground)]">没有符合条件的客户，试试切换视图或放宽筛选</div>
      )}
    </div>
  );
}
