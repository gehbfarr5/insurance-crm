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

const SM4_SBOX = [
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
  0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
  0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
  0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
  0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
  0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
  0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
  0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
  0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
  0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
  0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
  0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
  0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
  0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
  0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
  0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
];

const SM4_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];

const SM4_CK = [
  0x00070e15, 0x1c232a31, 0x383f464d, 0x545b6269,
  0x70777e85, 0x8c939aa1, 0xa8afb6bd, 0xc4cbd2d9,
  0xe0e7eef5, 0xfc030a11, 0x181f262d, 0x343b4249,
  0x50575e65, 0x6c737a81, 0x888f969d, 0xa4abb2b9,
  0xc0c7ced5, 0xdce3eaf1, 0xf8ff060d, 0x141b2229,
  0x30373e45, 0x4c535a61, 0x686f767d, 0x848b9299,
  0xa0a7aeb5, 0xbcc3cad1, 0xd8dfe6ed, 0xf4fb0209,
  0x10171e25, 0x2c333a41, 0x484f565d, 0x646b7279,
];

function sm4GetUlongBe(b: number[], i: number): number {
  return ((255 & b[i]!) << 24) | ((255 & b[i + 1]!) << 16) | ((255 & b[i + 2]!) << 8) | (255 & b[i + 3]!);
}

function sm4PutUlongBe(n: number, b: number[], i: number): void {
  const b0 = 255 & (n >> 24);
  const b1 = 255 & (n >> 16);
  const b2 = 255 & (n >> 8);
  const b3 = 255 & n;
  b[i] = b0 > 128 ? b0 - 256 : b0;
  b[i + 1] = b1 > 128 ? b1 - 256 : b1;
  b[i + 2] = b2 > 128 ? b2 - 256 : b2;
  b[i + 3] = b3 > 128 ? b3 - 256 : b3;
}

/** Matches CPIC RN `SM4Util` (signed `>>` right shift instead of `>>>`). */
function sm4Rotl(t: number, s: number): number {
  return ((4294967295 & t) << s) | (t >> (32 - s));
}

function sm4Sbox(x: number): number {
  const v = SM4_SBOX[255 & x]!;
  return v > 128 ? v - 256 : v;
}

function sm4Lt(ka: number): number {
  const a = [0, 0, 0, 0];
  sm4PutUlongBe(ka, a, 0);
  const b = [sm4Sbox(a[0]!), sm4Sbox(a[1]!), sm4Sbox(a[2]!), sm4Sbox(a[3]!)];
  const bb = sm4GetUlongBe(b, 0);
  return bb ^ sm4Rotl(bb, 2) ^ sm4Rotl(bb, 10) ^ sm4Rotl(bb, 18) ^ sm4Rotl(bb, 24);
}

function sm4CalciRk(ka: number): number {
  const a = [0, 0, 0, 0];
  sm4PutUlongBe(ka, a, 0);
  const b = [sm4Sbox(a[0]!), sm4Sbox(a[1]!), sm4Sbox(a[2]!), sm4Sbox(a[3]!)];
  const bb = sm4GetUlongBe(b, 0);
  return bb ^ sm4Rotl(bb, 13) ^ sm4Rotl(bb, 23);
}

function sm4SetKey(keyBytes: number[]): number[] {
  const mk = [
    sm4GetUlongBe(keyBytes, 0),
    sm4GetUlongBe(keyBytes, 4),
    sm4GetUlongBe(keyBytes, 8),
    sm4GetUlongBe(keyBytes, 12),
  ];
  const k = new Array<number>(36).fill(0);
  k[0] = mk[0]! ^ SM4_FK[0]!;
  k[1] = mk[1]! ^ SM4_FK[1]!;
  k[2] = mk[2]! ^ SM4_FK[2]!;
  k[3] = mk[3]! ^ SM4_FK[3]!;
  const sk = new Array<number>(32).fill(0);
  for (let i = 0; i < 32; i++) {
    k[i + 4] = k[i]! ^ sm4CalciRk(k[i + 1]! ^ k[i + 2]! ^ k[i + 3]! ^ SM4_CK[i]!);
    sk[i] = k[i + 4]!;
  }
  return sk;
}

function sm4OneRound(sk: number[], input: number[], output: number[]): void {
  const x = new Array<number>(36).fill(0);
  x[0] = sm4GetUlongBe(input, 0);
  x[1] = sm4GetUlongBe(input, 4);
  x[2] = sm4GetUlongBe(input, 8);
  x[3] = sm4GetUlongBe(input, 12);
  for (let i = 0; i < 32; i++) {
    x[i + 4] = x[i]! ^ sm4Lt(x[i + 1]! ^ x[i + 2]! ^ x[i + 3]! ^ sk[i]!);
  }
  sm4PutUlongBe(x[35]!, output, 0);
  sm4PutUlongBe(x[34]!, output, 4);
  sm4PutUlongBe(x[33]!, output, 8);
  sm4PutUlongBe(x[32]!, output, 12);
}

export function md5Hex(plain: string): string {
  return crypto.createHash('md5').update(plain, 'utf8').digest('hex');
}

/** Replicates CPIC `SM4Util.encryptData_CBC` (PKCS7 + Base64) for `/emp/api/login/login`. */
export function sm4CbcEncrypt(plain: string): string {
  if (!plain) return '';
  const bytes = Array.from(Buffer.from(plain, 'utf8'));
  const pad = 16 - (bytes.length % 16);
  for (let i = 0; i < pad; i++) {
    bytes.push(pad);
  }
  const sk = sm4SetKey(Array.from(KJGX_SM4_KEY));
  let iv = Array.from(KJGX_SM4_IV);
  const out: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const block = new Array<number>(16);
    for (let j = 0; j < 16; j++) {
      block[j] = bytes[offset + j]! ^ iv[j]!;
    }
    const enc = new Array<number>(16).fill(0);
    sm4OneRound(sk, block, enc);
    out.push(...enc);
    iv = enc.slice(0, 16);
  }
  return Buffer.from(out.map((v) => (v < 0 ? v + 256 : v))).toString('base64');
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
