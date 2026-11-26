import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { LogOut, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiUnauthorizedError,
  type DashboardResponse,
  type SyncStatusResponse,
  api,
  clearBearerToken,
  getBearerToken,
  setBearerToken,
} from './api.js';
import { DeskPage } from './components/DeskPage.js';
import { KjgxCapsule, KjgxPanel } from './components/KjgxPanel.js';
import { SyncPage } from './components/SyncPage.js';
import { useKjgxConnection } from './lib/kjgx.js';
import { useScheme } from './lib/theme.js';
import { useTopLayerPopover } from './lib/top-layer.js';
import { btnPrimary, inputCls } from './lib/ui.js';

type Page = 'desk' | 'sync';

export function App() {
  const { scheme, toggle } = useScheme();
  const [auth, setAuth] = useState<'checking' | 'ok' | 'required'>('checking');
  const [page, setPage] = useState<Page>('desk');
  const [syncMounted, setSyncMounted] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ id: number; text: string } | null>(null);
  const [stats, setStats] = useState<DashboardResponse['stats'] | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [kjgxOpen, setKjgxOpen] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);

  const toast = useCallback((text: string) => setToastMsg({ id: Date.now(), text }), []);
  const onUnauthorized = useCallback(() => setAuth('required'), []);
  useTopLayerPopover(toastRef, Boolean(toastMsg), toastMsg?.id);

  useEffect(() => {
    if (!toastMsg) return;
    const t = window.setTimeout(() => setToastMsg(null), 3200);
    return () => window.clearTimeout(t);
  }, [toastMsg]);

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
            <p className="text-[12.5px] text-[color:var(--muted-foreground)]">输入访问密钥，仅保存在当前浏览器</p>
          </div>
          {loginError && (
            <div role="alert" className="text-[color:var(--error)]">
              {loginError}
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-[12px] text-[color:var(--muted-foreground)]">访问密钥</span>
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
      <header className="sticky top-0 z-40 flex h-12 items-center justify-between gap-4 border-b border-[var(--card-border)] bg-[color-mix(in_srgb,var(--card)_88%,transparent)] px-6 backdrop-blur">
        <div className="flex h-full items-center gap-8">
          <span className="text-[14px] font-semibold tracking-tight">保顾 CRM</span>
          <nav aria-label="主导航" className="flex h-full items-center gap-1">
            {NAV.map((n) => (
              <button
                key={n.id}
                type="button"
                aria-current={page === n.id ? 'page' : undefined}
                onClick={() => goto(n.id)}
                className={`relative flex h-full cursor-pointer items-center gap-1.5 px-3 text-[13px] transition-colors ${
                  page === n.id ? 'font-medium text-[color:var(--foreground)]' : 'text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
                }`}
              >
                {n.label}
                {n.id === 'sync' && pendingCount > 0 && (
                  <span className="tnum rounded-full bg-[var(--primary)] px-1.5 text-[11px] text-[color:var(--primary-foreground)]">
                    {pendingCount}
                  </span>
                )}
                {page === n.id && (
                  <motion.span
                    layoutId="nav-underline"
                    className="absolute inset-x-2 bottom-0 h-0.5 bg-[var(--foreground)]"
                    transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                  />
                )}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <KjgxCapsule state={kjgx.state} status={kjgx.status} onClick={() => setKjgxOpen(true)} />
          <button
            type="button"
            onClick={toggle}
            aria-label={scheme === 'dark' ? '切换到浅色' : '切换到深色'}
            className="grid size-8 cursor-pointer place-items-center rounded-md border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--secondary)]"
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
              className="grid size-8 cursor-pointer place-items-center rounded-md border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--secondary)]"
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

      <div
        ref={toastRef}
        popover="manual"
        className="top-toast-layer pointer-events-none fixed inset-x-0 top-14 flex justify-center"
        aria-live="polite"
      >
        <AnimatePresence>
          {toastMsg && (
            <motion.div
              key={toastMsg.id}
              initial={{ opacity: 0, y: -10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 460, damping: 34 }}
              className="pointer-events-auto max-w-[min(34rem,92vw)] rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-[color:var(--foreground)] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.22)]"
            >
              {toastMsg.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
