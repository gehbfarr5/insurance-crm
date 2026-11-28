import { AnimatePresence, motion } from 'motion/react';
import { Phone, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  chooseDialResult,
  chooseToastReason,
  dismissToast,
  flushPendingToasts,
  hoverToast,
  subscribeToasts,
  type ToastEntry,
  undoToast,
} from '../lib/toast-bus.js';
import { TOP_LAYER_EVENT, useTopLayerPopover } from '../lib/top-layer.js';
import { QuickActions } from './DeskTable.js';

function resolveTopLayerTarget(): HTMLElement {
  const modals = document.querySelectorAll('dialog:modal');
  const open = modals.length > 0 ? modals : document.querySelectorAll('dialog[open]');
  return (open[open.length - 1] as HTMLElement | undefined) ?? document.body;
}

/**
 * Single unified bottom Top-Layer toast stack (`popover="manual"`).
 * Portals into the active modal <dialog> when one is open (so it is never marked `inert`),
 * and renders centered at the bottom above every dialog/drawer.
 */
export function BottomToastHost() {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const [portalTarget, setPortalTarget] = useState<HTMLElement>(() =>
    typeof document !== 'undefined' ? resolveTopLayerTarget() : (null as unknown as HTMLElement),
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeToasts(setItems), []);

  useEffect(() => {
    const syncTarget = () => setPortalTarget(resolveTopLayerTarget());
    syncTarget();
    window.addEventListener(TOP_LAYER_EVENT, syncTarget);
    return () => window.removeEventListener(TOP_LAYER_EVENT, syncTarget);
  }, [items.length]);

  useEffect(() => {
    const onHide = () => flushPendingToasts();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  useTopLayerPopover(ref, items.length > 0, `${items.map((i) => i.id).join(',')}:${portalTarget?.tagName ?? ''}`);

  if (!portalTarget) return null;

  return createPortal(
    <div
      ref={ref}
      popover="manual"
      role="region"
      aria-label="操作提示"
      className="top-toast-layer pointer-events-none fixed inset-x-0 flex flex-col items-center gap-2 px-3"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {items.map((it) => (
          <motion.div
            key={it.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            onMouseEnter={() => hoverToast(it.id, true)}
            onMouseLeave={() => hoverToast(it.id, false)}
            onFocus={() => hoverToast(it.id, true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) hoverToast(it.id, false);
            }}
            className="pointer-events-auto relative mx-auto w-[min(32rem,100%)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.24)]"
          >
            {it.dialCustomer ? (
              <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                <div className="flex items-center gap-2 text-[13px]">
                  <Phone className="size-3.5 text-[color:var(--muted-foreground)]" aria-hidden="true" />
                  <span>
                    刚联系了 <strong>{it.dialCustomer.name}</strong>？
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <QuickActions onQuick={(o) => chooseDialResult(it.id, o)} />
                  <button
                    type="button"
                    onClick={() => dismissToast(it.id)}
                    aria-label="忽略"
                    className="touch-icon-hit grid size-7 cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] hover:bg-[var(--secondary)]"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5">
                <span className="font-medium text-[color:var(--foreground)]">{it.text}</span>
                {it.note && <span className="text-[13px] text-[color:var(--muted-foreground)]">{it.note}</span>}
                {it.reasonChips && (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {it.reasonChips.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => chooseToastReason(it.id, r)}
                        className="touch-action h-7 cursor-pointer rounded-full border border-[var(--btn-border)] bg-[var(--btn-bg)] px-3 text-[13px] text-[color:var(--btn-fg)] transition-colors hover:bg-[var(--btn-hover)] hover:text-[color:var(--foreground)]"
                      >
                        {r}
                      </button>
                    ))}
                  </span>
                )}
                {it.onUndo && (
                  <button
                    type="button"
                    onClick={() => undoToast(it.id)}
                    className="touch-action ml-auto inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-[13px] font-medium text-[color:var(--primary-soft-fg)] hover:bg-[var(--primary-soft-bg)]"
                  >
                    <Undo2 className="size-3.5" />
                    {it.undoLabel ?? '撤销'}
                  </button>
                )}
              </div>
            )}

            {it.durationMs > 0 && (it.onUndo || it.reasonChips) && (
              <motion.div
                initial={{ scaleX: 1 }}
                animate={{ scaleX: it.paused ? 1 : 0 }}
                transition={{ duration: it.paused ? 0.15 : it.durationMs / 1000, ease: 'linear' }}
                className={`h-0.5 origin-left bg-[var(--primary)] ${it.paused ? 'opacity-20' : 'opacity-60'}`}
              />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    portalTarget,
  );
}
