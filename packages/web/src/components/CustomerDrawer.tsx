import type { DeskCustomer, Interaction } from '@insurance-crm/shared';
import { Check, Contact, Copy, Pencil, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { type Customer360Response, type SyncStatusResponse, api } from '../api.js';
import { useDialogControl } from '../lib/dialog.js';
import { buildInfoCard, CHANNEL_LABEL, copyText, fmtDateTime, fmtMoney, OUTCOME_LABEL } from '../lib/format.js';
import { btn, btnPrimary, inputCls, selectCls } from '../lib/ui.js';
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

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-[color:var(--muted-foreground)]">{label}</dt>
      <dd className="tnum break-words font-medium">{value || '—'}</dd>
    </div>
  );
}

export function CustomerDrawer({
  customer,
  open,
  onClose,
  onQuick,
  sync,
  onToast,
  onChanged,
  refreshSignal = 0,
}: {
  customer: DeskCustomer | null;
  open: boolean;
  onClose: () => void;
  onQuick: (c: DeskCustomer, o: QuickOutcome) => void;
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const customerId = customer?.id;

  useEffect(() => {
    setDetail(null);
    setNoteText('');
    setNoteKind('note');
    setCopied(false);
    setConfirmDeleteId(null);
  }, [customerId]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = window.setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmDeleteId]);

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

  const handleDeleteInteraction = async (interactionId: string) => {
    if (confirmDeleteId !== interactionId) {
      setConfirmDeleteId(interactionId);
      return;
    }
    setDeletingId(interactionId);
    try {
      await api.deleteInteraction(interactionId);
      setConfirmDeleteId(null);
      setTick((t) => t + 1);
      onChanged();
      onToast('已删除沟通记录');
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  };

  const c = detail?.customer;
  const contactsEnabled = Boolean(sync?.contacts?.contacts_write_enabled);

  return (
    <>
      <dialog ref={ref} className="drawer" aria-labelledby={titleId}>
        {customer && (
          <div className="flex min-h-full flex-col">
            <header className="sticky top-0 z-10 space-y-3 border-b border-[var(--card-border)] bg-[var(--card)] px-6 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 id={titleId} className="text-[17px] font-semibold">
                    {customer.name}
                  </h2>
                  <p className="text-[12.5px] text-[color:var(--muted-foreground)]">
                    {[customer.gender !== '未知' ? customer.gender : '', customer.age != null ? `${customer.age}岁` : '']
                      .filter(Boolean)
                      .join(' · ') || '资料待补全'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="关闭详情"
                  autoFocus
                  className="grid size-8 cursor-pointer place-items-center rounded-lg text-[color:var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[color:var(--foreground)]"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
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
                  写入 iPhone 通讯录
                </button>
                <button type="button" onClick={() => setEditOpen(true)} disabled={!c} className={btn}>
                  <Pencil className="size-3.5" />
                  编辑资料
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CallSummary c={customer} />
                <QuickActions onQuick={(o) => onQuick(customer, o)} />
              </div>
            </header>

            <div className="space-y-6 px-6 py-5">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5">
                <Fact label="手机" value={customer.primary_phone} />
                <Fact label="身份证" value={c?.id_no ?? customer.id_no} />
                <Fact label="出生日期" value={customer.birthday} />
                <Fact label="总保费" value={customer.total_premium ? `${fmtMoney(customer.total_premium)}（${customer.policy_total} 张）` : null} />
                <div className="col-span-2">
                  <Fact label="居住地址" value={customer.address} />
                </div>
                <Fact label="单位 / 职业" value={customer.company_or_occupation} />
                <Fact label="科技个险" value={customer.kjgx_customer_no ?? customer.kjgx_db_customer_id} />
                {customer.manual_summary && (
                  <div className="col-span-2">
                    <Fact label="备注" value={customer.manual_summary.replace(/\[#CRM-BEGIN\][\s\S]*?\[#CRM-END\]/g, '').trim()} />
                  </div>
                )}
              </dl>

              <section aria-label="保单明细" className="space-y-2">
                <h3 className="text-[12px] font-medium text-[color:var(--muted-foreground)]">保单明细</h3>
                {detail && detail.policies.length === 0 && <p className="text-[color:var(--muted-foreground)]">暂无保单</p>}
                <ul className="divide-y divide-[var(--card-border)] rounded-lg border border-[var(--card-border)]">
                  {detail?.policies.map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{p.product_name ?? '未命名险种'}</div>
                        <div className="tnum text-[12px] text-[color:var(--muted-foreground)]">
                          {p.policy_no} · {p.holder_role}
                        </div>
                      </div>
                      <div className="tnum shrink-0 font-medium">{fmtMoney(p.annual_premium)}</div>
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-label="沟通记录" className="space-y-3">
                <h3 className="text-[12px] font-medium text-[color:var(--muted-foreground)]">沟通记录</h3>
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveNote();
                  }}
                >
                  <select
                    aria-label="记录类型"
                    value={noteKind}
                    onChange={(e) => setNoteKind(e.target.value)}
                    className={selectCls}
                  >
                    {NOTE_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="沟通内容"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="补一句备注（详细沟通可交给 MUSE）"
                    className={`${inputCls} min-w-[12rem] flex-1`}
                  />
                  <button type="submit" disabled={busy || !noteText.trim()} className={btn}>
                    保存
                  </button>
                </form>
                <ol className="space-y-2">
                  {detail?.interactions.map((it) => {
                    const confirming = confirmDeleteId === it.id;
                    const deleting = deletingId === it.id;
                    return (
                      <li key={it.id} className="group rounded-lg border border-[var(--card-border)] px-3 py-2">
                        <div className="flex items-center justify-between gap-2 text-[12px] text-[color:var(--muted-foreground)]">
                          <span>
                            {CHANNEL_LABEL[it.channel] ?? it.channel} · {OUTCOME_LABEL[it.outcome] ?? it.outcome} ·{' '}
                            {it.recorded_by_actor}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="tnum">{fmtDateTime(it.occurred_at)}</span>
                            <button
                              type="button"
                              disabled={deleting}
                              onClick={() => void handleDeleteInteraction(it.id)}
                              aria-label={confirming ? '确认删除此记录' : '删除此记录'}
                              className={`inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-[11.5px] transition-colors ${
                                confirming
                                  ? 'bg-[var(--error)] font-medium text-white'
                                  : 'text-[color:var(--muted-foreground)] opacity-75 hover:bg-[var(--secondary)] hover:text-[color:var(--error)] hover:opacity-100'
                              }`}
                            >
                              <Trash2 className="size-3" />
                              {confirming ? (deleting ? '删除中…' : '确认删除') : '删除'}
                            </button>
                          </div>
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap break-words">{it.summary}</p>
                      </li>
                    );
                  })}
                  {detail && detail.interactions.length === 0 && (
                    <li className="text-[color:var(--muted-foreground)]">暂无沟通记录</li>
                  )}
                </ol>
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
