export const btn =
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-[var(--border)] bg-[var(--card)] text-[13px] font-medium text-[color:var(--foreground)] hover:bg-[var(--secondary)] transition-colors cursor-pointer select-none disabled:opacity-50 disabled:cursor-not-allowed';

export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-transparent bg-[var(--primary)] text-[13px] font-medium text-[color:var(--primary-foreground)] hover:opacity-85 transition-opacity cursor-pointer select-none disabled:opacity-50 disabled:cursor-not-allowed';

export const inputCls =
  'h-8 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 text-[13px] text-[color:var(--foreground)] placeholder:text-[color:var(--muted-foreground)] outline-none transition-colors focus:border-[var(--foreground)]';

export const chipCls = (active: boolean) =>
  `h-6 px-2 rounded-full border text-[12px] cursor-pointer select-none transition-colors ${
    active
      ? 'border-transparent bg-[var(--primary)] text-[color:var(--primary-foreground)]'
      : 'border-[var(--card-border)] bg-[var(--secondary)] text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
  }`;
