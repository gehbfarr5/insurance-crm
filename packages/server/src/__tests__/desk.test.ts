import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

describe('Outbound-call desk: multi-dimension filtering, call stats and plaintext ID', () => {
  let handle: Awaited<ReturnType<typeof buildApp>>;
  const auth = { authorization: 'Bearer desk-test-key' };

  type Item = {
    id: string;
    name: string;
    gender: string;
    age: number | null;
    address: string | null;
    total_premium: number | null;
    call_count: number;
    last_call_outcome: string | null;
    id_no: string | null;
  };
  const desk = async (qs = '') => {
    const res = await handle.app.inject({ method: 'GET', url: `/api/v1/desk/customers?limit=200${qs}`, headers: auth });
    expect(res.statusCode).toBe(200);
    return res.json() as { items: Item[]; total: number };
  };
  const logPhone = async (id: string, outcome: string, summary: string) => {
    const res = await handle.app.inject({
      method: 'POST',
      url: `/api/v1/customers/${id}/interactions`,
      headers: auth,
      payload: { channel: 'phone', outcome, summary },
    });
    expect(res.statusCode).toBe(201);
  };

  beforeAll(async () => {
    handle = await buildApp({ storage: 'memory', authMode: 'bearer', agentKeys: { human_web: 'desk-test-key' } });
  });
  afterAll(async () => {
    await handle.close();
  });

  it('sorts by premium by default and filters by gender, premium range and age', async () => {
    const all = await desk();
    expect(all.items.length).toBeGreaterThan(1);
    const prem = all.items.map((i) => i.total_premium ?? -1);
    expect(prem).toEqual([...prem].sort((a, b) => b - a));

    const females = await desk('&gender=%E5%A5%B3');
    expect(females.items.every((i) => i.gender === '女')).toBe(true);
    expect(females.total).toBeLessThanOrEqual(all.total);

    const rich = await desk('&min_premium=100000');
    expect(rich.items.length).toBeGreaterThan(0);
    expect(rich.items.every((i) => (i.total_premium ?? 0) >= 100000)).toBe(true);

    const withAge = all.items.filter((i) => i.age != null);
    if (withAge.length > 0) {
      const target = withAge[0]!.age!;
      const aged = await desk(`&min_age=${target}&max_age=${target}`);
      expect(aged.items.length).toBeGreaterThan(0);
      expect(aged.items.every((i) => i.age === target)).toBe(true);
    }

    const withAddr = all.items.find((i) => i.address);
    if (withAddr) {
      const needle = withAddr.address!.slice(0, 3);
      const hit = await desk(`&address_query=${encodeURIComponent(needle)}`);
      expect(hit.items.some((i) => i.id === withAddr.id)).toBe(true);
    }
  });

  it('counts phone calls and supports anti-repeat call filters', async () => {
    const created = await Promise.all(
      ['防重测试甲', '防重测试乙'].map(async (name, idx) => {
        const res = await handle.app.inject({
          method: 'POST',
          url: '/api/v1/customers',
          headers: auth,
          payload: { name, primary_phone: `1390000${idx}001`, total_premium: undefined },
        });
        expect(res.statusCode).toBe(201);
        return res.json() as { id: string };
      }),
    );
    const a = created[0]!;
    const b = created[1]!;

    const fresh = await desk('&call_filter=never_called');
    expect(fresh.items.some((i) => i.id === a.id)).toBe(true);
    expect(fresh.items.some((i) => i.id === b.id)).toBe(true);

    await logPhone(a.id, 'no_answer', '未接');
    await logPhone(a.id, 'no_answer', '未接');
    await logPhone(b.id, 'rejected', '拒绝');

    const after = await desk();
    const aRow = after.items.find((i) => i.id === a.id)!;
    expect(aRow.call_count).toBe(2);
    expect(aRow.last_call_outcome).toBe('no_answer');

    const never = await desk('&call_filter=never_called');
    expect(never.items.some((i) => i.id === a.id || i.id === b.id)).toBe(false);

    const ex7 = await desk('&call_filter=exclude_7d');
    expect(ex7.items.some((i) => i.id === a.id || i.id === b.id)).toBe(false);

    const exRej = await desk('&call_filter=exclude_rejected');
    expect(exRej.items.some((i) => i.id === b.id)).toBe(false);
    expect(exRej.items.some((i) => i.id === a.id)).toBe(true);

    await logPhone(a.id, 'invited', '邀约成功');
    const invited = await desk('&call_filter=invited');
    expect(invited.items.some((i) => i.id === a.id)).toBe(true);
    expect(invited.items.some((i) => i.id === b.id)).toBe(false);

    const byCalls = await desk('&sort_by=call_count&sort_dir=desc');
    const counts = byCalls.items.map((i) => i.call_count);
    expect(counts).toEqual([...counts].sort((x, y) => y - x));
    expect(byCalls.items.find((i) => i.id === a.id)!.call_count).toBe(3);
  });

  it('returns plaintext ID number in desk rows and customer 360 (no masking)', async () => {
    const created = await handle.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: auth,
      payload: { name: '明文证件测试', primary_phone: '13911112222', id_no: '110101199001011234' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const res = await handle.app.inject({ method: 'GET', url: `/api/v1/customers/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer: { id_no: string | null } };
    expect(body.customer.id_no).toBe('110101199001011234');

    const all = await desk();
    const row = all.items.find((i) => i.id === id)!;
    expect(row.id_no).toBe('110101199001011234');
  });
});
