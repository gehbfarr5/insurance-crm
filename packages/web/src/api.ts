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
  const token = localStorage.getItem('crm_bearer_token');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string; error?: string }).message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getDashboard: () => req<DashboardResponse>('/api/v1/dashboard'),
  searchCustomers: (params?: { query?: string; min_premium?: number; has_quality_flag?: boolean }) => {
    const sp = new URLSearchParams();
    if (params?.query) sp.set('query', params.query);
    if (params?.min_premium != null) sp.set('min_premium', String(params.min_premium));
    if (params?.has_quality_flag) sp.set('has_quality_flag', 'true');
    const q = sp.toString();
    return req<{ customers: Customer[]; total: number; truncated: boolean }>(`/api/v1/customers${q ? `?${q}` : ''}`);
  },
  getCustomer360: (id: string) => req<Customer360Response>(`/api/v1/customers/${id}`),
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
  ) => req<Customer>(`/api/v1/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  logInteraction: (
    id: string,
    body: {
      channel: Interaction['channel'];
      outcome: Interaction['outcome'];
      summary: string;
      followup_title?: string;
      enqueue_kjgx_visit?: boolean;
    },
  ) => req(`/api/v1/customers/${id}/interactions`, { method: 'POST', body: JSON.stringify(body) }),
  toggleFollowup: (id: string, status: Followup['status'], expected_version: number) =>
    req<Followup>(`/api/v1/followups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, expected_version }),
    }),
  getCampaigns: () => req<CampaignWithMembers[]>('/api/v1/campaigns'),
  getKjgxJobs: () => req<KjgxWritebackJob[]>('/api/v1/kjgx/jobs'),
  approveKjgxJob: (id: string) => req<KjgxWritebackJob>(`/api/v1/kjgx/jobs/${id}/approve`, { method: 'POST', body: '{}' }),
  rejectKjgxJob: (id: string) => req<KjgxWritebackJob>(`/api/v1/kjgx/jobs/${id}/reject`, { method: 'POST', body: '{}' }),
  getConflicts: () => req<SyncConflict[]>('/api/v1/sync/conflicts'),
  resolveConflict: (id: string, resolution: 'keep_crm' | 'take_remote') =>
    req<SyncConflict>(`/api/v1/sync/conflicts/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
    }),
  getStaging: () => req<ImportStagingItem[]>('/api/v1/staging'),
  commitStaging: (id: string) => req(`/api/v1/staging/${id}/commit`, { method: 'POST', body: '{}' }),
  rejectStaging: (id: string) => req(`/api/v1/staging/${id}/reject`, { method: 'POST', body: '{}' }),
};
