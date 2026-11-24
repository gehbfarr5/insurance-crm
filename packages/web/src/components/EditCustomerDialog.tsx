import type { Customer } from '@insurance-crm/shared';
import { useEffect, useRef, useState } from 'react';

interface Props {
  customer: Customer | null;
  open: boolean;
  onClose: () => void;
  onSave: (patch: {
    primary_phone: string;
    address: string;
    birthday: string | null;
    rapport_tag: Customer['rapport_tag'];
    enqueue_kjgx_writeback: boolean;
  }) => Promise<void>;
}

export function EditCustomerDialog({ customer, open, onClose, onSave }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [birthday, setBirthday] = useState('');
  const [rapport, setRapport] = useState<Customer['rapport_tag']>('unassessed');
  const [enqueueKjgx, setEnqueueKjgx] = useState(true);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && customer) {
      setPhone(customer.primary_phone ?? '');
      setAddress(customer.address ?? '');
      setBirthday(customer.birthday ?? '');
      setRapport(customer.rapport_tag);
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
      if (val === 'save') {
        void onSave({
          primary_phone: phone,
          address,
          birthday: birthday || null,
          rapport_tag: rapport,
          enqueue_kjgx_writeback: enqueueKjgx,
        });
      }
      onClose();
    };
    dialog.addEventListener('close', onDialogClose);
    return () => dialog.removeEventListener('close', onDialogClose);
  }, [phone, address, birthday, rapport, enqueueKjgx, onSave, onClose]);

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
    <dialog ref={ref} {...({ closedby: 'any' } as Record<string, string>)} aria-labelledby="edit-dialog-title">
      <form method="dialog" className="p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--card-border)] pb-3">
          <div>
            <h1 id="edit-dialog-title" className="text-base font-semibold">
              编辑客户资料（{customer?.name ?? ''}）
            </h1>
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
              保存后同步更新主库与 iCloud 队列，并按需生成科技个险回写 Diff
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
          <div>
            <label htmlFor="dlg-phone" className="block font-medium mb-1">
              主手机号
            </label>
            <input
              id="dlg-phone"
              type="tel"
              autoFocus
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
            />
          </div>
          <div>
            <label htmlFor="dlg-addr" className="block font-medium mb-1">
              联系地址
            </label>
            <input
              id="dlg-addr"
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="dlg-bday" className="block font-medium mb-1">
                出生日期
              </label>
              <input
                id="dlg-bday"
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
              />
            </div>
            <div>
              <label htmlFor="dlg-rapport" className="block font-medium mb-1">
                人工沟通体感（仅本地）
              </label>
              <select
                id="dlg-rapport"
                value={rapport}
                onChange={(e) => setRapport(e.target.value as Customer['rapport_tag'])}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
              >
                <option value="friendly">沟通顺畅 / 和气</option>
                <option value="neutral">中性待观察</option>
                <option value="cautious">表达强势 / 需留心</option>
                <option value="paused">暂缓投入</option>
                <option value="unassessed">尚未评估</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={enqueueKjgx}
              onChange={(e) => setEnqueueKjgx(e.target.checked)}
              className="accent-[var(--primary)]"
            />
            <span>同时生成一条「科技个险资料回写」待审批任务</span>
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
            保存并生成回写草稿
          </button>
        </div>
      </form>
    </dialog>
  );
}
