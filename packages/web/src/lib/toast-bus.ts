import type { DeskCustomer } from '@insurance-crm/shared';
import type { QuickOutcome } from '../components/DeskTable.js';

export interface ToastEntry {
  id: string;
  text: string;
  note?: string;
  durationMs: number;
  paused: boolean;
  undoLabel?: string;
  onUndo?: () => void;
  reasonChips?: readonly string[];
  onReason?: (reason: string) => void;
  onExpire?: () => void;
  dialCustomer?: DeskCustomer;
  onDialResult?: (c: DeskCustomer, o: QuickOutcome) => void;
}

type Listener = (items: ToastEntry[]) => void;

const entries = new Map<string, ToastEntry>();
const timers = new Map<string, number>();
const listeners = new Set<Listener>();

function emit() {
  const snap = Array.from(entries.values());
  for (const l of listeners) l(snap);
}

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t !== undefined) {
    window.clearTimeout(t);
    timers.delete(id);
  }
}

function startTimer(id: string, ms: number) {
  clearTimer(id);
  if (ms <= 0) return;
  const t = window.setTimeout(() => {
    const item = entries.get(id);
    if (!item) return;
    entries.delete(id);
    timers.delete(id);
    emit();
    item.onExpire?.();
  }, ms);
  timers.set(id, t);
}

export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn);
  fn(Array.from(entries.values()));
  return () => listeners.delete(fn);
}

export function pushToast(
  opts: Omit<ToastEntry, 'id' | 'paused' | 'durationMs'> & { id?: string; durationMs?: number },
): string {
  const id = opts.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (entries.has(id)) clearTimer(id);
  const durationMs = opts.durationMs ?? 3500;
  const entry: ToastEntry = { ...opts, id, durationMs, paused: false };
  entries.set(id, entry);
  emit();
  if (durationMs > 0) startTimer(id, durationMs);
  return id;
}

export function undoToast(id: string) {
  const item = entries.get(id);
  if (!item) return;
  clearTimer(id);
  entries.delete(id);
  emit();
  item.onUndo?.();
}

export function dismissToast(id: string) {
  clearTimer(id);
  entries.delete(id);
  emit();
}

export function chooseToastReason(id: string, reason: string) {
  const item = entries.get(id);
  if (!item) return;
  clearTimer(id);
  entries.delete(id);
  emit();
  item.onReason?.(reason);
}

export function chooseDialResult(id: string, outcome: QuickOutcome) {
  const item = entries.get(id);
  if (!item || !item.dialCustomer) return;
  const cust = item.dialCustomer;
  const cb = item.onDialResult;
  clearTimer(id);
  entries.delete(id);
  emit();
  cb?.(cust, outcome);
}

export function hoverToast(id: string, hovered: boolean) {
  const item = entries.get(id);
  if (!item || item.durationMs <= 0) return;
  item.paused = hovered;
  if (hovered) clearTimer(id);
  else startTimer(id, item.durationMs);
  emit();
}

export function flushPendingToasts() {
  for (const [id, item] of entries.entries()) {
    clearTimer(id);
    entries.delete(id);
    item.onExpire?.();
  }
  emit();
}
