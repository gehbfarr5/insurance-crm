import { AnimatePresence, motion } from 'motion/react';
import { Undo2 } from 'lucide-react';
import { useRef } from 'react';
import { OUTCOME_LABEL } from '../lib/format.js';
import { useTopLayerPopover } from '../lib/top-layer.js';
import type { QuickOutcome } from './DeskTable.js';

export interface PendingView {
  key: string;
  name: string;
  outcome: QuickOutcome;
  note?: string;
  paused?: boolean;
}

export const PENDING_MS = 5000;
export const REJECT_REASONS = ['没空', '在外地', '暂不考虑', '不需要'] as const;

/**
 * Top-layer `popover="manual"` stack of just-logged calls with a 5s undo window.
 * Always floats above any open modal dialog or drawer, and pauses on hover.
 */
export function CallToasts({
  pending,
  onUndo,
  onReason,
  onHover,
}: {
  pending: PendingView[];
  onUndo: (key: string) => void;
  onReason: (key: string, reason: string) => void;
  onHover: (key: string, hovered: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useTopLayerPopover(ref, pending.length > 0, pending.map((p) => p.key).join(','));

  return (
    <div
      ref={ref}
      popover="manual"
      className="top-toast-layer pointer-events-none fixed inset-x-0 bottom-5 flex flex-col items-center gap-2"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {pending.map((p) => (
          <motion.div
            key={p.key}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            onMouseEnter={() => onHover(p.key, true)}
            onMouseLeave={() => onHover(p.key, false)}
            className="pointer-events-auto relative w-[min(30rem,92vw)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.22)]"
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
                      className="h-6 cursor-pointer rounded-full border border-[var(--card-border)] bg-[var(--secondary)] px-2.5 text-[12px] text-[color:var(--muted-foreground)] transition-colors hover:text-[color:var(--foreground)]"
                    >
                      {r}
                    </button>
                  ))}
                </span>
              )}
              <button
                type="button"
                onClick={() => onUndo(p.key)}
                className="ml-auto inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-[color:var(--foreground)] hover:bg-[var(--secondary)]"
              >
                <Undo2 className="size-3.5" />
                撤销
              </button>
            </div>
            {!p.paused && (
              <motion.div
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: PENDING_MS / 1000, ease: 'linear' }}
                className="h-0.5 origin-left bg-[var(--foreground)] opacity-60"
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
