import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { IdVault } from './crypto/id-vault.js';
import { createDbClient } from './db/client.js';
import { registerApiRoutes } from './routes/api.js';
import { registerMcpRoute } from './routes/mcp.js';
import { type CardDavTransport, DirectIcloudCardDavClient } from './services/carddav-client.js';
import {
  HttpIcloudMcpTransport,
  type IcloudMcpTransport,
  IcloudSyncService,
  NoopIcloudMcpTransport,
} from './services/icloud-sync.js';
import { KjgxWritebackService } from './services/kjgx-worker-api.js';
import { RemindersSyncService } from './services/reminders-sync.js';
import { type CrmStore, InMemoryDemoStore, PostgresStore } from './services/store.js';

export interface BuildAppOptions {
  storage?: 'memory' | 'postgres';
  databaseUrl?: string;
  authMode?: 'bearer' | 'dev';
  agentKeys?: Record<string, string>;
  expectedBundleHash?: string;
  icloudTransport?: IcloudMcpTransport;
  cardDav?: CardDavTransport;
  icloudContactsWriteEnabled?: boolean;
  icloudRemindersWriteEnabled?: boolean;
  remindersBridgeUrl?: string;
  remindersBridgeToken?: string;
  remindersFetch?: typeof fetch;
  remindersAutoSyncIntervalSec?: number;
  vault?: IdVault;
  logger?: boolean;
}

function parseAgentKeyMap(raw?: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  let source = raw;
  if (!source && process.env.AGENT_ACCESS_KEYS_JSON) {
    try {
      source = JSON.parse(process.env.AGENT_ACCESS_KEYS_JSON) as Record<string, string>;
    } catch {
      source = {};
    }
  }
  for (const [actorId, token] of Object.entries(source ?? {})) {
    if (token && token !== 'replace-me') {
      map.set(token, actorId);
    }
  }
  return map;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<{
  app: FastifyInstance;
  store: CrmStore;
  close: () => Promise<void>;
}> {
  const storage = opts.storage ?? (process.env.CRM_STORAGE === 'postgres' ? 'postgres' : 'memory');
  const authMode = opts.authMode ?? (process.env.AUTH_MODE === 'dev' ? 'dev' : 'bearer');
  const vault = opts.vault ?? IdVault.fromEnv();
  const keyMap = parseAgentKeyMap(opts.agentKeys);

  let store: CrmStore;
  let pgPoolEnd: (() => Promise<void>) | undefined;

  if (storage === 'postgres') {
    const connStr = opts.databaseUrl ?? process.env.DATABASE_URL;
    if (!connStr) {
      throw new Error('DATABASE_URL is required when CRM_STORAGE=postgres');
    }
    const { pool, db } = createDbClient(connStr);
    store = new PostgresStore(db, vault);
    pgPoolEnd = () => pool.end();
  } else {
    store = new InMemoryDemoStore(vault);
  }

  let icloudTransport = opts.icloudTransport;
  if (!icloudTransport) {
    const endpoint = process.env.ICLOUD_MCP_ENDPOINT;
    const accessKey = process.env.ICLOUD_ACCESS_KEY;
    if (endpoint && accessKey && !endpoint.includes('example.ts.net') && accessKey !== 'replace-me') {
      icloudTransport = new HttpIcloudMcpTransport(endpoint, accessKey);
    } else {
      icloudTransport = new NoopIcloudMcpTransport();
    }
  }

  const contactsWriteEnabled =
    opts.icloudContactsWriteEnabled ?? process.env.ICLOUD_CONTACTS_WRITE_ENABLED === 'true';
  const remindersWriteEnabled =
    opts.icloudRemindersWriteEnabled ?? process.env.ICLOUD_REMINDERS_WRITE_ENABLED === 'true';

  let cardDav = opts.cardDav;
  if (!cardDav) {
    const email = process.env.ICLOUD_ACCOUNT_EMAIL?.trim() ?? '';
    const appPassword = process.env.ICLOUD_CARDDAV_APP_PASSWORD?.trim() ?? '';
    if (email && appPassword && !email.includes('example.com') && appPassword !== 'replace-me') {
      cardDav = new DirectIcloudCardDavClient({ email, appPassword });
    }
  }

  const icloudSync = new IcloudSyncService(store, icloudTransport, {
    contactsWriteEnabled,
    remindersWriteEnabled,
    cardDav,
  });
  const remindersSync = new RemindersSyncService(store, {
    bridgeUrl: opts.remindersBridgeUrl ?? process.env.PYICLOUD_REMINDERS_BRIDGE_URL,
    bridgeToken: opts.remindersBridgeToken ?? process.env.PYICLOUD_REMINDERS_BRIDGE_TOKEN,
    writeEnabled: remindersWriteEnabled,
    fetchImpl: opts.remindersFetch,
  });
  const autoSyncSec =
    opts.remindersAutoSyncIntervalSec ?? Number(process.env.REMINDERS_AUTO_SYNC_INTERVAL_SEC ?? 0);
  if (Number.isFinite(autoSyncSec) && autoSyncSec >= 30) {
    remindersSync.startAutoSync(Math.trunc(autoSyncSec));
  }
  const kjgxService = new KjgxWritebackService(store, opts.expectedBundleHash ?? process.env.KJGX_EXPECTED_BUNDLE_HASH ?? '');

  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });

  registerApiRoutes(app, { store, icloudSync, remindersSync, kjgxService, authMode, keyMap });
  registerMcpRoute(app, { store, icloudSync, remindersSync, kjgxService, authMode, keyMap });

  // Serve built React PWA when present
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/crm-mcp')) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      return reply.sendFile('index.html');
    });
  }

  return {
    app,
    store,
    close: async () => {
      remindersSync.stopAutoSync();
      await app.close();
      if (pgPoolEnd) await pgPoolEnd();
    },
  };
}
