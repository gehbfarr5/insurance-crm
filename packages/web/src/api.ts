import type {
  AuditLogEntry,
  Campaign,
  CampaignMember,
  Customer,
  ExternalLink,
  Followup,
  ImportStagingItem,
  Interaction,
  KjgxWritebackJob,
  Policy,
  SyncConflict,
} from '@insurance-crm/shared';

const TOKEN_STORAGE_KEY = 'crm_bearer_token';

export class ApiUnauthorizedError extends Error {
  constructor(message = '需要访问密钥登录') {
    super(message);
    this.name = 'ApiUnauthorizedError';
  }
}

export function getBearerToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

export function setBearerToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
}

export function clearBearerToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export interface DashboardResponse {
  stats: {
    total_customers: number;
    hnw_customers: number;
    pending_kjgx_jobs: number;
    open_conflicts: number;
    pending_staging: number;
  };
  followups: Array<Followup & { customer_name: string }>;
  pending_jobs: KjgxWritebackJob[];
  recent_audit: AuditLogEntry[];
}

export interface Customer360Response {
  customer: Customer;
  policies: Policy[];
  interactions: Interaction[];
  followups: Followup[];
  external_links: ExternalLink[];
  pending_jobs: KjgxWritebackJob[];
  open_conflicts: SyncConflict[];
}

export type CampaignWithMembers = Campaign & {
  members: Array<CampaignMember & { customer_name: string }>;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getBearerToken();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    throw new ApiUnauthorizedError((body as { message?: string }).message ?? '访问密钥无效或未登录');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string; error?: string }).message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface IcloudPreviewItem {
  customer_id: string;
  customer_name: string;
  contact_link_status: string;
  write_gate_status: 'locked_preview_only' | 'enabled';
  privacy_fence_mode?: 'disabled_full_dossier' | string;
  planned_followup_note: string | null;
  sanitized_payload: {
    fullName: string;
    phones: string[];
    birthday: string | null;
    address: string | null;
    company: string | null;
    groupNames: string[];
    idNo?: string | null;
    policyTotal?: number;
    totalPremium?: number | null;
    kjgxCustomerNo?: string | null;
    kjgxTempValue?: number | null;
    kjgxTempLevel?: string | null;
    manualSummary?: string | null;
  };
  diff: {
    toPushToRemote: Record<string, unknown>;
    toPullToCrm: Record<string, unknown>;
    conflicts: Array<{
      field: string;
      baseValue: unknown;
      crmValue: unknown;
      remoteValue: unknown;
    }>;
    inSync: boolean;
  };
  pending_reminders: Array<{
    listName: string;
    category: string;
    title: string;
    dueDate: string | null;
    priority: 'High' | 'None';
    notes: string;
  }>;
}

export interface KjgxWorkerStatusResponse {
  online: boolean;
  pixel_online?: boolean;
  ota_gate_armed: boolean;
  expected_bundle_hash_prefix: string | null;
  execution_mode?: 'direct_khzx_api';
  session_present?: boolean;
  session_source?: 'server_login' | 'pixel_heartbeat' | null;
  session_updated_at?: string | null;
  emp_name?: string | null;
  emp_no_prefix?: string | null;
  h5_gate?: {
    armed: boolean;
    expected_prefix: string | null;
    last_prefix: string | null;
    matched: boolean | null;
    script_count: number | null;
    checked_at: string | null;
  };
  worker: {
    device_id: string;
    app_version: string;
    bundle_hash_prefix: string;
    bundle_hash_matched: boolean;
    executor_ready: boolean;
    last_seen_at: string;
  } | null;
}

export interface KjgxProbeResponse {
  ok: boolean;
  status: number;
  session_expired: boolean;
  code: string;
  message: string;
  emp_name?: string;
  emp_no_prefix?: string;
  branch_code?: string;
  channel?: string;
}

export interface KjgxCaptchaResponse {
  ok: boolean;
  verify_id: string;
  image_data_url: string;
  verify_required: boolean;
}

export interface KjgxLoginResponse {
  ok: boolean;
  msgcode: string;
  message: string;
  needs_captcha?: boolean;
  needs_sms?: boolean;
  emp_name?: string | null;
  emp_no_prefix?: string | null;
  session_present?: boolean;
}

export interface SyncStatusResponse {
  configured: boolean;
  ok?: boolean;
  macserver_dependency: boolean;
  shortcut_sync_available: boolean;
  write_enabled?: boolean;
  bridge?: {
    status: string;
    engine: string;
    authenticated: boolean;
    trusted: boolean;
    active_lists_count: number;
    write_enabled: boolean;
    cookie_min_remaining_days: number | null;
    hsa_trust_remaining_days: number | null;
  };
  contacts?: {
    contacts_write_enabled: boolean;
    reminders_write_enabled: boolean;
    carddav_connected: boolean;
    privacy_fence_mode?: string;
    transport_mode: string;
  };
  auto_sync?: {
    enabled: boolean;
    interval_sec: number;
    last_run_at: string | null;
    last_result: {
      pushed: number;
      updated: number;
      pulled_completed: number;
      errors: string[];
    } | null;
  };
}

export const api = {
  getDashboard: () => req<DashboardResponse>('api/v1/dashboard'),
  searchCustomers: (params?: {
    query?: string;
    min_premium?: number;
    has_quality_flag?: boolean;
    limit?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params?.query) sp.set('query', params.query);
    if (params?.min_premium != null) sp.set('min_premium', String(params.min_premium));
    if (params?.has_quality_flag) sp.set('has_quality_flag', 'true');
    sp.set('limit', String(params?.limit ?? 100));
    const q = sp.toString();
    return req<{ customers: Customer[]; total: number; truncated: boolean }>(`api/v1/customers${q ? `?${q}` : ''}`);
  },
  getCustomer360: (id: string) => req<Customer360Response>(`api/v1/customers/${id}`),
  updateCustomer: (
    id: string,
    body: {
      expected_version: number;
      primary_phone?: string | null;
      address?: string | null;
      birthday?: string | null;
      rapport_tag?: Customer['rapport_tag'];
      enqueue_kjgx_writeback?: boolean;
    },
  ) => req<Customer>(`api/v1/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  logInteraction: (
    id: string,
    body: {
      channel: Interaction['channel'];
      outcome: Interaction['outcome'];
      summary: string;
      followup_title?: string;
      enqueue_kjgx_visit?: boolean;
    },
  ) => req(`api/v1/customers/${id}/interactions`, { method: 'POST', body: JSON.stringify(body) }),
  toggleFollowup: (id: string, status: Followup['status'], expected_version: number) =>
    req<Followup>(`api/v1/followups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expected_version }),
    }),
  getCampaigns: () => req<CampaignWithMembers[]>('api/v1/campaigns'),
  getKjgxJobs: () => req<KjgxWritebackJob[]>('api/v1/kjgx/jobs'),
  getKjgxWorkerStatus: () => req<KjgxWorkerStatusResponse>('api/v1/kjgx/worker/status'),
  probeKjgxWorker: () => req<KjgxProbeResponse>('api/v1/kjgx/worker/probe', { method: 'POST', body: '{}' }),
  checkKjgxH5Gate: () =>
    req<{ ok: boolean; armed: boolean; hash: string; prefix: string; matched: boolean; script_count: number; checked_at: string }>(
      'api/v1/kjgx/worker/h5-check',
      { method: 'POST', body: '{}' },
    ),
  getKjgxCaptcha: (empNo?: string) =>
    req<KjgxCaptchaResponse>('api/v1/kjgx/auth/captcha', {
      method: 'POST',
      body: JSON.stringify(empNo ? { empNo } : {}),
    }),
  sendKjgxSms: (empNo: string) =>
    req<{ ok: boolean; code: string; message: string }>('api/v1/kjgx/auth/sms', {
      method: 'POST',
      body: JSON.stringify({ empNo }),
    }),
  loginKjgx: async (body: {
    empNo: string;
    password: string;
    verifyId?: string;
    verifyCode?: string;
    mobilePhone?: string;
    smsCode?: string;
  }): Promise<KjgxLoginResponse> => {
    const token = getBearerToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch('api/v1/kjgx/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      throw new ApiUnauthorizedError('需要访问密钥登录');
    }
    return res.json() as Promise<KjgxLoginResponse>;
  },
  logoutKjgx: () => req<{ ok: boolean; session_present: boolean }>('api/v1/kjgx/auth/logout', { method: 'POST', body: '{}' }),
  approveKjgxJob: (id: string) => req<KjgxWritebackJob>(`api/v1/kjgx/jobs/${id}/approve`, { method: 'POST', body: '{}' }),
  rejectKjgxJob: (id: string) => req<KjgxWritebackJob>(`api/v1/kjgx/jobs/${id}/reject`, { method: 'POST', body: '{}' }),
  executeKjgxJob: (id: string, dryRun = false) =>
    req<{ ok: boolean; dry_run: boolean; job: KjgxWritebackJob; receipt?: Record<string, unknown> }>(
      `api/v1/kjgx/jobs/${id}/execute`,
      { method: 'POST', body: JSON.stringify({ dryRun }) },
    ),
  getConflicts: () => req<SyncConflict[]>('api/v1/sync/conflicts'),
  resolveConflict: (id: string, resolution: 'keep_crm' | 'take_remote') =>
    req<SyncConflict>(`api/v1/sync/conflicts/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    }),
  previewIcloudSync: (params?: {
    customer_id?: string;
    query?: string;
    min_premium?: number;
    only_with_phone?: boolean;
    has_manual_summary?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params?.customer_id) sp.set('customer_id', params.customer_id);
    if (params?.query) sp.set('query', params.query);
    if (params?.min_premium != null) sp.set('min_premium', String(params.min_premium));
    if (params?.only_with_phone) sp.set('only_with_phone', 'true');
    if (params?.has_manual_summary) sp.set('has_manual_summary', 'true');
    sp.set('limit', String(params?.limit ?? 10));
    if (params?.offset) sp.set('offset', String(params.offset));
    return req<IcloudPreviewItem[]>(`api/v1/sync/icloud/preview?${sp.toString()}`);
  },
  applyIcloudSync: (body: {
    customer_id?: string;
    customer_ids?: string[];
    create_missing?: boolean;
    limit?: number;
    include_reminders?: boolean;
  }) =>
    req<{
      mode: string;
      created_customers?: string[];
      pushed_customers: string[];
      pulled_customers: string[];
      created_conflicts: string[];
      skipped_unmatched?: string[];
    }>('api/v1/sync/icloud/apply', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getSyncStatus: () => req<SyncStatusResponse>('api/v1/sync/reminders/status'),
  syncRemindersNow: () =>
    req<{
      ok: boolean;
      mode: string;
      pushed: number;
      updated: number;
      pulled_completed: number;
      errors: string[];
    }>('api/v1/sync/reminders/sync', {
      method: 'POST',
      body: '{}',
    }),
  getStaging: () => req<ImportStagingItem[]>('api/v1/staging'),
  commitStaging: (id: string) => req(`api/v1/staging/${id}/commit`, { method: 'POST', body: '{}' }),
  rejectStaging: (id: string) => req(`api/v1/staging/${id}/reject`, { method: 'POST', body: '{}' }),
};
