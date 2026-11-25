import crypto from 'node:crypto';
import type { Customer, KjgxReceipt, KjgxWritebackJob } from '@insurance-crm/shared';

export const KJGX_DEFAULT_BASE_URL = 'https://kjgxplus.cpic.com.cn';

export interface KjgxSession {
  accesstoken: string;
  empNoAES: string;
  empNo?: string;
}

export interface KhzxApiResponse<T = Record<string, unknown>> {
  status: number;
  responseEncrypt: boolean;
  code?: string;
  msgcode?: string;
  message?: string;
  errorMsg?: string;
  result?: number | string;
  content?: T;
}

export interface KhzxProbeResult {
  ok: boolean;
  status: number;
  session_expired: boolean;
  code: string;
  message: string;
  emp_name?: string;
  emp_no_prefix?: string;
  branch_code?: string;
  channel?: string;
}

export interface KhzxCaptchaResult {
  verify_id: string;
  image_data_url: string;
}

export interface KhzxLoginResult {
  ok: boolean;
  msgcode: string;
  message: string;
  needs_captcha?: boolean;
  needs_sms?: boolean;
  session?: KjgxSession;
  emp_name?: string;
  emp_no_prefix?: string;
}

export interface KhzxH5Fingerprint {
  hash: string;
  prefix: string;
  script_count: number;
  checked_at: string;
}

const KJGX_SM4_KEY = Buffer.from('2s3niLTbcTJgLHSQ6ND52Q==', 'base64');
const KJGX_SM4_IV = Buffer.from('AxZRSfcze9dbz/maEUuptA==', 'base64');
const KJGX_EMPNO_AES_KEY = Buffer.from('liaoruozhizhang1', 'utf8');

export function md5Hex(plain: string): string {
  return crypto.createHash('md5').update(plain, 'utf8').digest('hex');
}

export function sm4CbcEncrypt(plain: string): string {
  if (!plain) return '';
  const cipher = crypto.createCipheriv('sm4-cbc', KJGX_SM4_KEY, KJGX_SM4_IV);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

export function normalizeEmpNoForLogin(empNo: string): string {
  const trimmed = empNo.trim();
  return trimmed === 'XIMU66Xl' ? trimmed : trimmed.toUpperCase();
}

/** Replicates KJGX RN `aesEncrypt` (AES-128-ECB + PKCS7 -> uppercase hex). */
export function empNoAesHexEncrypt(empNo: string): string {
  const norm = normalizeEmpNoForLogin(empNo);
  if (!norm) return '';
  const cipher = crypto.createCipheriv('aes-128-ecb', KJGX_EMPNO_AES_KEY, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(norm, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

function cipherAlgorithmForKey(key: string): string {
  const byteLen = Buffer.byteLength(key, 'utf8');
  if (byteLen === 16) return 'aes-128-ecb';
  if (byteLen === 24) return 'aes-192-ecb';
  if (byteLen === 32) return 'aes-256-ecb';
  throw new Error(`Unsupported AES-ECB key byte length: ${byteLen}`);
}

export function aesEcbEncrypt(plain: string, key: string): string {
  if (!plain) return '';
  const alg = cipherAlgorithmForKey(key);
  const cipher = crypto.createCipheriv(alg, Buffer.from(key, 'utf8'), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

export function aesEcbDecrypt(ciphertextB64: string, key: string): string {
  if (!ciphertextB64) return '';
  const alg = cipherAlgorithmForKey(key);
  const decipher = crypto.createDecipheriv(alg, Buffer.from(key, 'utf8'), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString('utf8');
}

function wrapSpkiPem(base64Der: string): string {
  const clean = base64Der.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, '');
  const lines = clean.match(/.{1,64}/g) ?? [clean];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

export function normalizeKhzxGender(gender?: string | null): '' | '1' | '2' {
  if (!gender) return '';
  const g = gender.trim();
  if (g === '1' || g === '男' || g.toUpperCase() === 'M') return '1';
  if (g === '2' || g === '女' || g.toUpperCase() === 'F') return '2';
  return '';
}

export function normalizeKhzxDate(dateStr?: string | null): string {
  if (!dateStr) return '';
  return dateStr.trim().replace(/\./g, '-').slice(0, 10);
}

export function tryDecryptField(raw: unknown, encryptKey: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const dec = aesEcbDecrypt(trimmed, encryptKey);
    if (dec) return dec;
  } catch {
    // Field was already plaintext/masked; fall back to raw.
  }
  return trimmed;
}

export interface BuildKhzxPayloadInput {
  mode: 'create' | 'update';
  customer: Customer;
  payloadTarget: Record<string, unknown>;
  decryptedIdNo?: string | null;
  empNoAES: string;
  encryptStr: string;
  existingDetail?: Record<string, unknown> | null;
}

/**
 * Builds the exact payload expected by `/cuscenter/customer/saveCustomerController/saveCustomerInfo`
 * or `/updateCustomer`, encrypting sensitive fields (`phoneNo`, `cardNo`) with `encryptStr`.
 * For updates, preserves non-overridden fields from `existingDetail` to avoid clearing existing KJGX attributes.
 */
export function buildKhzxCustomerPayload(input: BuildKhzxPayloadInput): {
  endpoint: string;
  payload: Record<string, unknown>;
  expectedPlain: {
    customerName: string;
    phoneNo: string;
    address: string;
    companyName: string;
    birthday: string;
    remake: string;
  };
} {
  const { mode, customer, payloadTarget, decryptedIdNo, empNoAES, encryptStr, existingDetail } = input;
  const ex = existingDetail ?? {};

  const pickStr = (targetKey: string, existingKey: string, fallback = ''): string => {
    const tv = payloadTarget[targetKey];
    if (typeof tv === 'string' && tv.trim()) return tv.trim();
    const ev = ex[existingKey];
    if (typeof ev === 'string' && ev.trim()) return ev.trim();
    return fallback;
  };

  const customerName =
    (typeof payloadTarget.customerName === 'string' && payloadTarget.customerName.trim()) ||
    (typeof payloadTarget.name === 'string' && payloadTarget.name.trim()) ||
    customer.name;

  const rawPhone =
    (typeof payloadTarget.phoneNo === 'string' && payloadTarget.phoneNo.trim()) ||
    (typeof payloadTarget.phone === 'string' && payloadTarget.phone.trim()) ||
    (typeof payloadTarget.primary_phone === 'string' && payloadTarget.primary_phone.trim()) ||
    customer.primary_phone ||
    tryDecryptField(ex.phoneNo, encryptStr) ||
    '';

  const existingIdPlain = tryDecryptField(ex.cardNo, encryptStr);
  const rawIdNo =
    (typeof payloadTarget.cardNo === 'string' && payloadTarget.cardNo.trim()) ||
    (typeof payloadTarget.id_no === 'string' && payloadTarget.id_no.trim()) ||
    decryptedIdNo?.trim() ||
    existingIdPlain ||
    '';

  const birthdayRaw =
    (typeof payloadTarget.birthday === 'string' && payloadTarget.birthday.trim()) ||
    customer.birthday ||
    (typeof ex.birthday === 'string' ? ex.birthday : '');
  const birthday = normalizeKhzxDate(birthdayRaw);

  const genderRaw =
    (typeof payloadTarget.gender === 'string' && payloadTarget.gender) ||
    customer.gender ||
    (typeof ex.gender === 'string' ? ex.gender : '');
  const gender = normalizeKhzxGender(genderRaw);

  const address =
    (typeof payloadTarget.address === 'string' && payloadTarget.address.trim()) ||
    customer.address ||
    (typeof ex.address === 'string' ? ex.address : '') ||
    '';

  const companyName =
    (typeof payloadTarget.companyName === 'string' && payloadTarget.companyName.trim()) ||
    (typeof payloadTarget.company === 'string' && payloadTarget.company.trim()) ||
    (typeof payloadTarget.company_or_occupation === 'string' && payloadTarget.company_or_occupation.trim()) ||
    customer.company_or_occupation ||
    (typeof ex.companyName === 'string' ? ex.companyName : '') ||
    '';

  const remake =
    (typeof payloadTarget.remake === 'string' && payloadTarget.remake.trim()) ||
    (typeof payloadTarget.remark === 'string' && payloadTarget.remark.trim()) ||
    (typeof payloadTarget.summary === 'string' && payloadTarget.summary.trim()) ||
    customer.manual_summary ||
    (typeof ex.remake === 'string' ? ex.remake : '') ||
    '';

  const existingPhoneList = Array.isArray(ex.phoneList) ? ex.phoneList : [];
  const existingAddrList = Array.isArray(ex.addressList) ? ex.addressList : [];
  const existingLabels = Array.isArray(ex.customerLabelList) ? ex.customerLabelList : [];
  const existingKyc =
    ex.kycInfo && typeof ex.kycInfo === 'object'
      ? (ex.kycInfo as Record<string, unknown>)
      : {
          ageGroup: '',
          familyInfo: '',
          knowTime: '',
          contactLevel: '',
          relationLevel: '',
          yearFaceTime: '',
          industry: '',
          careerBackground: '',
          recommendCustomerLevel: '',
          familyIncome: '',
        };

  const assetAlloc = Array.isArray(ex.assetAllocation)
    ? (ex.assetAllocation as string[]).join(',')
    : typeof ex.assetAllocation === 'string'
      ? ex.assetAllocation
      : '';
  const assetSit = Array.isArray(ex.assetSituation)
    ? (ex.assetSituation as string[]).join(',')
    : typeof ex.assetSituation === 'string'
      ? ex.assetSituation
      : '';

  const cardType = rawIdNo
    ? pickStr('cardType', 'cardType', '111')
    : '';

  const basePayload: Record<string, unknown> = {
    empNo: empNoAES,
    customerName,
    cardType,
    cardNo: rawIdNo ? aesEcbEncrypt(rawIdNo, encryptStr) : '',
    cardDateType: pickStr('cardDateType', 'cardDateType', ''),
    gender,
    birthday,
    phoneNo: rawPhone ? aesEcbEncrypt(rawPhone, encryptStr) : '',
    phoneList: existingPhoneList,
    companyName,
    email: pickStr('email', 'email', ''),
    remarkName: pickStr('remarkName', 'remarkName', ''),
    address,
    addressList: existingAddrList,
    career: pickStr('career', 'career', ''),
    dutiesType: pickStr('dutiesType', 'dutiesType', ''),
    incomeYear: pickStr('incomeYear', 'incomeYear', ''),
    education: pickStr('education', 'education', ''),
    isMarried: pickStr('isMarried', 'isMarried', ''),
    religion: pickStr('religion', 'religion', ''),
    nation: pickStr('nation', 'nation', ''),
    constellation: pickStr('constellation', 'constellation', ''),
    labels: existingLabels,
    remake,
    cardStartTime: normalizeKhzxDate(pickStr('cardStartTime', 'cardStartTime', '')),
    cardEndTime: normalizeKhzxDate(pickStr('cardEndTime', 'cardEndTime', '')),
    kycInfo: existingKyc,
    referralId: pickStr('referralId', 'referralId', ''),
    referralRelation: pickStr('referralRelation', 'referralRelation', ''),
    personalYearIncome: pickStr('personalYearIncome', 'personalYearIncome', ''),
    assetSize: pickStr('assetSize', 'assetSize', ''),
    assetAllocation: assetAlloc,
    assetSituation: assetSit,
    otherCareer: pickStr('career', 'career', '') === '99' ? pickStr('otherCareer', 'otherCareer', '') : '',
  };

  if (mode === 'update') {
    const remoteId =
      (typeof ex.id === 'string' || typeof ex.id === 'number' ? String(ex.id) : '') ||
      (typeof payloadTarget.id === 'string' ? payloadTarget.id : '') ||
      customer.kjgx_db_customer_id ||
      '';
    basePayload.id = remoteId;
    basePayload.flag = typeof ex.editFlag === 'string' ? ex.editFlag : '';
  }

  return {
    endpoint:
      mode === 'update'
        ? '/cuscenter/customer/saveCustomerController/updateCustomer'
        : '/cuscenter/customer/saveCustomerController/saveCustomerInfo',
    payload: basePayload,
    expectedPlain: {
      customerName,
      phoneNo: rawPhone,
      address,
      companyName,
      birthday,
      remake,
    },
  };
}

export function verifyCustomerReadback(
  expected: {
    customerName: string;
    phoneNo?: string;
    address?: string;
    companyName?: string;
    birthday?: string;
    remake?: string;
  },
  actualDetail: Record<string, unknown>,
  encryptStr: string,
): { matched: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const actualName = typeof actualDetail.customerName === 'string' ? actualDetail.customerName.trim() : '';
  if (actualName !== expected.customerName.trim()) {
    mismatches.push(`customerName(${actualName || '<empty>'}!=${expected.customerName})`);
  }

  if (expected.phoneNo) {
    const actualPhone = tryDecryptField(actualDetail.phoneNo, encryptStr);
    const digitsOnlyActual = actualPhone.replace(/\D/g, '');
    const digitsOnlyExpected = expected.phoneNo.replace(/\D/g, '');
    const maskedMatch =
      actualPhone.includes('*') &&
      digitsOnlyExpected.length >= 7 &&
      actualPhone.startsWith(digitsOnlyExpected.slice(0, 3)) &&
      actualPhone.endsWith(digitsOnlyExpected.slice(-4));
    if (digitsOnlyActual !== digitsOnlyExpected && !maskedMatch) {
      mismatches.push('phoneNo');
    }
  }

  if (expected.address) {
    const actualAddr = typeof actualDetail.address === 'string' ? actualDetail.address.trim() : '';
    if (actualAddr !== expected.address.trim()) {
      mismatches.push('address');
    }
  }

  if (expected.companyName) {
    const actualComp = typeof actualDetail.companyName === 'string' ? actualDetail.companyName.trim() : '';
    if (actualComp !== expected.companyName.trim()) {
      mismatches.push('companyName');
    }
  }

  if (expected.birthday) {
    const actualBday = normalizeKhzxDate(typeof actualDetail.birthday === 'string' ? actualDetail.birthday : '');
    if (actualBday !== normalizeKhzxDate(expected.birthday)) {
      mismatches.push('birthday');
    }
  }

  if (expected.remake) {
    const actualRemake = typeof actualDetail.remake === 'string' ? actualDetail.remake.trim() : '';
    if (actualRemake !== expected.remake.trim()) {
      mismatches.push('remake');
    }
  }

  return { matched: mismatches.length === 0, mismatches };
}

export class KjgxSessionExpiredError extends Error {
  constructor(message = 'KJGX session expired or unauthorized (99999999 / 401)') {
    super(message);
    this.name = 'KjgxSessionExpiredError';
  }
}

export class KjgxDirectApiClient {
  private cachedKeyMaterial: { encryptStr: string; serverPublicKeyPem: string; fetchedAt: number } | null = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly keyTtlMs: number;

  constructor(opts: { baseUrl?: string; fetchImpl?: typeof fetch; keyTtlMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.KJGX_API_BASE_URL ?? KJGX_DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.keyTtlMs = opts.keyTtlMs ?? 15 * 60_000;
  }

  async establishKeyMaterial(forceRefresh = false): Promise<{ encryptStr: string; serverPublicKeyPem: string }> {
    if (!forceRefresh && this.cachedKeyMaterial && Date.now() - this.cachedKeyMaterial.fetchedAt < this.keyTtlMs) {
      return {
        encryptStr: this.cachedKeyMaterial.encryptStr,
        serverPublicKeyPem: this.cachedKeyMaterial.serverPublicKeyPem,
      };
    }

    const r1Res = await this.fetchImpl(`${this.baseUrl}/display/api/apprsa/getrsa`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: crypto.randomUUID(), timestamp: Date.now(), key: '', value: '' }),
    });
    if (!r1Res.ok) {
      throw new Error(`KJGX RSA step1 HTTP ${r1Res.status}`);
    }
    const r1 = (await r1Res.json()) as { code?: string; content?: string; message?: string };
    if (String(r1.code) !== '200' || !r1.content) {
      throw new Error(`KJGX RSA step1 failed: code=${String(r1.code)} msg=${r1.message ?? ''}`);
    }

    const serverPubPem = wrapSpkiPem(r1.content);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const clientPubBody = publicKey
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s+/g, '');

    const encryptedClientPub = crypto
      .publicEncrypt(
        { key: serverPubPem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(clientPubBody, 'utf8'),
      )
      .toString('base64');

    const r2Res = await this.fetchImpl(`${this.baseUrl}/display/api/apprsa/getrsa`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid: crypto.randomUUID(),
        timestamp: Date.now(),
        key: 'KJGX_REQ',
        value: encryptedClientPub,
      }),
    });
    if (!r2Res.ok) {
      throw new Error(`KJGX RSA step2 HTTP ${r2Res.status}`);
    }
    const r2 = (await r2Res.json()) as { code?: string; content?: string; message?: string };
    if (String(r2.code) !== '200' || !r2.content) {
      throw new Error(`KJGX RSA step2 failed: code=${String(r2.code)} msg=${r2.message ?? ''}`);
    }

    const encryptStr = crypto
      .privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(r2.content, 'base64'),
      )
      .toString('utf8');

    this.cachedKeyMaterial = {
      encryptStr,
      serverPublicKeyPem: serverPubPem,
      fetchedAt: Date.now(),
    };
    return { encryptStr, serverPublicKeyPem: serverPubPem };
  }

  async establishEncryptKey(forceRefresh = false): Promise<string> {
    const mat = await this.establishKeyMaterial(forceRefresh);
    return mat.encryptStr;
  }

  async postEncrypted<T = Record<string, unknown>>(
    path: string,
    payload: Record<string, unknown> | string,
    session?: KjgxSession,
    opts: { showPlain?: boolean } = {},
  ): Promise<KhzxApiResponse<T> & { raw: Record<string, unknown> }> {
    const encryptKey = await this.establishEncryptKey();
    const plainStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const encData = aesEcbEncrypt(plainStr, encryptKey);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      accesstoken: session?.accesstoken ?? '',
      empnoaes: session?.empNoAES ?? '',
      'Request-Encrypt': 'true',
    };
    if (session?.empNoAES) {
      headers.empNoAES = session.empNoAES;
    }
    if (opts.showPlain !== false && session) {
      headers['X-Show-Plain'] = 'true';
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: encData }),
    });

    const reEnc = res.headers.get('response-encrypt') === 'true';
    const rawJson = (await res.json()) as Record<string, unknown>;
    let decoded: Record<string, unknown> = rawJson;
    if (reEnc && typeof rawJson.data === 'string') {
      decoded = JSON.parse(aesEcbDecrypt(rawJson.data, encryptKey)) as Record<string, unknown>;
    }

    const msgcode = decoded.msgcode !== undefined ? String(decoded.msgcode) : undefined;
    const code = decoded.code !== undefined ? String(decoded.code) : undefined;
    if (res.status === 401 || msgcode === '99999999') {
      throw new KjgxSessionExpiredError();
    }

    return {
      status: res.status,
      responseEncrypt: reEnc,
      code,
      msgcode,
      message: typeof decoded.message === 'string' ? decoded.message : undefined,
      errorMsg: typeof decoded.errorMsg === 'string' ? decoded.errorMsg : undefined,
      result: decoded.result as number | string | undefined,
      content: decoded.content as T | undefined,
      raw: decoded,
    };
  }

  async checkLoginVerifyRequired(empNo: string): Promise<{ required: boolean; msgcode: string; statusField: string }> {
    const resp = await this.postEncrypted('/emp/api/login/queryVerify', {
      empNo: empNoAesHexEncrypt(empNo),
    });
    const msgcode = String(resp.raw.msgcode ?? resp.code ?? '');
    const statusField = String(resp.raw.status ?? '');
    return {
      required: msgcode === '00' && statusField === '0',
      msgcode,
      statusField,
    };
  }

  async fetchLoginCaptcha(): Promise<KhzxCaptchaResult> {
    const resp = await this.postEncrypted('/behavior/api/getVerifyCode/getVerifyCode', '');
    const msgCode = String(resp.raw.msgCode ?? resp.raw.msgcode ?? resp.code ?? '');
    const verifyID = typeof resp.raw.verifyID === 'string' ? resp.raw.verifyID : '';
    const verifyImg = typeof resp.raw.verifyImg === 'string' ? resp.raw.verifyImg : '';
    if (msgCode !== '00' || !verifyID || !verifyImg) {
      throw new Error(resp.errorMsg ?? resp.message ?? `获取图形验证码失败 (code=${msgCode})`);
    }
    return {
      verify_id: verifyID,
      image_data_url: verifyImg.startsWith('data:') ? verifyImg : `data:image/png;base64,${verifyImg}`,
    };
  }

  async sendLoginSmsCode(empNo: string): Promise<{ ok: boolean; code: string; message: string }> {
    const resp = await this.postEncrypted('/emp/api/login/sendLoginAuthCode', {
      empNo: empNoAesHexEncrypt(empNo),
    });
    const code = resp.code ?? resp.msgcode ?? '';
    return {
      ok: code === '00',
      code,
      message: resp.message ?? resp.errorMsg ?? (code === '00' ? '短信验证码已发送' : '短信发送失败'),
    };
  }

  async loginWithPassword(params: {
    empNo: string;
    password: string;
    devicesn: string;
    verifyId?: string;
    verifyCode?: string;
    mobilePhone?: string;
    smsCode?: string;
  }): Promise<KhzxLoginResult> {
    const { encryptStr, serverPublicKeyPem } = await this.establishKeyMaterial();
    const innerPayload = {
      empNo: empNoAesHexEncrypt(params.empNo),
      password: sm4CbcEncrypt(md5Hex(params.password)),
      devicesn: params.devicesn,
      pwd: sm4CbcEncrypt(params.password),
      token: '',
      mobilePhone: params.mobilePhone?.trim() ?? '',
      mobileCheck: params.smsCode?.trim() ?? '',
      uuid: params.verifyId?.trim() ?? '',
      code: `Y_${params.verifyCode?.trim() ?? ''}`,
    };

    const reqAesKey = crypto.randomBytes(8).toString('hex');
    const encData = aesEcbEncrypt(JSON.stringify(innerPayload), reqAesKey);
    const ts = String(Date.now());
    const reqUuid = crypto.randomUUID();
    const digestHex = crypto.createHash('sha256').update(`${encData}${ts}${reqUuid}`, 'utf8').digest('hex');
    const sign = crypto
      .publicEncrypt(
        { key: serverPublicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(digestHex, 'utf8'),
      )
      .toString('base64');
    const skey = crypto
      .publicEncrypt(
        { key: serverPublicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(reqAesKey, 'utf8'),
      )
      .toString('base64');

    const res = await this.fetchImpl(`${this.baseUrl}/emp/api/login/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Request-Encrypt': 'true',
        'Times-Tamp': ts,
        Uuid: reqUuid,
        Sign: sign,
        Skey: skey,
      },
      body: JSON.stringify({ data: encData }),
    });

    const rawJson = (await res.json()) as Record<string, unknown>;
    const respEncLogin = res.headers.get('response-encrypt-login') === 'true';
    const respEnc = res.headers.get('response-encrypt') === 'true';
    let decoded: Record<string, unknown> = rawJson;
    if (respEncLogin && typeof rawJson.data === 'string') {
      decoded = JSON.parse(aesEcbDecrypt(rawJson.data, reqAesKey)) as Record<string, unknown>;
    } else if (respEnc && typeof rawJson.data === 'string') {
      decoded = JSON.parse(aesEcbDecrypt(rawJson.data, encryptStr)) as Record<string, unknown>;
    }

    const msgcode = String(decoded.msgcode ?? decoded.code ?? '');
    const message = String(decoded.errorMsg ?? decoded.message ?? '');
    const loginEmp = (decoded.loginEmp ?? {}) as Record<string, unknown>;
    const tok = typeof loginEmp.token === 'string' ? loginEmp.token.trim() : '';
    const empAes = typeof loginEmp.empNoAES === 'string' ? loginEmp.empNoAES.trim() : '';
    const empNo = typeof loginEmp.empNo === 'string' ? loginEmp.empNo.trim() : normalizeEmpNoForLogin(params.empNo);
    const empName = typeof loginEmp.empName === 'string' ? loginEmp.empName.trim() : undefined;

    if (['00', '0000', '42'].includes(msgcode) && tok && empAes) {
      return {
        ok: true,
        msgcode,
        message: message || '登录成功',
        session: { accesstoken: tok, empNoAES: empAes, empNo },
        emp_name: empName,
        emp_no_prefix: empNo.slice(0, 4),
      };
    }

    const msgLower = message.toLowerCase();
    return {
      ok: false,
      msgcode: msgcode || 'ERR',
      message: message || `登录失败 (${msgcode || res.status})`,
      needs_captcha: msgLower.includes('验证码') || msgcode === '1002' || msgcode === '02',
      needs_sms: msgLower.includes('短信') || msgLower.includes('动态密码') || msgLower.includes('设备'),
    };
  }

  async fetchKhzxH5Fingerprint(): Promise<KhzxH5Fingerprint> {
    const res = await this.fetchImpl(`${this.baseUrl}/khzx/`, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`khzx H5 index HTTP ${res.status}`);
    }
    const html = await res.text();
    const matches = html.match(/\/khzx\/static\/js\/[a-zA-Z0-9._-]+\.js/g) ?? [];
    const scripts = Array.from(new Set(matches)).sort();
    if (scripts.length === 0) {
      throw new Error('khzx H5 HTML contained no script manifest');
    }
    const hash = crypto.createHash('sha256').update(scripts.join('\n'), 'utf8').digest('hex');
    return {
      hash,
      prefix: hash.slice(0, 12),
      script_count: scripts.length,
      checked_at: new Date().toISOString(),
    };
  }

  async probeSession(session: KjgxSession): Promise<KhzxProbeResult> {
    try {
      const resp = await this.postEncrypted<Record<string, unknown>>(
        '/emp/api/login/accessEmpInfo',
        { empNo: session.empNoAES },
        session,
      );
      const ok = resp.status === 200 && resp.code === '00';
      const content = resp.content ?? {};
      const empNo = typeof content.empNo === 'string' ? content.empNo : '';
      return {
        ok,
        status: resp.status,
        session_expired: false,
        code: resp.code ?? resp.msgcode ?? '',
        message: resp.message ?? resp.errorMsg ?? (ok ? 'SUCCESS' : 'UNKNOWN'),
        emp_name: typeof content.empName === 'string' ? content.empName : undefined,
        emp_no_prefix: empNo ? empNo.slice(0, 4) : undefined,
        branch_code: typeof content.fgsCode === 'string' ? content.fgsCode : undefined,
        channel: typeof content.channle === 'string' ? content.channle : undefined,
      };
    } catch (err) {
      if (err instanceof KjgxSessionExpiredError) {
        return {
          ok: false,
          status: 401,
          session_expired: true,
          code: '99999999',
          message: err.message,
        };
      }
      throw err;
    }
  }

  async queryCustomerDetail(customerId: string, session: KjgxSession): Promise<KhzxApiResponse<Record<string, unknown>>> {
    return this.postEncrypted<Record<string, unknown>>(
      '/cuscenter/customer/CustomerDetailController/queryCustomerDetail',
      { customerId, empNo: session.empNoAES },
      session,
    );
  }

  async executeWritebackJob(params: {
    job: KjgxWritebackJob;
    customer: Customer;
    decryptedIdNo?: string | null;
    session: KjgxSession;
    deviceId: string;
    dryRun?: boolean;
  }): Promise<KjgxReceipt> {
    const { job, customer, decryptedIdNo, session, deviceId, dryRun } = params;
    if (job.job_type !== 'create_customer' && job.job_type !== 'update_profile') {
      return {
        assigned_device: deviceId,
        attempts: Math.max(1, job.attempts || 1),
        route_result: 'DIRECT_KHZX_UNSUPPORTED_JOB_TYPE',
        edit_page_seen: false,
        customer_name_seen: false,
        readback_matched: false,
        app_result: { job_type: job.job_type },
        error: `Direct khzx API does not support job_type=${job.job_type}`,
      };
    }

    const encryptStr = await this.establishEncryptKey();
    const isUpdate = job.job_type === 'update_profile';

    let existingDetail: Record<string, unknown> | null = null;
    const remoteCustomerId =
      (typeof job.payload_target.customerId === 'string' && job.payload_target.customerId.trim()) ||
      customer.kjgx_db_customer_id ||
      '';

    if (isUpdate) {
      if (!remoteCustomerId) {
        return {
          assigned_device: deviceId,
          attempts: Math.max(1, job.attempts || 1),
          route_result: 'DIRECT_KHZX_IDENTITY_MISSING',
          edit_page_seen: false,
          customer_name_seen: false,
          readback_matched: false,
          app_result: { error: 'missing_kjgx_db_customer_id' },
          error: 'IDENTITY_MISMATCH: missing kjgx_db_customer_id for update_profile',
        };
      }
      const preRead = await this.queryCustomerDetail(remoteCustomerId, session);
      if (preRead.code !== '00' || !preRead.content) {
        return {
          assigned_device: deviceId,
          attempts: Math.max(1, job.attempts || 1),
          route_result: 'DIRECT_KHZX_PRECHECK_FAILED',
          edit_page_seen: false,
          customer_name_seen: false,
          readback_matched: false,
          app_result: { code: preRead.code ?? preRead.msgcode ?? '', message: preRead.message ?? preRead.errorMsg ?? '' },
          error: `Pre-write queryCustomerDetail failed: ${preRead.message ?? preRead.errorMsg ?? preRead.code ?? ''}`,
        };
      }
      existingDetail = preRead.content;
      const remoteName = typeof existingDetail.customerName === 'string' ? existingDetail.customerName.trim() : '';
      if (!remoteName || remoteName !== customer.name.trim()) {
        return {
          assigned_device: deviceId,
          attempts: Math.max(1, job.attempts || 1),
          route_result: 'DIRECT_KHZX_IDENTITY_MISMATCH',
          edit_page_seen: true,
          customer_name_seen: false,
          readback_matched: false,
          app_result: { expected_name: customer.name, remote_name: remoteName },
          error: `IDENTITY_MISMATCH: remote customerName=${remoteName} != ${customer.name}`,
        };
      }
    }

    const built = buildKhzxCustomerPayload({
      mode: isUpdate ? 'update' : 'create',
      customer,
      payloadTarget: job.payload_target,
      decryptedIdNo,
      empNoAES: session.empNoAES,
      encryptStr,
      existingDetail,
    });

    if (dryRun) {
      return {
        assigned_device: deviceId,
        attempts: Math.max(1, job.attempts || 1),
        route_result: 'DIRECT_KHZX_DRY_RUN',
        edit_page_seen: true,
        customer_name_seen: true,
        readback_matched: false,
        app_result: {
          dry_run: true,
          endpoint: built.endpoint,
          payload_keys: Object.keys(built.payload),
          has_encrypted_phone: Boolean(built.payload.phoneNo),
          has_encrypted_card: Boolean(built.payload.cardNo),
        },
        error: null,
      };
    }

    const writeResp = await this.postEncrypted<string | number | Record<string, unknown>>(
      built.endpoint,
      built.payload,
      session,
    );
    if (writeResp.code !== '00') {
      return {
        assigned_device: deviceId,
        attempts: Math.max(1, job.attempts || 1),
        route_result: 'DIRECT_KHZX_WRITE_ERROR',
        edit_page_seen: true,
        customer_name_seen: true,
        readback_matched: false,
        app_result: {
          endpoint: built.endpoint,
          code: writeResp.code ?? writeResp.msgcode ?? '',
          message: writeResp.message ?? writeResp.errorMsg ?? '',
        },
        error: writeResp.message ?? writeResp.errorMsg ?? `KJGX write failed code=${writeResp.code ?? ''}`,
      };
    }

    const extractReturnedId = (c: unknown): string => {
      if (typeof c === 'number' && Number.isFinite(c)) return String(Math.trunc(c));
      if (typeof c === 'string' && c.trim()) return c.trim();
      if (c && typeof c === 'object') {
        const obj = c as Record<string, unknown>;
        for (const k of ['addcustomerId', 'customerId', 'id']) {
          const v = obj[k];
          if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
          if (typeof v === 'string' && v.trim()) return v.trim();
        }
      }
      return '';
    };

    const returnedId = extractReturnedId(writeResp.content) || remoteCustomerId;

    if (!returnedId) {
      return {
        assigned_device: deviceId,
        attempts: Math.max(1, job.attempts || 1),
        route_result: 'DIRECT_KHZX_NO_CUSTOMER_ID',
        edit_page_seen: true,
        customer_name_seen: true,
        readback_matched: false,
        app_result: { endpoint: built.endpoint, code: writeResp.code ?? '' },
        error: 'KJGX write succeeded without returning customerId for readback',
      };
    }

    const readback = await this.queryCustomerDetail(returnedId, session);
    if (readback.code !== '00' || !readback.content) {
      return {
        assigned_device: deviceId,
        attempts: Math.max(1, job.attempts || 1),
        route_result: 'DIRECT_KHZX_READBACK_FAILED',
        edit_page_seen: true,
        customer_name_seen: true,
        readback_matched: false,
        app_result: {
          endpoint: built.endpoint,
          addcustomerId: returnedId,
          readback_code: readback.code ?? readback.msgcode ?? '',
        },
        error: `Post-write readback failed: ${readback.message ?? readback.errorMsg ?? ''}`,
      };
    }

    const verified = verifyCustomerReadback(built.expectedPlain, readback.content, encryptStr);
    return {
      assigned_device: deviceId,
      attempts: Math.max(1, job.attempts || 1),
      route_result: verified.matched ? 'DIRECT_KHZX_API_VERIFIED' : 'DIRECT_KHZX_READBACK_MISMATCH',
      edit_page_seen: true,
      customer_name_seen: true,
      readback_matched: verified.matched,
      app_result: {
        ok: verified.matched,
        endpoint: built.endpoint,
        addcustomerId: returnedId,
        mismatches: verified.mismatches,
      },
      error: verified.matched ? null : `Readback mismatch: ${verified.mismatches.join(', ')}`,
    };
  }
}
