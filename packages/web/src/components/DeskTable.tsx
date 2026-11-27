import type { DeskCustomer } from '@insurance-crm/shared';
import { Phone } from 'lucide-react';
import { motion } from 'motion/react';
import { fmtMoney, OUTCOME_LABEL, relTime } from '../lib/format.js';
import { RollingNumber } from './Motion.js';

export type QuickOutcome = 'no_answer' | 'rejected' | 'invited';

const OUTCOME_TONE: Record<string, string> = {
  rejected: 'text-[color:var(--error)]',
  invited: 'text-[color:var(--success)]',
  attended: 'text-[color:var(--success)]',
};

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
        : 'border-[var(--border)] bg-[var(--card)] text-[color:var(--foreground)] hover:bg-[var(--secondary)]';
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`touch-action h-7 shrink-0 cursor-pointer select-none whitespace-nowrap rounded-lg border px-2.5 text-[13px] font-medium transition-colors ${cls}`}
    >
      {label}
    </motion.button>
  );
}

export function QuickActions({ onQuick }: { onQuick: (o: QuickOutcome) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <QuickButton label="未接" tone="ghost" onClick={() => onQuick('no_answer')} />
      <QuickButton label="拒绝" tone="danger" onClick={() => onQuick('rejected')} />
      <QuickButton label="邀约 ✓" tone="primary" onClick={() => onQuick('invited')} />
    </div>
  );
}

export function CallSummary({ c }: { c: DeskCustomer }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="tnum whitespace-nowrap font-medium">
        <RollingNumber value={c.call_count} /> <span className="font-normal text-[color:var(--muted-foreground)]">次</span>
      </span>
      {c.last_call_at && c.last_call_outcome && (
        <span className="whitespace-nowrap text-[13px] text-[color:var(--muted-foreground)]">
          {relTime(c.last_call_at)} ·{' '}
          <span className={OUTCOME_TONE[c.last_call_outcome] ?? ''}>{OUTCOME_LABEL[c.last_call_outcome]}</span>
        </span>
      )}
      {c.ever_rejected && c.last_call_outcome !== 'rejected' && (
        <span className="whitespace-nowrap text-[13px] font-medium text-[color:var(--error)]">
          曾拒绝
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
          ? 'tnum inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 font-medium text-[color:var(--foreground)] transition-colors hover:bg-[var(--card)]'
          : 'tnum inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-3 text-[13px] font-medium text-[color:var(--foreground)] transition-colors active:scale-[0.97]'
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
}: {
  items: DeskCustomer[];
  loading: boolean;
  onOpen: (c: DeskCustomer) => void;
  onQuick: (c: DeskCustomer, o: QuickOutcome) => void;
  onDial: (c: DeskCustomer) => void;
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
        <caption className="sr-only">客户筛选与外呼列表</caption>
        <thead>
          <tr>
            <th scope="col">客户</th>
            <th scope="col" className="text-right">
              总保费
            </th>
            <th scope="col">居住地址</th>
            <th scope="col">拨号</th>
            <th scope="col">外呼记录</th>
            <th scope="col">速记</th>
          </tr>
        </thead>
        <tbody className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {items.map((c) => (
            <motion.tr
              key={c.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.16 }}
              onClick={() => onOpen(c)}
              className="cursor-pointer"
            >
              <td>
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
                <div className="text-[13px] text-[color:var(--muted-foreground)]">
                  {[c.gender !== '未知' ? c.gender : '', c.age != null ? `${c.age}岁` : ''].filter(Boolean).join(' · ') || '—'}
                </div>
              </td>
              <td className="text-right">
                <div className="tnum font-medium">{fmtMoney(c.total_premium)}</div>
                {c.policy_total > 0 && (
                  <div className="text-[13px] text-[color:var(--muted-foreground)]">{c.policy_total} 张保单</div>
                )}
              </td>
              <td className="max-w-[20rem]">
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
              <td>
                <QuickActions onQuick={(o) => onQuick(c, o)} />
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && !loading && (
        <div className="py-20 text-center text-[color:var(--muted-foreground)]">没有符合条件的客户，试试放宽筛选</div>
      )}
    </div>
  );
}
