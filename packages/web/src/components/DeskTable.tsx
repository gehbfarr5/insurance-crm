import type { DeskCustomer } from '@insurance-crm/shared';
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
      ? 'border-transparent bg-[var(--primary)] text-[color:var(--primary-foreground)] hover:opacity-85'
      : tone === 'danger'
        ? 'border-[var(--border)] bg-[var(--card)] text-[color:var(--foreground)] hover:border-[var(--error)] hover:text-[color:var(--error)]'
        : 'border-[var(--border)] bg-[var(--card)] text-[color:var(--foreground)] hover:bg-[var(--secondary)]';
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`h-7 cursor-pointer select-none rounded-md border px-2.5 text-[12.5px] font-medium transition-colors ${cls}`}
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
    <div className="flex items-center gap-2 whitespace-nowrap">
      <span className="tnum font-medium">
        <RollingNumber value={c.call_count} /> <span className="font-normal text-[color:var(--muted-foreground)]">次</span>
      </span>
      {c.last_call_at && c.last_call_outcome && (
        <span className="text-[12px] text-[color:var(--muted-foreground)]">
          {relTime(c.last_call_at)} ·{' '}
          <span className={OUTCOME_TONE[c.last_call_outcome] ?? ''}>{OUTCOME_LABEL[c.last_call_outcome]}</span>
        </span>
      )}
      {c.ever_rejected && c.last_call_outcome !== 'rejected' && (
        <span className="rounded-full border border-[var(--card-border)] px-1.5 text-[11px] text-[color:var(--error)]">曾拒绝</span>
      )}
    </div>
  );
}

export function DeskTable({
  items,
  loading,
  onOpen,
  onQuick,
  onCopyPhone,
}: {
  items: DeskCustomer[];
  loading: boolean;
  onOpen: (c: DeskCustomer) => void;
  onQuick: (c: DeskCustomer, o: QuickOutcome) => void;
  onCopyPhone: (c: DeskCustomer) => void;
}) {
  return (
    <div className="desk-scroll min-h-0 flex-1" aria-busy={loading}>
      <table className="desk-table">
        <caption className="sr-only">客户筛选与外呼列表</caption>
        <thead>
          <tr>
            <th scope="col">客户</th>
            <th scope="col" className="text-right">
              总保费
            </th>
            <th scope="col">居住地址</th>
            <th scope="col">手机号</th>
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
                <div className="text-[12px] text-[color:var(--muted-foreground)]">
                  {[c.gender !== '未知' ? c.gender : '', c.age != null ? `${c.age}岁` : ''].filter(Boolean).join(' · ') || '—'}
                </div>
              </td>
              <td className="text-right">
                <div className="tnum font-medium">{fmtMoney(c.total_premium)}</div>
                {c.policy_total > 0 && (
                  <div className="text-[12px] text-[color:var(--muted-foreground)]">{c.policy_total} 张保单</div>
                )}
              </td>
              <td className="max-w-[20rem]">
                <div className="truncate" title={c.address ?? undefined}>
                  {c.address ?? <span className="text-[color:var(--muted-foreground)]">—</span>}
                </div>
              </td>
              <td>
                {c.primary_phone ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopyPhone(c);
                    }}
                    title="点击复制"
                    className="tnum cursor-pointer rounded px-1 py-0.5 hover:bg-[var(--card)]"
                  >
                    {c.primary_phone}
                  </button>
                ) : (
                  <span className="text-[color:var(--muted-foreground)]">—</span>
                )}
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
