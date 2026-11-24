import crypto from 'node:crypto';
import { normalizePhone, type SanitizedIcloudContact } from '@insurance-crm/shared';
import { ConflictError, NotFoundError } from './store.js';

export interface ParsedVcard {
  uid: string | null;
  fn: string | null;
  phones: string[];
  rawPhones: string[];
  birthday: string | null;
  address: string | null;
  company: string | null;
  note: string | null;
  isGroup: boolean;
}

export interface CardDavContactRecord {
  href: string;
  etag: string | null;
  rawVcard: string;
  parsed: ParsedVcard;
}

export interface CardDavContactPatch {
  fullName?: string;
  phones?: string[];
  birthday?: string | null;
  address?: string | null;
  company?: string | null;
}

export interface CardDavTransport {
  discoverAddressBook(): Promise<string>;
  listContacts(): Promise<CardDavContactRecord[]>;
  getCard(href: string): Promise<CardDavContactRecord | null>;
  createCard(
    sanitized: SanitizedIcloudContact,
    note: string | null,
    uid?: string,
  ): Promise<{ href: string; etag: string | null; uid: string }>;
  updateCardSurgical(
    href: string,
    expectedEtag: string | null,
    rawVcard: string,
    patch: CardDavContactPatch,
    mergedNote: string | null,
  ): Promise<{ href: string; etag: string | null }>;
  deleteCard(href: string, expectedEtag?: string | null): Promise<void>;
}

function unescapeVcardValue(raw: string): string {
  return raw.replace(/\\([nN,;\\])/g, (_m, ch: string) => {
    if (ch === 'n' || ch === 'N') return '\n';
    return ch;
  });
}

function escapeVcardValue(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function unfoldVcardLines(raw: string): string[] {
  return raw
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

function splitPropertyLine(line: string): { group: string | null; prop: string; value: string } | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const propToken = head.split(';')[0] ?? '';
  const dotIdx = propToken.indexOf('.');
  if (dotIdx !== -1) {
    return {
      group: propToken.slice(0, dotIdx),
      prop: propToken.slice(dotIdx + 1).toUpperCase(),
      value,
    };
  }
  return { group: null, prop: propToken.toUpperCase(), value };
}

function formatNameComponent(fullName: string): string {
  const clean = fullName.trim();
  if (!clean) return ';;;;';
  const spaceParts = clean.split(/\s+/);
  if (spaceParts.length >= 2) {
    const family = escapeVcardValue(spaceParts[0]!);
    const given = escapeVcardValue(spaceParts.slice(1).join(' '));
    return `${family};${given};;;`;
  }
  const chars = Array.from(clean);
  if (chars.length >= 2 && /[\u4e00-\u9fff]/.test(clean)) {
    return `${escapeVcardValue(chars[0]!)};${escapeVcardValue(chars.slice(1).join(''))};;;`;
  }
  return `${escapeVcardValue(clean)};;;;`;
}

function normalizeBirthdayValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }
  return trimmed;
}

export function parseVcard(raw: string): ParsedVcard {
  const lines = unfoldVcardLines(raw);
  let uid: string | null = null;
  let fn: string | null = null;
  const phones: string[] = [];
  const rawPhones: string[] = [];
  let birthday: string | null = null;
  let address: string | null = null;
  let company: string | null = null;
  let note: string | null = null;
  let isGroup = false;

  for (const line of lines) {
    const parsed = splitPropertyLine(line);
    if (!parsed) continue;
    const { prop, value } = parsed;

    if (prop === 'X-ADDRESSBOOKSERVER-KIND' && value.trim().toLowerCase() === 'group') {
      isGroup = true;
    } else if (prop === 'UID' && uid === null) {
      uid = unescapeVcardValue(value).trim() || null;
    } else if (prop === 'FN' && fn === null) {
      fn = unescapeVcardValue(value).trim() || null;
    } else if (prop === 'TEL') {
      const rawPhone = unescapeVcardValue(value).trim();
      if (rawPhone) {
        rawPhones.push(rawPhone);
        const norm = normalizePhone(rawPhone);
        if (norm && !phones.includes(norm)) {
          phones.push(norm);
        }
      }
    } else if (prop === 'BDAY' && birthday === null) {
      birthday = normalizeBirthdayValue(unescapeVcardValue(value));
    } else if (prop === 'ADR' && address === null) {
      const parts = value
        .split(/(?<!\\);/)
        .map((p) => unescapeVcardValue(p).trim())
        .filter(Boolean);
      address = parts.join(' ').trim() || null;
    } else if (prop === 'ORG' && company === null) {
      const parts = value
        .split(/(?<!\\);/)
        .map((p) => unescapeVcardValue(p).trim())
        .filter(Boolean);
      company = parts.join(' ').trim() || null;
    } else if (prop === 'NOTE' && note === null) {
      note = unescapeVcardValue(value);
    }
  }

  return { uid, fn, phones, rawPhones, birthday, address, company, note, isGroup };
}

export function buildNewVcard(
  sanitized: SanitizedIcloudContact,
  note: string | null,
  uid: string = crypto.randomUUID(),
): string {
  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Insurance CRM//CardDAV Sync//EN',
    `UID:${uid}`,
    `N:${formatNameComponent(sanitized.fullName)}`,
    `FN:${escapeVcardValue(sanitized.fullName)}`,
  ];

  for (const phone of sanitized.phones) {
    if (phone.trim()) {
      lines.push(`TEL;TYPE=CELL:${phone.trim()}`);
    }
  }
  if (sanitized.birthday) {
    lines.push(`BDAY:${sanitized.birthday}`);
  }
  if (sanitized.address) {
    lines.push(`ADR;TYPE=HOME:;;${escapeVcardValue(sanitized.address)};;;;`);
  }
  if (sanitized.company) {
    lines.push(`ORG:${escapeVcardValue(sanitized.company)}`);
  }
  if (note) {
    lines.push(`NOTE:${escapeVcardValue(note)}`);
  }
  lines.push(`REV:${new Date().toISOString()}`);
  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}

export function patchVcardSurgical(
  raw: string,
  patch: CardDavContactPatch,
  mergedNote: string | null,
): string {
  const lines = unfoldVcardLines(raw);
  const propsToReplace = new Set<string>(['REV']);
  if ('fullName' in patch && patch.fullName !== undefined) propsToReplace.add('FN');
  if ('phones' in patch && patch.phones !== undefined) propsToReplace.add('TEL');
  if ('birthday' in patch) propsToReplace.add('BDAY');
  if ('address' in patch) propsToReplace.add('ADR');
  if ('company' in patch) propsToReplace.add('ORG');
  if (mergedNote !== null) propsToReplace.add('NOTE');

  // Identify itemN prefixes owned solely by replaced TEL/ADR lines so orphaned labels don't linger
  const removedGroups = new Set<string>();
  const keptGroups = new Set<string>();
  for (const line of lines) {
    const parsed = splitPropertyLine(line);
    if (!parsed?.group) continue;
    if (propsToReplace.has(parsed.prop)) {
      removedGroups.add(parsed.group);
    } else if (parsed.prop !== 'X-ABLABEL' && parsed.prop !== 'X-ABADR') {
      keptGroups.add(parsed.group);
    }
  }

  const kept: string[] = [];
  let hasBegin = false;
  let hasUid = false;

  for (const line of lines) {
    const parsed = splitPropertyLine(line);
    if (!parsed) continue;
    if (parsed.prop === 'BEGIN') {
      hasBegin = true;
      kept.push('BEGIN:VCARD');
      continue;
    }
    if (parsed.prop === 'END') {
      continue;
    }
    if (parsed.prop === 'UID') hasUid = true;
    if (propsToReplace.has(parsed.prop)) {
      continue;
    }
    if (
      parsed.group &&
      removedGroups.has(parsed.group) &&
      !keptGroups.has(parsed.group) &&
      (parsed.prop === 'X-ABLABEL' || parsed.prop === 'X-ABADR')
    ) {
      continue;
    }
    kept.push(line);
  }

  if (!hasBegin) kept.unshift('BEGIN:VCARD', 'VERSION:3.0');
  if (!hasUid) kept.push(`UID:${crypto.randomUUID()}`);

  if ('fullName' in patch && patch.fullName !== undefined) {
    kept.push(`FN:${escapeVcardValue(patch.fullName)}`);
  }
  if ('phones' in patch && patch.phones !== undefined) {
    for (const phone of patch.phones) {
      if (phone.trim()) {
        kept.push(`TEL;TYPE=CELL:${phone.trim()}`);
      }
    }
  }
  if ('birthday' in patch && patch.birthday) {
    kept.push(`BDAY:${patch.birthday}`);
  }
  if ('address' in patch && patch.address) {
    kept.push(`ADR;TYPE=HOME:;;${escapeVcardValue(patch.address)};;;;`);
  }
  if ('company' in patch && patch.company) {
    kept.push(`ORG:${escapeVcardValue(patch.company)}`);
  }
  if (mergedNote !== null) {
    kept.push(`NOTE:${escapeVcardValue(mergedNote)}`);
  }
  kept.push(`REV:${new Date().toISOString()}`);
  kept.push('END:VCARD');
  return `${kept.join('\r\n')}\r\n`;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractTagText(xml: string, localName: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${localName}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${localName}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1]!.trim()) : null;
}

function extractDavResponses(xml: string): string[] {
  const matches = xml.match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi);
  return matches ?? [];
}

export class DirectIcloudCardDavClient implements CardDavTransport {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private cachedBookUrl: string | null = null;
  private readonly etagCache = new Map<string, CardDavContactRecord>();

  constructor(opts: {
    email: string;
    appPassword: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  }) {
    const basic = Buffer.from(`${opts.email}:${opts.appPassword}`, 'utf8').toString('base64');
    this.authHeader = `Basic ${basic}`;
    this.baseUrl = (opts.baseUrl ?? 'https://contacts.icloud.com').replace(/\/+$/, '');
    this.fetchFn = opts.fetchImpl ?? fetch;
  }

  private async davRequest(
    method: string,
    url: string,
    opts: { depth?: string; contentType?: string; body?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: this.authHeader,
      ...opts.extraHeaders,
    };
    if (opts.depth !== undefined) headers.Depth = opts.depth;
    if (opts.contentType) headers['content-type'] = opts.contentType;

    return this.fetchFn(url, {
      method,
      headers,
      body: opts.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
  }

  async discoverAddressBook(): Promise<string> {
    if (this.cachedBookUrl) return this.cachedBookUrl;

    const r1 = await this.davRequest('PROPFIND', `${this.baseUrl}/`, {
      depth: '0',
      contentType: 'application/xml; charset=utf-8',
      body: '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
    });
    if (!r1.ok && r1.status !== 207) {
      throw new Error(`CardDAV principal discovery failed HTTP ${r1.status}`);
    }
    const x1 = await r1.text();
    const principalSection = x1.match(/<(?:[\w-]+:)?current-user-principal[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?current-user-principal>/i)?.[1] ?? '';
    const principalHref = extractTagText(principalSection, 'href');
    if (!principalHref) throw new Error('CardDAV current-user-principal href missing');
    const principalUrl = new URL(principalHref, r1.url || `${this.baseUrl}/`).href;

    const r2 = await this.davRequest('PROPFIND', principalUrl, {
      depth: '0',
      contentType: 'application/xml; charset=utf-8',
      body: '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><c:addressbook-home-set/></d:prop></d:propfind>',
    });
    if (!r2.ok && r2.status !== 207) {
      throw new Error(`CardDAV home-set discovery failed HTTP ${r2.status}`);
    }
    const x2 = await r2.text();
    const homeSection = x2.match(/<(?:[\w-]+:)?addressbook-home-set[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?addressbook-home-set>/i)?.[1] ?? '';
    const homeHref = extractTagText(homeSection, 'href');
    if (!homeHref) throw new Error('CardDAV addressbook-home-set href missing');
    const homeUrl = new URL(homeHref, r2.url || principalUrl).href;

    const r3 = await this.davRequest('PROPFIND', homeUrl, {
      depth: '1',
      contentType: 'application/xml; charset=utf-8',
      body: '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    });
    if (!r3.ok && r3.status !== 207) {
      throw new Error(`CardDAV addressbooks discovery failed HTTP ${r3.status}`);
    }
    const x3 = await r3.text();
    let bookHref: string | null = null;
    for (const block of extractDavResponses(x3)) {
      if (/<(?:[\w-]+:)?addressbook\b/i.test(block)) {
        bookHref = extractTagText(block, 'href');
        if (bookHref) break;
      }
    }
    if (!bookHref) throw new Error('CardDAV default addressbook collection not found');
    const bookUrl = new URL(bookHref, r3.url || homeUrl).href;
    this.cachedBookUrl = bookUrl.endsWith('/') ? bookUrl : `${bookUrl}/`;
    return this.cachedBookUrl;
  }

  async listContacts(): Promise<CardDavContactRecord[]> {
    const bookUrl = await this.discoverAddressBook();
    const idxRes = await this.davRequest('PROPFIND', bookUrl, {
      depth: '1',
      contentType: 'application/xml; charset=utf-8',
      body: '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>',
    });
    if (!idxRes.ok && idxRes.status !== 207) {
      throw new Error(`CardDAV index PROPFIND failed HTTP ${idxRes.status}`);
    }
    const idxXml = await idxRes.text();

    const currentRefs: Array<{ href: string; fullUrl: string; etag: string | null }> = [];
    const staleUrls: string[] = [];
    const seenUrls = new Set<string>();

    for (const block of extractDavResponses(idxXml)) {
      const href = extractTagText(block, 'href');
      if (!href || !href.endsWith('.vcf')) continue;
      const fullUrl = new URL(href, bookUrl).href;
      const etag = extractTagText(block, 'getetag');
      seenUrls.add(fullUrl);
      currentRefs.push({ href, fullUrl, etag });

      const cached = this.etagCache.get(fullUrl);
      if (!cached || !etag || cached.etag !== etag) {
        staleUrls.push(href);
      }
    }

    for (const key of Array.from(this.etagCache.keys())) {
      if (!seenUrls.has(key)) this.etagCache.delete(key);
    }

    for (let i = 0; i < staleUrls.length; i += 100) {
      const batch = staleUrls.slice(i, i + 100);
      const hrefXml = batch.map((h) => `<d:href>${escapeXml(h)}</d:href>`).join('');
      const reportBody = `<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop>${hrefXml}</c:addressbook-multiget>`;
      const repRes = await this.davRequest('REPORT', bookUrl, {
        depth: '1',
        contentType: 'application/xml; charset=utf-8',
        body: reportBody,
      });
      if (!repRes.ok && repRes.status !== 207) {
        throw new Error(`CardDAV multiget REPORT failed HTTP ${repRes.status}`);
      }
      const repXml = await repRes.text();
      for (const block of extractDavResponses(repXml)) {
        const href = extractTagText(block, 'href');
        const rawVcard = extractTagText(block, 'address-data');
        if (!href || !rawVcard) continue;
        const fullUrl = new URL(href, bookUrl).href;
        const etag = extractTagText(block, 'getetag');
        const parsed = parseVcard(rawVcard);
        this.etagCache.set(fullUrl, { href: fullUrl, etag, rawVcard, parsed });
      }
    }

    const contacts: CardDavContactRecord[] = [];
    for (const ref of currentRefs) {
      const rec = this.etagCache.get(ref.fullUrl);
      if (rec && !rec.parsed.isGroup) {
        contacts.push(rec);
      }
    }
    return contacts;
  }

  async getCard(href: string): Promise<CardDavContactRecord | null> {
    const bookUrl = await this.discoverAddressBook();
    const fullUrl = new URL(href, bookUrl).href;
    const res = await this.davRequest('GET', fullUrl);
    if (res.status === 404) {
      this.etagCache.delete(fullUrl);
      return null;
    }
    if (!res.ok) {
      throw new Error(`CardDAV GET failed HTTP ${res.status}`);
    }
    const rawVcard = await res.text();
    const etag = res.headers.get('etag');
    const parsed = parseVcard(rawVcard);
    const rec: CardDavContactRecord = { href: fullUrl, etag, rawVcard, parsed };
    this.etagCache.set(fullUrl, rec);
    return rec;
  }

  async createCard(
    sanitized: SanitizedIcloudContact,
    note: string | null,
    uid: string = crypto.randomUUID().toUpperCase(),
  ): Promise<{ href: string; etag: string | null; uid: string }> {
    const bookUrl = await this.discoverAddressBook();
    const targetUrl = new URL(`${uid}.vcf`, bookUrl).href;
    const body = buildNewVcard(sanitized, note, uid);
    const res = await this.davRequest('PUT', targetUrl, {
      contentType: 'text/vcard; charset=utf-8',
      body,
      extraHeaders: { 'If-None-Match': '*' },
    });
    if (res.status === 412) {
      throw new ConflictError(`CardDAV card ${uid} already exists`);
    }
    if (!res.ok) {
      throw new Error(`CardDAV createCard PUT failed HTTP ${res.status}`);
    }
    const etag = res.headers.get('etag');
    const fresh = await this.getCard(targetUrl);
    return { href: targetUrl, etag: fresh?.etag ?? etag, uid };
  }

  async updateCardSurgical(
    href: string,
    expectedEtag: string | null,
    rawVcard: string,
    patch: CardDavContactPatch,
    mergedNote: string | null,
  ): Promise<{ href: string; etag: string | null }> {
    const bookUrl = await this.discoverAddressBook();
    const fullUrl = new URL(href, bookUrl).href;
    const nextVcard = patchVcardSurgical(rawVcard, patch, mergedNote);
    const extraHeaders: Record<string, string> = {};
    if (expectedEtag) extraHeaders['If-Match'] = expectedEtag;

    const res = await this.davRequest('PUT', fullUrl, {
      contentType: 'text/vcard; charset=utf-8',
      body: nextVcard,
      extraHeaders,
    });
    if (res.status === 412) {
      throw new ConflictError('iCloud 联系人已被其他设备修改 (CardDAV 412 Precondition Failed)');
    }
    if (res.status === 404) {
      this.etagCache.delete(fullUrl);
      throw new NotFoundError('iCloud 联系人卡片不存在或已被删除 (404)');
    }
    if (!res.ok) {
      throw new Error(`CardDAV updateCardSurgical PUT failed HTTP ${res.status}`);
    }
    const fresh = await this.getCard(fullUrl);
    return { href: fullUrl, etag: fresh?.etag ?? res.headers.get('etag') };
  }

  async deleteCard(href: string, expectedEtag?: string | null): Promise<void> {
    const bookUrl = await this.discoverAddressBook();
    const fullUrl = new URL(href, bookUrl).href;
    const extraHeaders: Record<string, string> = {};
    if (expectedEtag) extraHeaders['If-Match'] = expectedEtag;

    const res = await this.davRequest('DELETE', fullUrl, { extraHeaders });
    if (res.status === 404) {
      this.etagCache.delete(fullUrl);
      return;
    }
    if (res.status === 412) {
      throw new ConflictError('iCloud 联系人删除 ETag 冲突 (412)');
    }
    if (!res.ok) {
      throw new Error(`CardDAV DELETE failed HTTP ${res.status}`);
    }
    this.etagCache.delete(fullUrl);
  }
}
