import {
  type Customer,
  type DeskCustomer,
  type Followup,
  type Interaction,
  RAPPORT_TAGS,
} from '@insurance-crm/shared';
import { Calendar, Check, Contact, Copy, Pencil, Phone, Star, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { type Customer360Response, type SyncStatusResponse, api } from '../api.js';
import { useDialogControl } from '../lib/dialog.js';
import {
  buildInfoCard,
  CHANNEL_LABEL,
  copyText,
  fmtDateTime,
  fmtMoney,
  fmtShortDate,
  followupUrgency,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RAPPORT_LABEL,
  RAPPORT_TONE,
} from '../lib/format.js';
import { pushToast } from '../lib/toast-bus.js';
import { badgeCls, btn, btnPrimary, inputCls, selectCls } from '../lib/ui.js';
import { CallSummary, QuickActions, type QuickOutcome } from './DeskTable.js';
import { EditCustomerDialog } from './EditCustomerDialog.js';

const NOTE_KINDS: ReadonlyArray<{
  value: string;
  label: string;
  channel: Interaction['channel'];
  outcome: Interaction['outcome'];
}> = [
  { value: 'note', label: '仅备注', channel: 'other', outcome: 'followed_up' },
  { value: 'connected', label: '电话 · 已接通', channel: 'phone', outcome: 'connected' },
  { value: 'no_answer', label: '电话 · 未接', channel: 'phone', outcome: 'no_answer' },
  { value: 'rejected', label: '电话 · 拒绝', channel: 'phone', outcome: 'rejected' },
  { value: 'invited', label: '电话 · 邀约成功', channel: 'phone', outcome: 'invited' },
];

type TimelineItem =
  | { kind: 'interaction'; ts: number; dateStr: string; data: Interaction }
  | { kind: 'followup'; ts: number; dateStr: string; data: Followup };

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3.5 py-2.5 text-[13px]">
      <dt className="w-24 shrink-0 text-[color:var(--muted-foreground)]">{label}</dt>
      <dd className="tnum min-w-0 flex-1 text-right font-medium text-[color:var(--foreground)] break-words">
        {children}
      </dd>
    </div>
  );
}

export function CustomerDrawer({
  customer,
  open,
  onClose,
  onQuick,
  onDial,
  onUpdateField,
  onDeleteCustomer,
  sync,
  onToast,
  onChanged,
  refreshSignal = 0,
}: {
  customer: DeskCustomer | null;
  open: boolean;
  onClose: () => void;
  onQuick: (c: DeskCustomer, o: QuickOutcome) => void;
  onDial: (c: DeskCustomer) => void;
  onUpdateField?: (
    c: DeskCustomer,
    patch: Partial<Pick<Customer, 'rapport_tag' | 'visit_priority' | 'next_followup_at'>>,
    successText?: string,
  ) => void;
  onDeleteCustomer?: (c: DeskCustomer) => void;
  sync: SyncStatusResponse | null;
  onToast: (msg: string) => void;
  onChanged: () => void;
  refreshSignal?: number;
}) {
  const { ref, close } = useDialogControl(open, onClose);
  const titleId = useId();
  const [detail, setDetail] = useState<Customer360Response | null>(null);
  const [tick, setTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [noteKind, setNoteKind] = useState('note');
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set());

  const customerId = customer?.id;

  useEffect(() => {
    setDetail(null);
    setNoteText('');
    setNoteKind('note');
    setCopied(false);
    setPendingDeleteIds(new Set());
  }, [customerId]);

  useEffect(() => {
    if (!open || !customerId) return;
    let cancelled = false;
    api
      .getCustomer360(customerId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => onToast(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [open, customerId, tick, refreshSignal, onToast]);

  const copyCard = useCallback(async () => {
    if (!detail || !customer) return;
    const ok = await copyText(buildInfoCard(detail, customer.age));
    setCopied(ok);
    onToast(ok ? '完整信息卡已复制，可直接发给 MUSE' : '复制失败，请重试');
    if (ok) setTimeout(() => setCopied(false), 2000);
  }, [detail, customer, onToast]);

  const writeContacts = async () => {
    if (!customer) return;
    setBusy(true);
    try {
      const res = await api.applyIcloudSync({ customer_id: customer.id, create_missing: true });
      onToast(`已写入 iPhone 通讯录（新建 ${res.created_customers?.length ?? 0}，更新 ${res.pushed_customers.length}）`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if (!customer || !noteText.trim()) return;
    const kind = NOTE_KINDS.find((k) => k.value === noteKind) ?? NOTE_KINDS[0]!;
    setBusy(true);
    try {
      await api.logInteraction(customer.id, {
        channel: kind.channel,
        outcome: kind.outcome,
        summary: noteText.trim(),
      });
      setNoteText('');
      setTick((t) => t + 1);
      onChanged();
      onToast('已保存沟通记录');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteInteraction = (it: Interaction) => {
    setPendingDeleteIds((prev) => new Set(prev).add(it.id));
    pushToast({
      text: `已删除「${OUTCOME_LABEL[it.outcome] ?? it.outcome}」记录`,
      durationMs: 5000,
      onUndo: () => {
        setPendingDeleteIds((prev) => {
          const next = new Set(prev);
          next.delete(it.id);
          return next;
        });
      },
      onExpire: () => {
        void api
          .deleteInteraction(it.id)
          .then(() => {
            setTick((t) => t + 1);
            onChanged();
          })
          .catch((err) => {
            setPendingDeleteIds((prev) => {
              const next = new Set(prev);
              next.delete(it.id);
              return next;
            });
            onToast(err instanceof Error ? err.message : '删除失败');
          });
      },
    });
  };

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!detail) return [];
    const items: TimelineItem[] = [];
    for (const it of detail.interactions) {
      if (pendingDeleteIds.has(it.id)) continue;
      items.push({
        kind: 'interaction',
        ts: Date.parse(it.occurred_at) || 0,
        dateStr: it.occurred_at,
        data: it,
      });
    }
    for (const fu of detail.followups) {
      const refDate = fu.completed_at ?? fu.due_at ?? fu.created_at;
      items.push({
        kind: 'followup',
        ts: Date.parse(refDate) || 0,
        dateStr: refDate,
        data: fu,
      });
    }
    return items.sort((a, b) => b.ts - a.ts);
  }, [detail, pendingDeleteIds]);

  const c = detail?.customer;
  const contactsEnabled = Boolean(sync?.contacts?.contacts_write_enabled);
  const nextFollowupDateValue = customer?.next_followup_at ? customer.next_followup_at.slice(0, 10) : '';
  const urgency = followupUrgency(customer?.next_followup_at);

  return (
    <>
      <dialog ref={ref} className="drawer" aria-labelledby={titleId}>
        {customer && (
          <div className="flex min-h-full flex-col pb-[env(safe-area-inset-bottom)]">
            <header className="sticky top-0 z-10 space-y-3 border-b border-[var(--card-border)] bg-[var(--surface-elevated)] px-4 py-3.5 md:px-6 md:py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id={titleId} className="text-[16px] font-semibold tracking-tight">
                      {customer.name}
                    </h2>
                    <span className={badgeCls(RAPPORT_TONE[customer.rapport_tag] ?? 'neutral')}>
                      {RAPPORT_LABEL[customer.rapport_tag] ?? customer.rapport_tag}
                    </span>
                    {onUpdateField && (
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateField(
                            customer,
                            { visit_priority: customer.visit_priority === 'high' ? null : 'high' },
                            customer.visit_priority === 'high' ? '已取消重点跟进' : '已设为重点跟进',
                          )
                        }
                        aria-label={customer.visit_priority === 'high' ? '取消重点跟进' : '设为重点跟进'}
                        title={customer.visit_priority === 'high' ? '取消重点跟进' : '设为重点跟进'}
                        className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[13px] transition-colors duration-120 ${
                          customer.visit_priority === 'high'
                            ? 'border-[var(--warning-border)] bg-[var(--warning-bg)] text-[color:var(--warning)]'
                            : 'border-[var(--card-border)] bg-[var(--card)] text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]'
                        }`}
                      >
                        <Star className={`size-3 ${customer.visit_priority === 'high' ? 'fill-current' : ''}`} />
                        <span>重点</span>
                      </button>
                    )}
                  </div>
                  <p className="tnum text-[13px] text-[color:var(--muted-foreground)]">
                    {[
                      customer.gender !== '未知' ? customer.gender : '',
                      customer.age != null ? `${customer.age}岁` : '',
                      customer.total_premium ? `${fmtMoney(customer.total_premium)}（${customer.policy_total} 张）` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || '资料待补全'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="关闭详情"
                  autoFocus
                  className="touch-icon-hit grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-[color:var(--muted-foreground)] transition-colors duration-120 hover:bg-[var(--hover)] hover:text-[color:var(--foreground)]"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={copyCard} disabled={!detail} className={btnPrimary}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  复制完整信息卡（给 MUSE）
                </button>
                <button
                  type="button"
                  onClick={writeContacts}
                  disabled={busy || !contactsEnabled}
                  title={contactsEnabled ? undefined : '通讯录写入闸门未开启'}
                  className={btn}
                >
                  <Contact className="size-3.5" />
                  写入通讯录
                </button>
                <button type="button" onClick={() => setEditOpen(true)} disabled={!c} className={btn}>
                  <Pencil className="size-3.5" />
                  编辑
                </button>
                {onDeleteCustomer && (
                  <button
                    type="button"
                    onClick={() => onDeleteCustomer(customer)}
                    className={`${btn} hover:border-[var(--error)] hover:text-[color:var(--error)]`}
                  >
                    <Trash2 className="size-3.5" />
                    删除
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <CallSummary c={customer} />
                <QuickActions onQuick={(o) => onQuick(customer, o)} />
              </div>
            </header>

            <div className="space-y-5 px-4 py-4 md:px-6 md:py-5">
              {/* Inline workflow controls: stage + next followup date */}
              {onUpdateField && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--card-border)] bg-[var(--surface-subtle)] px-3.5 py-2.5">
                  <label className="flex items-center gap-2 text-[13px]">
                    <span className="text-[color:var(--muted-foreground)]">跟进阶段</span>
                    <select
                      value={customer.rapport_tag}
                      onChange={(e) => {
                        const tag = e.target.value as Customer['rapport_tag'];
                        onUpdateField(customer, { rapport_tag: tag }, `已更新阶段为「${RAPPORT_LABEL[tag]}」`);
                      }}
                      className={`${selectCls} h-7 leading-7`}
                    >
                      {RAPPORT_TAGS.map((tag) => (
                        <option key={tag} value={tag}>
                          {RAPPORT_LABEL[tag]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-[13px]">
                    <span className="inline-flex items-center gap-1 text-[color:var(--muted-foreground)]">
                      <Calendar className="size-3.5" />
                      下次跟进
                    </span>
                    <input
                      type="date"
                      value={nextFollowupDateValue}
                      onChange={(e) => {
                        const val = e.target.value ? `${e.target.value}T09:00:00.000Z` : null;
                        onUpdateField(
                          customer,
                          { next_followup_at: val },
                          val ? `已设置下次跟进：${e.target.value}` : '已清除下次跟进日期',
                        );
                      }}
                      className={`${inputCls} tnum h-7 ${
                        urgency === 'overdue'
                          ? 'border-[var(--error-border)] text-[color:var(--error)]'
                          : urgency === 'today'
                            ? 'border-[var(--warning-border)] text-[color:var(--warning)]'
                            : ''
                      }`}
                    />
                  </label>
                </div>
              )}

              {/* Quick follow-up note composer */}
              <section aria-label="快捷记跟进" className="rounded-lg border border-[var(--card-border)] bg-[var(--surface-subtle)] p-3">
                <form
                  className="space-y-2.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveNote();
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-[color:var(--foreground)]">快捷写跟进</span>
                    <select
                      aria-label="记录类型"
                      value={noteKind}
                      onChange={(e) => setNoteKind(e.target.value)}
                      className={`${selectCls} h-7 leading-7`}
                    >
                      {NOTE_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    rows={2}
                    aria-label="沟通内容"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && noteText.trim() && !busy) {
                        e.preventDefault();
                        void saveNote();
                      }
                    }}
                    placeholder="记录沟通要点或客户反馈（Cmd/Ctrl + Enter 提交）"
                    className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-2 text-[13px] text-[color:var(--foreground)] placeholder:text-[color:var(--muted-foreground)] outline-none transition-[border-color,box-shadow] duration-120 focus-visible:border-[color:var(--foreground)]/45 focus-visible:ring-[3px] focus-visible:ring-[var(--ring)]"
                  />
                  <div className="flex items-center justify-end">
                    <button type="submit" disabled={busy || !noteText.trim()} className={btnPrimary}>
                      保存跟进
                    </button>
                  </div>
                </form>
              </section>

              {/* Twenty-style flat property table */}
              <section aria-label="核心资料" className="space-y-2">
                <h3 className="text-[13px] font-medium text-[color:var(--muted-foreground)]">核心资料</h3>
                <dl className="divide-y divide-[var(--card-border)] rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
                  <PropertyRow label="手机">
                    {customer.primary_phone ? (
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <a
                          href={`tel:${customer.primary_phone}`}
                          onClick={() => onDial(customer)}
                          className="tnum inline-flex items-center gap-1.5 text-[color:var(--foreground)] hover:underline"
                        >
                          <Phone className="size-3.5 text-[color:var(--muted-foreground)]" aria-hidden="true" />
                          {customer.primary_phone}
                        </a>
                        <button
                          type="button"
                          aria-label="复制手机号"
                          onClick={() =>
                            void copyText(customer.primary_phone!).then((ok) =>
                              onToast(ok ? `已复制 ${customer.primary_phone}` : '复制失败'),
                            )
                          }
                          className="touch-icon-hit grid size-6 cursor-pointer place-items-center rounded text-[color:var(--muted-foreground)] hover:bg-[var(--hover)] hover:text-[color:var(--foreground)]"
                        >
                          <Copy className="size-3" />
                        </button>
                      </span>
                    ) : (
                      '—'
                    )}
                  </PropertyRow>
                  <PropertyRow label="身份证">{c?.id_no ?? customer.id_no ?? '—'}</PropertyRow>
                  <PropertyRow label="出生日期">{customer.birthday ?? '—'}</PropertyRow>
                  <PropertyRow label="居住地址">{customer.address ?? '—'}</PropertyRow>
                  <PropertyRow label="单位 / 职业">{customer.company_or_occupation ?? '—'}</PropertyRow>
                  <PropertyRow label="科技个险">{customer.kjgx_customer_no ?? customer.kjgx_db_customer_id ?? '—'}</PropertyRow>
                  {customer.manual_summary && (
                    <PropertyRow label="客户备注">
                      {customer.manual_summary.replace(/\[#CRM-BEGIN\][\s\S]*?\[#CRM-END\]/g, '').trim() || '—'}
                    </PropertyRow>
                  )}
                </dl>
              </section>

              {/* Policies */}
              <section aria-label="保单明细" className="space-y-2">
                <h3 className="text-[13px] font-medium text-[color:var(--muted-foreground)]">
                  保单明细{detail ? `（${detail.policies.length}）` : ''}
                </h3>
                {detail && detail.policies.length === 0 && (
                  <p className="rounded-lg border border-[var(--card-border)] px-3.5 py-3 text-[13px] text-[color:var(--muted-foreground)]">
                    暂无保单
                  </p>
                )}
                {detail && detail.policies.length > 0 && (
                  <ul className="divide-y divide-[var(--card-border)] rounded-lg border border-[var(--card-border)] bg-[var(--card)]">
                    {detail.policies.map((p) => (
                      <li key={p.id} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium">{p.product_name ?? '未命名险种'}</div>
                          <div className="tnum text-[13px] text-[color:var(--muted-foreground)]">
                            {p.policy_no} · {p.holder_role}
                          </div>
                        </div>
                        <div className="tnum shrink-0 text-[13px] font-medium">{fmtMoney(p.annual_premium)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Reverse-chronological Timeline */}
              <section aria-label="跟进时间轴" className="space-y-2.5">
                <h3 className="text-[13px] font-medium text-[color:var(--muted-foreground)]">跟进时间轴</h3>
                {detail && timeline.length === 0 && (
                  <p className="rounded-lg border border-[var(--card-border)] px-3.5 py-3 text-[13px] text-[color:var(--muted-foreground)]">
                    暂无沟通或跟进记录
                  </p>
                )}
                {timeline.length > 0 && (
                  <ol className="relative space-y-4 pl-5 before:absolute before:inset-y-1.5 before:left-[7px] before:w-px before:bg-[var(--card-border)]">
                    {timeline.map((item) => {
                      if (item.kind === 'interaction') {
                        const it = item.data;
                        return (
                          <li key={`it-${it.id}`} className="group relative">
                            <span
                              aria-hidden="true"
                              className="absolute -left-5 top-1.5 size-3.5 rounded-full border-2 border-[var(--surface-elevated)] bg-[var(--foreground)]/70"
                            />
                            <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-3.5 py-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className={badgeCls(OUTCOME_TONE[it.outcome] ?? 'neutral')}>
                                    {CHANNEL_LABEL[it.channel] ?? it.channel} · {OUTCOME_LABEL[it.outcome] ?? it.outcome}
                                  </span>
                                  <span className="text-[13px] text-[color:var(--muted-foreground)]">
                                    {it.recorded_by_actor}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteInteraction(it)}
                                  aria-label="删除此记录"
                                  className="touch-icon-hit inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-[13px] text-[color:var(--muted-foreground)] transition-colors duration-120 hover:bg-[var(--hover)] hover:text-[color:var(--error)]"
                                >
                                  <Trash2 className="size-3.5" />
                                  删除
                                </button>
                              </div>
                              <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                                {it.summary}
                              </p>
                              <div className="mt-1.5 flex justify-end">
                                <span className="tnum text-[13px] text-[color:var(--muted-foreground)]">
                                  {fmtDateTime(it.occurred_at)}
                                </span>
                              </div>
                            </div>
                          </li>
                        );
                      }

                      const fu = item.data;
                      return (
                        <li key={`fu-${fu.id}`} className="relative">
                          <span
                            aria-hidden="true"
                            className={`absolute -left-5 top-1.5 size-3.5 rounded-full border-2 border-[var(--surface-elevated)] ${
                              fu.status === 'done' ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'
                            }`}
                          />
                          <div className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-3.5 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className={badgeCls(fu.status === 'done' ? 'success' : 'warning')}>
                                待办 · {fu.status === 'done' ? '已完成' : fu.status === 'cancelled' ? '已取消' : '待跟进'}
                              </span>
                              {fu.due_at && (
                                <span className="tnum text-[13px] text-[color:var(--muted-foreground)]">
                                  计划 {fmtShortDate(fu.due_at)}
                                </span>
                              )}
                            </div>
                            <p className="mt-1.5 text-[13px] font-medium">{fu.title}</p>
                            {fu.notes && (
                              <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-[color:var(--muted-foreground)]">
                                {fu.notes}
                              </p>
                            )}
                            <div className="mt-1.5 flex justify-end">
                              <span className="tnum text-[13px] text-[color:var(--muted-foreground)]">
                                {fmtDateTime(fu.completed_at ?? fu.created_at)}
                              </span>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </div>
          </div>
        )}
      </dialog>

      <EditCustomerDialog
        customer={editOpen && c ? c : null}
        open={editOpen && Boolean(c)}
        onClose={() => setEditOpen(false)}
        onSave={async (patch) => {
          if (!c) return;
          await api.updateCustomer(c.id, { expected_version: c.version, ...patch });
          onToast(`已保存 ${c.name} 资料${patch.enqueue_kjgx_writeback ? '，并生成科技个险回写任务' : ''}`);
          setTick((t) => t + 1);
          onChanged();
        }}
      />
    </>
  );
}
