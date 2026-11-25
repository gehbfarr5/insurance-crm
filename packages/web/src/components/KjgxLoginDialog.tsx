import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.js';

interface Props {
  open: boolean;
  initialEmpNoPrefix?: string | null;
  onClose: () => void;
  onSuccess: (msg: string) => Promise<void> | void;
}

export function KjgxLoginDialog({ open, initialEmpNoPrefix, onClose, onSuccess }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const empId = useId();
  const pwdId = useId();
  const pwdWarnId = useId();
  const captchaId = useId();
  const phoneId = useId();
  const smsId = useId();

  const [empNo, setEmpNo] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [verifyId, setVerifyId] = useState('');
  const [captchaImg, setCaptchaImg] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [showSmsSection, setShowSmsSection] = useState(false);
  const [mobilePhone, setMobilePhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [captchaBusy, setCaptchaBusy] = useState(false);
  const [smsBusy, setSmsBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const loadCaptcha = useCallback(async (targetEmpNo?: string) => {
    setCaptchaBusy(true);
    setStatusMsg(null);
    try {
      const res = await api.getKjgxCaptcha(targetEmpNo?.trim() || undefined);
      setVerifyId(res.verify_id);
      setCaptchaImg(res.image_data_url);
      setVerifyCode('');
    } catch (err) {
      setStatusMsg({
        kind: 'error',
        text: err instanceof Error ? err.message : '拉取图形验证码失败，请重试',
      });
    } finally {
      setCaptchaBusy(false);
    }
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      setPassword('');
      setShowPassword(false);
      setVerifyCode('');
      setSmsCode('');
      setStatusMsg(null);
      if (!empNo && initialEmpNoPrefix && initialEmpNoPrefix.length > 4) {
        setEmpNo(initialEmpNoPrefix);
      }
      if (!dialog.open) {
        dialog.showModal();
      }
      void loadCaptcha(empNo);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, initialEmpNoPrefix, loadCaptcha]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      dialog.returnValue = '';
      setPassword('');
      onClose();
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  const handleRequestClose = () => {
    setPassword('');
    ref.current?.close('cancel');
  };

  const handleSendSms = async () => {
    const trimmedEmp = empNo.trim();
    if (!trimmedEmp) {
      setStatusMsg({ kind: 'error', text: '请先输入工号后再发送短信验证码' });
      return;
    }
    setSmsBusy(true);
    setStatusMsg(null);
    try {
      const res = await api.sendKjgxSms(trimmedEmp);
      setStatusMsg({
        kind: res.ok ? 'info' : 'error',
        text: res.message || (res.ok ? '短信验证码已发送，请查收' : '发送失败'),
      });
    } catch (err) {
      setStatusMsg({
        kind: 'error',
        text: err instanceof Error ? err.message : '短信发送失败',
      });
    } finally {
      setSmsBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setStatusMsg(null);
    try {
      const res = await api.loginKjgx({
        empNo: empNo.trim(),
        password,
        verifyId: verifyId || undefined,
        verifyCode: verifyCode.trim() || undefined,
        mobilePhone: mobilePhone.trim() || undefined,
        smsCode: smsCode.trim() || undefined,
      });
      if (!res.ok) {
        if (res.needs_sms) {
          setShowSmsSection(true);
        }
        setStatusMsg({
          kind: 'error',
          text: res.message || '登录未成功，请核对工号、密码或验证码',
        });
        void loadCaptcha(empNo);
        return;
      }
      setPassword('');
      ref.current?.close('success');
      await onSuccess(`科技个险服务端直连登录成功（${res.emp_name ?? res.emp_no_prefix ?? '已就绪'}），已加密持久化至服务器`);
    } catch (err) {
      setStatusMsg({
        kind: 'error',
        text: err instanceof Error ? err.message : '登录请求异常，请重试',
      });
      void loadCaptcha(empNo);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog ref={ref} {...({ closedby: 'closerequest' } as Record<string, string>)} aria-labelledby={titleId}>
      <form onSubmit={handleSubmit} className="p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--card-border)] pb-3">
          <div>
            <h1 id={titleId} className="text-base font-semibold">
              登录科技个险（服务端直连 · 无需手机）
            </h1>
            <p className="text-xs text-[var(--muted-foreground)] mt-0.5">
              凭据仅用于本次加密登录交换，密码绝不保存；签发的会话令牌将通过 AES-256-GCM 持久化于首尔数据库
            </p>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            aria-label="关闭登录弹窗"
            className="px-2 py-1 text-xs rounded-md border border-[var(--border)] cursor-pointer"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 text-xs">
          <div>
            <label htmlFor={empId} className="block font-medium mb-1">
              外勤工号 <span aria-hidden="true">*</span>
            </label>
            <input
              id={empId}
              name="kjgx_emp_no"
              type="text"
              autoFocus
              required
              autoComplete="username"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              value={empNo}
              onChange={(e) => setEmpNo(e.target.value)}
              placeholder="请输入外勤工号"
              className="w-full px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-base"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={pwdId} className="font-medium">
                登录密码 <span aria-hidden="true">*</span>
              </label>
              <button
                type="button"
                aria-pressed={showPassword}
                aria-describedby={pwdWarnId}
                onClick={() => setShowPassword((v) => !v)}
                className="text-[var(--link)] hover:underline cursor-pointer"
              >
                {showPassword ? '隐藏密码' : '显示密码'}
              </button>
            </div>
            <span id={pwdWarnId} className="sr-only">
              切换后将在屏幕上明文显示所输入的密码
            </span>
            <input
              id={pwdId}
              name="kjgx_password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
              enterKeyHint="next"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-base"
            />
          </div>

          <div>
            <label htmlFor={captchaId} className="block font-medium mb-1">
              图形验证码 <span aria-hidden="true">*</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={captchaId}
                name="kjgx_captcha"
                type="text"
                required
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="done"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value)}
                placeholder="输入右侧字符"
                className="flex-1 min-w-[8rem] px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-base"
              />
              {captchaImg ? (
                <img
                  src={captchaImg}
                  alt="科技个险图形验证码"
                  className="h-11 rounded-lg border border-[var(--border)] bg-white object-contain"
                />
              ) : (
                <span className="text-[var(--muted-foreground)] px-2 py-2">
                  {captchaBusy ? '加载中…' : '暂无图片'}
                </span>
              )}
              <button
                type="button"
                disabled={captchaBusy}
                onClick={() => void loadCaptcha(empNo)}
                className="px-2.5 py-2 rounded-lg border border-[var(--border)] cursor-pointer disabled:opacity-60"
              >
                {captchaBusy ? '刷新中…' : '换一张'}
              </button>
            </div>
          </div>

          <div>
            <button
              type="button"
              aria-expanded={showSmsSection}
              onClick={() => setShowSmsSection((v) => !v)}
              className="text-[var(--link)] hover:underline cursor-pointer"
            >
              {showSmsSection ? '收起新设备短信校验 ▼' : '如提示需要短信动态码，点此展开 ▶'}
            </button>
            {showSmsSection && (
              <div className="mt-2 p-3 rounded-lg bg-[var(--secondary)] space-y-2.5">
                <div>
                  <label htmlFor={phoneId} className="block font-medium mb-1">
                    手机号（如系统要求）
                  </label>
                  <input
                    id={phoneId}
                    name="kjgx_mobile_phone"
                    type="tel"
                    autoComplete="tel-national"
                    value={mobilePhone}
                    onChange={(e) => setMobilePhone(e.target.value)}
                    placeholder="选填"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-base"
                  />
                </div>
                <div>
                  <label htmlFor={smsId} className="block font-medium mb-1">
                    短信验证码
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id={smsId}
                      name="kjgx_sms_code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={smsCode}
                      onChange={(e) => setSmsCode(e.target.value)}
                      placeholder="6 位数字"
                      className="flex-1 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-base"
                    />
                    <button
                      type="button"
                      disabled={smsBusy}
                      onClick={() => void handleSendSms()}
                      className="px-3 py-2 rounded-lg border border-[var(--border)] cursor-pointer disabled:opacity-60"
                    >
                      {smsBusy ? '发送中…' : '发送短信码'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div role="status" aria-live="polite" className="min-h-[1.25rem]">
            {statusMsg && (
              <p className={statusMsg.kind === 'error' ? 'text-[var(--error)] font-medium' : 'text-[var(--success)]'}>
                {statusMsg.text}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--card-border)]">
          <button
            type="button"
            onClick={handleRequestClose}
            className="px-3 py-2 text-xs rounded-lg border border-[var(--border)] cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] cursor-pointer disabled:opacity-60"
          >
            {submitting ? '正在加密登录…' : '登录并保存会话'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
