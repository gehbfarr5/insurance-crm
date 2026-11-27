import { AnimatePresence, motion } from 'motion/react';
import { useId } from 'react';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-[var(--card-border)] bg-[var(--secondary)] p-0.5"
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
            className={`relative h-7 cursor-pointer rounded-[5px] px-2.5 text-[13px] transition-colors ${
              active ? 'font-medium text-[color:var(--foreground)]' : 'text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
            }`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-[5px] border border-[var(--card-border)] bg-[var(--card)] shadow-sm"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Slot-machine style number: old value slides out, new value slides in. */
export function RollingNumber({ value }: { value: number }) {
  return (
    <span className="tnum relative inline-flex h-[1.4em] items-center overflow-hidden align-middle">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: '90%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '-90%', opacity: 0 }}
          transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          className="inline-block"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
