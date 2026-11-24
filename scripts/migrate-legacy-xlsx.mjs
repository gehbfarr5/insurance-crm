#!/usr/bin/env node
/**
 * Migrate legacy deduplicated customer Excel ("客户汇总" worksheet) into PostgreSQL 16.
 *
 * Usage:
 *   node scripts/migrate-legacy-xlsx.mjs --input /path/to/summary.xlsx --dry-run
 *   node scripts/migrate-legacy-xlsx.mjs --input /path/to/summary.xlsx --apply
 *
 * Security & Privacy:
 *   --dry-run prints ONLY aggregate counts (zero customer PII).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

function parseArgs(argv) {
  const args = { input: '', apply: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' && argv[i + 1]) {
      args.input = argv[++i];
    } else if (a === '--apply') {
      args.apply = true;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    }
  }
  if (!args.apply) args.dryRun = true;
  return args;
}

/** Pure-Node ZIP central directory reader (no external dependencies). */
function readZipEntries(buf) {
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid XLSX/ZIP archive (EOCD not found)');
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const files = new Map();

  let ptr = cdOffset;
  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    files.set(name, () => {
      if (method === 0) return compressed;
      if (method === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    });
  }
  return files;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function colRefToIndex(ref) {
  const letters = ref.replace(/\d+$/, '');
  let idx = 0;
  for (let i = 0; i < letters.length; i += 1) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function parseSharedStrings(xml) {
  const list = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch;
    let combined = '';
    while ((tMatch = tRe.exec(m[1])) !== null) {
      combined += decodeXmlEntities(tMatch[1]);
    }
    list.push(combined);
  }
  return list;
}

function findSheetPath(workbookXml, relsXml, targetSheetName) {
  const rels = new Map();
  const relTagRe = /<Relationship\b([^>]*)\/?>/g;
  let rm;
  while ((rm = relTagRe.exec(relsXml)) !== null) {
    const attrs = rm[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) rels.set(id, target);
  }
  const sheetTagRe = /<sheet\b([^>]*)\/?>/g;
  let sm;
  let firstTarget = null;
  while ((sm = sheetTagRe.exec(workbookXml)) !== null) {
    const attrs = sm[1];
    const name = /\bname="([^"]+)"/.exec(attrs)?.[1];
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    if (!rid) continue;
    const rawTarget = rels.get(rid);
    if (!rawTarget) continue;
    const normalized = rawTarget.startsWith('/xl/')
      ? rawTarget.slice(1)
      : rawTarget.startsWith('xl/')
        ? rawTarget
        : `xl/${rawTarget.replace(/^\/+/, '')}`;
    if (!firstTarget) firstTarget = normalized;
    if (name === targetSheetName) return normalized;
  }
  return firstTarget;
}

function parseWorksheetRows(sheetXml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const rowValues = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1];
      const inner = cm[2] ?? '';
      const rAttr = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const tAttr = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const colIdx = rAttr ? colRefToIndex(rAttr) : rowValues.length;
      let val = '';
      if (inner) {
        if (tAttr === 'inlineStr') {
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let tm;
          while ((tm = tRe.exec(inner)) !== null) val += decodeXmlEntities(tm[1]);
        } else {
          const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          if (vMatch) {
            val = tAttr === 's' ? (sharedStrings[Number(vMatch[1])] ?? '') : decodeXmlEntities(vMatch[1]);
          }
        }
      }
      rowValues[colIdx] = val.trim();
    }
    rows.push(rowValues);
  }
  return rows;
}

const ID_W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_C = '10X98765432';

function cleanStr(v) {
  const s = String(v ?? '').trim();
  return ['nan', 'none', 'null', 'nat'].includes(s.toLowerCase()) ? '' : s;
}

function normPhone(v) {
  let d = cleanStr(v).replace(/\D/g, '');
  if (d.startsWith('0086')) d = d.slice(4);
  else if (d.startsWith('86') && d.length === 13) d = d.slice(2);
  return d;
}

function validMobile(p) {
  return /^1[3-9]\d{9}$/.test(p);
}

function normId(v) {
  return cleanStr(v).replace(/[\s-]/g, '').toUpperCase();
}

function idChecksum(i) {
  if (!/^\d{17}[\dX]$/.test(i)) return null;
  let tot = 0;
  for (let k = 0; k < 17; k += 1) tot += Number(i[k]) * ID_W[k];
  return ID_C[tot % 11] === i[17];
}

function maskId(i) {
  if (!i) return null;
  if (i.includes('*')) return i;
  if (i.length === 18) return `${i.slice(0, 4)}**********${i.slice(14)}`;
  return '****';
}

function normDate(v) {
  const m = cleanStr(v).match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function toNum(v) {
  const t = cleanStr(v).replace(/[,，¥]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function mapRapport(priority) {
  return priority ? 'unassessed' : 'unassessed';
}

function mapPriority(v) {
  if (v === '高' || v === 'high') return 'high';
  if (v === '中' || v === 'medium') return 'medium';
  if (v === '低' || v === 'low') return 'low';
  return null;
}

function mapGender(v) {
  if (v === '男' || v === '1' || v === 'M') return '男';
  if (v === '女' || v === '2' || v === 'F') return '女';
  return '未知';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('Usage: node scripts/migrate-legacy-xlsx.mjs --input <path-to-xlsx> [--dry-run | --apply]');
    process.exit(1);
  }
  const buf = fs.readFileSync(args.input);
  const zip = readZipEntries(buf);

  const sharedXml = zip.has('xl/sharedStrings.xml') ? zip.get('xl/sharedStrings.xml')().toString('utf8') : '';
  const sharedStrings = sharedXml ? parseSharedStrings(sharedXml) : [];
  const wbXml = zip.get('xl/workbook.xml')().toString('utf8');
  const relsXml = zip.get('xl/_rels/workbook.xml.rels')().toString('utf8');
  const targetSheet = findSheetPath(wbXml, relsXml, '客户汇总');
  if (!targetSheet || !zip.has(targetSheet)) {
    throw new Error('Could not locate worksheet 客户汇总');
  }
  const rows = parseWorksheetRows(zip.get(targetSheet)().toString('utf8'), sharedStrings);
  if (rows.length < 2) throw new Error('Worksheet has no data rows');

  const headers = rows[0].map((h) => cleanStr(h));
  const stats = {
    mode: args.apply ? 'apply' : 'dry-run',
    total_rows: 0,
    valid_mobile_count: 0,
    unmasked_id_count: 0,
    masked_id_count: 0,
    id_checksum_valid_count: 0,
    premium_ge_100k_count: 0,
    quality_flagged_count: 0,
    field_conflict_count: 0,
    has_kjgx_key_count: 0,
  };

  const normalizedRecords = [];
  for (let i = 1; i < rows.length; i += 1) {
    const raw = rows[i];
    if (!raw || raw.every((x) => !cleanStr(x))) continue;
    const row = {};
    for (let c = 0; c < headers.length; c += 1) {
      row[headers[c]] = cleanStr(raw[c]);
    }
    if (!row['客户ID'] && !row['姓名'] && !row['手机'] && !row['证件号']) continue;

    stats.total_rows += 1;
    const phone = normPhone(row['手机']);
    const idRaw = normId(row['证件号']);
    const ck = idRaw && !idRaw.includes('*') ? idChecksum(idRaw) : null;
    const premium = toNum(row['保费']);
    const issues = row['疑似问题'] ? row['疑似问题'].split('；').filter(Boolean) : [];
    const conflicts = row['字段冲突'] ? row['字段冲突'].split('；').filter(Boolean) : [];
    const flags = [...issues, ...conflicts];

    if (validMobile(phone)) stats.valid_mobile_count += 1;
    if (idRaw) {
      if (idRaw.includes('*')) stats.masked_id_count += 1;
      else stats.unmasked_id_count += 1;
    }
    if (ck === true) stats.id_checksum_valid_count += 1;
    if (premium != null && premium >= 100000) stats.premium_ge_100k_count += 1;
    if (issues.length > 0) stats.quality_flagged_count += 1;
    if (conflicts.length > 0) stats.field_conflict_count += 1;
    if (row['客户编号'] || row['DB客户ID']) stats.has_kjgx_key_count += 1;

    normalizedRecords.push({
      legacy_group_key: row['客户ID'] || null,
      name: row['姓名'] || '(待补姓名)',
      gender: mapGender(row['性别']),
      birthday: normDate(row['出生日期']),
      age_override: toNum(row['年龄']),
      primary_phone: phone || null,
      address: row['地址'] || null,
      id_raw: idRaw || null,
      id_no_masked: maskId(idRaw),
      id_no_checksum_ok: ck,
      kjgx_customer_no: row['客户编号'] || null,
      kjgx_db_customer_id: row['DB客户ID'] || null,
      policy_total: toNum(row['保单数']) ?? 0,
      total_premium: premium,
      insurer_asset_wan: toNum(row['保险资产(万元)']),
      kjgx_customer_level: row['客户等级'] || null,
      kjgx_temp_level: row['客温层级'] || null,
      kjgx_temp_value: toNum(row['客温值']),
      kjgx_customer_status: row['客户状态'] || null,
      family_members_count: toNum(row['家庭人数']),
      kjgx_work_status: row['工作状态'] || null,
      kjgx_asset_index: toNum(row['资产指数']),
      kjgx_service_num: toNum(row['服务数']),
      kjgx_visit_num: toNum(row['拜访数']),
      kjgx_offline_visit_num: toNum(row['离线拜访数']),
      kjgx_kyc_score: toNum(row['KYC']),
      visit_priority: mapPriority(row['跟进优先级']),
      next_followup_at: normDate(row['下次跟进日期']),
      manual_summary: row['手工备注'] || null,
      source_type: row['来源'] || 'legacy_812_migration',
      rapport_tag: mapRapport(row['跟进优先级']),
      tags: row['活动标签'] ? [row['活动标签']] : [],
      data_quality_flags: flags,
    });
  }

  if (!args.apply) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  const encKeyHex = process.env.ID_VAULT_ENC_KEY_HEX;
  const hmacKeyHex = process.env.ID_VAULT_HMAC_KEY_HEX;
  if (!dbUrl || !encKeyHex || !hmacKeyHex) {
    throw new Error('--apply requires DATABASE_URL, ID_VAULT_ENC_KEY_HEX, and ID_VAULT_HMAC_KEY_HEX');
  }
  const encKey = Buffer.from(encKeyHex, 'hex');
  const hmacKey = Buffer.from(hmacKeyHex, 'hex');
  if (encKey.length !== 32) throw new Error('ID_VAULT_ENC_KEY_HEX must be 64 hex chars');

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  let applied = 0;
  try {
    await client.query('BEGIN');
    for (const r of normalizedRecords) {
      let encrypted = null;
      let hmac = null;
      if (r.id_raw) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
        const ct = Buffer.concat([cipher.update(r.id_raw, 'utf8'), cipher.final()]);
        encrypted = Buffer.concat([iv, cipher.getAuthTag(), ct]);
        if (!r.id_raw.includes('*')) {
          hmac = crypto.createHmac('sha256', hmacKey).update(r.id_raw).digest('hex');
        }
      }

      const phonesJson = r.primary_phone
        ? JSON.stringify([{ value: r.primary_phone, label: 'mobile', is_primary: true }])
        : '[]';

      const res = await client.query(
        `INSERT INTO customers (
          legacy_group_key, name, gender, birthday, age_override,
          primary_phone, phones, address, id_no_encrypted, id_no_masked, id_no_hmac, id_no_checksum_ok,
          kjgx_customer_no, kjgx_db_customer_id, policy_total, total_premium, insurer_asset_wan,
          kjgx_customer_level, kjgx_temp_level, kjgx_temp_value, kjgx_customer_status, family_members_count,
          kjgx_work_status, kjgx_asset_index, kjgx_service_num, kjgx_visit_num, kjgx_offline_visit_num,
          kjgx_kyc_score, visit_priority, next_followup_at, manual_summary, source_type, rapport_tag,
          tags, data_quality_flags
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
        )
        ON CONFLICT (legacy_group_key) DO UPDATE SET
          name = EXCLUDED.name,
          primary_phone = COALESCE(EXCLUDED.primary_phone, customers.primary_phone),
          total_premium = COALESCE(EXCLUDED.total_premium, customers.total_premium),
          policy_total = GREATEST(customers.policy_total, EXCLUDED.policy_total)
        RETURNING id`,
        [
          r.legacy_group_key, r.name, r.gender, r.birthday, r.age_override,
          r.primary_phone, phonesJson, r.address, encrypted, r.id_no_masked, hmac, r.id_no_checksum_ok,
          r.kjgx_customer_no, r.kjgx_db_customer_id, r.policy_total, r.total_premium, r.insurer_asset_wan,
          r.kjgx_customer_level, r.kjgx_temp_level, r.kjgx_temp_value, r.kjgx_customer_status, r.family_members_count,
          r.kjgx_work_status, r.kjgx_asset_index, r.kjgx_service_num, r.kjgx_visit_num, r.kjgx_offline_visit_num,
          r.kjgx_kyc_score, r.visit_priority, r.next_followup_at, r.manual_summary, r.source_type, r.rapport_tag,
          r.tags, r.data_quality_flags,
        ],
      );

      const custId = res.rows[0].id;
      const extKey = r.kjgx_db_customer_id || r.kjgx_customer_no;
      if (extKey) {
        await client.query(
          `INSERT INTO external_links (customer_id, system, external_id, secondary_key, sync_status)
           VALUES ($1, 'kjgx_app', $2, $3, 'linked')
           ON CONFLICT (system, external_id) DO NOTHING`,
          [custId, extKey, r.kjgx_customer_no],
        );
      }
      applied += 1;
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ ...stats, applied_rows: applied }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
