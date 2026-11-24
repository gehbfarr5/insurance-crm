import { describe, expect, it } from 'vitest';
import { IdVault } from '../crypto/id-vault.js';

describe('IdVault AES-256-GCM & HMAC-SHA256', () => {
  const vault = new IdVault('aa'.repeat(32), 'bb'.repeat(32));

  it('encrypts, decrypts, masks, and hashes deterministically without storing plaintext', () => {
    const sampleId = ['110105', '19491231', '002x'].join('');
    const sealed = vault.seal(sampleId);
    expect(sealed).not.toBeNull();
    expect(sealed!.masked).toBe('1101**********002X');
    expect(sealed!.checksumOk).toBe(true);
    expect(sealed!.hmac).toHaveLength(64);
    expect(vault.decrypt(sealed!.encrypted)).toBe(sampleId.toUpperCase());
    expect(vault.hmac(sampleId)).toBe(sealed!.hmac);
  });

  it('handles pre-masked ID strings safely without generating misleading full HMAC', () => {
    const masked = vault.seal('3101**********001X');
    expect(masked!.masked).toBe('3101**********001X');
    expect(masked!.hmac).toBeNull();
    expect(masked!.checksumOk).toBeNull();
  });
});
