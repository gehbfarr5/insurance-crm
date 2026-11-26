import { useEffect, type RefObject } from 'react';

export const TOP_LAYER_EVENT = 'crm:top-layer-changed';

export function notifyTopLayerChanged() {
  window.dispatchEvent(new CustomEvent(TOP_LAYER_EVENT));
}

/**
 * Promotes a `popover="manual"` container into the browser's Top Layer whenever `active` is true,
 * and re-promotes it on `TOP_LAYER_EVENT` so toasts always stack ABOVE any open modal <dialog>.
 */
export function useTopLayerPopover(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  promoteSignal?: unknown,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.showPopover !== 'function') return;

    const sync = () => {
      try {
        if (active) {
          if (el.matches(':popover-open')) el.hidePopover();
          el.showPopover();
        } else if (el.matches(':popover-open')) {
          el.hidePopover();
        }
      } catch {
        // Ignore if element is detached or browser rejects popover state transition
      }
    };

    sync();
    if (!active) return;

    const onLayerChange = () => sync();
    window.addEventListener(TOP_LAYER_EVENT, onLayerChange);
    return () => window.removeEventListener(TOP_LAYER_EVENT, onLayerChange);
  }, [ref, active, promoteSignal]);
}
