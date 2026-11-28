import {
  CreateCustomerInputSchema,
  CreateInteractionInputSchema,
  EnqueueKjgxJobInputSchema,
  ResolveConflictInputSchema,
  UpdateCustomerInputSchema,
  UpsertFollowupInputSchema,
} from '@insurance-crm/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IcloudWriteLockedError, type IcloudSyncService } from '../services/icloud-sync.js';
import type { KjgxWritebackService } from '../services/kjgx-worker-api.js';
import type { RemindersSyncService } from '../services/reminders-sync.js';
import { ConflictError, type CrmStore, NotFoundError } from '../services/store.js';
import { resolveActorFromRequest } from './api.js';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CRM_MCP_TOOLS: McpToolDef[] = [
  // Read (7)
  {
    name: 'crm_search_customers',
    description: 'Search active CRM customers by query, tags, min_premium, rapport_tag, or quality flags.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        min_premium: { type: 'number' },
        rapport_tag: { type: 'string' },
        has_quality_flag: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: 'crm_get_customer_360',
    description: 'Fetch full 360 customer dossier: profile, policies, recent 20 interactions, followups, links, writeback jobs, and open conflicts.',
    inputSchema: {
      type: 'object',
      required: ['customer_id'],
      properties: { customer_id: { type: 'string' } },
    },
  },
  {
    name: 'crm_list_campaigns',
    description: 'List platform event / supervisor list campaigns with member funnel stages.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crm_filter_candidates',
    description: 'Filter campaign candidates replacing legacy Python screening rules.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        min_premium: { type: 'number' },
        max_age: { type: 'integer' },
        gender: { type: 'string' },
        stage: { type: 'string' },
        exclude_paused: { type: 'boolean' },
        limit: { type: 'integer' },
      },
    },
  },
  {
    name: 'crm_list_followups',
    description: 'List open or completed followups synced with Apple Reminders (工作待办 Work).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, customer_id: { type: 'string' } },
    },
  },
  {
    name: 'crm_list_conflicts',
    description: 'List 3-Way sync conflicts between CRM and iPhone Contacts/Reminders or KJGX.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
  },
  {
    name: 'crm_kjgx_job_status',
    description: 'Check KJGX writeback queue jobs and readback receipts.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        customer_id: { type: 'string' },
        execution_status: { type: 'string' },
      },
    },
  },
  // Write (6)
  {
    name: 'crm_create_customer',
    description: 'Create a customer after strict exact dedup by phone and ID HMAC.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        gender: { type: 'string' },
        birthday: { type: 'string' },
        primary_phone: { type: 'string' },
        address: { type: 'string' },
        source_type: { type: 'string' },
        id_no: { type: 'string' },
      },
    },
  },
  {
    name: 'crm_update_customer',
    description: 'Update customer profile enforcing optimistic lock expected_version and optional KJGX writeback.',
    inputSchema: {
      type: 'object',
      required: ['customer_id', 'expected_version'],
      properties: {
        customer_id: { type: 'string' },
        expected_version: { type: 'integer' },
        primary_phone: { type: 'string' },
        address: { type: 'string' },
        birthday: { type: 'string' },
        rapport_tag: { type: 'string' },
        manual_summary: { type: 'string' },
        enqueue_kjgx_writeback: { type: 'boolean' },
      },
    },
  },
  {
    name: 'crm_log_interaction',
    description: 'Append an immutable interaction timeline entry and optionally create followup or KJGX visit writeback.',
    inputSchema: {
      type: 'object',
      required: ['customer_id', 'channel', 'outcome', 'summary'],
      properties: {
        customer_id: { type: 'string' },
        channel: { type: 'string' },
        outcome: { type: 'string' },
        summary: { type: 'string' },
        followup_title: { type: 'string' },
        enqueue_kjgx_visit: { type: 'boolean' },
      },
    },
  },
  {
    name: 'crm_upsert_followup',
    description: 'Create or update a followup item marked for Apple Reminders sync (工作待办 Work).',
    inputSchema: {
      type: 'object',
      required: ['customer_id', 'title'],
      properties: {
        id: { type: 'string' },
        customer_id: { type: 'string' },
        title: { type: 'string' },
        due_at: { type: 'string' },
        priority: { type: 'string' },
        status: { type: 'string' },
        expected_version: { type: 'integer' },
      },
    },
  },
  {
    name: 'crm_update_campaign_member',
    description: 'Advance a customer through platform event two-round screening stages.',
    inputSchema: {
      type: 'object',
      required: ['campaign_id', 'customer_id'],
      properties: {
        campaign_id: { type: 'string' },
        customer_id: { type: 'string' },
        stage: { type: 'string' },
        invite_result: { type: 'string' },
        round2_notes: { type: 'string' },
      },
    },
  },
  {
    name: 'crm_stage_import_draft',
    description: 'Stage Family Card OCR, Excel rows, or AI-extracted notes into import_staging before commit.',
    inputSchema: {
      type: 'object',
      required: ['source_kind', 'normalized_draft'],
      properties: {
        source_kind: { type: 'string' },
        source_ref: { type: 'string' },
        normalized_draft: { type: 'object' },
        validation_warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  // Sync & Writeback (3)
  {
    name: 'crm_sync_icloud_preview',
    description: 'Preview 3-Way Diff and full CRM dossier note for iCloud Contacts/Reminders without mutating data.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        query: { type: 'string' },
        min_premium: { type: 'number' },
        only_with_phone: { type: 'boolean' },
        has_manual_summary: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        offset: { type: 'integer', minimum: 0 },
      },
    },
  },
  {
    name: 'crm_sync_icloud_apply',
    description: 'Apply safe iCloud sync updates with ETag checks, CardDAV writeback, optional Reminders sync, and conflict resolutions.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        customer_ids: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        query: { type: 'string' },
        min_premium: { type: 'number' },
        only_with_phone: { type: 'boolean' },
        has_manual_summary: { type: 'boolean' },
        session_id: { type: 'string' },
        create_missing: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        offset: { type: 'integer', minimum: 0 },
        include_reminders: { type: 'boolean' },
        resolutions: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'crm_kjgx_enqueue_writeback',
    description: 'Enqueue a KJGX writeback draft (defaults to pending_review awaiting human approval).',
    inputSchema: {
      type: 'object',
      required: ['customer_id', 'job_type', 'payload_target'],
      properties: {
        customer_id: { type: 'string' },
        job_type: { type: 'string' },
        payload_target: { type: 'object' },
        field_diff: { type: 'array', items: { type: 'object' } },
        auto_approve: { type: 'boolean' },
      },
    },
  },
];

const JsonRpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export function registerMcpRoute(
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

  app.get('/crm-mcp', async (req, reply) => {
    const actor = resolveActorFromRequest(req, authMode, keyMap);
    if (!actor) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Valid Agent Bearer Key required' });
    }
    return reply.header('Allow', 'POST, DELETE').code(405).send({
      error: 'METHOD_NOT_ALLOWED',
      message: 'This Streamable HTTP MCP server uses POST JSON-RPC only (no SSE GET stream).',
    });
  });

  app.delete('/crm-mcp', async (req, reply) => {
    const actor = resolveActorFromRequest(req, authMode, keyMap);
    if (!actor) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Valid Agent Bearer Key required' });
    }
    return reply.code(204).send();
  });

  app.post('/crm-mcp', async (req, reply) => {
    const actor = resolveActorFromRequest(req, authMode, keyMap);
    if (!actor) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Valid Agent Bearer Key required' });
    }

    const parsed = JsonRpcSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
      });
    }

    const { id = null, method, params = {} } = parsed.data;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'insurance-crm-mcp', version: '1.2.2' },
        },
      };
    }

    if (method === 'ping') {
      return {
        jsonrpc: '2.0',
        id,
        result: {},
      };
    }

    if (method.startsWith('notifications/')) {
      return reply.code(202).send();
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: CRM_MCP_TOOLS },
      };
    }

    if (method === 'tools/call') {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      try {
        let data: unknown;
        switch (name) {
          case 'crm_search_customers':
            data = await store.searchCustomers(args as never);
            break;
          case 'crm_get_customer_360': {
            const customerId = String(args.customer_id ?? '');
            const detail = await store.getCustomer360(customerId);
            const idMap = await store.getDecryptedIdMap([customerId]);
            data = {
              ...detail,
              customer: { ...detail.customer, id_no: idMap.get(customerId) ?? null },
            };
            break;
          }
          case 'crm_list_campaigns':
            data = await store.listCampaigns();
            break;
          case 'crm_filter_candidates':
            data = await store.filterCandidates(args as never);
            break;
          case 'crm_list_followups':
            data = await store.listFollowups(args as never);
            break;
          case 'crm_list_conflicts':
            data = await store.listConflicts(typeof args.status === 'string' ? args.status : undefined);
            break;
          case 'crm_kjgx_job_status':
            if (typeof args.job_id === 'string') {
              data = await store.getKjgxJob(args.job_id);
            } else {
              data = await store.listKjgxJobs(args as never);
            }
            break;
          case 'crm_create_customer':
            data = await store.createCustomer(CreateCustomerInputSchema.parse(args), actor);
            break;
          case 'crm_update_customer': {
            const customerId = String(args.customer_id ?? '');
            data = await store.updateCustomer(customerId, UpdateCustomerInputSchema.parse(args), actor);
            break;
          }
          case 'crm_log_interaction': {
            const customerId = String(args.customer_id ?? '');
            const logRes = await store.logInteraction(customerId, CreateInteractionInputSchema.parse(args), actor);
            if (logRes.followup && remindersSync.isConfigured && remindersSync.writeEnabled) {
              try {
                const detail = await store.getCustomer360(logRes.followup.customer_id);
                const pushRes = await remindersSync.pushFollowup(logRes.followup, detail.customer, actor);
                if (pushRes.followup) logRes.followup = pushRes.followup;
              } catch {
                // Non-blocking sync hook
              }
            }
            data = logRes;
            break;
          }
          case 'crm_upsert_followup': {
            const fu = await store.upsertFollowup(UpsertFollowupInputSchema.parse(args), actor);
            if (remindersSync.isConfigured && remindersSync.writeEnabled) {
              try {
                const detail = await store.getCustomer360(fu.customer_id);
                const pushRes = await remindersSync.pushFollowup(fu, detail.customer, actor);
                data = pushRes.followup ?? fu;
              } catch {
                data = fu;
              }
            } else {
              data = fu;
            }
            break;
          }
          case 'crm_update_campaign_member':
            data = await store.updateCampaignMember(
              String(args.campaign_id ?? ''),
              String(args.customer_id ?? ''),
              args as never,
              actor,
            );
            break;
          case 'crm_stage_import_draft':
            data = await store.stageImportDraft(args as never, actor);
            break;
          case 'crm_sync_icloud_preview':
            data = await icloudSync.previewSync({
              customerId: typeof args.customer_id === 'string' ? args.customer_id : undefined,
              query: typeof args.query === 'string' ? args.query : undefined,
              minPremium: typeof args.min_premium === 'number' ? args.min_premium : undefined,
              onlyWithPhone: typeof args.only_with_phone === 'boolean' ? args.only_with_phone : undefined,
              hasManualSummary: typeof args.has_manual_summary === 'boolean' ? args.has_manual_summary : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
              offset: typeof args.offset === 'number' ? args.offset : undefined,
            });
            break;
          case 'crm_sync_icloud_apply': {
            const contactRes = await icloudSync.applySync(
              {
                customerId: typeof args.customer_id === 'string' ? args.customer_id : undefined,
                customerIds: Array.isArray(args.customer_ids)
                  ? args.customer_ids.filter((x): x is string => typeof x === 'string')
                  : undefined,
                query: typeof args.query === 'string' ? args.query : undefined,
                minPremium: typeof args.min_premium === 'number' ? args.min_premium : undefined,
                onlyWithPhone: typeof args.only_with_phone === 'boolean' ? args.only_with_phone : undefined,
                hasManualSummary: typeof args.has_manual_summary === 'boolean' ? args.has_manual_summary : undefined,
                sessionId: typeof args.session_id === 'string' ? args.session_id : undefined,
                createMissing: typeof args.create_missing === 'boolean' ? args.create_missing : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
                offset: typeof args.offset === 'number' ? args.offset : undefined,
                resolutions: Array.isArray(args.resolutions)
                  ? args.resolutions.map((r) => ({
                      conflict_id: String((r as Record<string, unknown>).conflict_id),
                      ...ResolveConflictInputSchema.parse(r),
                    }))
                  : undefined,
              },
              actor,
            );
            if (args.include_reminders === true) {
              const remindersSyncRes = await remindersSync.syncAll(actor);
              data = { ...contactRes, reminders_sync: remindersSyncRes };
            } else {
              data = contactRes;
            }
            break;
          }
          case 'crm_kjgx_enqueue_writeback':
            data = await kjgxService.enqueue(EnqueueKjgxJobInputSchema.parse(args), actor);
            break;
          default:
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Unknown MCP tool: ${name}` },
            };
        }

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data) }],
            structuredContent: data,
          },
        };
      } catch (err) {
        const code =
          err instanceof IcloudWriteLockedError
            ? 'ICLOUD_WRITE_LOCKED'
            : err instanceof ConflictError
              ? 'CONFLICT'
              : err instanceof NotFoundError
                ? 'NOT_FOUND'
                : 'INVALID_INPUT';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: code,
                  message: err instanceof Error ? err.message : String(err),
                  latest: err instanceof ConflictError ? err.latest : undefined,
                }),
              },
            ],
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not supported: ${method}` },
    };
  });
}
