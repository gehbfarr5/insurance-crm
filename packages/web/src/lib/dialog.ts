import { useCallback, useEffect, useRef } from 'react';
import { notifyTopLayerChanged } from './top-layer.js';

let supportsDisplayTransition: boolean | undefined;

function canTransitionDisplay(): boolean {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) return false;
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit(): boolean {
  return Boolean(window.CSS?.supports?.('overlay', 'auto')) && canTransitionDisplay();
}

/** Closes a modal dialog after its exit transition (with a data-closing fallback for Firefox/Safari). */
export async function closeTopLayer(el: HTMLDialogElement): Promise<void> {
  if (!el.open) return;
  if (!supportsTopLayerExit()) {
    el.setAttribute('data-closing', '');
    const animations = el.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 600)),
      ]);
    } else {
      await new Promise((r) => setTimeout(r, 220));
    }
    if (!el.hasAttribute('data-closing')) return;
    el.removeAttribute('data-closing');
  }
  el.close();
}

/** Syncs a controlled `open` flag with a native modal <dialog>, routing Esc / backdrop clicks through closeTopLayer. */
export function useDialogControl(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      notifyTopLayerChanged();
    } else if (!open && d.open) {
      void closeTopLayer(d);
    }
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      if (e.cancelable) {
        e.preventDefault();
        void closeTopLayer(d);
      }
    };
    const onNativeClose = () => onCloseRef.current();
    const onClick = (e: MouseEvent) => {
      if (e.target === d) void closeTopLayer(d);
    };
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onNativeClose);
    d.addEventListener('click', onClick);
    return () => {
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onNativeClose);
      d.removeEventListener('click', onClick);
    };
  }, []);

  const close = useCallback(() => {
    const d = ref.current;
    if (d) void closeTopLayer(d);
  }, []);

  return { ref, close };
}
