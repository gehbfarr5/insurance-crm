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

export interface KjgxH5GateState {
  armed: boolean;
  expected_prefix: string | null;
  last_prefix: string | null;
  matched: boolean | null;
  script_count: number | null;
  checked_at: string | null;
}

export class KjgxWritebackService {
  private lastHeartbeat: KjgxWorkerHeartbeat | null = null;
  private liveSession: KjgxSession | null = null;
  private sessionSource: 'server_login' | 'pixel_heartbeat' | null = null;
  private sessionUpdatedAt: string | null = null;
  private empName: string | null = null;
  private empNoPrefix: string | null = null;
  private serverDevicesn: string = process.env.KJGX_SERVER_DEVICESN?.trim() || 'crm-seoul-kjgx-01';
  private lastH5Check: { hash: string; prefix: string; matched: boolean; script_count: number; checked_at: string } | null = null;
  private readonly apiClient: KjgxDirectApiClient;

  constructor(
    private readonly store: CrmStore,
    private readonly expectedBundleHash: string = process.env.KJGX_EXPECTED_BUNDLE_HASH ?? '',
    apiClient?: KjgxDirectApiClient,
    private readonly expectedH5Hash: string = process.env.KJGX_EXPECTED_H5_HASH ?? '',
  ) {
    this.apiClient = apiClient ?? new KjgxDirectApiClient();
  }

  private isGateArmed(): boolean {
    const h = this.expectedBundleHash.trim();
    return Boolean(h) && h !== 'replace-with-current-sha256';
  }

  private isH5GateArmed(): boolean {
    const h = this.expectedH5Hash.trim();
    return Boolean(h) && h !== 'replace-with-current-sha256';
  }

  async hydrateFromStore(): Promise<boolean> {
    const saved = await this.store.loadKjgxSession();
    if (!saved) return false;
    this.liveSession = {
      accesstoken: saved.accesstoken,
      empNoAES: saved.empNoAES,
      ...(saved.empNo ? { empNo: saved.empNo } : {}),
    };
    this.sessionSource = saved.source;
    this.sessionUpdatedAt = saved.updated_at;
    this.empName = saved.empName ?? this.empName;
    this.empNoPrefix = saved.empNo ? saved.empNo.slice(0, 4) : this.empNoPrefix;
    if (saved.devicesn) {
      this.serverDevicesn = saved.devicesn;
    }
    return true;
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
      this.sessionSource = 'pixel_heartbeat';
      this.sessionUpdatedAt = new Date().toISOString();
      await this.store.saveKjgxSession({
        accesstoken: this.liveSession.accesstoken,
        empNoAES: this.liveSession.empNoAES,
        empName: this.empName ?? undefined,
        devicesn: params.deviceId,
        source: 'pixel_heartbeat',
      });
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
    const h5Armed = this.isH5GateArmed();
    const expectedH5 = this.expectedH5Hash.trim();
    const pixelOnline = Boolean(
      this.lastHeartbeat && Date.now() - Date.parse(this.lastHeartbeat.last_seen_at) <= 120_000,
    );
    const sessionPresent = Boolean(this.liveSession?.accesstoken && this.liveSession?.empNoAES);
    const online = pixelOnline || (sessionPresent && this.sessionSource === 'server_login');
    return {
      online,
      pixel_online: pixelOnline,
      ota_gate_armed: gateArmed,
      expected_bundle_hash_prefix: gateArmed ? expected.slice(0, 12) : null,
      execution_mode: 'direct_khzx_api' as const,
      session_present: sessionPresent,
      session_source: sessionPresent ? this.sessionSource : null,
      session_updated_at: sessionPresent ? this.sessionUpdatedAt : null,
      emp_name: sessionPresent ? this.empName : null,
      emp_no_prefix: sessionPresent ? this.empNoPrefix : null,
      h5_gate: {
        armed: h5Armed,
        expected_prefix: h5Armed ? expectedH5.slice(0, 12) : null,
        last_prefix: this.lastH5Check?.prefix ?? null,
        matched: this.lastH5Check?.matched ?? null,
        script_count: this.lastH5Check?.script_count ?? null,
        checked_at: this.lastH5Check?.checked_at ?? null,
      } satisfies KjgxH5GateState,
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
        message: 'No live KJGX session available yet',
      };
    }
    const res = await this.apiClient.probeSession(this.liveSession);
    if (res.session_expired) {
      this.liveSession = null;
      this.sessionSource = null;
      this.sessionUpdatedAt = null;
      await this.store.clearKjgxSession();
      return res;
    }
    if (res.ok) {
      this.empName = res.emp_name ?? this.empName;
      this.empNoPrefix = res.emp_no_prefix ?? this.empNoPrefix;
    }
    return res;
  }

  async getLoginCaptcha(empNo?: string) {
    const captcha = await this.apiClient.fetchLoginCaptcha();
    let verifyRequired = true;
    if (empNo?.trim()) {
      try {
        const chk = await this.apiClient.checkLoginVerifyRequired(empNo.trim());
        verifyRequired = chk.required;
      } catch {
        verifyRequired = true;
      }
    }
    return {
      ok: true as const,
      verify_id: captcha.verify_id,
      image_data_url: captcha.image_data_url,
      verify_required: verifyRequired,
    };
  }

  async sendLoginSms(empNo: string) {
    return this.apiClient.sendLoginSmsCode(empNo);
  }

  async loginDirect(
    params: {
      empNo: string;
      password: string;
      verifyId?: string;
      verifyCode?: string;
      mobilePhone?: string;
      smsCode?: string;
      devicesn?: string;
    },
    actor: ActorContext,
  ) {
    const devicesn = params.devicesn?.trim() || this.serverDevicesn;
    const res = await this.apiClient.loginWithPassword({
      empNo: params.empNo,
      password: params.password,
      devicesn,
      verifyId: params.verifyId,
      verifyCode: params.verifyCode,
      mobilePhone: params.mobilePhone,
      smsCode: params.smsCode,
    });

    if (!res.ok || !res.session) {
      return {
        ok: false as const,
        msgcode: res.msgcode,
        message: res.message,
        needs_captcha: Boolean(res.needs_captcha),
        needs_sms: Boolean(res.needs_sms),
      };
    }

    this.liveSession = res.session;
    this.sessionSource = 'server_login';
    this.sessionUpdatedAt = new Date().toISOString();
    this.empName = res.emp_name ?? null;
    this.empNoPrefix = res.emp_no_prefix ?? null;
    this.serverDevicesn = devicesn;

    try {
      const probe = await this.apiClient.probeSession(res.session);
      if (probe.ok) {
        this.empName = probe.emp_name ?? this.empName;
        this.empNoPrefix = probe.emp_no_prefix ?? this.empNoPrefix;
      }
    } catch {
      // Non-fatal; login itself already issued a session.
    }

    await this.store.saveKjgxSession({
      accesstoken: res.session.accesstoken,
      empNoAES: res.session.empNoAES,
      empNo: res.session.empNo,
      empName: this.empName ?? undefined,
      devicesn,
      source: 'server_login',
    });

    await this.store.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'kjgx_session',
      entity_id: null,
      action: `科技个险服务端直连登录成功 (${this.empNoPrefix ?? '***'})`,
      before_state: null,
      after_state: { emp_name: this.empName, emp_no_prefix: this.empNoPrefix, source: 'server_login' },
      metadata: {},
    });

    return {
      ok: true as const,
      msgcode: res.msgcode,
      message: res.message,
      emp_name: this.empName,
      emp_no_prefix: this.empNoPrefix,
      session_present: true,
    };
  }

  async logoutSession(actor: ActorContext) {
    this.liveSession = null;
    this.sessionSource = null;
    this.sessionUpdatedAt = null;
    this.empName = null;
    this.empNoPrefix = null;
    await this.store.clearKjgxSession();
    await this.store.appendAudit({
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      entity_type: 'kjgx_session',
      entity_id: null,
      action: '清除科技个险直连会话',
      before_state: null,
      after_state: { session_present: false },
      metadata: {},
    });
    return { ok: true as const, session_present: false };
  }

  async checkH5Gate() {
    const fp = await this.apiClient.fetchKhzxH5Fingerprint();
    const armed = this.isH5GateArmed();
    const expected = this.expectedH5Hash.trim();
    const matched = !armed || fp.hash === expected;
    this.lastH5Check = {
      hash: fp.hash,
      prefix: fp.prefix,
      matched,
      script_count: fp.script_count,
      checked_at: fp.checked_at,
    };
    return {
      ok: matched,
      armed,
      expected_prefix: armed ? expected.slice(0, 12) : null,
      ...this.lastH5Check,
    };
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

    const deviceId =
      this.sessionSource === 'server_login'
        ? 'server-direct'
        : (this.lastHeartbeat?.device_id ?? 'server-direct');
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

    if (this.isH5GateArmed()) {
      const h5 = await this.checkH5Gate();
      if (!h5.matched) {
        const blocked = await this.store.updateKjgxJob(
          job.id,
          {
            execution_status: 'blocked_ota',
            assigned_device: deviceId,
            stage: 'l0_h5_mismatch',
            receipt: {
              assigned_device: deviceId,
              attempts: job.attempts,
              route_result: 'L0_H5_ABORT',
              edit_page_seen: false,
              customer_name_seen: false,
              readback_matched: false,
              app_result: { expected_prefix: this.expectedH5Hash.slice(0, 12), actual_prefix: h5.prefix },
              error: 'H5_HASH_MISMATCH: khzx frontend assets changed, halting fail-closed',
            },
          },
          actor,
        );
        return { ok: false, dry_run: Boolean(opts.dryRun), job: blocked };
      }
    }

    if (!this.liveSession?.accesstoken || !this.liveSession?.empNoAES) {
      throw new Error('SESSION_MISSING: KJGX session is not available; please sign in via CRM UI');
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
        this.sessionSource = null;
        this.sessionUpdatedAt = null;
        await this.store.clearKjgxSession().catch(() => {});
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
    const updated = await this.store.updateKjgxJob(
      jobId,
      {
        execution_status: succeeded ? 'succeeded' : 'failed',
        stage: succeeded ? 'completed' : 'readback_mismatch_halted',
        receipt,
      },
      { actorType: 'kjgx_worker', actorId: deviceId },
    );
    if (succeeded && receipt.app_result && typeof receipt.app_result === 'object') {
      const rawAddId = receipt.app_result.addcustomerId;
      if (typeof rawAddId === 'number' || (typeof rawAddId === 'string' && rawAddId.trim())) {
        await this.store.setCustomerKjgxDbId(updated.customer_id, String(rawAddId).trim());
      }
    }
    return updated;
  }
}
