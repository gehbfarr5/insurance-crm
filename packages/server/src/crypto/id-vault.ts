import crypto from 'node:crypto';
import { maskIdNo, normalizeIdNo, validateCnIdChecksum } from '@insurance-crm/shared';

export interface SealedIdRecord {
  encrypted: Buffer;
  masked: string | null;
  hmac: string | null;
  checksumOk: boolean | null;
}

export class IdVault {
  private readonly encKey: Buffer;
  private readonly hmacKey: Buffer;

  constructor(encKeyHex: string, hmacKeyHex: string) {
    this.encKey = Buffer.from(encKeyHex, 'hex');
    this.hmacKey = Buffer.from(hmacKeyHex, 'hex');
    if (this.encKey.length !== 32) {
      throw new Error('ID_VAULT_ENC_KEY_HEX must decode to 32 bytes (64 hex chars)');
    }
    if (this.hmacKey.length < 16) {
      throw new Error('ID_VAULT_HMAC_KEY_HEX must decode to at least 16 bytes');
    }
  }

  static fromEnv(): IdVault {
    const enc = process.env.ID_VAULT_ENC_KEY_HEX ?? '00'.repeat(32);
    const hmac = process.env.ID_VAULT_HMAC_KEY_HEX ?? '11'.repeat(32);
    return new IdVault(enc, hmac);
  }

  encrypt(plaintext: string): Buffer {
    const norm = normalizeIdNo(plaintext);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(norm, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]);
  }

  decrypt(blob: Buffer): string {
    if (blob.length < 28) {
      throw new Error('Invalid encrypted ID payload');
    }
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  }

  /** Encrypts arbitrary UTF-8 secrets (e.g. JSON session credentials) verbatim without ID normalization. */
  encryptSecret(plaintext: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]);
  }

  /** Decrypts arbitrary UTF-8 secrets encrypted by `encryptSecret`. */
  decryptSecret(blob: Buffer): string {
    return this.decrypt(blob);
  }

  hmac(plaintext: string): string {
    const norm = normalizeIdNo(plaintext);
    return crypto.createHmac('sha256', this.hmacKey).update(norm).digest('hex');
  }

  seal(rawIdNo: string | null | undefined): SealedIdRecord | null {
    const norm = normalizeIdNo(rawIdNo);
    if (!norm) return null;
    const masked = maskIdNo(norm);
    const checksumOk = validateCnIdChecksum(norm);
    const isFullUnmasked = !norm.includes('*');
    return {
      encrypted: this.encrypt(norm),
      masked,
      hmac: isFullUnmasked ? this.hmac(norm) : null,
      checksumOk,
    };
  }
}
