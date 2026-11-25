import type {
  Customer,
  ImportStagingItem,
  KjgxWritebackJob,
  SyncConflict,
} from '@insurance-crm/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiUnauthorizedError,
  type CampaignWithMembers,
  type Customer360Response,
  type DashboardResponse,
  type IcloudPreviewItem,
  type KjgxWorkerStatusResponse,
  type SyncStatusResponse,
  api,
  clearBearerToken,
  getBearerToken,
  setBearerToken,
} from './api.js';
import { EditCustomerDialog } from './components/EditCustomerDialog.js';
import { KjgxLoginDialog } from './components/KjgxLoginDialog.js';
import { LogInteractionDialog } from './components/LogInteractionDialog.js';

type NavTab = 'workbench' | 'customers' | 'detail' | 'sync' | 'staging';
type DetailTab = 'overview' | 'interactions' | 'followups' | 'sync';

const RAPPORT_LABELS: Record<Customer['rapport_tag'], string> = {
  friendly: '沟通顺畅 / 和气',
  neutral: '中性待观察',
  cautious: '表达强势 / 需留心',
  paused: '暂缓投入',
  unassessed: '尚未评估',
};

const STAGE_LABELS: Record<string, string> = {
  imported: '待初筛',
  screened_in: '一轮筛入',
  screened_out: '一轮筛出',
  invited: '已约上平台会',
  attended: '已到场(二轮)',
  round2_qualified: '二轮锁定',
  nurture: '长期培育',
  closed: '暂结束',
};

function fmtRMB(val: number | null | undefined): string {
  if (val == null) return '-';
  return `¥ ${Number(val).toLocaleString('zh-CN')}`;
}

export function App() {
  const [nav, setNav] = useState<NavTab>('workbench');
  const [mobileMode, setMobileMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [totalCustomers, setTotalCustomers] = useState(0);
  const [campaigns, setCampaigns] = useState<CampaignWithMembers[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [detail, setDetail] = useState<Customer360Response | null>(null);
  const [kjgxJobs, setKjgxJobs] = useState<KjgxWritebackJob[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [staging, setStaging] = useState<ImportStagingItem[]>([]);
  const [icloudPreview, setIcloudPreview] = useState<IcloudPreviewItem[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewQuery, setPreviewQuery] = useState('');
  const [previewPreset, setPreviewPreset] = useState<'hnw' | 'summary' | 'phone' | 'all'>('hnw');
  const [previewLimit, setPreviewLimit] = useState<10 | 20 | 50>(10);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
  const [workerStatus, setWorkerStatus] = useState<KjgxWorkerStatusResponse | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterChip, setFilterChip] = useState<'all' | 'hnw' | 'orphan' | 'quality'>('all');

  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [logTarget, setLogTarget] = useState<Customer | null>(null);
  const [kjgxLoginOpen, setKjgxLoginOpen] = useState(false);
  const [kjgxBusy, setKjgxBusy] = useState(false);

  const tablistRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef<Record<DetailTab, HTMLDivElement | null>>({
    overview: null,
    interactions: null,
    followups: null,
    sync: null,
  });

  const refreshAll = useCallback(async () => {
    const [dash, custRes, camps, jobs, cfs, stg, st, wk] = await Promise.all([
      api.getDashboard(),
      api.searchCustomers({
        query: searchQuery || undefined,
        min_premium: filterChip === 'hnw' ? 100000 : undefined,
        has_quality_flag: filterChip === 'quality' ? true : undefined,
      }),
      api.getCampaigns(),
      api.getKjgxJobs(),
      api.getConflicts(),
      api.getStaging(),
      api.getSyncStatus().catch(() => null),
      api.getKjgxWorkerStatus().catch(() => null),
    ]);
    setDashboard(dash);
    const list = filterChip === 'orphan' ? custRes.customers.filter((c) => c.source_type === '孤儿单') : custRes.customers;
    setCustomers(list);
    setTotalCustomers(filterChip === 'orphan' ? list.length : custRes.total);
    setCampaigns(camps);
    setKjgxJobs(jobs);
    setConflicts(cfs);
    setStaging(stg);
    if (st) setSyncStatus(st);
    if (wk) setWorkerStatus(wk);
    setAuthRequired(false);
    setLoginError(null);

    const targetId = selectedId || custRes.customers[0]?.id;
    if (targetId) {
      if (!selectedId) setSelectedId(targetId);
      const d = await api.getCustomer360(targetId);
      setDetail(d);
    }
  }, [searchQuery, filterChip, selectedId]);

  useEffect(() => {
    void refreshAll().catch((err) => {
      if (err instanceof ApiUnauthorizedError) {
        setAuthRequired(true);
      } else {
        setToast(err instanceof Error ? err.message : String(err));
      }
    });
  }, [refreshAll]);

  // Listen to beforematch on hidden="until-found" tab panels
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    for (const key of ['overview', 'interactions', 'followups', 'sync'] as DetailTab[]) {
      const el = panelRefs.current[key];
      if (!el) continue;
      const handler = () => setDetailTab(key);
      el.addEventListener('beforematch', handler);
      cleanups.push(() => el.removeEventListener('beforematch', handler));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [detail]);

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ('focusGroup' in HTMLElement.prototype) return;
    const order: DetailTab[] = ['overview', 'interactions', 'followups', 'sync'];
    const idx = order.indexOf(detailTab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % order.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + order.length) % order.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    if (next !== -1) {
      e.preventDefault();
      const nextKey = order[next]!;
      setDetailTab(nextKey);
      tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }
  };

  const openCustomer360 = async (id: string) => {
    setSelectedId(id);
    setNav('detail');
    const d = await api.getCustomer360(id);
    setDetail(d);
  };

  const loadIcloudPreview = async (overrides?: {
    offset?: number;
    preset?: 'hnw' | 'summary' | 'phone' | 'all';
    limit?: 10 | 20 | 50;
    query?: string;
  }) => {
    const nextOffset = overrides?.offset ?? previewOffset;
    const nextPreset = overrides?.preset ?? previewPreset;
    const nextLimit = overrides?.limit ?? previewLimit;
    const nextQuery = overrides?.query ?? previewQuery;
    setPreviewLoading(true);
    try {
      const items = await api.previewIcloudSync({
        query: nextQuery.trim() || undefined,
        min_premium: nextPreset === 'hnw' ? 100000 : undefined,
        has_manual_summary: nextPreset === 'summary' ? true : undefined,
        only_with_phone: nextPreset === 'phone' ? true : undefined,
        limit: nextLimit,
        offset: nextOffset,
      });
      setIcloudPreview(items);
      setPreviewOffset(nextOffset);
      return items;
    } finally {
      setPreviewLoading(false);
    }
  };

  const stageByCustomer = new Map<string, string>();
  for (const camp of campaigns) {
    for (const m of camp.members) {
      stageByCustomer.set(m.customer_id, m.stage);
    }
  }

  const pendingSyncBadge =
    (dashboard?.stats.pending_kjgx_jobs ?? 0) + (dashboard?.stats.open_conflicts ?? 0);

  if (authRequired) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4 bg-[var(--background)] text-[var(--foreground)]">
        <div className="w-full max-w-sm bg-[var(--card)] border border-[var(--border)] rounded-2xl p-6 space-y-4">
          <div className="space-y-1">
            <h1 className="text-base font-semibold">保顾客户中枢 · 访问密钥登录</h1>
            <p className="text-xs text-[var(--muted-foreground)]">
              请输入您的 Bearer Access Key（仅保存在当前浏览器本地存储，不回传明文）
            </p>
          </div>
          {loginError && (
            <div role="alert" className="p-2.5 rounded-lg border border-[var(--error)] text-xs text-[var(--error)]">
              {loginError}
            </div>
          )}
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBearerToken(loginToken);
              try {
                await refreshAll();
                setLoginToken('');
              } catch (err) {
                clearBearerToken();
                setLoginError(err instanceof Error ? err.message : '认证失败，请核对密钥');
              }
            }}
          >
            <div>
              <label htmlFor="login-access-key" className="block text-xs font-medium mb-1">
                访问密钥 (Access Key)
              </label>
              <input
                id="login-access-key"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                value={loginToken}
                onChange={(e) => setLoginToken(e.target.value)}
                placeholder="输入 human_web 访问密钥"
                className="w-full px-3 py-2 text-xs rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2 rounded-lg text-xs font-medium bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
            >
              登录工作台
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen p-3 sm:p-5">
      {/* Top Bar */}
      <header className="max-w-7xl mx-auto mb-4 bg-[var(--card)] border border-[var(--border)] rounded-xl p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-base tracking-tight">保顾客户中枢 · Insurance CRM</span>
            <span className="crm-badge crm-badge-success">PostgreSQL / API 就绪</span>
            <span className="crm-badge crm-badge-primary">MUSE Reminders 工作待办 Work 路由</span>
          </div>
          <div className="text-xs text-[var(--muted-foreground)]">
            多 Agent Streamable HTTP MCP · iPhone 通讯录/提醒 3-Way 双向同步 · 科技个险回写优先
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted-foreground)]">视口预览：</span>
          <div className="inline-flex rounded-lg border border-[var(--border)] bg-[var(--secondary)] p-0.5">
            <button
              type="button"
              onClick={() => setMobileMode(false)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${!mobileMode ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--foreground)]'}`}
            >
              桌面端
            </button>
            <button
              type="button"
              onClick={() => setMobileMode(true)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${mobileMode ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--foreground)]'}`}
            >
              iPhone (390px)
            </button>
          </div>
          {getBearerToken() && (
            <button
              type="button"
              onClick={() => {
                clearBearerToken();
                setAuthRequired(true);
              }}
              className="px-2.5 py-1.5 text-xs rounded-lg border border-[var(--border)] cursor-pointer"
            >
              退出登录
            </button>
          )}
        </div>
      </header>

      <div className={`device-shell max-w-7xl mx-auto ${mobileMode ? 'mobile-mode' : ''}`}>
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-xl overflow-hidden flex flex-col">
          {/* Subheader & Primary Nav */}
          <div className="px-4 py-3 border-b border-[var(--card-border)] flex flex-wrap items-center justify-between gap-3">
            <span className="font-semibold text-sm">太平洋保险 · 客户自主工作台</span>
            <nav className="desktop-only-nav flex items-center gap-1.5" aria-label="主导航">
              {(
                [
                  ['workbench', '今日工作台'],
                  ['customers', `客户与筛客 (${dashboard?.stats.total_customers ?? 0})`],
                  ['detail', '客户 360° 档案'],
                  ['sync', '同步中心'],
                  ['staging', '导入草稿箱'],
                ] as Array<[NavTab, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setNav(id)}
                  aria-current={nav === id ? 'page' : undefined}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer ${
                    nav === id
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                      : 'text-[var(--foreground)] hover:bg-[var(--secondary)]'
                  }`}
                >
                  {label}
                  {id === 'sync' && pendingSyncBadge > 0 && (
                    <span className="crm-badge crm-badge-warning ml-1">{pendingSyncBadge}</span>
                  )}
                  {id === 'staging' && (dashboard?.stats.pending_staging ?? 0) > 0 && (
                    <span className="crm-badge crm-badge-primary ml-1">{dashboard?.stats.pending_staging}</span>
                  )}
                </button>
              ))}
            </nav>
          </div>

          {toast && (
            <div
              role="status"
              aria-live="polite"
              className="mx-4 mt-3 px-3 py-2 rounded-lg border border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-xs flex items-center justify-between gap-2"
            >
              <span>{toast}</span>
              <button type="button" onClick={() => setToast(null)} className="underline cursor-pointer">
                知道了
              </button>
            </div>
          )}

          <main className="p-4 space-y-5 min-h-[540px]">
            {/* View 1: Workbench */}
            {nav === 'workbench' && dashboard && (
              <section className="space-y-4">
                <div className="kpi-grid grid grid-cols-4 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setFilterChip('all');
                      setNav('customers');
                    }}
                    className="text-left p-3.5 rounded-xl bg-[var(--card)] border border-[var(--card-border)] hover:border-[var(--primary)] cursor-pointer"
                  >
                    <div className="text-xs text-[var(--muted-foreground)]">客户总数</div>
                    <div className="text-xl font-bold mt-1 tabular-nums">{dashboard.stats.total_customers}</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFilterChip('hnw');
                      setNav('customers');
                    }}
                    className="text-left p-3.5 rounded-xl bg-[var(--card)] border border-[var(--card-border)] hover:border-[var(--primary)] cursor-pointer"
                  >
                    <div className="text-xs text-[var(--muted-foreground)]">保费 &ge; 10 万</div>
                    <div className="text-xl font-bold mt-1 tabular-nums text-[var(--primary)]">
                      {dashboard.stats.hnw_customers}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNav('sync')}
                    className="text-left p-3.5 rounded-xl bg-[var(--card)] border border-[var(--card-border)] hover:border-[var(--primary)] cursor-pointer"
                  >
                    <div className="text-xs text-[var(--muted-foreground)]">待审科技个险回写</div>
                    <div className="text-xl font-bold mt-1 tabular-nums text-[var(--warning)]">
                      {dashboard.stats.pending_kjgx_jobs}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNav('sync')}
                    className="text-left p-3.5 rounded-xl bg-[var(--card)] border border-[var(--card-border)] hover:border-[var(--primary)] cursor-pointer"
                  >
                    <div className="text-xs text-[var(--muted-foreground)]">iPhone 双向冲突</div>
                    <div className="text-xl font-bold mt-1 tabular-nums text-[var(--error)]">
                      {dashboard.stats.open_conflicts}
                    </div>
                  </button>
                </div>

                <div className="split-grid grid grid-cols-2 gap-4">
                  <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold">今日待跟进（MUSE 工作待办 Work）</h2>
                      <span className="crm-badge crm-badge-primary">Reminders 双向</span>
                    </div>
                    <div className="space-y-2.5">
                      {dashboard.followups.map((f) => {
                        const done = f.status === 'done';
                        return (
                          <div
                            key={f.id}
                            className="p-3 rounded-lg border border-[var(--card-border)] flex items-start justify-between gap-2 text-xs"
                          >
                            <label className="flex items-start gap-2.5 cursor-pointer flex-1">
                              <input
                                type="checkbox"
                                checked={done}
                                onChange={async () => {
                                  await api.toggleFollowup(f.id, done ? 'open' : 'done', f.version);
                                  setToast(
                                    done
                                      ? `已重开「${f.title}」并同步至 iPhone 提醒`
                                      : `已完成「${f.title}」并同步至 iPhone 提醒`,
                                  );
                                  await refreshAll();
                                }}
                                className="mt-0.5 accent-[var(--primary)]"
                              />
                              <span>
                                <span className={`block font-medium ${done ? 'line-through text-[var(--muted-foreground)]' : ''}`}>
                                  {f.title}
                                </span>
                                <span className="block text-[var(--muted-foreground)]">
                                  客户：{f.customer_name} · 列表：{f.icloud_list_id ?? '工作待办 Work'}
                                </span>
                              </span>
                            </label>
                            <button
                              type="button"
                              onClick={() => void openCustomer360(f.customer_id)}
                              className="px-2 py-1 rounded-md border border-[var(--border)] cursor-pointer shrink-0"
                            >
                              档案
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold">科技个险待审回写</h2>
                      <button type="button" onClick={() => setNav('sync')} className="text-xs text-[var(--primary)] underline cursor-pointer">
                        进入队列
                      </button>
                    </div>
                    <div className="space-y-2.5">
                      {dashboard.pending_jobs.slice(0, 3).map((j) => (
                        <div key={j.id} className="p-3 rounded-lg border border-[var(--card-border)] space-y-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">{j.customer_name ?? j.customer_id} · {j.job_type}</span>
                            <span className={`crm-badge ${j.execution_status === 'succeeded' ? 'crm-badge-success' : 'crm-badge-warning'}`}>
                              {j.execution_status === 'succeeded' ? '已回读成功 ✓' : j.approval_status}
                            </span>
                          </div>
                          {j.approval_status === 'pending_review' && (
                            <button
                              type="button"
                              onClick={async () => {
                                await api.approveKjgxJob(j.id);
                                setToast(`已放行 ${j.customer_name ?? ''} 的科技个险回写任务，可在同步中心执行直连回写`);
                                await refreshAll();
                              }}
                              className="px-2.5 py-1 rounded-md font-medium bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
                            >
                              批准回写
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-2">
                  <h2 className="text-sm font-semibold">多 Agent / 多端操作审计</h2>
                  <ul className="divide-y divide-[var(--card-border)] text-xs">
                    {dashboard.recent_audit.map((a) => (
                      <li key={a.id} className="py-2 flex items-start justify-between gap-2">
                        <div>
                          <span className="crm-badge mr-1.5">{a.actor_id}</span>
                          <span>{a.action}</span>
                        </div>
                        <span className="text-[var(--muted-foreground)] tabular-nums shrink-0">
                          {a.created_at.slice(11, 16)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            )}

            {/* View 2: Customers & Screening */}
            {nav === 'customers' && (
              <section className="space-y-4">
                <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-3.5 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索姓名 / 手机号 / 地址 / 标签..."
                      className="flex-1 min-w-[200px] px-3 py-2 text-xs rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ['all', '全部客户'],
                        ['hnw', '保费 ≥ 10万'],
                        ['orphan', '孤儿单客户'],
                        ['quality', '待复核(缺项/共用号)'],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setFilterChip(id)}
                        className={`px-2.5 py-1 rounded-full text-xs border cursor-pointer ${
                          filterChip === id
                            ? 'bg-[var(--primary)] text-[var(--primary-foreground)] border-[var(--primary)]'
                            : 'bg-[var(--secondary)] text-[var(--secondary-foreground)] border-[var(--card-border)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div tabIndex={0} role="region" aria-labelledby="customer-table-caption" className="table-wrapper">
                  <table className="crm-table">
                    <caption id="customer-table-caption">
                      客户主档与两轮筛查列表（当前显示 {customers.length} / 共 {totalCustomers} 位客户，窄视口自动切换卡片视图）
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">姓名 / 来源 / 体感</th>
                        <th scope="col">手机 / 快捷拨号</th>
                        <th scope="col">保费与保单</th>
                        <th scope="col">客温 / 资产</th>
                        <th scope="col">平台会阶段</th>
                        <th scope="col">双端状态</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customers.map((c) => {
                        const stage = stageByCustomer.get(c.id) ?? 'imported';
                        return (
                          <tr key={c.id}>
                            <th scope="row">
                              <button
                                type="button"
                                onClick={() => void openCustomer360(c.id)}
                                className="text-left hover:underline text-[var(--primary)] font-semibold cursor-pointer"
                              >
                                {c.name}
                              </button>
                              <div className="mt-1 flex flex-wrap gap-1">
                                <span className="crm-badge">{c.source_type ?? '未标注'}</span>
                                <span className="crm-badge">{RAPPORT_LABELS[c.rapport_tag]}</span>
                              </div>
                            </th>
                            <td>
                              <div className="tabular-nums font-medium">{c.primary_phone ?? '-'}</div>
                              {c.primary_phone && (
                                <a href={`tel:${c.primary_phone}`} className="inline-block mt-1 text-xs text-[var(--link)] underline">
                                  iPhone 一键拨号
                                </a>
                              )}
                            </td>
                            <td>
                              <div className="font-semibold tabular-nums">{fmtRMB(c.total_premium)}</div>
                              <div className="text-xs text-[var(--muted-foreground)]">{c.policy_total} 张保单</div>
                            </td>
                            <td>
                              <div>客温 {c.kjgx_temp_value ?? '-'} ({c.kjgx_temp_level ?? '-'})</div>
                              <div className="text-xs text-[var(--muted-foreground)]">我司资产 {c.insurer_asset_wan ?? '-'} 万</div>
                            </td>
                            <td>
                              <span className="crm-badge crm-badge-primary">{STAGE_LABELS[stage] ?? stage}</span>
                            </td>
                            <td>
                              <span className="crm-badge">{c.tags[0] ?? '未分组'}</span>
                            </td>
                            <td>
                              <div className="flex flex-wrap gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => void openCustomer360(c.id)}
                                  className="px-2.5 py-1 rounded-md text-xs border border-[var(--border)] cursor-pointer"
                                >
                                  360°档案
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setLogTarget(c)}
                                  className="px-2.5 py-1 rounded-md text-xs bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
                                >
                                  记沟通
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* View 3: Customer 360 Detail */}
            {nav === 'detail' && detail && (
              <section className="space-y-4">
                <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-bold">{detail.customer.name}</h2>
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {detail.customer.gender} · v{detail.customer.version}
                      </span>
                      <span className="crm-badge crm-badge-primary">{detail.customer.source_type}</span>
                    </div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      人工体感：{RAPPORT_LABELS[detail.customer.rapport_tag]} · 总保费：{fmtRMB(detail.customer.total_premium)} · 保单 {detail.customer.policy_total} 张
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditTarget(detail.customer)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] cursor-pointer"
                    >
                      编辑资料 (生成回写)
                    </button>
                    <button
                      type="button"
                      onClick={() => setLogTarget(detail.customer)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
                    >
                      速记沟通
                    </button>
                  </div>
                </div>

                <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4">
                  <div
                    ref={tablistRef}
                    className="crm-tablist"
                    role="tablist"
                    aria-label="客户档案分类"
                    onKeyDown={handleTabKeyDown}
                    {...({ focusgroup: 'tablist nomemory' } as Record<string, string>)}
                  >
                    {(
                      [
                        ['overview', '基础与保单'],
                        ['interactions', '沟通时间轴'],
                        ['followups', '跟进与提醒'],
                        ['sync', '同步与映射'],
                      ] as Array<[DetailTab, string]>
                    ).map(([id, label]) => {
                      const selected = detailTab === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          id={`tab-${id}`}
                          aria-selected={selected}
                          onClick={() => setDetailTab(id)}
                          onFocus={() => setDetailTab(id)}
                          {...(selected ? ({ focusgroupstart: '' } as Record<string, string>) : {})}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Tab 1 */}
                  <div
                    ref={(el) => { panelRefs.current.overview = el; }}
                    role="tabpanel"
                    aria-labelledby="tab-overview"
                    tabIndex={detailTab === 'overview' ? 0 : undefined}
                    {...(detailTab === 'overview' ? {} : ({ hidden: 'until-found' } as Record<string, string>))}
                  >
                    <div className="tab-panel-inner grid sm:grid-cols-2 gap-3 text-xs">
                      <div className="p-3 rounded-lg border border-[var(--card-border)] space-y-1.5">
                        <div className="font-semibold">基础身份</div>
                        <div>手机：{detail.customer.primary_phone ?? '-'}</div>
                        <div>生日：{detail.customer.birthday ?? '-'} ({detail.customer.birthday_source})</div>
                        <div>地址：{detail.customer.address ?? '-'}</div>
                        <div>身份证：{detail.customer.id_no_masked ?? '-'} <span className="crm-badge crm-badge-success">同步通讯录含完整档案</span></div>
                      </div>
                      <div className="p-3 rounded-lg border border-[var(--card-border)] space-y-2">
                        <div className="font-semibold">保单档案 ({detail.policies.length})</div>
                        {detail.policies.map((p) => (
                          <div key={p.id} className="p-2 rounded bg-[var(--secondary)] space-y-0.5">
                            <div className="font-semibold">{p.product_name ?? p.policy_no} · {fmtRMB(p.annual_premium)}</div>
                            <div className="text-[var(--muted-foreground)]">{p.policy_no} · {p.holder_role}</div>
                            {p.coverage_gap_note && <div className="text-[var(--primary)]">{p.coverage_gap_note}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Tab 2 */}
                  <div
                    ref={(el) => { panelRefs.current.interactions = el; }}
                    role="tabpanel"
                    aria-labelledby="tab-interactions"
                    tabIndex={detailTab === 'interactions' ? 0 : undefined}
                    {...(detailTab === 'interactions' ? {} : ({ hidden: 'until-found' } as Record<string, string>))}
                  >
                    <div className="tab-panel-inner space-y-2.5 text-xs">
                      {detail.interactions.map((it) => (
                        <div key={it.id} className="p-3 rounded-lg border border-[var(--card-border)] space-y-1">
                          <div className="flex justify-between gap-2">
                            <span>
                              <span className="crm-badge crm-badge-primary mr-1">{it.channel}</span>
                              <span className="crm-badge mr-1">{it.outcome}</span>
                              <span className="text-[var(--muted-foreground)]">{it.recorded_by_actor}</span>
                            </span>
                            <span className="text-[var(--muted-foreground)]">{it.occurred_at.slice(0, 16)}</span>
                          </div>
                          <p>{it.summary}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Tab 3 */}
                  <div
                    ref={(el) => { panelRefs.current.followups = el; }}
                    role="tabpanel"
                    aria-labelledby="tab-followups"
                    tabIndex={detailTab === 'followups' ? 0 : undefined}
                    {...(detailTab === 'followups' ? {} : ({ hidden: 'until-found' } as Record<string, string>))}
                  >
                    <div className="tab-panel-inner space-y-2.5 text-xs">
                      {detail.followups.map((f) => (
                        <div key={f.id} className="p-3 rounded-lg border border-[var(--card-border)] flex items-center justify-between">
                          <div>
                            <div className="font-medium">{f.title}</div>
                            <div className="text-[var(--muted-foreground)]">列表：{f.icloud_list_id ?? '工作待办 Work'} · 状态：{f.status}</div>
                          </div>
                          <span className="crm-badge crm-badge-primary">MUSE Reminders</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Tab 4 */}
                  <div
                    ref={(el) => { panelRefs.current.sync = el; }}
                    role="tabpanel"
                    aria-labelledby="tab-sync"
                    tabIndex={detailTab === 'sync' ? 0 : undefined}
                    {...(detailTab === 'sync' ? {} : ({ hidden: 'until-found' } as Record<string, string>))}
                  >
                    <div className="tab-panel-inner grid sm:grid-cols-2 gap-3 text-xs">
                      <div className="p-3 rounded-lg border border-[var(--card-border)] space-y-1">
                        <div className="font-semibold">科技个险绑定</div>
                        <div>客户编号：{detail.customer.kjgx_customer_no ?? '(待回写生成)'}</div>
                        <div>DB ID：{detail.customer.kjgx_db_customer_id ?? '-'}</div>
                      </div>
                      <div className="p-3 rounded-lg border border-[var(--card-border)] space-y-2">
                        <div className="font-semibold">iCloud 映射</div>
                        <div>外部链路数：{detail.external_links.length}</div>
                        <div>未解决冲突：{detail.open_conflicts.length}</div>
                        {syncStatus?.contacts?.contacts_write_enabled && (
                          <button
                            type="button"
                            disabled={syncBusy}
                            onClick={async () => {
                              setSyncBusy(true);
                              try {
                                const res = await api.applyIcloudSync({
                                  customer_id: detail.customer.id,
                                  create_missing: true,
                                });
                                setToast(
                                  `已同步「${detail.customer.name}」至 iCloud 通讯录（mode=${res.mode}, pushed=${res.pushed_customers.length}）`,
                                );
                                await refreshAll();
                              } catch (err) {
                                setToast(err instanceof Error ? err.message : String(err));
                              } finally {
                                setSyncBusy(false);
                              }
                            }}
                            className="mt-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer disabled:opacity-60"
                          >
                            同步此客户到 iCloud 通讯录
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* View 4: Sync Center */}
            {nav === 'sync' && (
              <div className="space-y-4">
                <section className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">iCloud 提醒事项（CloudKit 直连 · 无 MacServer）</h2>
                      <span
                        className={`crm-badge ${syncStatus?.bridge?.authenticated ? 'crm-badge-success' : 'crm-badge-warning'}`}
                      >
                        {syncStatus?.bridge?.authenticated
                          ? `在线 · ${syncStatus.bridge.active_lists_count} 个列表 · Cookie 余 ${syncStatus.bridge.cookie_min_remaining_days ?? '-'} 天`
                          : '未连接 / 待鉴权'}
                      </span>
                      <span
                        className={`crm-badge ${syncStatus?.bridge?.write_enabled ? 'crm-badge-primary' : 'crm-badge-warning'}`}
                      >
                        {syncStatus?.bridge?.write_enabled ? '已放开双向写入' : '只读锁'}
                      </span>
                      {syncStatus?.auto_sync?.enabled && (
                        <span className="crm-badge crm-badge-success">
                          每 {Math.max(1, Math.round(syncStatus.auto_sync.interval_sec / 60))} 分钟自动双向同步
                          {syncStatus.auto_sync.last_run_at
                            ? ` · 上次 ${syncStatus.auto_sync.last_run_at.slice(11, 16)}`
                            : ''}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={syncBusy || !syncStatus?.bridge?.write_enabled}
                      onClick={async () => {
                        setSyncBusy(true);
                        try {
                          const res = await api.syncRemindersNow();
                          setToast(
                            `提醒事项双向同步完成：新增 ${res.pushed}，更新 ${res.updated}，回拉完成 ${res.pulled_completed}`,
                          );
                          await refreshAll();
                        } catch (err) {
                          setToast(err instanceof Error ? err.message : String(err));
                        } finally {
                          setSyncBusy(false);
                        }
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer disabled:opacity-50"
                    >
                      立即双向同步提醒事项
                    </button>
                  </div>
                </section>

                <section className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">iCloud 通讯录人工预览（完整客户档案 + [#FUP:] 摘要）</h2>
                      {syncStatus?.contacts?.contacts_write_enabled ? (
                        <span className="crm-badge crm-badge-success">
                          已放开写入 · 无隐私围栏 · 完整档案 + [#FUP:]
                          {syncStatus.contacts.carddav_connected ? ' (CardDAV 直连)' : ''}
                        </span>
                      ) : (
                        <span className="crm-badge crm-badge-warning">人工触发 · 仅预览 · 写入闸门已锁</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={previewLoading}
                        onClick={async () => {
                          try {
                            const items = await loadIcloudPreview({ offset: 0 });
                            setToast(`已生成 ${items.length} 位客户的 iCloud 通讯录预览`);
                          } catch (err) {
                            setToast(err instanceof Error ? err.message : String(err));
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer disabled:opacity-60"
                      >
                        {previewLoading ? '正在生成预览...' : '人工触发预览 (只读，不写入 iCloud)'}
                      </button>
                      {syncStatus?.contacts?.contacts_write_enabled &&
                        icloudPreview &&
                        icloudPreview.length > 0 && (
                          <button
                            type="button"
                            disabled={syncBusy || previewLoading}
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `确认将当前筛选的 ${icloudPreview.length} 位客户完整档案（含身份证/保单/保费/[#FUP:]，保留原有个人手写备注）写入 iCloud 通讯录？`,
                                )
                              ) {
                                return;
                              }
                              setSyncBusy(true);
                              try {
                                const res = await api.applyIcloudSync({
                                  customer_ids: icloudPreview.map((i) => i.customer_id),
                                  create_missing: true,
                                  limit: icloudPreview.length,
                                });
                                setToast(
                                  `批量写入完成：新建 ${res.created_customers?.length ?? 0}，更新 ${res.pushed_customers.length}，冲突 ${res.created_conflicts.length}`,
                                );
                                await loadIcloudPreview();
                                await refreshAll();
                              } catch (err) {
                                setToast(err instanceof Error ? err.message : String(err));
                              } finally {
                                setSyncBusy(false);
                              }
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--primary)] text-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] cursor-pointer disabled:opacity-60"
                          >
                            批量写入当前页 ({icloudPreview.length} 位客户到 iCloud)
                          </button>
                        )}
                      {!syncStatus?.contacts?.contacts_write_enabled && (
                        <button
                          type="button"
                          disabled
                          title="依据当前安全策略，iCloud 通讯录写入闸门处于锁定状态，仅允许人工只读预览"
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] opacity-50 cursor-not-allowed"
                        >
                          写入 iCloud（当前锁定）
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    已取消隐私围栏：将完整身份证号、保单明细、保费资产、科技个险指标、人工备注与近期沟通以幂等 <code>[#CRM-BEGIN]...[#CRM-END]</code> 区块写入 iPhone 通讯录备注，同时完整保留原有个人手写备注、头像与 <code>[#FUP:]</code> 单行跟进摘要。
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                    <input
                      type="search"
                      value={previewQuery}
                      onChange={(e) => setPreviewQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void loadIcloudPreview({ offset: 0, query: e.currentTarget.value }).catch((err) =>
                            setToast(err instanceof Error ? err.message : String(err)),
                          );
                        }
                      }}
                      placeholder="按姓名 / 手机 / 地址筛选..."
                      className="flex-1 min-w-[180px] px-2.5 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
                    />
                    {(
                      [
                        ['hnw', '高净值 ≥ 10万'],
                        ['summary', '有人工备注'],
                        ['phone', '全部有手机号'],
                        ['all', '全部客户'],
                      ] as const
                    ).map(([presetId, label]) => (
                      <button
                        key={presetId}
                        type="button"
                        disabled={previewLoading}
                        onClick={() => {
                          setPreviewPreset(presetId);
                          void loadIcloudPreview({ preset: presetId, offset: 0 }).catch((err) =>
                            setToast(err instanceof Error ? err.message : String(err)),
                          );
                        }}
                        className={`px-2.5 py-1 rounded-full border cursor-pointer ${
                          previewPreset === presetId
                            ? 'bg-[var(--primary)] text-[var(--primary-foreground)] border-[var(--primary)]'
                            : 'bg-[var(--secondary)] text-[var(--secondary-foreground)] border-[var(--card-border)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                    <label className="flex items-center gap-1 text-[var(--muted-foreground)]">
                      每页
                      <select
                        aria-label="预览每页数量"
                        value={previewLimit}
                        onChange={(e) => {
                          const nextLimit = Number(e.target.value) as 10 | 20 | 50;
                          setPreviewLimit(nextLimit);
                          void loadIcloudPreview({ limit: nextLimit, offset: 0 }).catch((err) =>
                            setToast(err instanceof Error ? err.message : String(err)),
                          );
                        }}
                        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
                      >
                        <option value={10}>10</option>
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                      </select>
                    </label>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={previewLoading || previewOffset === 0}
                        onClick={() => {
                          const prevOff = Math.max(0, previewOffset - previewLimit);
                          void loadIcloudPreview({ offset: prevOff }).catch((err) =>
                            setToast(err instanceof Error ? err.message : String(err)),
                          );
                        }}
                        className="px-2 py-1 rounded border border-[var(--border)] cursor-pointer disabled:opacity-40"
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        disabled={previewLoading || (icloudPreview !== null && icloudPreview.length < previewLimit)}
                        onClick={() => {
                          const nextOff = previewOffset + previewLimit;
                          void loadIcloudPreview({ offset: nextOff }).catch((err) =>
                            setToast(err instanceof Error ? err.message : String(err)),
                          );
                        }}
                        className="px-2 py-1 rounded border border-[var(--border)] cursor-pointer disabled:opacity-40"
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                  {icloudPreview && (
                    <div className="grid sm:grid-cols-2 gap-3">
                      {icloudPreview.map((item) => {
                        const diffCount =
                          Object.keys(item.diff.toPushToRemote).length +
                          Object.keys(item.diff.toPullToCrm).length +
                          item.diff.conflicts.length;
                        return (
                          <div
                            key={item.customer_id}
                            className="p-3 rounded-xl border border-[var(--card-border)] space-y-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold">{item.customer_name}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="crm-badge">{item.contact_link_status}</span>
                                <span className="crm-badge crm-badge-primary">差异字段 {diffCount}</span>
                              </div>
                            </div>
                            <div className="text-[var(--muted-foreground)] space-y-0.5">
                              <div>电话：{item.sanitized_payload.phones.join(', ') || '-'}</div>
                              <div>生日：{item.sanitized_payload.birthday ?? '-'}</div>
                              <div>地址：{item.sanitized_payload.address ?? '-'}</div>
                              <div>
                                保费/保单：{fmtRMB(item.sanitized_payload.totalPremium ?? null)} /{' '}
                                {item.sanitized_payload.policyTotal ?? 0} 张保单
                              </div>
                              <div>
                                身份证：{item.sanitized_payload.idNo ? '已含完整/归档证件号' : '无'}
                              </div>
                            </div>
                            <pre className="bg-[var(--secondary)] p-2 rounded font-mono text-[11px] whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                              {item.planned_followup_note ?? '(无摘要)'}
                            </pre>
                            {syncStatus?.contacts?.contacts_write_enabled && (
                              <div className="pt-1">
                                <button
                                  type="button"
                                  disabled={syncBusy}
                                  onClick={async () => {
                                    setSyncBusy(true);
                                    try {
                                      const res = await api.applyIcloudSync({
                                        customer_id: item.customer_id,
                                        create_missing: true,
                                      });
                                      setToast(
                                        `已写入「${item.customer_name}」到 iCloud 通讯录（pushed=${res.pushed_customers.length}, conflicts=${res.created_conflicts.length}）`,
                                      );
                                      await loadIcloudPreview();
                                      await refreshAll();
                                    } catch (err) {
                                      setToast(err instanceof Error ? err.message : String(err));
                                    } finally {
                                      setSyncBusy(false);
                                    }
                                  }}
                                  className="px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer disabled:opacity-60"
                                >
                                  写入此客户到 iCloud 通讯录
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="split-grid grid grid-cols-2 gap-4">
                  <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h2 className="text-sm font-semibold">科技个险回写队列</h2>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                          {workerStatus?.session_present ? (
                            <span className="crm-badge crm-badge-success">
                              {workerStatus.session_source === 'server_login'
                                ? `服务端直连就绪 (${workerStatus.emp_name ?? workerStatus.emp_no_prefix ?? '已登录'} · 无手机模式)`
                                : workerStatus.pixel_online && workerStatus.worker
                                  ? `会话已同步 (${workerStatus.emp_name ?? workerStatus.emp_no_prefix ?? '有效'} · ${workerStatus.worker.device_id})`
                                  : `持久化会话有效 (${workerStatus.emp_name ?? workerStatus.emp_no_prefix ?? '已就绪'} · 手机暂停中)`}
                            </span>
                          ) : workerStatus?.online && workerStatus.worker && !workerStatus.worker.bundle_hash_matched ? (
                            <span className="crm-badge crm-badge-error">Pixel 在线 · OTA 哈希变更(已熔断)</span>
                          ) : (
                            <span className="crm-badge crm-badge-warning">未登录科技个险（点击右侧直接登录）</span>
                          )}
                          <span className="crm-badge crm-badge-primary">
                            {workerStatus?.h5_gate?.armed
                              ? `L0 H5 门禁 (${workerStatus.h5_gate.expected_prefix})`
                              : '直连 khzx 加密 API + 强制回读'}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setKjgxLoginOpen(true)}
                          className="px-2.5 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-medium cursor-pointer"
                        >
                          {workerStatus?.session_present ? '重新登录科技个险' : '登录科技个险'}
                        </button>
                        <button
                          type="button"
                          disabled={kjgxBusy}
                          onClick={async () => {
                            setKjgxBusy(true);
                            try {
                              const [probe, h5] = await Promise.all([
                                api.probeKjgxWorker(),
                                api.checkKjgxH5Gate().catch(() => null),
                              ]);
                              setToast(
                                probe.ok
                                  ? `科技个险会话有效 (${probe.emp_name ?? probe.emp_no_prefix ?? ''})${h5 ? ` · H5(${h5.prefix})` : ''}`
                                  : `会话已过期或未登录：${probe.message}`,
                              );
                              await refreshAll();
                            } finally {
                              setKjgxBusy(false);
                            }
                          }}
                          className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] cursor-pointer disabled:opacity-60"
                        >
                          {kjgxBusy ? '探测中…' : '探活'}
                        </button>
                        {workerStatus?.session_present && (
                          <button
                            type="button"
                            disabled={kjgxBusy}
                            onClick={async () => {
                              setKjgxBusy(true);
                              try {
                                await api.logoutKjgx();
                                setToast('已清除服务端科技个险会话');
                                await refreshAll();
                              } finally {
                                setKjgxBusy(false);
                              }
                            }}
                            className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] cursor-pointer disabled:opacity-60"
                          >
                            退出会话
                          </button>
                        )}
                      </div>
                    </div>
                    {kjgxJobs.map((j) => (
                      <div key={j.id} className="p-3 rounded-xl border border-[var(--card-border)] space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{j.customer_name ?? j.customer_id} · {j.job_type}</span>
                          <span className={`crm-badge ${j.execution_status === 'succeeded' ? 'crm-badge-success' : 'crm-badge-warning'}`}>
                            {j.approval_status} / {j.execution_status}
                          </span>
                        </div>
                        <div className="bg-[var(--secondary)] p-2 rounded space-y-1">
                          {j.field_diff.map((d, i) => (
                            <div key={i}>
                              {d.field}: <span className="line-through opacity-70">{d.before}</span> → <strong>{d.after}</strong>
                            </div>
                          ))}
                        </div>
                        {j.approval_status === 'pending_review' && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={async () => {
                                await api.approveKjgxJob(j.id);
                                setToast('已批准回写任务');
                                await refreshAll();
                              }}
                              className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
                            >
                              批准放行
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                await api.rejectKjgxJob(j.id);
                                setToast('已驳回回写任务');
                                await refreshAll();
                              }}
                              className="px-3 py-1.5 rounded-lg border border-[var(--border)] cursor-pointer"
                            >
                              驳回
                            </button>
                          </div>
                        )}
                        {(j.approval_status === 'approved' || j.approval_status === 'auto_approved') &&
                          j.execution_status === 'queued' && (
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={kjgxBusy}
                                onClick={async () => {
                                  setKjgxBusy(true);
                                  try {
                                    const res = await api.executeKjgxJob(j.id, true);
                                    setToast(res.ok ? `演练通过（Dry-Run）：payload 已通过校验` : '演练未通过，请检查任务详情');
                                  } catch (err) {
                                    setToast(err instanceof Error ? err.message : '演练失败');
                                  } finally {
                                    setKjgxBusy(false);
                                  }
                                }}
                                className="px-3 py-1.5 rounded-lg border border-[var(--border)] cursor-pointer disabled:opacity-60"
                              >
                                演练 (Dry-Run)
                              </button>
                              <button
                                type="button"
                                disabled={kjgxBusy}
                                onClick={async () => {
                                  setKjgxBusy(true);
                                  try {
                                    const res = await api.executeKjgxJob(j.id, false);
                                    setToast(res.ok ? '直连回写并回读校验成功 ✓' : `回写失败：${res.job.receipt?.route_result ?? ''}`);
                                    await refreshAll();
                                  } catch (err) {
                                    setToast(err instanceof Error ? err.message : '直连回写失败');
                                  } finally {
                                    setKjgxBusy(false);
                                  }
                                }}
                                className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer disabled:opacity-60"
                              >
                                直连回写
                              </button>
                            </div>
                          )}
                      </div>
                    ))}
                  </div>

                  <div className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-3">
                    <h2 className="text-sm font-semibold">iPhone 通讯录 &amp; 提醒 3-Way 冲突仲裁</h2>
                    {conflicts.map((cf) => (
                      <div key={cf.id} className="p-3 rounded-xl border border-[var(--card-border)] space-y-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">{cf.customer_name ?? cf.entity_id} · {cf.field_name}</span>
                          <span className={`crm-badge ${cf.status === 'open' ? 'crm-badge-error' : 'crm-badge-success'}`}>
                            {cf.status}
                          </span>
                        </div>
                        <div className="bg-[var(--secondary)] p-2 rounded space-y-1">
                          <div>BASE: {String(cf.base_value)}</div>
                          <div>CRM: <strong>{String(cf.crm_value)}</strong></div>
                          <div>iPhone: <strong className="text-[var(--primary)]">{String(cf.remote_value)}</strong></div>
                        </div>
                        {cf.status === 'open' && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={async () => {
                                await api.resolveConflict(cf.id, 'keep_crm');
                                setToast('已保留 CRM 值并刷新同步基线');
                                await refreshAll();
                              }}
                              className="px-3 py-1.5 rounded-lg border border-[var(--border)] cursor-pointer"
                            >
                              保留 CRM
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                await api.resolveConflict(cf.id, 'take_remote');
                                setToast('已采用 iPhone 值更新 CRM 主档');
                                await refreshAll();
                              }}
                              className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
                            >
                              采用 iPhone
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {/* View 5: Staging Inbox */}
            {nav === 'staging' && (
              <section className="space-y-3">
                {staging.map((s) => (
                  <div key={s.id} className="bg-[var(--card)] border border-[var(--card-border)] rounded-xl p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="crm-badge crm-badge-primary">{s.source_kind}</span>
                        <span className="font-semibold">{String(s.normalized_draft.name ?? '')}</span>
                      </div>
                      <span className={`crm-badge ${s.status === 'pending_review' ? 'crm-badge-warning' : 'crm-badge-success'}`}>
                        {s.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.validation_warnings.map((w, i) => (
                        <span key={i} className="crm-badge">{w}</span>
                      ))}
                    </div>
                    {s.status === 'pending_review' && (
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={async () => {
                            await api.commitStaging(s.id);
                            setToast('已确认入库 / 合并至客户主档');
                            await refreshAll();
                          }}
                          className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
                        >
                          确认入库
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await api.rejectStaging(s.id);
                            setToast('已忽略草稿');
                            await refreshAll();
                          }}
                          className="px-3 py-1.5 rounded-lg border border-[var(--border)] cursor-pointer"
                        >
                          忽略
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            )}
          </main>

          <nav className="mobile-bottom-nav grid-cols-5 border-t border-[var(--card-border)] text-center" aria-label="移动端主导航">
            {(
              [
                ['workbench', '工作台'],
                ['customers', '客户'],
                ['detail', '360°'],
                ['sync', '同步'],
                ['staging', '草稿箱'],
              ] as Array<[NavTab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setNav(id)}
                className={`py-2.5 text-xs font-medium cursor-pointer ${
                  nav === id ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <EditCustomerDialog
        customer={editTarget}
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        onSave={async (patch) => {
          if (!editTarget) return;
          await api.updateCustomer(editTarget.id, { expected_version: editTarget.version, ...patch });
          setToast(`已保存 ${editTarget.name} 资料${patch.enqueue_kjgx_writeback ? '并生成科技个险回写草稿' : ''}`);
          await refreshAll();
        }}
      />

      <LogInteractionDialog
        customer={logTarget}
        open={Boolean(logTarget)}
        onClose={() => setLogTarget(null)}
        onSave={async (payload) => {
          if (!logTarget) return;
          await api.logInteraction(logTarget.id, payload);
          setToast(`已写入 ${logTarget.name} 沟通记录`);
          await refreshAll();
        }}
      />

      <KjgxLoginDialog
        open={kjgxLoginOpen}
        initialEmpNoPrefix={workerStatus?.emp_no_prefix}
        credentialsConfigured={workerStatus?.credentials_configured}
        configuredEmpPrefix={workerStatus?.configured_emp_prefix}
        configuredMobileMasked={workerStatus?.configured_mobile_masked}
        onClose={() => setKjgxLoginOpen(false)}
        onSuccess={async (msg) => {
          setToast(msg);
          await refreshAll();
        }}
      />
    </div>
  );
}
