import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useId } from 'react';

/** Restrained productivity easing curve: crisp deceleration, zero bounce. */
export const EASE_OUT = [0.2, 0, 0, 1] as const;
export const T_FAST = 0.12;
export const T_UI = 0.18;

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  onChange: (v: T) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center rounded-md border border-[var(--card-border)] bg-[var(--surface-subtle)] p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] whitespace-nowrap transition-colors duration-120 ease-[cubic-bezier(0.2,0,0,1)] ${
              active ? 'font-medium text-[color:var(--foreground)]' : 'text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
            }`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-[5px] border border-[var(--card-border)] bg-[var(--card)]"
                transition={{ duration: 0.16, ease: EASE_OUT }}
              />
            )}
            <span className="relative">{o.label}</span>
            {o.count !== undefined && (
              <span
                className={`tnum relative rounded px-1 text-[13px] leading-4 ${
                  active
                    ? 'bg-[var(--secondary)] text-[color:var(--foreground)]'
                    : 'text-[color:var(--muted-foreground)]'
                }`}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Calm numeric update without bouncy slot-machine overshoots. */
export function RollingNumber({ value }: { value: number }) {
  return (
    <span className="tnum relative inline-flex items-center align-middle">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: 3, opacity: 0.45 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -3, opacity: 0 }}
          transition={{ duration: 0.14, ease: EASE_OUT }}
          className="inline-block"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** Smooth 180ms collapsible region for filter drawers and secondary panels. */
export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: T_UI, ease: EASE_OUT }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
