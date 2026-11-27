import type { DeskCustomer } from '@insurance-crm/shared';
import { AnimatePresence, motion } from 'motion/react';
import { Phone, Undo2, X } from 'lucide-react';
import { useRef } from 'react';
import { OUTCOME_LABEL } from '../lib/format.js';
import { useTopLayerPopover } from '../lib/top-layer.js';
import { QuickActions, type QuickOutcome } from './DeskTable.js';

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
 * Top-layer `popover="manual"` stack for just-logged calls (5s undo) and post-call return prompts.
 * Always floats above any open modal dialog or bottom-sheet drawer.
 */
export function CallToasts({
  pending,
  dialPrompt,
  onDialResult,
  onDismissDialPrompt,
  onUndo,
  onReason,
  onHover,
}: {
  pending: PendingView[];
  dialPrompt: DeskCustomer | null;
  onDialResult: (c: DeskCustomer, outcome: QuickOutcome) => void;
  onDismissDialPrompt: () => void;
  onUndo: (key: string) => void;
  onReason: (key: string, reason: string) => void;
  onHover: (key: string, hovered: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = pending.length > 0 || Boolean(dialPrompt);
  useTopLayerPopover(ref, active, `${dialPrompt?.id ?? ''}:${pending.map((p) => p.key).join(',')}`);

  return (
    <div
      ref={ref}
      popover="manual"
      className="top-toast-layer pointer-events-none fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] flex flex-col items-center gap-2 px-3"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {dialPrompt && (
          <motion.div
            key={`dial-${dialPrompt.id}`}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="pointer-events-auto flex w-[min(32rem,100%)] flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.24)]"
          >
            <div className="flex items-center gap-2 text-[13px]">
              <Phone className="size-3.5 text-[color:var(--muted-foreground)]" aria-hidden="true" />
              <span>
                刚联系了 <strong>{dialPrompt.name}</strong>？
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <QuickActions onQuick={(o) => onDialResult(dialPrompt, o)} />
              <button
                type="button"
                onClick={onDismissDialPrompt}
                aria-label="忽略"
                className="grid size-7 cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] hover:bg-[var(--secondary)]"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </motion.div>
        )}

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
            className="pointer-events-auto relative w-[min(30rem,100%)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.22)]"
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
