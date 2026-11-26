import type { KjgxWritebackJob } from '@insurance-crm/shared';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type IcloudPreviewItem, type SyncStatusResponse, api } from '../api.js';
import { fmtMoney } from '../lib/format.js';
import { btn, btnPrimary, chipCls, inputCls } from '../lib/ui.js';

const APPROVAL_LABEL: Record<string, string> = {
  draft: '草稿',
  pending_review: '待审核',
  approved: '已批准',
  auto_approved: '已批准',
  rejected: '已驳回',
};
const EXEC_LABEL: Record<string, string> = {
  queued: '待执行',
  claimed: '执行中',
  running: '执行中',
  readback_verifying: '回读校验中',
  succeeded: '已完成',
  failed: '失败',
  blocked_ota: '已熔断',
  cancelled: '已取消',
};
const JOB_TYPE_LABEL: Record<string, string> = {
  create_customer: '新建客户',
  update_profile: '更新资料',
  log_visit: '拜访记录',
  sync_tags: '同步标签',
};

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--card-border)] bg-[var(--card)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--card-border)] px-5 py-3">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {aside}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function JobsSection({ onToast, onChanged }: { onToast: (m: string) => void; onChanged: () => void }) {
  const [jobs, setJobs] = useState<KjgxWritebackJob[]>([]);
  const [busy, setBusy] = useState('');
  const [h5, setH5] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs(await api.getKjgxJobs());
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      onToast(await fn());
      await load();
      onChanged();
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const open = jobs.filter((j) => j.execution_status !== 'succeeded' && j.execution_status !== 'cancelled');
  const done = jobs.filter((j) => j.execution_status === 'succeeded');

  return (
    <Section
      title="科技个险回写队列"
      aside={
        <div className="flex items-center gap-2">
          {h5 && <span className="text-[12px] text-[color:var(--muted-foreground)]">{h5}</span>}
          <button
            type="button"
            className={btn}
            disabled={busy === 'h5'}
            onClick={() =>
              void run('h5', async () => {
                const r = await api.checkKjgxH5Gate();
                const txt = `前端指纹 ${r.prefix}${r.armed ? (r.matched ? ' · 与基线一致' : ' · 与基线不一致，已熔断') : ' · 未设基线'}`;
                setH5(txt);
                return txt;
              })
            }
          >
            检查前端指纹
          </button>
        </div>
      }
    >
      {open.length === 0 && <p className="text-[color:var(--muted-foreground)]">没有待处理的回写任务</p>}
      <ul className="space-y-3">
        {open.map((j) => (
          <li key={j.id} className="space-y-2.5 rounded-lg border border-[var(--card-border)] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {j.customer_name ?? j.customer_id} · {JOB_TYPE_LABEL[j.job_type] ?? j.job_type}
              </span>
              <span className="text-[12px] text-[color:var(--muted-foreground)]">
                {APPROVAL_LABEL[j.approval_status] ?? j.approval_status} · {EXEC_LABEL[j.execution_status] ?? j.execution_status}
              </span>
            </div>
            <div className="space-y-0.5 rounded-md bg-[var(--secondary)] px-3 py-2">
              {j.field_diff.map((d, i) => (
                <div key={i} className="break-words">
                  <span className="text-[color:var(--muted-foreground)]">{d.field}：</span>
                  <span className="text-[color:var(--muted-foreground)] line-through">{d.before}</span> → <strong>{d.after}</strong>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {j.approval_status === 'pending_review' && (
                <>
                  <button
                    type="button"
                    className={btnPrimary}
                    disabled={busy === j.id}
                    onClick={() =>
                      void run(j.id, async () => {
                        await api.approveKjgxJob(j.id);
                        return '已批准回写任务';
                      })
                    }
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className={btn}
                    disabled={busy === j.id}
                    onClick={() =>
                      void run(j.id, async () => {
                        await api.rejectKjgxJob(j.id);
                        return '已驳回回写任务';
                      })
                    }
                  >
                    驳回
                  </button>
                </>
              )}
              {(j.approval_status === 'approved' || j.approval_status === 'auto_approved') &&
                j.execution_status === 'queued' && (
                  <>
                    <button
                      type="button"
                      className={btn}
                      disabled={busy === j.id}
                      onClick={() =>
                        void run(j.id, async () => {
                          const r = await api.executeKjgxJob(j.id, true);
                          return r.ok ? '演练通过：写入内容校验正常' : '演练未通过，请检查任务';
                        })
                      }
                    >
                      演练
                    </button>
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={busy === j.id}
                      onClick={() =>
                        void run(j.id, async () => {
                          const r = await api.executeKjgxJob(j.id, false);
                          return r.ok ? '已写入科技个险，回读校验通过' : `回写失败：${r.job.receipt?.route_result ?? ''}`;
                        })
                      }
                    >
                      {busy === j.id ? '写入中…' : '立即回写'}
                    </button>
                  </>
                )}
            </div>
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[12.5px] text-[color:var(--muted-foreground)]">已完成 {done.length} 项</summary>
          <ul className="mt-2 divide-y divide-[var(--card-border)] rounded-lg border border-[var(--card-border)]">
            {done.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  {j.customer_name ?? j.customer_id} · {JOB_TYPE_LABEL[j.job_type] ?? j.job_type}
                </span>
                <span className="text-[12px] text-[color:var(--success)]">已回读校验</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

type Preset = 'hnw' | 'summary' | 'phone' | 'all';
const PRESETS: ReadonlyArray<{ value: Preset; label: string }> = [
  { value: 'hnw', label: '高净值 ≥10万' },
  { value: 'summary', label: '有备注' },
  { value: 'phone', label: '有手机号' },
  { value: 'all', label: '全部' },
];
const PREVIEW_PAGE = 10;

function ContactsSection({ sync, onToast }: { sync: SyncStatusResponse | null; onToast: (m: string) => void }) {
  const [preset, setPreset] = useState<Preset>('hnw');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<IcloudPreviewItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState('');
  const enabled = Boolean(sync?.contacts?.contacts_write_enabled);

  const load = async (next?: { offset?: number; preset?: Preset }) => {
    const p = next?.preset ?? preset;
    const o = next?.offset ?? offset;
    setLoading(true);
    try {
      const res = await api.previewIcloudSync({
        query: query.trim() || undefined,
        min_premium: p === 'hnw' ? 100000 : undefined,
        has_manual_summary: p === 'summary' ? true : undefined,
        only_with_phone: p === 'phone' ? true : undefined,
        limit: PREVIEW_PAGE,
        offset: o,
      });
      setItems(res);
      setOffset(o);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const write = async (ids: string[], label: string) => {
    setWriting(label);
    try {
      const res = await api.applyIcloudSync({ customer_ids: ids, create_missing: true, limit: ids.length });
      onToast(`已写入通讯录：新建 ${res.created_customers?.length ?? 0}，更新 ${res.pushed_customers.length}，冲突 ${res.created_conflicts.length}`);
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setWriting('');
    }
  };

  return (
    <Section
      title="iPhone 通讯录"
      aside={
        <span className="text-[12px] text-[color:var(--muted-foreground)]">
          {enabled ? '写入已开启 · 保留原有手写备注' : '写入闸门未开启，仅可预览'}
        </span>
      }
    >
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load({ offset: 0 });
        }}
      >
        <input
          aria-label="按姓名、手机或地址筛选"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="姓名 / 手机 / 地址"
          className={`${inputCls} w-56`}
        />
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={preset === p.value}
            className={chipCls(preset === p.value)}
            onClick={() => {
              setPreset(p.value);
              void load({ preset: p.value, offset: 0 });
            }}
          >
            {p.label}
          </button>
        ))}
        <button type="submit" className={btnPrimary} disabled={loading}>
          {loading ? '生成中…' : '生成预览'}
        </button>
        {enabled && items && items.length > 0 && (
          <button
            type="button"
            className={btn}
            disabled={Boolean(writing)}
            onClick={() => {
              if (window.confirm(`将当前 ${items.length} 位客户的完整档案写入 iPhone 通讯录？（保留原有手写备注）`)) {
                void write(
                  items.map((i) => i.customer_id),
                  'batch',
                );
              }
            }}
          >
            写入当前页 {items.length} 位
          </button>
        )}
      </form>

      {items === null && <p className="text-[color:var(--muted-foreground)]">选择筛选条件后生成预览，确认后再写入。</p>}
      {items && items.length === 0 && <p className="text-[color:var(--muted-foreground)]">没有匹配的客户</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {items?.map((it) => {
          const diff =
            Object.keys(it.diff.toPushToRemote).length + Object.keys(it.diff.toPullToCrm).length + it.diff.conflicts.length;
          return (
            <li key={it.customer_id} className="space-y-2 rounded-lg border border-[var(--card-border)] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{it.customer_name}</span>
                <span className="text-[12px] text-[color:var(--muted-foreground)]">
                  {it.contact_link_status} · 差异 {diff}
                </span>
              </div>
              <div className="tnum space-y-0.5 text-[12.5px] text-[color:var(--muted-foreground)]">
                <div>手机：{it.sanitized_payload.phones.join(' / ') || '—'}</div>
                <div>地址：{it.sanitized_payload.address ?? '—'}</div>
                <div>
                  保费：{fmtMoney(it.sanitized_payload.totalPremium ?? null)}（{it.sanitized_payload.policyTotal ?? 0} 张）
                </div>
              </div>
              {it.planned_followup_note && (
                <details>
                  <summary className="cursor-pointer text-[12px] text-[color:var(--muted-foreground)]">将写入的备注</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--secondary)] p-2 text-[11.5px]">
                    {it.planned_followup_note}
                  </pre>
                </details>
              )}
              {enabled && (
                <button
                  type="button"
                  className={btn}
                  disabled={Boolean(writing)}
                  onClick={() => void write([it.customer_id], it.customer_id)}
                >
                  {writing === it.customer_id ? '写入中…' : '写入此客户'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {items && (
        <div className="mt-4 flex items-center justify-end gap-1.5">
          <button
            type="button"
            className={`${btn} w-8 px-0`}
            aria-label="上一页"
            disabled={loading || offset === 0}
            onClick={() => void load({ offset: Math.max(0, offset - PREVIEW_PAGE) })}
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            className={`${btn} w-8 px-0`}
            aria-label="下一页"
            disabled={loading || items.length < PREVIEW_PAGE}
            onClick={() => void load({ offset: offset + PREVIEW_PAGE })}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}
    </Section>
  );
}

function RemindersSection({ sync, onToast }: { sync: SyncStatusResponse | null; onToast: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const auto = sync?.auto_sync;
  return (
    <Section
      title="iPhone 提醒事项"
      aside={
        <button
          type="button"
          className={btn}
          disabled={busy || !sync?.bridge?.write_enabled}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.syncRemindersNow();
              onToast(`提醒同步完成：新增 ${r.pushed}，更新 ${r.updated}，回拉完成 ${r.pulled_completed}`);
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
          立即同步
        </button>
      }
    >
      <p className="text-[color:var(--muted-foreground)]">
        {sync?.bridge?.authenticated ? '已连接 iCloud 提醒事项' : '未连接 iCloud 提醒事项'}
        {auto?.enabled && `，每 ${Math.max(1, Math.round(auto.interval_sec / 60))} 分钟自动双向同步`}
        {auto?.last_run_at && `（上次 ${auto.last_run_at.slice(11, 16)} UTC）`}
      </p>
    </Section>
  );
}

export function SyncPage({
  sync,
  onToast,
  onChanged,
}: {
  sync: SyncStatusResponse | null;
  onToast: (m: string) => void;
  onChanged: () => void;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-6 py-6">
      <JobsSection onToast={onToast} onChanged={onChanged} />
      <ContactsSection sync={sync} onToast={onToast} />
      <RemindersSection sync={sync} onToast={onToast} />
    </div>
  );
}
