import { type Customer, type DeskCustomer, RAPPORT_TAGS } from '@insurance-crm/shared';
import { Phone, Star } from 'lucide-react';
import {
  fmtMoney,
  fmtShortDate,
  followupUrgency,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RAPPORT_LABEL,
  RAPPORT_TONE,
  relTime,
} from '../lib/format.js';
import { badgeCls } from '../lib/ui.js';
import { RollingNumber } from './Motion.js';

export type QuickOutcome = 'no_answer' | 'rejected' | 'invited';

function QuickButton({
  label,
  tone,
  onClick,
}: {
  label: string;
  tone: 'ghost' | 'danger' | 'primary';
  onClick: () => void;
}) {
  const cls =
    tone === 'primary'
      ? 'border-transparent bg-[var(--primary)] text-[color:var(--primary-foreground)] hover:opacity-90'
      : tone === 'danger'
        ? 'border-[var(--border)] bg-[var(--card)] text-[color:var(--foreground)] hover:border-[var(--error)] hover:text-[color:var(--error)]'
        : 'border-[var(--border)] bg-[var(--card)] text-[color:var(--foreground)] hover:bg-[var(--hover)]';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`touch-action h-7 shrink-0 cursor-pointer select-none whitespace-nowrap rounded-md border px-2 text-[13px] font-medium transition-[background-color,border-color,color,opacity] duration-120 ease-[cubic-bezier(0.2,0,0,1)] ${cls}`}
    >
      {label}
    </button>
  );
}

export function QuickActions({ onQuick }: { onQuick: (o: QuickOutcome) => void }) {
  return (
    <div className="flex items-center gap-1">
      <QuickButton label="未接" tone="ghost" onClick={() => onQuick('no_answer')} />
      <QuickButton label="拒绝" tone="danger" onClick={() => onQuick('rejected')} />
      <QuickButton label="邀约 ✓" tone="primary" onClick={() => onQuick('invited')} />
    </div>
  );
}

export function CallSummary({ c }: { c: DeskCustomer }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="tnum whitespace-nowrap font-medium">
        <RollingNumber value={c.call_count} /> <span className="font-normal text-[color:var(--muted-foreground)]">次</span>
      </span>
      {c.last_call_at && c.last_call_outcome && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="tnum text-[13px] text-[color:var(--muted-foreground)]">{relTime(c.last_call_at)}</span>
          <span className={badgeCls(OUTCOME_TONE[c.last_call_outcome] ?? 'neutral')}>
            {OUTCOME_LABEL[c.last_call_outcome] ?? c.last_call_outcome}
          </span>
        </span>
      )}
      {c.ever_rejected && c.last_call_outcome !== 'rejected' && (
        <span className={badgeCls('error')}>曾拒绝</span>
      )}
    </div>
  );
}

export function FollowupStageCell({ c }: { c: DeskCustomer }) {
  const urgency = followupUrgency(c.next_followup_at);
  const dateText = fmtShortDate(c.next_followup_at);
  const dateCls =
    urgency === 'overdue'
      ? 'text-[color:var(--error)] font-medium'
      : urgency === 'today'
        ? 'text-[color:var(--warning)] font-medium'
        : 'text-[color:var(--muted-foreground)]';

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={badgeCls(RAPPORT_TONE[c.rapport_tag] ?? 'neutral')}>
        {RAPPORT_LABEL[c.rapport_tag] ?? c.rapport_tag}
      </span>
      {dateText && (
        <span className={`tnum whitespace-nowrap text-[13px] ${dateCls}`}>
          {urgency === 'overdue' ? `逾期 ${dateText}` : urgency === 'today' ? `今日` : dateText}
        </span>
      )}
    </div>
  );
}

export function DialLink({
  customer,
  onDial,
  compact = false,
}: {
  customer: DeskCustomer;
  onDial: (c: DeskCustomer) => void;
  compact?: boolean;
}) {
  if (!customer.primary_phone) {
    return <span className="text-[color:var(--muted-foreground)]">—</span>;
  }
  return (
    <a
      href={`tel:${customer.primary_phone}`}
      onClick={(e) => {
        e.stopPropagation();
        onDial(customer);
      }}
      title="点击直接拨号"
      className={
        compact
          ? 'tnum inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 font-medium text-[color:var(--foreground)] transition-colors duration-120 hover:bg-[var(--secondary)]'
          : 'tnum inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--secondary)] px-3 text-[13px] font-medium text-[color:var(--foreground)] transition-colors duration-120'
      }
    >
      <Phone className="size-3.5 shrink-0 text-[color:var(--muted-foreground)]" aria-hidden="true" />
      <span>{customer.primary_phone}</span>
    </a>
  );
}

export function DeskTable({
  items,
  loading,
  onOpen,
  onQuick,
  onDial,
  onChangeStage,
}: {
  items: DeskCustomer[];
  loading: boolean;
  onOpen: (c: DeskCustomer) => void;
  onQuick: (c: DeskCustomer, o: QuickOutcome) => void;
  onDial: (c: DeskCustomer) => void;
  onChangeStage: (c: DeskCustomer, tag: Customer['rapport_tag']) => void;
}) {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="客户列表"
      className="desk-scroll hidden min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] md:block"
      aria-busy={loading}
    >
      <table className="desk-table">
        <caption className="sr-only">客户筛选与跟进列表</caption>
        <thead>
          <tr>
            <th scope="col">客户</th>
            <th scope="col">阶段 / 下次跟进</th>
            <th scope="col" className="text-right">
              总保费
            </th>
            <th scope="col">居住地址</th>
            <th scope="col">拨号</th>
            <th scope="col">外呼记录</th>
            <th scope="col" className="text-right">
              快捷操作
            </th>
          </tr>
        </thead>
        <tbody className={loading ? 'opacity-60 transition-opacity duration-120' : 'transition-opacity duration-120'}>
          {items.map((c) => (
            <tr key={c.id} onClick={() => onOpen(c)} className="cursor-pointer">
              <td>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(c);
                    }}
                    className="cursor-pointer text-left font-medium hover:underline"
                  >
                    {c.name}
                  </button>
                  {c.visit_priority === 'high' && (
                    <Star
                      aria-label="重点跟进"
                      className="size-3.5 shrink-0 fill-[var(--warning)] text-[color:var(--warning)]"
                    />
                  )}
                </div>
                <div className="tnum text-[13px] text-[color:var(--muted-foreground)]">
                  {[c.gender !== '未知' ? c.gender : '', c.age != null ? `${c.age}岁` : ''].filter(Boolean).join(' · ') || '—'}
                </div>
              </td>
              <td>
                <FollowupStageCell c={c} />
              </td>
              <td className="text-right">
                <div className="tnum font-medium">{fmtMoney(c.total_premium)}</div>
                {c.policy_total > 0 && (
                  <div className="tnum text-[13px] text-[color:var(--muted-foreground)]">{c.policy_total} 张保单</div>
                )}
              </td>
              <td className="max-w-[16rem]">
                <div className="truncate" title={c.address ?? undefined}>
                  {c.address ?? <span className="text-[color:var(--muted-foreground)]">—</span>}
                </div>
              </td>
              <td>
                <DialLink customer={c} onDial={onDial} compact />
              </td>
              <td>
                <CallSummary c={c} />
              </td>
              <td className="text-right">
                <div className="desk-row-actions inline-flex items-center justify-end gap-1.5">
                  <select
                    aria-label={`修改 ${c.name} 阶段`}
                    value={c.rapport_tag}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      e.stopPropagation();
                      onChangeStage(c, e.target.value as Customer['rapport_tag']);
                    }}
                    className="h-7 cursor-pointer rounded-md border border-[var(--border)] bg-[var(--card)] px-1.5 text-[13px] text-[color:var(--foreground)] outline-none transition-colors duration-120 hover:bg-[var(--hover)]"
                  >
                    {RAPPORT_TAGS.map((tag) => (
                      <option key={tag} value={tag}>
                        {RAPPORT_LABEL[tag]}
                      </option>
                    ))}
                  </select>
                  <QuickActions onQuick={(o) => onQuick(c, o)} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && !loading && (
        <div className="py-20 text-center text-[color:var(--muted-foreground)]">没有符合条件的客户，试试切换视图或放宽筛选</div>
      )}
    </div>
  );
}
