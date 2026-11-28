#!/usr/bin/env node
/**
 * One-shot local Google Workspace OAuth 2.0 setup helper for Insurance CRM.
 *
 * Scopes requested (official Google APIs only):
 *  - https://www.googleapis.com/auth/contacts  (Google People API)
 *  - https://www.googleapis.com/auth/calendar  (Google Calendar API v3)
 *  - https://www.googleapis.com/auth/tasks     (Google Tasks API v1)
 *
 * Usage:
 *   GOOGLE_CLIENT_ID="xxx.apps.googleusercontent.com" \
 *   GOOGLE_CLIENT_SECRET="GOCSPX-xxx" \
 *   node scripts/google-oauth-setup.mjs
 *
 * Never commit the resulting GOOGLE_REFRESH_TOKEN to GitHub; place it only in
 * the private Seoul production /opt/insurance-crm/.env file (chmod 600).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET ?? '').trim();
const PORT = Number(process.env.OAUTH_CALLBACK_PORT ?? 18991);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required.');
  console.error('Create a Desktop App OAuth 2.0 client in Google Cloud Console first.');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
];

const state = crypto.randomBytes(16).toString('hex');
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('state', state);

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function verifyReadOnly(accessToken) {
  const hdrs = { authorization: `Bearer ${accessToken}` };
  const [groupsRes, calRes, tasksRes] = await Promise.all([
    fetch('https://people.googleapis.com/v1/contactGroups?pageSize=100', { headers: hdrs }),
    fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: hdrs }),
    fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100', { headers: hdrs }),
  ]);
  const groups = groupsRes.ok ? ((await groupsRes.json()).contactGroups ?? []).map((g) => g.name) : [];
  const calendars = calRes.ok ? ((await calRes.json()).items ?? []).map((c) => c.summary) : [];
  const taskLists = tasksRes.ok ? ((await tasksRes.json()).items ?? []).map((l) => l.title) : [];
  return {
    peopleOk: groupsRes.ok,
    calendarOk: calRes.ok,
    tasksOk: tasksRes.ok,
    groups,
    calendars,
    taskLists,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  if (err || !code || gotState !== state) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`OAuth failed: ${err ?? 'invalid state or missing code'}`);
    server.close();
    process.exit(1);
  }

  try {
    const tokens = await exchangeCode(code);
    const probe = await verifyReadOnly(tokens.access_token);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h2>Google OAuth 授权成功！请回到终端查看校验结果并关闭此页面。</h2>');

    console.log('\n=== Google API 只读探活结果 ===');
    console.log(`People API   : ${probe.peopleOk ? 'OK' : 'FAIL'} | 分组: ${probe.groups.join(', ')}`);
    console.log(`Calendar API : ${probe.calendarOk ? 'OK' : 'FAIL'} | 日历: ${probe.calendars.join(', ')}`);
    console.log(`Tasks API    : ${probe.tasksOk ? 'OK' : 'FAIL'} | 列表: ${probe.taskLists.join(', ')}`);

    console.log('\n=== 请将以下配置写入首尔私有 /opt/insurance-crm/.env（先只读，核验无误后再开写开关）===');
    console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token ?? '<MISSING_RETRY_WITH_CONSENT>'}`);
    console.log('GOOGLE_SYNC_ENABLED=true');
    console.log('GOOGLE_CONTACTS_WRITE_ENABLED=false');
    console.log('GOOGLE_CALENDAR_WRITE_ENABLED=false');
    console.log('GOOGLE_TASKS_WRITE_ENABLED=false');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e));
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log('\n请在浏览器打开以下链接完成本人 Google 账号授权：\n');
  console.log(authUrl.toString());
  console.log('');
  if (process.platform === 'darwin') {
    exec(`open "${authUrl.toString()}"`);
  }
});
