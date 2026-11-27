import { motion } from 'motion/react';
import { RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { type KjgxWorkerStatusResponse, api } from '../api.js';
import { useDialogControl } from '../lib/dialog.js';
import { fmtDateTime } from '../lib/format.js';
import type { KjgxState } from '../lib/kjgx.js';
import { btn, btnPrimary, inputCls } from '../lib/ui.js';

const DOT: Record<KjgxState, string> = {
  checking: 'bg-[var(--muted-foreground)]',
  connected: 'bg-[var(--success)]',
  expired: 'bg-[var(--warning)]',
};

const LABEL: Record<KjgxState, string> = {
  checking: '检查中',
  connected: '已连接',
  expired: '需验证',
};

export function KjgxCapsule({
  state,
  status,
  onClick,
}: {
  state: KjgxState;
  status: KjgxWorkerStatusResponse | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="touch-icon-hit inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 text-[13px] transition-colors hover:bg-[var(--secondary)] sm:gap-2 sm:px-3"
    >
      <motion.span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${DOT[state]}`}
        animate={state === 'checking' ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
        transition={state === 'checking' ? { duration: 1.2, repeat: Infinity } : undefined}
      />
      <span>
        <span className="hidden sm:inline">科技个险 · </span>
        {LABEL[state]}
        {state === 'connected' && status?.emp_name ? (
          <span className="hidden md:inline"> · {status.emp_name}</span>
        ) : null}
      </span>
    </button>
  );
}

type Msg = { kind: 'error' | 'info'; text: string } | null;

export function KjgxPanel({
  open,
  onClose,
  state,
  status,
  check,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  state: KjgxState;
  status: KjgxWorkerStatusResponse | null;
  check: (forceProbe?: boolean) => Promise<boolean>;
  onToast: (msg: string) => void;
}) {
  const { ref, close } = useDialogControl(open, onClose);
  const titleId = useId();
  const captchaId = useId();
  const smsId = useId();
  const empId = useId();
  const pwdId = useId();

  const [mode, setMode] = useState<'info' | 'verify'>('verify');
  const [verifyId, setVerifyId] = useState('');
  const [captchaImg, setCaptchaImg] = useState('');
  const [verifyRequired, setVerifyRequired] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [empNo, setEmpNo] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState<'' | 'captcha' | 'sms' | 'login' | 'check' | 'logout'>('');

  const configured = status?.credentials_configured === true;

  const loadCaptcha = useCallback(
    async (keepMsg = false) => {
      setBusy('captcha');
      if (!keepMsg) setMsg(null);
      try {
        const res = await api.getKjgxCaptcha(configured ? undefined : empNo.trim() || undefined);
        setVerifyId(res.verify_id);
        setCaptchaImg(res.image_data_url);
        setVerifyRequired(res.verify_required);
        setVerifyCode('');
      } catch (err) {
        if (!keepMsg) setMsg({ kind: 'error', text: err instanceof Error ? err.message : '验证码获取失败' });
      } finally {
        setBusy('');
      }
    },
    [configured, empNo],
  );

  useEffect(() => {
    if (!open) return;
    const next = state === 'connected' ? 'info' : 'verify';
    setMode(next);
    setMsg(null);
    setSmsCode('');
    setVerifyCode('');
    setPassword('');
    if (next === 'verify') void loadCaptcha();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const enterVerify = () => {
    setMode('verify');
    setMsg(null);
    void loadCaptcha();
  };

  const sendSms = async () => {
    if (!configured && !empNo.trim()) {
      setMsg({ kind: 'error', text: '请先输入外勤工号' });
      return;
    }
    setBusy('sms');
    setMsg(null);
    try {
      const res = await api.sendKjgxSms(configured ? undefined : empNo.trim());
      setMsg({ kind: res.ok ? 'info' : 'error', text: res.message || (res.ok ? '短信验证码已发送' : '发送失败') });
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof Error ? err.message : '短信发送失败' });
    } finally {
      setBusy('');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy('login');
    setMsg(null);
    try {
      const res = await api.loginKjgx({
        ...(configured ? {} : { empNo: empNo.trim(), password }),
        verifyId: verifyId || undefined,
        verifyCode: verifyCode.trim() || undefined,
        smsCode: smsCode.trim() || undefined,
      });
      if (!res.ok) {
        setMsg({ kind: 'error', text: res.message || '验证未通过，请重试' });
        void loadCaptcha(true);
        return;
      }
      setPassword('');
      await check(true);
      onToast(`科技个险已连接${res.emp_name ? `（${res.emp_name}）` : ''}`);
      close();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof Error ? err.message : '请求异常，请重试' });
      void loadCaptcha(true);
    } finally {
      setBusy('');
    }
  };

  const doCheck = async () => {
    setBusy('check');
    setMsg(null);
    const ok = await check(true);
    setBusy('');
    if (ok) setMsg({ kind: 'info', text: '连接正常' });
    else enterVerify();
  };

  const doLogout = async () => {
    setBusy('logout');
    try {
      await api.logoutKjgx();
      await check();
      onToast('已清除科技个险会话');
      close();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof Error ? err.message : '操作失败' });
    } finally {
      setBusy('');
    }
  };

  return (
    <dialog ref={ref} aria-labelledby={titleId}>
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${DOT[state]}`} aria-hidden="true" />
            <h2 id={titleId} className="text-[15px] font-semibold">
              科技个险 · {LABEL[state]}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="grid size-8 cursor-pointer place-items-center rounded-md hover:bg-[var(--secondary)]"
          >
            <X className="size-4" />
          </button>
        </div>

        {mode === 'info' ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[12px] text-[color:var(--muted-foreground)]">外勤</dt>
                <dd className="font-medium">{status?.emp_name ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-[color:var(--muted-foreground)]">会话建立</dt>
                <dd className="tnum font-medium">{fmtDateTime(status?.session_updated_at) || '—'}</dd>
              </div>
            </dl>
            <div role="status" aria-live="polite" className="min-h-5 text-[color:var(--success)]">
              {msg?.text}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={doCheck} disabled={busy !== ''} className={btn}>
                <RefreshCw className={`size-3.5 ${busy === 'check' ? 'animate-spin' : ''}`} />
                检查连接
              </button>
              <button type="button" onClick={enterVerify} disabled={busy !== ''} className={btn}>
                重新验证
              </button>
              <button
                type="button"
                onClick={doLogout}
                disabled={busy !== ''}
                className={`${btn} ml-auto hover:border-[var(--error)] hover:text-[color:var(--error)]`}
              >
                退出会话
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3.5">
            <p className="text-[color:var(--muted-foreground)]">
              {configured ? '账号与绑定手机已托管在服务端，完成验证即可连接。' : '请输入外勤工号与登录密码。'}
            </p>

            {!configured && (
              <div className="grid grid-cols-2 gap-3">
                <label htmlFor={empId} className="space-y-1">
                  <span className="text-[12px] text-[color:var(--muted-foreground)]">外勤工号</span>
                  <input
                    id={empId}
                    value={empNo}
                    onChange={(e) => setEmpNo(e.target.value)}
                    autoComplete="username"
                    spellCheck={false}
                    autoCapitalize="none"
                    required
                    className={`${inputCls} w-full`}
                  />
                </label>
                <label htmlFor={pwdId} className="space-y-1">
                  <span className="text-[12px] text-[color:var(--muted-foreground)]">登录密码</span>
                  <input
                    id={pwdId}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className={`${inputCls} w-full`}
                  />
                </label>
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor={captchaId} className="text-[12px] text-[color:var(--muted-foreground)]">
                图形验证码{verifyRequired ? '' : '（可留空，被要求时再填）'}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={captchaId}
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required={verifyRequired}
                  autoFocus
                  className={`${inputCls} min-w-0 flex-1`}
                />
                {captchaImg ? (
                  <img
                    src={captchaImg}
                    alt="图形验证码"
                    className="h-8 rounded-md border border-[var(--border)] bg-white object-contain"
                  />
                ) : (
                  <span className="text-[12px] text-[color:var(--muted-foreground)]">{busy === 'captcha' ? '加载中…' : '无图'}</span>
                )}
                <button type="button" onClick={() => void loadCaptcha()} disabled={busy === 'captcha'} className={btn}>
                  换一张
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor={smsId} className="text-[12px] text-[color:var(--muted-foreground)]">
                短信验证码（新设备核验时填写，发往绑定手机）
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={smsId}
                  value={smsCode}
                  onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  placeholder="6 位数字"
                  className={`${inputCls} tnum min-w-0 flex-1`}
                />
                <button type="button" onClick={sendSms} disabled={busy === 'sms'} className={btn}>
                  {busy === 'sms' ? '发送中…' : '发送短信码'}
                </button>
              </div>
            </div>

            <div
              role="status"
              aria-live="polite"
              className={`min-h-5 break-words ${msg?.kind === 'error' ? 'font-medium text-[color:var(--error)]' : 'text-[color:var(--success)]'}`}
            >
              {msg?.text}
            </div>

            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={close} className={btn}>
                取消
              </button>
              <button type="submit" disabled={busy === 'login'} className={btnPrimary}>
                {busy === 'login' ? '验证中…' : '验证并连接'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
