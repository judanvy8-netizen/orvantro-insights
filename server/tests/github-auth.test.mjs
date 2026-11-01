import test from 'node:test';
import assert from 'node:assert/strict';
import { env, now } from './support.mjs';
import { handleRequest, pruneExpired } from '../worker.mjs';

const origin = 'https://stats.example.test';
function setup() { return { ...env(), AUTH_PROVIDER: 'github', AUTH_ORIGIN: origin, GITHUB_CLIENT_ID: 'test-client-id', GITHUB_CLIENT_SECRET: 'test-only-client-secret-do-not-use', AUTH_GITHUB_OWNER_ID: '123' }; }
function request(path, method = 'GET', body, headers = {}) {
  return new Request(origin + path, { method, ...(body === undefined ? {} : { body }), headers });
}
function post(path, body, cookie = '') { return request(path, 'POST', body, { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }); }
async function begin(configuration, destination = 'admin') {
  const result = await handleRequest(post('/auth/login', `next=${destination}`), configuration, { now });
  assert.equal(result.status, 303);
  const authorization = new URL(result.headers.get('Location'));
  assert.equal(authorization.origin, 'https://github.com');
  assert.equal(authorization.searchParams.get('scope'), 'user:email');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('redirect_uri'), origin + '/auth/callback');
  return { authorization, state: authorization.searchParams.get('state'), cookie: result.headers.getSetCookie()[0].split(';')[0] };
}
function provider(flow, userId = 123, email = 'owner@example.test', verified = true) {
  let calls = 0;
  return async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = new URLSearchParams(options.body);
      const actual = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))).toString('base64url');
      assert.equal(actual, flow.authorization.searchParams.get('code_challenge'));
      assert.equal(body.get('redirect_uri'), origin + '/auth/callback');
      return Response.json({ access_token: 'provider-test-token-never-store', token_type: 'bearer', scope: 'user:email' });
    }
    assert.equal(options.headers.Authorization, 'Bearer provider-test-token-never-store');
    if (url === 'https://api.github.com/user') return Response.json({ id: userId, login: 'irrelevant-name', email });
    assert.equal(url, 'https://api.github.com/user/emails?per_page=100');
    return Response.json([{ email, primary: true, verified }]);
  };
}
async function finish(configuration, flow, { userId = 123, email = 'owner@example.test', verified = true, time = now } = {}) {
  return handleRequest(request(`/auth/callback?state=${flow.state}&code=test-authorization-code`, 'GET', undefined, { Cookie: flow.cookie }), configuration,
    { now: time, fetcher: provider(flow, userId, email, verified) });
}
function sessionCookie(response) { return response.headers.getSetCookie().find(value => value.startsWith('__Host-orvantro_session=')).split(';')[0]; }

test('GitHub owner login uses PKCE, verified email, a stable ID and only hashed session storage', async () => {
  const configuration = setup(), flow = await begin(configuration);
  const response = await finish(configuration, flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/admin/');
  assert.match(response.headers.getSetCookie()[0], /Secure; HttpOnly; SameSite=Lax; Max-Age=28800/);
  const cookie = sessionCookie(response);
  const stored = configuration.DB.sqlite.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(stored.subject, 'github:123');
  assert.equal(stored.email, 'owner@example.test');
  assert.ok(!JSON.stringify(stored).includes(cookie.split('=')[1]));
  assert.ok(!JSON.stringify(stored).includes('provider-test-token'));
  const summary = await handleRequest(request('/api/admin/summary', 'GET', undefined, { Cookie: cookie }), configuration, { now });
  assert.equal(summary.status, 200);
  const workspace = await handleRequest(request('/api/workspaces', 'POST', JSON.stringify({ name: 'Owner workspace' }), { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }), configuration, { now });
  assert.equal(workspace.status, 201);
});

test('anonymous HTML navigations get a login page while APIs remain 401 without redirects', async () => {
  const configuration = setup();
  for (const path of ['/admin/', '/workspace/']) {
    const response = await handleRequest(request(path), configuration, { now });
    assert.equal(response.status, 303);
    assert.match(response.headers.get('Location'), /^\/auth\/login\?next=/);
  }
  assert.equal((await handleRequest(request('/api/admin/summary'), configuration, { now })).status, 401);
  const login = await handleRequest(request('/auth/login?next=//attacker.test'), configuration, { now });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('Referrer-Policy'), 'same-origin');
  assert.match(login.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.match(login.headers.get('Content-Security-Policy'), /form-action 'self' https:\/\/github.com\/login\/oauth\/authorize;/);
  assert.ok(!(await login.text()).includes('attacker.test'));
});

test('login start and logout reject cross-origin and missing-origin mutations', async () => {
  const configuration = setup();
  for (const path of ['/auth/login', '/auth/logout']) {
    for (const site of ['', 'https://attacker.test']) {
      const response = await handleRequest(request(path, 'POST', 'next=admin', { Origin: site, 'Content-Type': 'application/x-www-form-urlencoded' }), configuration, { now });
      assert.equal(response.status, 403);
    }
  }
});

test('callback requires the browser-bound state and consumes it atomically', async () => {
  const configuration = setup(), flow = await begin(configuration);
  const missing = await handleRequest(request(`/auth/callback?state=${flow.state}&code=test-code`), configuration, { now });
  assert.equal(missing.status, 401);
  assert.equal((await finish(configuration, flow)).status, 303);
  const replay = await finish(configuration, flow);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, 'login_expired');
});

test('expired login and session cannot be reused and cleanup removes them', async () => {
  const configuration = setup(), flow = await begin(configuration);
  assert.equal((await finish(configuration, flow, { time: now + 600_000 })).status, 401);
  const second = await begin(configuration), signedIn = await finish(configuration, second);
  const expired = await handleRequest(request('/api/admin/summary', 'GET', undefined, { Cookie: sessionCookie(signedIn) }), configuration, { now: now + 28_800_000 });
  assert.equal(expired.status, 401);
  await pruneExpired(configuration, now + 28_800_000);
  assert.equal(configuration.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
  assert.equal(configuration.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_flows').get().n, 0);
});

test('email matching the owner does not authorize another GitHub ID, and unverified email never signs in', async () => {
  for (const options of [{ userId: 456 }, { verified: false }]) {
    const configuration = setup(), flow = await begin(configuration);
    assert.equal((await finish(configuration, flow, options)).status, 403);
    assert.equal(configuration.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
  }
});

test('uninvited users cannot sign in to workspaces', async () => {
  const configuration = setup(), flow = await begin(configuration, 'workspace');
  const response = await finish(configuration, flow, { userId: 456, email: 'member@example.test' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'invitation_required');
});

test('invited member signs into only the assigned workspace and cannot administer or create workspaces', async () => {
  const configuration = setup(), workspaceId = crypto.randomUUID();
  configuration.DB.sqlite.prepare('INSERT INTO workspaces VALUES (?, ?, ?, 1, ?, ?)').run(workspaceId, 'Team', 'github:123', now, now);
  configuration.DB.sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?, ?, NULL, ?, 1, ?, ?)').run(crypto.randomUUID(), workspaceId, 'member@example.test', 'viewer', now, now);
  const flow = await begin(configuration, 'workspace');
  const response = await finish(configuration, flow, { userId: 456, email: 'member@example.test' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/workspace/');
  const cookie = sessionCookie(response);
  const workspaces = await handleRequest(request('/api/workspaces', 'GET', undefined, { Cookie: cookie }), configuration, { now });
  const data = await workspaces.json();
  assert.equal(data.workspaces[0].id, workspaceId);
  assert.equal(data.workspaces[0].role, 'viewer');
  assert.equal((await handleRequest(request('/api/admin/summary', 'GET', undefined, { Cookie: cookie }), configuration, { now })).status, 403);
  assert.equal((await handleRequest(request('/api/workspaces', 'POST', '{"name":"Unauthorized"}', { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }), configuration, { now })).status, 403);
});

test('logout confirmation is non-mutating, logout POST revokes the session', async () => {
  const configuration = setup(), flow = await begin(configuration), response = await finish(configuration, flow), cookie = sessionCookie(response);
  assert.equal((await handleRequest(request('/auth/logout', 'GET', undefined, { Cookie: cookie }), configuration, { now })).status, 200);
  assert.equal(configuration.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
  const logout = await handleRequest(post('/auth/logout', '', cookie), configuration, { now });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/);
  assert.equal((await handleRequest(request('/api/admin/summary', 'GET', undefined, { Cookie: cookie }), configuration, { now })).status, 401);
});

test('duplicate cookies, provider failures and wrong deployment origin fail closed', async () => {
  const configuration = setup(), flow = await begin(configuration);
  const callback = request(`/auth/callback?state=${flow.state}&code=test-code`, 'GET', undefined, { Cookie: `${flow.cookie}; ${flow.cookie}` });
  assert.equal((await handleRequest(callback, configuration, { now })).status, 401);
  const failed = await handleRequest(request(`/auth/callback?state=${flow.state}&code=test-code`, 'GET', undefined, { Cookie: flow.cookie }), configuration,
    { now, fetcher: async () => { throw Error('never-return-provider-sensitive-data'); } });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('sensitive'));
  assert.equal((await handleRequest(new Request('https://preview.example.test/auth/login'), configuration, { now })).status, 503);
});

test('provider redirects never forward the client secret or bearer token to another URL', async () => {
  const configuration = setup(), flow = await begin(configuration);
  const destinations = [];
  const response = await handleRequest(request(`/auth/callback?state=${flow.state}&code=test-code`, 'GET', undefined, { Cookie: flow.cookie }), configuration,
    { now, fetcher: async (url, options) => {
      destinations.push(url);
      assert.equal(options.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/collect-token' } });
    } });
  assert.equal(response.status, 503);
  assert.deepEqual(destinations, ['https://github.com/login/oauth/access_token']);
  assert.equal(configuration.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
});
