import { KjgxReceiptSchema, type EnqueueKjgxJobInput, type KjgxWritebackJob } from '@insurance-crm/shared';
import {
  KjgxDirectApiClient,
  KjgxSessionExpiredError,
  type KhzxProbeResult,
  type KjgxSession,
} from './kjgx-api-client.js';
import type { ActorContext, CrmStore } from './store.js';

export interface KjgxWorkerHeartbeat {
  device_id: string;
  app_version: string;
  bundle_hash_prefix: string;
  bundle_hash_matched: boolean;
  executor_ready: boolean;
  last_seen_at: string;
}

export class KjgxWritebackService {
  private lastHeartbeat: KjgxWorkerHeartbeat | null = null;
  private liveSession: KjgxSession | null = null;
  private readonly apiClient: KjgxDirectApiClient;

  constructor(
    private readonly store: CrmStore,
    private readonly expectedBundleHash: string = process.env.KJGX_EXPECTED_BUNDLE_HASH ?? '',
    apiClient?: KjgxDirectApiClient,
  ) {
    this.apiClient = apiClient ?? new KjgxDirectApiClient();
  }

  private isGateArmed(): boolean {
    const h = this.expectedBundleHash.trim();
    return Boolean(h) && h !== 'replace-with-current-sha256';
  }

  async recordHeartbeat(params: {
    deviceId: string;
    appVersion: string;
    bundleHash: string;
    executorReady?: boolean;
    sessionToken?: string;
    empNoAes?: string;
  }) {
    const gateArmed = this.isGateArmed();
    const expected = this.expectedBundleHash.trim();
    const matched = !gateArmed || params.bundleHash === expected;

    if (params.sessionToken && params.empNoAes) {
      this.liveSession = {
        accesstoken: params.sessionToken.trim(),
        empNoAES: params.empNoAes.trim(),
      };
    }

    this.lastHeartbeat = {
      device_id: params.deviceId,
      app_version: params.appVersion,
      bundle_hash_prefix: params.bundleHash.slice(0, 12),
      bundle_hash_matched: matched,
      executor_ready: params.executorReady === true || Boolean(this.liveSession),
      last_seen_at: new Date().toISOString(),
    };
    const jobs = await this.store.listKjgxJobs({ execution_status: 'queued' });
    const pendingApproved = jobs.filter(
      (j) => (j.approval_status === 'approved' || j.approval_status === 'auto_approved') && j.attempts < j.max_attempts,
    ).length;
    return {
      ok: true as const,
      ota_gate_armed: gateArmed,
      bundle_hash_matched: matched,
      session_present: Boolean(this.liveSession?.accesstoken && this.liveSession?.empNoAES),
      pending_approved_jobs: pendingApproved,
      worker: this.lastHeartbeat,
    };
  }

  getWorkerStatus() {
    const gateArmed = this.isGateArmed();
    const expected = this.expectedBundleHash.trim();
    const online = Boolean(
      this.lastHeartbeat && Date.now() - Date.parse(this.lastHeartbeat.last_seen_at) <= 120_000,
    );
    return {
      online,
      ota_gate_armed: gateArmed,
      expected_bundle_hash_prefix: gateArmed ? expected.slice(0, 12) : null,
      execution_mode: 'direct_khzx_api' as const,
      session_present: Boolean(this.liveSession?.accesstoken && this.liveSession?.empNoAES),
      worker: this.lastHeartbeat,
    };
  }

  async probeSession(): Promise<KhzxProbeResult> {
    if (!this.liveSession?.accesstoken || !this.liveSession?.empNoAES) {
      return {
        ok: false,
        status: 401,
        session_expired: true,
        code: 'NO_SESSION',
        message: 'No live KJGX session synced from Pixel worker yet',
      };
    }
    const res = await this.apiClient.probeSession(this.liveSession);
    if (res.session_expired) {
      this.liveSession = null;
    }
    return res;
  }

  async enqueue(input: EnqueueKjgxJobInput, actor: ActorContext): Promise<KjgxWritebackJob> {
    const detail = await this.store.getCustomer360(input.customer_id);
    const idempotencyKey =
      input.idempotency_key ?? `${input.job_type}-${input.customer_id}-${Date.now()}`;
    return this.store.enqueueKjgxJob(
      {
        customer_id: input.customer_id,
        job_type: input.job_type,
        risk_level: input.risk_level ?? 'L2_profile_write',
        idempotency_key: idempotencyKey,
        payload_before: {
          name: detail.customer.name,
          primary_phone: detail.customer.primary_phone,
          address: detail.customer.address,
        },
        payload_target: input.payload_target,
        field_diff: input.field_diff ?? [],
        validation_checks: {
          phone_valid: Boolean(detail.customer.primary_phone),
          identity_matched: Boolean(detail.customer.kjgx_customer_no || detail.customer.primary_phone),
        },
        auto_approve: input.auto_approve,
      },
      actor,
    );
  }

  async approve(jobId: string, actor: ActorContext): Promise<KjgxWritebackJob> {
    return this.store.updateKjgxJob(
      jobId,
      {
        approval_status: 'approved',
        approved_by: actor.actorId,
        approved_at: new Date().toISOString(),
        stage: 'queued_for_worker',
      },
      actor,
    );
  }

  async reject(jobId: string, actor: ActorContext): Promise<KjgxWritebackJob> {
    return this.store.updateKjgxJob(
      jobId,
      {
        approval_status: 'rejected',
        execution_status: 'cancelled',
        stage: 'rejected_by_human',
      },
      actor,
    );
  }

  /**
   * Executes a single human-approved queued job via the direct authenticated khzx HTTPS API
   * with L0 OTA gate + dual-identity check + mandatory post-write readback verification.
   */
  async executeJob(
    jobId: string,
    actor: ActorContext,
    opts: { dryRun?: boolean } = {},
  ): Promise<{ ok: boolean; dry_run: boolean; job: KjgxWritebackJob; receipt?: unknown }> {
    const job = await this.store.getKjgxJob(jobId);
    if (!job) {
      throw new Error(`KJGX job ${jobId} not found`);
    }
    if (job.approval_status !== 'approved' && job.approval_status !== 'auto_approved') {
      throw new Error(`Job ${jobId} is not approved (approval_status=${job.approval_status})`);
    }
    if (!opts.dryRun && (job.execution_status !== 'queued' || job.attempts >= job.max_attempts)) {
      throw new Error(`Job ${jobId} is not executable (status=${job.execution_status}, attempts=${job.attempts}/${job.max_attempts})`);
    }

    const deviceId = this.lastHeartbeat?.device_id ?? 'pixel3a-kjgx';
    if (this.isGateArmed() && this.lastHeartbeat && !this.lastHeartbeat.bundle_hash_matched) {
      const blocked = await this.store.updateKjgxJob(
        job.id,
        {
          execution_status: 'blocked_ota',
          assigned_device: deviceId,
          stage: 'l0_ota_mismatch',
          receipt: {
            assigned_device: deviceId,
            attempts: job.attempts,
            route_result: 'L0_OTA_ABORT',
            edit_page_seen: false,
            customer_name_seen: false,
            readback_matched: false,
            app_result: { expected_prefix: this.expectedBundleHash.slice(0, 12) },
            error: 'OTA_HASH_MISMATCH: Bundle hash changed, halting fail-closed',
          },
        },
        actor,
      );
      return { ok: false, dry_run: Boolean(opts.dryRun), job: blocked };
    }

    if (!this.liveSession?.accesstoken || !this.liveSession?.empNoAES) {
      throw new Error('SESSION_MISSING: Pixel 3a KJGX session is not available');
    }

    const detail = await this.store.getCustomer360(job.customer_id);
    const idMap = await this.store.getDecryptedIdMap([job.customer_id]);
    const decryptedIdNo = idMap.get(job.customer_id) ?? null;

    if (opts.dryRun) {
      const dryReceipt = await this.apiClient.executeWritebackJob({
        job,
        customer: detail.customer,
        decryptedIdNo,
        session: this.liveSession,
        deviceId,
        dryRun: true,
      });
      return { ok: true, dry_run: true, job, receipt: dryReceipt };
    }

    const claimed = await this.store.updateKjgxJob(
      job.id,
      {
        execution_status: 'claimed',
        assigned_device: deviceId,
        attempts: job.attempts + 1,
        stage: 'direct_khzx_api_running',
      },
      actor,
    );

    try {
      const receipt = await this.apiClient.executeWritebackJob({
        job: claimed,
        customer: detail.customer,
        decryptedIdNo,
        session: this.liveSession,
        deviceId,
      });
      const completed = await this.completeJob(job.id, receipt, deviceId);
      return { ok: receipt.readback_matched === true, dry_run: false, job: completed, receipt };
    } catch (err) {
      if (err instanceof KjgxSessionExpiredError) {
        this.liveSession = null;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const failed = await this.completeJob(
        job.id,
        {
          assigned_device: deviceId,
          attempts: claimed.attempts,
          route_result: err instanceof KjgxSessionExpiredError ? 'SESSION_EXPIRED' : 'DIRECT_KHZX_EXCEPTION',
          edit_page_seen: false,
          customer_name_seen: false,
          readback_matched: false,
          app_result: { error: errMsg },
          error: errMsg,
        },
        deviceId,
      );
      return { ok: false, dry_run: false, job: failed };
    }
  }

  /**
   * Single serial worker claim with L0 OTA Bundle Hash melt-down gate.
   * Rejects dispatch and marks `blocked_ota` if bundleHash diverges from expectedBundleHash.
   */
  async claimNext(params: { deviceId: string; appVersion: string; bundleHash: string }) {
    const gateActive = this.isGateArmed();
    const configuredHash = this.expectedBundleHash.trim();
    this.lastHeartbeat = {
      device_id: params.deviceId,
      app_version: params.appVersion,
      bundle_hash_prefix: params.bundleHash.slice(0, 12),
      bundle_hash_matched: !gateActive || params.bundleHash === configuredHash,
      executor_ready: true,
      last_seen_at: new Date().toISOString(),
    };

    const jobs = await this.store.listKjgxJobs({ execution_status: 'queued' });
    const eligible = jobs
      .filter((j) => (j.approval_status === 'approved' || j.approval_status === 'auto_approved') && j.attempts < j.max_attempts)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    if (eligible.length === 0) {
      return { ok: true as const, job: null };
    }

    const nextJob = eligible[0]!;
    if (gateActive && params.bundleHash !== configuredHash) {
      const blocked = await this.store.updateKjgxJob(
        nextJob.id,
        {
          execution_status: 'blocked_ota',
          assigned_device: params.deviceId,
          stage: 'l0_ota_mismatch',
          receipt: {
            assigned_device: params.deviceId,
            attempts: nextJob.attempts,
            route_result: 'L0_OTA_ABORT',
            edit_page_seen: false,
            customer_name_seen: false,
            readback_matched: false,
            app_result: { expected_hash: configuredHash, actual_hash: params.bundleHash, app_version: params.appVersion },
            error: 'OTA_HASH_MISMATCH: Bundle hash changed, halting fail-closed',
          },
        },
        { actorType: 'kjgx_worker', actorId: params.deviceId },
      );
      return {
        ok: false as const,
        code: 'OTA_HASH_MISMATCH',
        job: blocked,
      };
    }

    const claimed = await this.store.updateKjgxJob(
      nextJob.id,
      {
        execution_status: 'claimed',
        assigned_device: params.deviceId,
        attempts: nextJob.attempts + 1,
        stage: 'claimed_by_worker',
      },
      { actorType: 'kjgx_worker', actorId: params.deviceId },
    );

    return { ok: true as const, job: claimed };
  }

  /**
   * Complete job strictly requiring `readback_matched === true`.
   * Any mismatch or false flag fails closed (`failed`) without blind retry.
   */
  async completeJob(jobId: string, rawReceipt: unknown, deviceId: string): Promise<KjgxWritebackJob> {
    const receipt = KjgxReceiptSchema.parse(rawReceipt);
    const succeeded = receipt.readback_matched === true;
    return this.store.updateKjgxJob(
      jobId,
      {
        execution_status: succeeded ? 'succeeded' : 'failed',
        stage: succeeded ? 'completed' : 'readback_mismatch_halted',
        receipt,
      },
      { actorType: 'kjgx_worker', actorId: deviceId },
    );
  }
}
