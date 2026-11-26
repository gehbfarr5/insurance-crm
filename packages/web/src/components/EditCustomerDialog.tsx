import type { Customer } from '@insurance-crm/shared';
import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useDialogControl } from '../lib/dialog.js';
import { btn, btnPrimary, inputCls, selectCls } from '../lib/ui.js';

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
  const { ref, close } = useDialogControl(open, onClose);
  const titleId = useId();
  const phoneId = useId();
  const addrId = useId();
  const bdayId = useId();
  const rapportId = useId();

  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [birthday, setBirthday] = useState('');
  const [rapport, setRapport] = useState<Customer['rapport_tag']>('unassessed');
  const [enqueueKjgx, setEnqueueKjgx] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && customer) {
      setPhone(customer.primary_phone ?? '');
      setAddress(customer.address ?? '');
      setBirthday(customer.birthday ?? '');
      setRapport(customer.rapport_tag);
      setEnqueueKjgx(true);
      setErr(null);
    }
  }, [open, customer]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setErr(null);
    try {
      await onSave({
        primary_phone: phone.trim(),
        address: address.trim(),
        birthday: birthday || null,
        rapport_tag: rapport,
        enqueue_kjgx_writeback: enqueueKjgx,
      });
      close();
    } catch (error) {
      setErr(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={ref} aria-labelledby={titleId}>
      <form onSubmit={submit} className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-[15px] font-semibold">
            编辑资料 · {customer?.name ?? ''}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="grid size-8 cursor-pointer place-items-center rounded-lg text-[color:var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[color:var(--foreground)]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3">
          <label htmlFor={phoneId} className="block space-y-1">
            <span className="text-[12px] text-[color:var(--muted-foreground)]">主手机号</span>
            <input
              id={phoneId}
              type="tel"
              autoFocus
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={`${inputCls} tnum w-full`}
            />
          </label>
          <label htmlFor={addrId} className="block space-y-1">
            <span className="text-[12px] text-[color:var(--muted-foreground)]">居住地址</span>
            <input
              id={addrId}
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className={`${inputCls} w-full`}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label htmlFor={bdayId} className="block space-y-1">
              <span className="text-[12px] text-[color:var(--muted-foreground)]">出生日期</span>
              <input
                id={bdayId}
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
                className={`${inputCls} tnum w-full`}
              />
            </label>
            <label htmlFor={rapportId} className="block space-y-1">
              <span className="text-[12px] text-[color:var(--muted-foreground)]">沟通体感</span>
              <select
                id={rapportId}
                value={rapport}
                onChange={(e) => setRapport(e.target.value as Customer['rapport_tag'])}
                className={`${selectCls} w-full`}
              >
                <option value="friendly">沟通顺畅</option>
                <option value="neutral">中性待观察</option>
                <option value="cautious">需留心</option>
                <option value="paused">暂缓</option>
                <option value="unassessed">未评估</option>
              </select>
            </label>
          </div>
          <label className="flex cursor-pointer items-center gap-2 pt-1 text-[12.5px]">
            <input
              type="checkbox"
              checked={enqueueKjgx}
              onChange={(e) => setEnqueueKjgx(e.target.checked)}
              className="size-3.5 accent-[var(--primary)]"
            />
            <span>同步生成科技个险回写任务</span>
          </label>
          {err && <p className="text-[12.5px] text-[color:var(--error)]">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={close} className={btn}>
            取消
          </button>
          <button type="submit" disabled={saving} className={btnPrimary}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
