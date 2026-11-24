#!/usr/bin/env node
/**
 * KJGX Writeback Serial Worker Client (Single Device Exclusive Lock).
 *
 * Usage:
 *   CRM_API_URL=https://crm.example.ts.net:8443 \
 *   CRM_WORKER_TOKEN=... \
 *   KJGX_DEVICE_ID=pixel3a-kjgx \
 *   KJGX_APP_VERSION=18.5 \
 *   KJGX_BUNDLE_HASH=<sha256> \
 *   node scripts/kjgx-worker.mjs [--once] [--dry-run]
 */
import { execSync } from 'node:child_process';

function parseArgs(argv) {
  return {
    once: argv.includes('--once'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function executeJobViaHook(job, dryRun, deviceId) {
  if (dryRun) {
    return {
      assigned_device: deviceId,
      attempts: job.attempts ?? 1,
      route_result: 'DRY_RUN_NAVIGATED',
      edit_page_seen: true,
      customer_name_seen: true,
      readback_matched: true,
      app_result: { ok: true, mode: 'dry-run' },
    };
  }
  const execCmd = process.env.KJGX_EXEC_CMD;
  if (!execCmd) {
    throw new Error('KJGX_EXEC_CMD must be set when running without --dry-run');
  }
  const out = execSync(execCmd, {
    input: JSON.stringify(job),
    encoding: 'utf8',
    timeout: 90_000,
  });
  return JSON.parse(out);
}

async function pollOnce(cfg, args) {
  const claimUrl = `${cfg.apiUrl}/api/v1/kjgx/worker/claim`;
  const claimRes = await postJson(claimUrl, cfg.token, {
    deviceId: cfg.deviceId,
    appVersion: cfg.appVersion,
    bundleHash: cfg.bundleHash,
  });

  if (claimRes.status === 409 || claimRes.data?.ok === false) {
    console.error('KJGX L0 GATE HALTED:', JSON.stringify(claimRes.data));
    return { halted: true, processed: false };
  }
  if (claimRes.status >= 400) {
    throw new Error(`Claim failed HTTP ${claimRes.status}: ${JSON.stringify(claimRes.data)}`);
  }

  const job = claimRes.data?.job;
  if (!job) {
    return { halted: false, processed: false };
  }

  let receipt;
  try {
    receipt = executeJobViaHook(job, args.dryRun, cfg.deviceId);
  } catch (err) {
    receipt = {
      assigned_device: cfg.deviceId,
      attempts: job.attempts ?? 1,
      route_result: 'EXECUTION_ERROR',
      edit_page_seen: false,
      customer_name_seen: false,
      readback_matched: false,
      app_result: { ok: false },
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const completeUrl = `${cfg.apiUrl}/api/v1/kjgx/worker/complete`;
  const completeRes = await postJson(completeUrl, cfg.token, {
    jobId: job.id,
    deviceId: cfg.deviceId,
    receipt,
  });
  if (completeRes.status >= 400) {
    throw new Error(`Complete failed HTTP ${completeRes.status}: ${JSON.stringify(completeRes.data)}`);
  }
  console.log(
    JSON.stringify({
      job_id: job.id,
      execution_status: completeRes.data?.execution_status,
      readback_matched: Boolean(receipt.readback_matched),
    }),
  );
  return { halted: false, processed: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = (process.env.CRM_API_URL ?? '').replace(/\/+$/, '');
  const token = process.env.CRM_WORKER_TOKEN ?? '';
  const deviceId = process.env.KJGX_DEVICE_ID ?? 'pixel3a-kjgx';
  const appVersion = process.env.KJGX_APP_VERSION ?? '18.5';
  const bundleHash = process.env.KJGX_BUNDLE_HASH ?? '';
  const pollMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000);

  if (!apiUrl || !token || !bundleHash) {
    console.error('Required env vars: CRM_API_URL, CRM_WORKER_TOKEN, KJGX_BUNDLE_HASH');
    process.exit(1);
  }

  const cfg = { apiUrl, token, deviceId, appVersion, bundleHash };
  if (args.once) {
    const res = await pollOnce(cfg, args);
    if (res.halted) process.exit(2);
    return;
  }

  while (true) {
    const res = await pollOnce(cfg, args);
    if (res.halted) {
      console.error('Halting worker loop due to L0 OTA gate.');
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, res.processed ? 1000 : pollMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
