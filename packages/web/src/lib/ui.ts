export const btn =
  'touch-action inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[13px] font-medium text-[color:var(--foreground)] shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] hover:bg-[var(--secondary)] active:scale-[0.98] transition-[background-color,border-color,transform] duration-150 cursor-pointer select-none disabled:opacity-45 disabled:cursor-not-allowed';

export const btnPrimary =
  'touch-action inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg border border-transparent bg-[var(--primary)] text-[13px] font-medium text-[color:var(--primary-foreground)] shadow-[0_1px_2px_0_rgb(0_0_0/0.08)] hover:opacity-90 active:scale-[0.98] transition-[opacity,transform] duration-150 cursor-pointer select-none disabled:opacity-45 disabled:cursor-not-allowed';

export const inputCls =
  'h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 text-[13px] text-[color:var(--foreground)] placeholder:text-[color:var(--muted-foreground)] outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-[color:var(--foreground)]/45 focus-visible:ring-[3px] focus-visible:ring-[var(--ring)]';

export const selectCls =
  'h-8 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-0 text-[13px] leading-8 text-[color:var(--foreground)] outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-[color:var(--foreground)]/45 focus-visible:ring-[3px] focus-visible:ring-[var(--ring)] cursor-pointer';

export const chipCls = (active: boolean) =>
  `touch-action inline-flex items-center h-7 px-3 rounded-full border text-[13px] cursor-pointer select-none transition-colors ${
    active
      ? 'border-transparent bg-[var(--primary)] text-[color:var(--primary-foreground)] font-medium'
      : 'border-[var(--card-border)] bg-[var(--secondary)] text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
  }`;
