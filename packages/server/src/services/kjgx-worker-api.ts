import { KjgxReceiptSchema, type EnqueueKjgxJobInput, type KjgxWritebackJob } from '@insurance-crm/shared';
import type { ActorContext, CrmStore } from './store.js';

export class KjgxWritebackService {
  constructor(
    private readonly store: CrmStore,
    private readonly expectedBundleHash: string = process.env.KJGX_EXPECTED_BUNDLE_HASH ?? '',
  ) {}

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
   * Single serial worker claim with L0 OTA Bundle Hash melt-down gate.
   * Rejects dispatch and marks `blocked_ota` if bundleHash diverges from expectedBundleHash.
   */
  async claimNext(params: { deviceId: string; appVersion: string; bundleHash: string }) {
    const jobs = await this.store.listKjgxJobs({ execution_status: 'queued' });
    const eligible = jobs
      .filter((j) => (j.approval_status === 'approved' || j.approval_status === 'auto_approved') && j.attempts < j.max_attempts)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    if (eligible.length === 0) {
      return { ok: true as const, job: null };
    }

    const nextJob = eligible[0]!;
    const configuredHash = this.expectedBundleHash.trim();
    const gateActive = Boolean(configuredHash) && configuredHash !== 'replace-with-current-sha256';
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
