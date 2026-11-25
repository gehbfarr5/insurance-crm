import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IdVault } from '../crypto/id-vault.js';
import {
  aesEcbDecrypt,
  aesEcbEncrypt,
  buildKhzxCustomerPayload,
  empNoAesHexEncrypt,
  KjgxDirectApiClient,
  md5Hex,
  sm4CbcEncrypt,
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
    expect(created.payload.cardType).toBe('111');
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

  it('encrypts secrets verbatim in IdVault and runs full server login + captcha + H5 gate + DB session reload without Pixel', async () => {
    const vault = new IdVault(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    );
    const secretPayload = JSON.stringify({ accesstoken: 'MixedCase_Tok-123+/', empNoAES: 'EmpAes==' });
    const sealed = vault.encryptSecret(secretPayload);
    expect(vault.decryptSecret(sealed)).toBe(secretPayload);

    // SM4-CBC + empNo AES-128-ECB uppercase hex smoke check
    const sm4Out = sm4CbcEncrypt('test');
    expect(sm4Out).toBe('2y+Epv1zwcfRktaZJyp1eg==');
    expect(empNoAesHexEncrypt('emp00001')).toMatch(/^[0-9A-F]{32}$/);
    expect(empNoAesHexEncrypt('emp00001')).toBe(empNoAesHexEncrypt('EMP00001'));

    const store = new InMemoryDemoStore(vault);
    const list = await store.searchCustomers({ limit: 1 });
    const customer = list.customers[0]!;

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
    let lastLoginHeaders: Record<string, string> = {};
    let lastLoginInner: Record<string, unknown> = {};
    let savedRecord: Record<string, unknown> | null = null;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/khzx/')) {
        return new Response(
          '<html><script src="/khzx/static/js/app-5a11b65b.b21da7ed.js"></script><script src="/khzx/static/js/runtime.3e69b042.js"></script></html>',
          { status: 200 },
        );
      }

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

      if (url.endsWith('/emp/api/login/login')) {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        lastLoginHeaders = hdrs;
        const reqX = crypto
          .privateDecrypt(
            { key: serverKeys.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(hdrs.Skey!, 'base64'),
          )
          .toString('utf8');
        const decSha = crypto
          .privateDecrypt(
            { key: serverKeys.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(hdrs.Sign!, 'base64'),
          )
          .toString('utf8');
        const expectedSha = crypto
          .createHash('sha256')
          .update(`${body.data}${hdrs['Times-Tamp']}${hdrs.Uuid}`, 'utf8')
          .digest('hex');
        expect(decSha).toBe(expectedSha);

        lastLoginInner = JSON.parse(aesEcbDecrypt(body.data!, reqX)) as Record<string, unknown>;
        const respPlain = JSON.stringify({
          msgcode: '00',
          errorMsg: '',
          loginEmp: {
            empNo: 'EMP00001',
            empName: '测试外勤',
            empNoAES: 'SERVER_EMP_AES_99',
            token: 'server-tok-abc-999',
          },
        });
        return new Response(JSON.stringify({ data: aesEcbEncrypt(respPlain, reqX) }), {
          status: 200,
          headers: { 'response-encrypt-login': 'true' },
        });
      }

      const plainStr = body.data ? aesEcbDecrypt(body.data, aesSessionKey) : '';
      const plainReq = plainStr ? (JSON.parse(plainStr) as Record<string, unknown>) : {};
      const respond = (obj: Record<string, unknown>) =>
        new Response(JSON.stringify({ data: aesEcbEncrypt(JSON.stringify(obj), aesSessionKey) }), {
          status: 200,
          headers: { 'response-encrypt': 'true' },
        });

      if (url.endsWith('/emp/api/login/queryVerify')) {
        return respond({ msgcode: '00', status: '0' });
      }
      if (url.endsWith('/behavior/api/getVerifyCode/getVerifyCode')) {
        return respond({ msgCode: '00', verifyID: 'cap-uuid-123', verifyImg: 'iVBORw0KGgo=' });
      }
      if (url.endsWith('/emp/api/login/sendLoginAuthCode')) {
        return respond({ code: '00', message: '发送成功' });
      }
      if (url.endsWith('/emp/api/login/accessEmpInfo')) {
        return respond({
          code: '00',
          message: 'SUCCESS',
          content: { empNo: 'EMP00001', empName: '测试外勤', fgsCode: '310', channle: 'U12' },
        });
      }
      if (url.endsWith('/cuscenter/customer/saveCustomerController/saveCustomerInfo')) {
        savedRecord = {
          id: 406806674,
          customerId: 406806674,
          customerName: plainReq.customerName,
          phoneNo: plainReq.phoneNo,
          address: plainReq.address,
          companyName: plainReq.companyName,
          birthday: plainReq.birthday,
          remake: plainReq.remake,
        };
        return respond({ code: '00', message: 'SUCCESS', content: 406806674 });
      }
      if (url.endsWith('/cuscenter/customer/CustomerDetailController/queryCustomerDetail')) {
        return respond({ code: '00', message: 'SUCCESS', content: savedRecord ?? {} });
      }
      return new Response(JSON.stringify({ code: '99' }), { status: 404 });
    };

    const apiClient = new KjgxDirectApiClient({ fetchImpl: mockFetch });
    const h5 = await apiClient.fetchKhzxH5Fingerprint();
    expect(h5.script_count).toBe(2);

    const svc1 = new KjgxWritebackService(store, '', apiClient, h5.hash);
    const actor = { actorType: 'human' as const, actorId: 'human_web' };

    const cap = await svc1.getLoginCaptcha('emp00001');
    expect(cap.verify_id).toBe('cap-uuid-123');
    expect(cap.image_data_url).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(cap.verify_required).toBe(true);

    const sms = await svc1.sendLoginSms('emp00001');
    expect(sms.ok).toBe(true);

    const loginRes = await svc1.loginDirect(
      {
        empNo: 'emp00001',
        password: 'SamplePass!123',
        verifyId: 'cap-uuid-123',
        verifyCode: 'ABCD',
        smsCode: '123456',
      },
      actor,
    );
    expect(loginRes.ok).toBe(true);
    expect(loginRes.emp_name).toBe('测试外勤');
    expect(JSON.stringify(loginRes)).not.toContain('server-tok-abc-999');
    expect(lastLoginHeaders['Request-Encrypt']).toBe('true');
    expect(lastLoginInner.empNo).toBe(empNoAesHexEncrypt('EMP00001'));
    expect(lastLoginInner.password).toBe(sm4CbcEncrypt(md5Hex('SamplePass!123')));
    expect(lastLoginInner.pwd).toBe(sm4CbcEncrypt('SamplePass!123'));
    expect(lastLoginInner.code).toBe('Y_ABCD');
    expect(lastLoginInner.mobileCheck).toBe('123456');

    // Simulate process restart without any Pixel 3a device heartbeat
    const svcRestarted = new KjgxWritebackService(store, '', apiClient, h5.hash);
    expect(await svcRestarted.hydrateFromStore()).toBe(true);
    const status = svcRestarted.getWorkerStatus();
    expect(status.online).toBe(true);
    expect(status.pixel_online).toBe(false);
    expect(status.session_present).toBe(true);
    expect(status.session_source).toBe('server_login');
    expect(JSON.stringify(status)).not.toContain('server-tok-abc-999');

    const job = await svcRestarted.enqueue(
      {
        customer_id: customer.id,
        job_type: 'create_customer',
        payload_target: { address: '无手机服务端直连地址1号' },
      },
      actor,
    );
    await svcRestarted.approve(job.id, actor);
    const execRes = await svcRestarted.executeJob(job.id, actor);
    expect(execRes.ok).toBe(true);
    expect(execRes.job.assigned_device).toBe('server-direct');
    expect(execRes.job.receipt?.readback_matched).toBe(true);
    expect(execRes.job.receipt?.app_result?.addcustomerId).toBe('406806674');
    const refreshed = await store.getCustomer360(customer.id);
    expect(refreshed.customer.kjgx_db_customer_id).toBe('406806674');

    await svcRestarted.logoutSession(actor);
    expect(svcRestarted.getWorkerStatus().session_present).toBe(false);
  });
});
