import { describe, expect, it } from 'vitest';
import {
  isPlaceholderName,
  isValidCnMobile,
  maskIdNo,
  normalizeDate,
  normalizePhone,
  validateCnIdChecksum,
} from '../dedup.js';

describe('Dedup & Validation Helpers', () => {
  it('normalizes and validates synthetic Chinese mobile numbers', () => {
    expect(normalizePhone('+86 138-0000-1001')).toBe('13800001001');
    expect(normalizePhone('008613800001002')).toBe('13800001002');
    expect(isValidCnMobile('138 0000 1003')).toBe(true);
    expect(isValidCnMobile('12345')).toBe(false);
  });

  it('validates 18-digit GB 11643-1999 checksum and masks ID numbers safely', () => {
    const validSample = ['110105', '19491231', '002X'].join('');
    const badCheckDigit = ['110105', '19491231', '0021'].join('');
    expect(validateCnIdChecksum(validSample)).toBe(true);
    expect(validateCnIdChecksum(badCheckDigit)).toBe(false);
    expect(validateCnIdChecksum('3101**********001X')).toBeNull();
    expect(maskIdNo(validSample)).toBe('1101**********002X');
  });

  it('filters placeholder names and normalizes dates', () => {
    expect(isPlaceholderName('微信用户')).toBe(true);
    expect(isPlaceholderName('林致远')).toBe(false);
    expect(normalizeDate('2026/5/8')).toBe('2026-05-08');
    expect(normalizeDate('19870311')).toBe('1987-03-11');
  });
});
