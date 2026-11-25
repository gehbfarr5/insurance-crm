import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IdVault } from '../crypto/id-vault.js';
import {
  aesEcbDecrypt,
  aesEcbEncrypt,
  buildKhzxCustomerPayload,
  KjgxDirectApiClient,
  verifyCustomerReadback,
} from '../services/kjgx-api-client.js';
import { KjgxWritebackService } from '../services/kjgx-worker-api.js';
import { InMemoryDemoStore } from '../services/store.js';

describe('KjgxDirectApiClient & KjgxWritebackService', () => {
  it('round-trips AES-128-ECB encryption compatible with khzx', () => {
    const key = '0123456789abcdef';
    const plain = JSON.stringify({ empNo: 'AES_EMP', customerName: '张测试' });
    const enc = aesEcbEncrypt(plain, key);
    expect(enc).not.toBe(plain);
    expect(aesEcbDecrypt(enc, key)).toBe(plain);
    expect(aesEcbEncrypt('', key)).toBe('');
  });

  it('builds encrypted saveCustomerInfo / updateCustomer payloads while preserving existing fields', async () => {
    const vault = new IdVault(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    );
    const store = new InMemoryDemoStore(vault);
    const list = await store.searchCustomers({ limit: 1 });
    const customer = list.customers[0]!;
    const key = 'fedcba9876543210';

    const created = buildKhzxCustomerPayload({
      mode: 'create',
      customer,
      payloadTarget: { address: '浦东新区世纪大道100号', remark: '高净值重点跟进' },
      decryptedIdNo: '31010119850101123X',
      empNoAES: 'EMP_AES_001',
      encryptStr: key,
    });
    expect(created.endpoint).toBe('/cuscenter/customer/saveCustomerController/saveCustomerInfo');
    expect(created.payload.empNo).toBe('EMP_AES_001');
    expect(created.payload.cardType).toBe('1');
    expect(aesEcbDecrypt(String(created.payload.cardNo), key)).toBe('31010119850101123X');
    expect(aesEcbDecrypt(String(created.payload.phoneNo), key)).toBe(customer.primary_phone);
    expect(created.payload.address).toBe('浦东新区世纪大道100号');
    expect(created.payload.remake).toBe('高净值重点跟进');

    const updated = buildKhzxCustomerPayload({
      mode: 'update',
      customer: { ...customer, company_or_occupation: null },
      payloadTarget: { address: '新地址88号' },
      decryptedIdNo: '31010119850101123X',
      empNoAES: 'EMP_AES_001',
      encryptStr: key,
      existingDetail: {
        id: '99887766',
        editFlag: '1',
        companyName: '原有单位集团',
        email: 'keep@example.com',
        kycInfo: { ageGroup: '2', familyInfo: '1' },
        customerLabelList: [{ propName: 'tag', propValues: 'A' }],
      },
    });
    expect(updated.endpoint).toBe('/cuscenter/customer/saveCustomerController/updateCustomer');
    expect(updated.payload.id).toBe('99887766');
    expect(updated.payload.flag).toBe('1');
    expect(updated.payload.email).toBe('keep@example.com');
    expect(updated.payload.companyName).toBe('原有单位集团');
    expect(updated.payload.address).toBe('新地址88号');
  });

  it('executes approved writeback end-to-end via mocked RSA/AES khzx API with mandatory readback verification', async () => {
    const vault = new IdVault(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    );
    const store = new InMemoryDemoStore(vault);
    const list = await store.searchCustomers({ limit: 1 });
    const customer = list.customers[0]!;

    // Simulate KJGX server RSA keypair and dynamic AES key exchange
    const serverKeys = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const serverPubB64 = serverKeys.publicKey
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s+/g, '');
    const aesSessionKey = '1234567890abcdef';
    let savedRecord: Record<string, unknown> | null = null;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;

      if (url.endsWith('/display/api/apprsa/getrsa')) {
        if (!body.key) {
          return new Response(JSON.stringify({ code: '200', content: serverPubB64 }), { status: 200 });
        }
        const clientPubB64 = crypto
          .privateDecrypt(
            { key: serverKeys.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(body.value, 'base64'),
          )
          .toString('utf8');
        const clientPubPem = `-----BEGIN PUBLIC KEY-----\n${clientPubB64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
        const encKey = crypto
          .publicEncrypt(
            { key: clientPubPem, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(aesSessionKey, 'utf8'),
          )
          .toString('base64');
        return new Response(JSON.stringify({ code: '200', content: encKey }), { status: 200 });
      }

      const plainReq = JSON.parse(aesEcbDecrypt(body.data, aesSessionKey)) as Record<string, unknown>;
      const respond = (obj: Record<string, unknown>) =>
        new Response(JSON.stringify({ data: aesEcbEncrypt(JSON.stringify(obj), aesSessionKey) }), {
          status: 200,
          headers: { 'response-encrypt': 'true' },
        });

      if (url.endsWith('/emp/api/login/accessEmpInfo')) {
        return respond({
          code: '00',
          message: 'SUCCESS',
          content: { empNo: 'EMP00001', empName: '测试外勤', fgsCode: '310', channle: 'U11' },
        });
      }

      if (url.endsWith('/cuscenter/customer/saveCustomerController/saveCustomerInfo')) {
        savedRecord = {
          id: 'cust-new-888',
          customerId: 'cust-new-888',
          customerName: plainReq.customerName,
          phoneNo: plainReq.phoneNo,
          address: plainReq.address,
          companyName: plainReq.companyName,
          birthday: plainReq.birthday,
          remake: plainReq.remake,
        };
        return respond({ code: '00', message: 'SUCCESS', content: 'cust-new-888' });
      }

      if (url.endsWith('/cuscenter/customer/CustomerDetailController/queryCustomerDetail')) {
        return respond({
          code: '00',
          message: 'SUCCESS',
          content: savedRecord ?? {},
        });
      }

      return new Response(JSON.stringify({ code: '99', message: 'unexpected path' }), { status: 404 });
    };

    const apiClient = new KjgxDirectApiClient({ fetchImpl: mockFetch });
    const service = new KjgxWritebackService(store, 'expected_hash_abc123', apiClient);

    // Heartbeat syncs session in memory without leaking it in status
    const hb = await service.recordHeartbeat({
      deviceId: 'pixel3a-kjgx',
      appVersion: '18.8',
      bundleHash: 'expected_hash_abc123',
      sessionToken: 'secret-tok-xyz',
      empNoAes: 'secret-emp-aes',
    });
    expect(hb.session_present).toBe(true);
    const statusJson = JSON.stringify(service.getWorkerStatus());
    expect(statusJson).not.toContain('secret-tok-xyz');
    expect(statusJson).not.toContain('secret-emp-aes');

    const probe = await service.probeSession();
    expect(probe.ok).toBe(true);
    expect(probe.emp_no_prefix).toBe('EMP0');

    const actor = { actorType: 'human' as const, actorId: 'human_web' };
    const job = await service.enqueue(
      {
        customer_id: customer.id,
        job_type: 'create_customer',
        payload_target: { address: '直连测试地址99号', remark: 'API直连回写验证' },
      },
      actor,
    );
    await service.approve(job.id, actor);

    const dry = await service.executeJob(job.id, actor, { dryRun: true });
    expect(dry.ok).toBe(true);
    expect(dry.dry_run).toBe(true);

    const execRes = await service.executeJob(job.id, actor);
    expect(execRes.ok).toBe(true);
    expect(execRes.job.execution_status).toBe('succeeded');
    expect(execRes.job.receipt?.readback_matched).toBe(true);
    expect(execRes.job.receipt?.route_result).toBe('DIRECT_KHZX_API_VERIFIED');

    // Verify mismatch fails closed
    const badCheck = verifyCustomerReadback(
      { customerName: customer.name, address: '预期地址' },
      { customerName: customer.name, address: '不一致地址' },
      aesSessionKey,
    );
    expect(badCheck.matched).toBe(false);
    expect(badCheck.mismatches).toContain('address');
  });
});
