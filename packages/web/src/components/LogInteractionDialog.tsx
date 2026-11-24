import type { Customer, Interaction } from '@insurance-crm/shared';
import { useEffect, useRef, useState } from 'react';

interface Props {
  customer: Customer | null;
  open: boolean;
  onClose: () => void;
  onSave: (payload: {
    channel: Interaction['channel'];
    outcome: Interaction['outcome'];
    summary: string;
    followup_title?: string;
    enqueue_kjgx_visit: boolean;
  }) => Promise<void>;
}

export function LogInteractionDialog({ customer, open, onClose, onSave }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [channel, setChannel] = useState<Interaction['channel']>('phone');
  const [outcome, setOutcome] = useState<Interaction['outcome']>('connected');
  const [summary, setSummary] = useState('');
  const [followupTitle, setFollowupTitle] = useState('');
  const [enqueueKjgx, setEnqueueKjgx] = useState(true);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && customer) {
      setChannel('phone');
      setOutcome('connected');
      setSummary('');
      setFollowupTitle('');
      setEnqueueKjgx(true);
      if (!dialog.open) dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, customer]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onDialogClose = () => {
      const val = dialog.returnValue;
      dialog.returnValue = '';
      if (val === 'save' && summary.trim()) {
        void onSave({
          channel,
          outcome,
          summary: summary.trim(),
          followup_title: followupTitle.trim() || undefined,
          enqueue_kjgx_visit: enqueueKjgx,
        });
      }
      onClose();
    };
    dialog.addEventListener('close', onDialogClose);
    return () => dialog.removeEventListener('close', onDialogClose);
  }, [channel, outcome, summary, followupTitle, enqueueKjgx, onSave, onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || 'closedBy' in HTMLDialogElement.prototype) return;
    const outside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let downOut = false;
    const onDown = (e: PointerEvent) => {
      downOut = outside(e);
    };
    const onUp = (e: PointerEvent) => {
      if (downOut && outside(e)) dialog.close('cancel');
    };
    dialog.addEventListener('pointerdown', onDown);
    dialog.addEventListener('pointerup', onUp);
    return () => {
      dialog.removeEventListener('pointerdown', onDown);
      dialog.removeEventListener('pointerup', onUp);
    };
  }, []);

  return (
    <dialog ref={ref} {...({ closedby: 'any' } as Record<string, string>)} aria-labelledby="log-dialog-title">
      <form method="dialog" className="p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--card-border)] pb-3">
          <div>
            <h1 id="log-dialog-title" className="text-base font-semibold">
              速记沟通 / 挂断后录入
            </h1>
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
              当前客户：{customer?.name ?? ''}（{customer?.primary_phone ?? '-'}）
            </p>
          </div>
          <button
            type="submit"
            value="cancel"
            aria-label="关闭弹窗"
            className="px-2 py-1 text-xs rounded-md border border-[var(--border)] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="log-ch" className="block font-medium mb-1">
                沟通渠道
              </label>
              <select
                id="log-ch"
                value={channel}
                onChange={(e) => setChannel(e.target.value as Interaction['channel'])}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
              >
                <option value="phone">电话外呼</option>
                <option value="platform_event">平台会面谈</option>
                <option value="wechat">微信沟通</option>
                <option value="in_person_visit">独立拜访</option>
                <option value="policy_review">保单检视</option>
              </select>
            </div>
            <div>
              <label htmlFor="log-out" className="block font-medium mb-1">
                本次结果
              </label>
              <select
                id="log-out"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as Interaction['outcome'])}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
              >
                <option value="connected">已接通 · 正常交流</option>
                <option value="invited">已约上平台会</option>
                <option value="attended">已到场参加</option>
                <option value="no_answer">未接听 / 改日再打</option>
                <option value="rejected">明确暂不考虑</option>
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="log-sum" className="block font-medium mb-1">
              沟通摘要（仅追加，不覆盖主档资料）
            </label>
            <textarea
              id="log-sum"
              rows={3}
              autoFocus
              required
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="例如：已确认老保单缴费状况，约定下周三再电联。"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
            />
          </div>
          <div>
            <label htmlFor="log-fu" className="block font-medium mb-1">
              顺手创建提醒（自动路由至 iPhone「工作待办 Work」）
            </label>
            <input
              id="log-fu"
              type="text"
              value={followupTitle}
              onChange={(e) => setFollowupTitle(e.target.value)}
              placeholder="例如：下周三上午回访确认方案"
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
            />
          </div>
          <label className="flex items-center gap-2 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={enqueueKjgx}
              onChange={(e) => setEnqueueKjgx(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            <span>生成「科技个险拜访记录」待审批回写任务</span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--card-border)]">
          <button type="submit" value="cancel" className="px-3 py-2 text-xs rounded-lg border border-[var(--border)] cursor-pointer">
            取消
          </button>
          <button
            type="submit"
            value="save"
            className="px-3.5 py-2 text-xs font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer"
          >
            写入时间轴
          </button>
        </div>
      </form>
    </dialog>
  );
}
