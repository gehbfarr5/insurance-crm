import { MotionConfig, motion } from 'motion/react';
import { EASE_OUT } from './components/Motion.js';
import { LogOut, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiUnauthorizedError,
  type DashboardResponse,
  type SyncStatusResponse,
  api,
  clearBearerToken,
  getBearerToken,
  setBearerToken,
} from './api.js';
import { BottomToastHost } from './components/BottomToastHost.js';
import { DeskPage } from './components/DeskPage.js';
import { KjgxCapsule, KjgxPanel } from './components/KjgxPanel.js';
import { SyncPage } from './components/SyncPage.js';
import { useKjgxConnection } from './lib/kjgx.js';
import { useScheme } from './lib/theme.js';
import { pushToast } from './lib/toast-bus.js';
import { btnPrimary, inputCls } from './lib/ui.js';

type Page = 'desk' | 'sync';

export function App() {
  const { scheme, toggle } = useScheme();
  const [auth, setAuth] = useState<'checking' | 'ok' | 'required'>('checking');
  const [page, setPage] = useState<Page>('desk');
  const [syncMounted, setSyncMounted] = useState(false);
  const [stats, setStats] = useState<DashboardResponse['stats'] | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [kjgxOpen, setKjgxOpen] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const toast = useCallback((text: string) => {
    pushToast({ text, durationMs: 3200 });
  }, []);
  const onUnauthorized = useCallback(() => setAuth('required'), []);

  const refreshMeta = useCallback(async () => {
    try {
      const [d, st] = await Promise.all([api.getDashboard(), api.getSyncStatus().catch(() => null)]);
      setStats(d.stats);
      if (st) setSyncStatus(st);
      setAuth('ok');
    } catch (err) {
      if (err instanceof ApiUnauthorizedError) setAuth('required');
      else setAuth((prev) => (prev === 'checking' ? 'ok' : prev));
    }
  }, []);

  useEffect(() => {
    void refreshMeta();
    const t = window.setInterval(() => void refreshMeta(), 60_000);
    return () => window.clearInterval(t);
  }, [refreshMeta]);

  const kjgx = useKjgxConnection(auth === 'ok');

  const goto = (p: Page) => {
    setPage(p);
    if (p === 'sync') setSyncMounted(true);
  };

  if (auth === 'required') {
    return (
      <main className="grid min-h-dvh place-items-center bg-[var(--background)] p-4">
        <form
          className="w-full max-w-sm space-y-4 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            setBearerToken(loginToken);
            try {
              await api.getDashboard();
              setLoginToken('');
              setLoginError(null);
              setAuth('ok');
              void refreshMeta();
            } catch (err) {
              clearBearerToken();
              setLoginError(err instanceof Error ? err.message : '认证失败，请核对密钥');
            }
          }}
        >
          <div>
            <h1 className="text-[16px] font-semibold">保顾 CRM</h1>
            <p className="text-[13px] text-[color:var(--muted-foreground)]">输入访问密钥，仅保存在当前浏览器</p>
          </div>
          {loginError && (
            <div role="alert" className="text-[color:var(--error)]">
              {loginError}
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-[13px] text-[color:var(--muted-foreground)]">访问密钥</span>
            <input
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
              className={`${inputCls} w-full`}
            />
          </label>
          <button type="submit" className={`${btnPrimary} w-full`}>
            进入
          </button>
        </form>
      </main>
    );
  }

  const pendingCount = (stats?.pending_kjgx_jobs ?? 0) + (stats?.open_conflicts ?? 0);
  const NAV: ReadonlyArray<{ id: Page; label: string }> = [
    { id: 'desk', label: '筛客外呼' },
    { id: 'sync', label: '同步与回写' },
  ];

  return (
    <MotionConfig reducedMotion="user">
      <header className="sticky top-0 z-40 flex h-12 items-center justify-between gap-2 border-b border-[var(--card-border)] bg-[color-mix(in_srgb,var(--surface-elevated)_92%,transparent)] px-3.5 backdrop-blur md:gap-4 md:px-6">
        <div className="flex h-full min-w-0 items-center gap-3 md:gap-8">
          <span className="shrink-0 whitespace-nowrap text-[16px] font-semibold tracking-tight">保顾 CRM</span>
          <nav aria-label="主导航" className="flex h-full items-center gap-0.5 md:gap-1">
            {NAV.map((n) => (
              <button
                key={n.id}
                type="button"
                aria-current={page === n.id ? 'page' : undefined}
                onClick={() => goto(n.id)}
                className={`relative flex h-full shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-2 text-[13px] transition-colors md:px-3 ${
                  page === n.id
                    ? 'font-medium text-[color:var(--foreground)]'
                    : 'text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
                }`}
              >
                {n.label}
                {n.id === 'sync' && pendingCount > 0 && (
                  <span className="tnum inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-[var(--primary-soft-border)] bg-[var(--primary-soft-bg)] px-1.5 text-[13px] font-medium text-[color:var(--primary-soft-fg)]">
                    {pendingCount}
                  </span>
                )}
                {page === n.id && (
                  <motion.span
                    layoutId="nav-underline"
                    className="absolute inset-x-1.5 bottom-0 h-0.5 bg-[var(--primary)] md:inset-x-2"
                    transition={{ duration: 0.16, ease: EASE_OUT }}
                  />
                )}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
          <KjgxCapsule state={kjgx.state} status={kjgx.status} onClick={() => setKjgxOpen(true)} />
          <button
            type="button"
            onClick={toggle}
            aria-label={scheme === 'dark' ? '切换到浅色' : '切换到深色'}
            className="touch-icon-hit grid size-8 cursor-pointer place-items-center rounded-md border border-[var(--btn-border)] bg-[var(--btn-bg)] text-[color:var(--btn-fg)] transition-colors duration-120 hover:bg-[var(--btn-hover)] hover:text-[color:var(--foreground)]"
          >
            {scheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          {getBearerToken() && (
            <button
              type="button"
              onClick={() => {
                clearBearerToken();
                setAuth('required');
              }}
              aria-label="退出登录"
              title="退出登录"
              className="touch-icon-hit grid size-8 cursor-pointer place-items-center rounded-md border border-[var(--btn-border)] bg-[var(--btn-bg)] text-[color:var(--btn-fg)] transition-colors duration-120 hover:bg-[var(--btn-hover)] hover:text-[color:var(--foreground)]"
            >
              <LogOut className="size-4" />
            </button>
          )}
        </div>
      </header>

      <main>
        <div hidden={page !== 'desk'}>
          {auth === 'ok' && <DeskPage syncStatus={syncStatus} onToast={toast} onUnauthorized={onUnauthorized} />}
        </div>
        {syncMounted && (
          <div hidden={page !== 'sync'}>
            <SyncPage sync={syncStatus} onToast={toast} onChanged={() => void refreshMeta()} />
          </div>
        )}
      </main>

      <KjgxPanel
        open={kjgxOpen}
        onClose={() => setKjgxOpen(false)}
        state={kjgx.state}
        status={kjgx.status}
        check={kjgx.check}
        onToast={toast}
      />

      <BottomToastHost />
    </MotionConfig>
  );
}
