export const btn =
  'touch-action inline-flex items-center justify-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--border)] bg-[var(--card)] text-[13px] font-medium text-[color:var(--foreground)] hover:bg-[var(--hover)] transition-[background-color,border-color,color] duration-120 ease-[cubic-bezier(0.2,0,0,1)] cursor-pointer select-none disabled:opacity-45 disabled:cursor-not-allowed';

export const btnPrimary =
  'touch-action inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-transparent bg-[var(--primary)] text-[13px] font-medium text-[color:var(--primary-foreground)] hover:opacity-90 transition-[opacity,background-color] duration-120 ease-[cubic-bezier(0.2,0,0,1)] cursor-pointer select-none disabled:opacity-45 disabled:cursor-not-allowed';

export const btnGhost =
  'touch-action inline-flex items-center justify-center gap-1.5 h-7 px-2 rounded-md border border-transparent bg-transparent text-[13px] font-medium text-[color:var(--muted-foreground)] hover:bg-[var(--hover)] hover:text-[color:var(--foreground)] transition-[background-color,color] duration-120 ease-[cubic-bezier(0.2,0,0,1)] cursor-pointer select-none disabled:opacity-45 disabled:cursor-not-allowed';

export const inputCls =
  'h-8 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 text-[13px] text-[color:var(--foreground)] placeholder:text-[color:var(--muted-foreground)] outline-none transition-[border-color,box-shadow] duration-120 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:border-[color:var(--foreground)]/45 focus-visible:ring-[3px] focus-visible:ring-[var(--ring)]';

export const selectCls =
  'h-8 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-0 text-[13px] leading-8 text-[color:var(--foreground)] outline-none transition-[border-color,box-shadow] duration-120 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:border-[color:var(--foreground)]/45 focus-visible:ring-[3px] focus-visible:ring-[var(--ring)] cursor-pointer';

export const chipCls = (active: boolean) =>
  `touch-action inline-flex items-center h-7 px-2.5 rounded-md border text-[13px] cursor-pointer select-none transition-[background-color,border-color,color] duration-120 ease-[cubic-bezier(0.2,0,0,1)] ${
    active
      ? 'border-transparent bg-[var(--primary)] text-[color:var(--primary-foreground)] font-medium'
      : 'border-[var(--card-border)] bg-[var(--secondary)] text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
  }`;

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-[var(--card-border)] bg-[var(--secondary)] text-[color:var(--secondary-foreground)]',
  success: 'border-[var(--success-border)] bg-[var(--success-bg)] text-[color:var(--success)]',
  warning: 'border-[var(--warning-border)] bg-[var(--warning-bg)] text-[color:var(--warning)]',
  error: 'border-[var(--error-border)] bg-[var(--error-bg)] text-[color:var(--error)]',
  info: 'border-[var(--info-border)] bg-[var(--info-bg)] text-[color:var(--info)]',
};

export function badgeCls(tone: BadgeTone = 'neutral'): string {
  return `inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[13px] font-medium leading-tight whitespace-nowrap ${BADGE_TONES[tone]}`;
}
