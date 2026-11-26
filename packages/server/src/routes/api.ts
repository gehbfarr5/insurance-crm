import {
  CreateCustomerInputSchema,
  CreateInteractionInputSchema,
  EnqueueKjgxJobInputSchema,
  ResolveConflictInputSchema,
  UpdateCustomerInputSchema,
  UpsertFollowupInputSchema,
  formatMuseReminderPayload,
} from '@insurance-crm/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { queryDesk } from '../services/desk.js';
import { IcloudWriteLockedError, type IcloudSyncService } from '../services/icloud-sync.js';
import type { KjgxWritebackService } from '../services/kjgx-worker-api.js';
import type { RemindersSyncService } from '../services/reminders-sync.js';
import {
  type ActorContext,
  ConflictError,
  type CrmStore,
  NotFoundError,
  ValidationError,
} from '../services/store.js';

export function resolveActorFromRequest(
  req: FastifyRequest,
  authMode: 'bearer' | 'dev',
  keyMap: Map<string, string>,
): ActorContext | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    const actorId = keyMap.get(token);
    if (actorId) {
      const actorType: ActorContext['actorType'] = actorId.startsWith('human') || actorId.startsWith('jin')
        ? 'human'
        : actorId.includes('pixel')
          ? 'kjgx_worker'
          : 'agent';
      return { actorType, actorId };
    }
    if (authMode === 'bearer') return null;
  }
  if (authMode === 'dev') {
    const hdrActor = req.headers['x-crm-actor'];
    const actorId = typeof hdrActor === 'string' && hdrActor.trim() ? hdrActor.trim() : 'human_web';
    return {
      actorType: actorId.startsWith('human') || actorId.startsWith('jin') ? 'human' : 'agent',
      actorId,
    };
  }
  return null;
}

function handleRouteError(err: unknown, reply: FastifyReply) {
  if (err instanceof IcloudWriteLockedError) {
    return reply.code(403).send({ error: err.code, message: err.message });
  }
  if (err instanceof ConflictError) {
    return reply.code(409).send({ error: err.code, message: err.message, latest: err.latest });
  }
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: err.code, message: err.message });
  }
  if (err instanceof ValidationError || err instanceof z.ZodError) {
    return reply.code(400).send({ error: 'INVALID_INPUT', message: err instanceof Error ? err.message : String(err) });
  }
  throw err;
}

export function registerApiRoutes(
  app: FastifyInstance,
  deps: {
    store: CrmStore;
    icloudSync: IcloudSyncService;
    remindersSync: RemindersSyncService;
    kjgxService: KjgxWritebackService;
    authMode: 'bearer' | 'dev';
    keyMap: Map<string, string>;
  },
) {
  const { store, icloudSync, remindersSync, kjgxService, authMode, keyMap } = deps;

  const autoPushFollowup = async (
    followup: Awaited<ReturnType<CrmStore['upsertFollowup']>>,
    actor: ActorContext,
  ) => {
    if (!remindersSync.isConfigured || !remindersSync.writeEnabled) return followup;
    try {
      const detail = await store.getCustomer360(followup.customer_id);
      const res = await remindersSync.pushFollowup(followup, detail.customer, actor);
      return res.followup ?? followup;
    } catch {
      return followup;
    }
  };

  app.get('/health', async () => ({
    ok: true,
    service: 'insurance-crm',
    storage: process.env.CRM_STORAGE ?? 'memory',
    timestamp: new Date().toISOString(),
  }));

  app.register(async (v1) => {
    v1.addHook('preHandler', async (req, reply) => {
      const actor = resolveActorFromRequest(req, authMode, keyMap);
      if (!actor) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Valid Bearer Access Key required' });
      }
      (req as FastifyRequest & { crmActor: ActorContext }).crmActor = actor;
    });

    const actorOf = (req: FastifyRequest) => (req as FastifyRequest & { crmActor: ActorContext }).crmActor;

    v1.get('/dashboard', async () => store.getDashboard());

    v1.get('/customers', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const minPremium = q.min_premium !== undefined && q.min_premium !== '' ? Number(q.min_premium) : undefined;
      return store.searchCustomers({
        query: q.query,
        min_premium: minPremium !== undefined && Number.isFinite(minPremium) ? minPremium : undefined,
        rapport_tag: q.rapport_tag,
        has_quality_flag: q.has_quality_flag === 'true',
        source_type: q.source_type,
        only_with_phone: q.only_with_phone === 'true',
        has_manual_summary: q.has_manual_summary === 'true',
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      });
    });

    v1.post('/customers', async (req, reply) => {
      try {
        const input = CreateCustomerInputSchema.parse(req.body);
        const res = await store.createCustomer(input, actorOf(req));
        if (!res.created) {
          return reply.code(409).send({ error: 'DUPLICATE_CANDIDATES', duplicates: res.duplicates });
        }
        return reply.code(201).send(res.customer);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/desk/customers', async (req, reply) => {
      try {
        const q = req.query as Record<string, string | undefined>;
        const num = (v: string | undefined) => {
          if (v === undefined || v.trim() === '') return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        return await queryDesk(store, {
          query: q.query,
          gender: q.gender,
          min_age: num(q.min_age),
          max_age: num(q.max_age),
          min_premium: num(q.min_premium),
          max_premium: num(q.max_premium),
          address_query: q.address_query,
          call_filter: q.call_filter,
          sort_by: q.sort_by,
          sort_dir: q.sort_dir,
          limit: num(q.limit),
          offset: num(q.offset),
        });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/customers/:id', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const detail = await store.getCustomer360(id);
        const idMap = await store.getDecryptedIdMap([id]);
        return { ...detail, customer: { ...detail.customer, id_no: idMap.get(id) ?? null } };
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.patch('/customers/:id', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const input = UpdateCustomerInputSchema.parse(req.body);
        return await store.updateCustomer(id, input, actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/customers/:id/interactions', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const input = CreateInteractionInputSchema.parse(req.body);
        const actor = actorOf(req);
        const res = await store.logInteraction(id, input, actor);
        if (res.followup) {
          res.followup = await autoPushFollowup(res.followup, actor);
        }
        return reply.code(201).send(res);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/followups', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return store.listFollowups({ status: q.status, customer_id: q.customer_id });
    });

    v1.post('/followups', async (req, reply) => {
      try {
        const input = UpsertFollowupInputSchema.parse(req.body);
        const actor = actorOf(req);
        const created = await store.upsertFollowup(input, actor);
        const pushed = await autoPushFollowup(created, actor);
        return reply.code(201).send(pushed);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.patch('/followups/:id', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = req.body as Record<string, unknown>;
        const existing = (await store.listFollowups()).find((f) => f.id === id);
        if (!existing) throw new NotFoundError(`Followup ${id} not found`);
        const input = UpsertFollowupInputSchema.parse({
          ...body,
          id,
          customer_id: existing.customer_id,
          title: body.title ?? existing.title,
        });
        const actor = actorOf(req);
        const updated = await store.upsertFollowup(input, actor);
        return await autoPushFollowup(updated, actor);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/campaigns', async () => store.listCampaigns());

    v1.post('/campaigns/:id/members', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = z
          .object({
            customer_id: z.string(),
            stage: z.enum([
              'imported',
              'screened_in',
              'screened_out',
              'invited',
              'attended',
              'round2_qualified',
              'nurture',
              'closed',
            ]).optional(),
            invite_result: z.string().nullable().optional(),
            round2_notes: z.string().nullable().optional(),
          })
          .parse(req.body);
        return await store.updateCampaignMember(id, body.customer_id, body, actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/kjgx/jobs', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return store.listKjgxJobs({
        customer_id: q.customer_id,
        execution_status: q.execution_status,
        approval_status: q.approval_status,
      });
    });

    v1.post('/kjgx/jobs', async (req, reply) => {
      try {
        const input = EnqueueKjgxJobInputSchema.parse(req.body);
        return reply.code(201).send(await kjgxService.enqueue(input, actorOf(req)));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/jobs/:id/approve', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        return await kjgxService.approve(id, actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/jobs/:id/reject', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        return await kjgxService.reject(id, actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/kjgx/worker/status', async () => kjgxService.getWorkerStatus());

    v1.post('/kjgx/worker/probe', async () => kjgxService.probeSession());

    v1.post('/kjgx/worker/h5-check', async (_req, reply) => {
      try {
        return await kjgxService.checkH5Gate();
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/auth/captcha', async (req, reply) => {
      try {
        const body = z.object({ empNo: z.string().optional() }).optional().parse(req.body);
        return await kjgxService.getLoginCaptcha(body?.empNo);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/auth/sms', async (req, reply) => {
      try {
        const body = z.object({ empNo: z.string().optional() }).optional().parse(req.body ?? {});
        return await kjgxService.sendLoginSms(body?.empNo);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/auth/login', async (req, reply) => {
      try {
        const body = z
          .object({
            empNo: z.string().optional(),
            password: z.string().optional(),
            verifyId: z.string().optional(),
            verifyCode: z.string().optional(),
            mobilePhone: z.string().optional(),
            smsCode: z.string().optional(),
            devicesn: z.string().optional(),
          })
          .parse(req.body ?? {});
        const res = await kjgxService.loginDirect(body, actorOf(req));
        if (!res.ok) {
          req.log.warn(
            {
              msgcode: res.msgcode,
              message: res.message,
              needs_captcha: res.needs_captcha,
              needs_sms: res.needs_sms,
            },
            'KJGX direct login failed',
          );
          return reply.code(400).send(res);
        }
        return res;
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/auth/logout', async (req, reply) => {
      try {
        return await kjgxService.logoutSession(actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/jobs/:id/execute', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const body = z.object({ dryRun: z.boolean().optional() }).optional().parse(req.body);
        return await kjgxService.executeJob(id, actorOf(req), { dryRun: body?.dryRun });
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/worker/heartbeat', async (req, reply) => {
      try {
        const body = z
          .object({
            deviceId: z.string().min(1),
            appVersion: z.string().min(1),
            bundleHash: z.string().min(1),
            executorReady: z.boolean().optional(),
            sessionToken: z.string().optional(),
            empNoAes: z.string().optional(),
          })
          .parse(req.body);
        return await kjgxService.recordHeartbeat(body);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/worker/claim', async (req, reply) => {
      try {
        const body = z
          .object({
            deviceId: z.string().min(1),
            appVersion: z.string().min(1),
            bundleHash: z.string().min(1),
          })
          .parse(req.body);
        const res = await kjgxService.claimNext(body);
        if (!res.ok) return reply.code(409).send(res);
        return res;
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/kjgx/worker/complete', async (req, reply) => {
      try {
        const body = z
          .object({
            jobId: z.string().min(1),
            deviceId: z.string().min(1),
            receipt: z.record(z.string(), z.unknown()),
          })
          .parse(req.body);
        return await kjgxService.completeJob(body.jobId, body.receipt, body.deviceId);
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/sync/conflicts', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return store.listConflicts(q.status);
    });

    v1.post('/sync/conflicts/:id/resolve', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        const input = ResolveConflictInputSchema.parse(req.body);
        return await store.resolveConflict(id, input, actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/sync/icloud/preview', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      const minPremium = q.min_premium !== undefined && q.min_premium !== '' ? Number(q.min_premium) : undefined;
      return icloudSync.previewSync({
        customerId: q.customer_id,
        query: q.query,
        minPremium: minPremium !== undefined && Number.isFinite(minPremium) ? minPremium : undefined,
        onlyWithPhone: q.only_with_phone === 'true',
        hasManualSummary: q.has_manual_summary === 'true',
        limit: q.limit ? Number(q.limit) : 20,
        offset: q.offset ? Number(q.offset) : 0,
      });
    });

    v1.post('/sync/icloud/apply', async (req, reply) => {
      try {
        const body = z
          .object({
            customer_id: z.string().optional(),
            customer_ids: z.array(z.string()).max(50).optional(),
            query: z.string().optional(),
            min_premium: z.number().optional(),
            only_with_phone: z.boolean().optional(),
            has_manual_summary: z.boolean().optional(),
            session_id: z.string().optional(),
            create_missing: z.boolean().optional(),
            limit: z.number().int().min(1).max(50).optional(),
            offset: z.number().int().min(0).optional(),
            include_reminders: z.boolean().optional(),
          })
          .parse(req.body ?? {});
        const actor = actorOf(req);
        const contactRes = await icloudSync.applySync(
          {
            customerId: body.customer_id,
            customerIds: body.customer_ids,
            query: body.query,
            minPremium: body.min_premium,
            onlyWithPhone: body.only_with_phone,
            hasManualSummary: body.has_manual_summary,
            sessionId: body.session_id,
            createMissing: body.create_missing,
            limit: body.limit,
            offset: body.offset,
          },
          actor,
        );
        if (body.include_reminders === true) {
          const remindersSyncRes = await remindersSync.syncAll(actor);
          return { ...contactRes, reminders_sync: remindersSyncRes };
        }
        return contactRes;
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/sync/reminders/shortcut-pull', async () => {
      const openFollowups = await store.listFollowups({ status: 'open' });
      const search = await store.searchCustomers({ limit: 500 });
      const custMap = new Map(search.customers.map((c) => [c.id, c]));

      const items = [];
      for (const f of openFollowups) {
        let cust = custMap.get(f.customer_id);
        if (!cust) {
          try {
            const detail = await store.getCustomer360(f.customer_id);
            cust = detail.customer;
            custMap.set(cust.id, cust);
          } catch {
            continue;
          }
        }
        const payload = formatMuseReminderPayload(f, cust.name, cust.legacy_group_key);
        items.push({
          followup_id: f.id,
          customer_id: f.customer_id,
          customer_name: cust.name,
          list_name: payload.listName,
          title: payload.title,
          due_iso: payload.dueDate,
          priority: payload.priority,
          notes: payload.notes,
          status: f.status,
          version: f.version,
          icloud_reminder_id: f.icloud_reminder_id,
          icloud_list_id: f.icloud_list_id ?? payload.listName,
        });
      }

      return {
        count: items.length,
        mode: 'iphone_shortcut_direct' as const,
        items,
      };
    });

    v1.post('/sync/reminders/shortcut-ack', async (req, reply) => {
      try {
        const body = z
          .object({
            items: z.array(
              z.object({
                followup_id: z.string(),
                icloud_reminder_id: z.string().nullable().optional(),
                icloud_list_id: z.string().nullable().optional(),
                status: z.enum(['open', 'done', 'cancelled']).optional(),
              }),
            ),
          })
          .parse(req.body);

        const existingList = await store.listFollowups();
        const byId = new Map(existingList.map((f) => [f.id, f]));
        const updatedIds: string[] = [];

        for (const ack of body.items) {
          const existing = byId.get(ack.followup_id);
          if (!existing) {
            throw new NotFoundError(`Followup ${ack.followup_id} not found`);
          }
          const updated = await store.upsertFollowup(
            {
              id: existing.id,
              customer_id: existing.customer_id,
              title: existing.title,
              status: ack.status ?? existing.status,
              icloud_reminder_id:
                ack.icloud_reminder_id !== undefined ? ack.icloud_reminder_id : existing.icloud_reminder_id,
              icloud_list_id:
                ack.icloud_list_id !== undefined ? ack.icloud_list_id : existing.icloud_list_id,
              sync_state:
                ack.icloud_reminder_id || existing.icloud_reminder_id ? 'in_sync' : existing.sync_state,
              expected_version: existing.version,
            },
            actorOf(req),
          );
          updatedIds.push(updated.id);
        }

        return {
          updated_count: updatedIds.length,
          updated_ids: updatedIds,
        };
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/sync/reminders/status', async (_req, reply) => {
      const status = await remindersSync.getStatus();
      const base = {
        ...status,
        contacts: icloudSync.status,
      };
      if (status.configured === true && status.ok === false) {
        return reply.code(502).send(base);
      }
      return base;
    });

    v1.post('/sync/reminders/sync', async (req, reply) => {
      try {
        return await remindersSync.syncAll(actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/staging', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return store.listStaging(q.status);
    });

    v1.post('/staging', async (req, reply) => {
      try {
        const body = z
          .object({
            batch_id: z.string().optional(),
            source_kind: z.enum(['legacy_812_migration', 'excel_upload', 'family_card_ocr', 'agent_note_extract']),
            source_ref: z.string().nullable().optional(),
            raw_payload: z.record(z.string(), z.unknown()).optional(),
            normalized_draft: z.record(z.string(), z.unknown()),
            validation_warnings: z.array(z.string()).optional(),
          })
          .parse(req.body);
        return reply.code(201).send(await store.stageImportDraft(body, actorOf(req)));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/staging/:id/commit', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        return await store.commitStaging(id, actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.post('/staging/:id/reject', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        return await store.rejectStaging(id, actorOf(req));
      } catch (err) {
        return handleRouteError(err, reply);
      }
    });

    v1.get('/audit', async (req) => {
      const q = req.query as Record<string, string | undefined>;
      return store.listAuditLogs(q.limit ? Number(q.limit) : 30);
    });
  }, { prefix: '/api/v1' });
}
