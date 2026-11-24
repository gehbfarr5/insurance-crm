const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECK_CHARS = '10X98765432';

export const PLACEHOLDER_NAMES = new Set([
  '微信用户',
  '客户',
  '未知',
  '匿名',
  '无',
  '测试',
  '生日祝福',
  '客户详情',
  '我的客户',
]);

export function normalizePhone(raw: string | null | undefined): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('0086')) return digits.slice(4);
  if (digits.startsWith('86') && digits.length === 13) return digits.slice(2);
  return digits;
}

export function isValidCnMobile(phone: string | null | undefined): boolean {
  const norm = normalizePhone(phone);
  return /^1[3-9]\d{9}$/.test(norm);
}

export function normalizeIdNo(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

export function validateCnIdChecksum(raw: string | null | undefined): boolean | null {
  const norm = normalizeIdNo(raw);
  if (!/^\d{17}[\dX]$/.test(norm)) return null;
  let total = 0;
  for (let i = 0; i < 17; i += 1) {
    total += Number(norm[i]) * ID_WEIGHTS[i];
  }
  return ID_CHECK_CHARS[total % 11] === norm[17];
}

export function maskIdNo(raw: string | null | undefined): string | null {
  const norm = normalizeIdNo(raw);
  if (!norm) return null;
  if (norm.includes('*')) return norm;
  if (norm.length === 18) {
    return `${norm.slice(0, 4)}**********${norm.slice(14)}`;
  }
  if (norm.length > 4) {
    return `${norm.slice(0, 2)}${'*'.repeat(norm.length - 4)}${norm.slice(-2)}`;
  }
  return '****';
}

export function normalizeName(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/\u3000/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function isPlaceholderName(raw: string | null | undefined): boolean {
  const name = normalizeName(raw);
  return name === '' || PLACEHOLDER_NAMES.has(name);
}

export function normalizeDate(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
