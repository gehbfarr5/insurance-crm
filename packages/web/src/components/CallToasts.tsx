import { AnimatePresence, motion } from 'motion/react';
import { Undo2 } from 'lucide-react';
import { OUTCOME_LABEL } from '../lib/format.js';
import type { QuickOutcome } from './DeskTable.js';

export interface PendingView {
  key: string;
  name: string;
  outcome: QuickOutcome;
  note?: string;
}

export const PENDING_MS = 5000;
export const REJECT_REASONS = ['没空', '在外地', '暂不考虑', '不需要'] as const;

/** Bottom stack of just-logged calls with a short undo window (commit happens when the bar expires). */
export function CallToasts({
  pending,
  onUndo,
  onReason,
}: {
  pending: PendingView[];
  onUndo: (key: string) => void;
  onReason: (key: string, reason: string) => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {pending.map((p) => (
          <motion.div
            key={p.key}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="pointer-events-auto relative w-[min(30rem,92vw)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5">
              <span className="font-medium">
                {p.name} · {OUTCOME_LABEL[p.outcome]}
              </span>
              {p.note && <span className="text-[12px] text-[color:var(--muted-foreground)]">{p.note}</span>}
              {p.outcome === 'rejected' && (
                <span className="flex flex-wrap items-center gap-1">
                  {REJECT_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => onReason(p.key, r)}
                      className="h-6 cursor-pointer rounded-full border border-[var(--card-border)] bg-[var(--secondary)] px-2 text-[12px] text-[color:var(--muted-foreground)] transition-colors hover:text-[color:var(--foreground)]"
                    >
                      {r}
                    </button>
                  ))}
                </span>
              )}
              <button
                type="button"
                onClick={() => onUndo(p.key)}
                className="ml-auto inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12.5px] font-medium hover:bg-[var(--secondary)]"
              >
                <Undo2 className="size-3.5" />
                撤销
              </button>
            </div>
            <motion.div
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: PENDING_MS / 1000, ease: 'linear' }}
              className="h-0.5 origin-left bg-[var(--foreground)] opacity-70"
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
