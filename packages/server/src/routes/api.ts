import {
  CreateCustomerInputSchema,
  CreateInteractionInputSchema,
  EnqueueKjgxJobInputSchema,
  ResolveConflictInputSchema,
  UpdateCustomerInputSchema,
  UpsertFollowupInputSchema,
} from '@insurance-crm/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IcloudSyncService } from '../services/icloud-sync.js';
import type { KjgxWritebackService } from '../services/kjgx-worker-api.js';
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
    kjgxService: KjgxWritebackService;
    authMode: 'bearer' | 'dev';
    keyMap: Map<string, string>;
  },
) {
  const { store, icloudSync, kjgxService, authMode, keyMap } = deps;

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
      return store.searchCustomers({
        query: q.query,
        min_premium: q.min_premium ? Number(q.min_premium) : undefined,
        rapport_tag: q.rapport_tag,
        has_quality_flag: q.has_quality_flag === 'true',
        source_type: q.source_type,
        limit: q.limit ? Number(q.limit) : undefined,
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

    v1.get('/customers/:id', async (req, reply) => {
      try {
        const { id } = req.params as { id: string };
        return await store.getCustomer360(id);
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
        return reply.code(201).send(await store.logInteraction(id, input, actorOf(req)));
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
        return reply.code(201).send(await store.upsertFollowup(input, actorOf(req)));
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
        return await store.upsertFollowup(input, actorOf(req));
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
      return icloudSync.previewSync(q.customer_id);
    });

    v1.post('/sync/icloud/apply', async (req) => {
      const body = z
        .object({
          customer_id: z.string().optional(),
          session_id: z.string().optional(),
        })
        .parse(req.body ?? {});
      return icloudSync.applySync(
        { customerId: body.customer_id, sessionId: body.session_id },
        actorOf(req),
      );
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
