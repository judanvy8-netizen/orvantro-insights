import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, verifyIdentity } from '../worker.mjs';
import { validateSimulator } from '../premium.mjs';
import { env, now, token, base64url, fetcher } from './support.mjs';

const origin = 'https://stats.example.test';
const actors = Object.fromEntries(['owner', 'editor', 'viewer', 'outside', 'second'].map(name => [name, { sub: `${name}-subject`, email: `${name}@example.test` }]));
const simulator = () => ({ sell: '19900', cost: '6500', ship: '3000', ad: '1200', fixed: '300000', feePct: '5.8', units: '300', targetPct: '30', reservePct: '3.3', reserveEnabled: false, platform: '5.8' });
const scenario = (name = '기본 판매안') => ({ name, simulator: simulator() });
const configuration = () => ({ ...env(), PREMIUM_ACCESS_AUD: 'premium-audience' });
async function request(path = '/api/workspaces', method = 'GET', body, actor = 'owner', headers = {}) {
  return new Request(origin + path, {
    method,
    headers: { 'Cf-Access-Jwt-Assertion': await token({ aud: ['premium-audience'], ...actors[actor] }), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}
async function call(config, path, method, body, actor, headers) { return handleRequest(await request(path, method, body, actor, headers), config, { now, fetcher }); }
async function createWorkspace(config, actor = 'owner', name = 'ORVANTRO 작업 공간') {
  const response = await call(config, '/api/workspaces', 'POST', { name }, actor);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).workspace;
}
async function invite(config, workspace, actor, role = actor) {
  const response = await call(config, `/api/workspaces/${workspace.id}/members`, 'POST', { email: actors[actor].email, role });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).member;
}
async function workspaceDetail(config, workspace, actor = 'owner') {
  const response = await call(config, `/api/workspaces/${workspace.id}`, 'GET', undefined, actor);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function createScenario(config, workspace, actor = 'owner') {
  const response = await call(config, `/api/workspaces/${workspace.id}/scenarios`, 'POST', scenario(), actor);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).scenario;
}
const match = item => ({ 'If-Match': `"${item.version}"` });

test('workspace creates its verified user as owner and lists only that user memberships', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  assert.equal(workspace.role, 'owner');
  assert.equal(workspace.version, 1);
  const response = await call(config);
  const data = await response.json();
  assert.deepEqual(data.identity, { subject: actors.owner.sub, email: actors.owner.email });
  assert.equal(data.workspaces[0].id, workspace.id);
  assert.equal(data.limits.scenariosPerWorkspace, 100);
  const detail = await workspaceDetail(config, workspace);
  assert.equal(detail.members.length, 1);
  assert.equal(detail.members[0].status, 'active');
  assert.equal(detail.members[0].role, 'owner');
  assert.equal((await (await call(config, '/api/workspaces', 'GET', undefined, 'outside')).json()).workspaces.length, 0);
  assert.equal(JSON.stringify(detail).includes(actors.owner.sub), false);
});

test('unconfigured workspace and a shared admin audience fail closed', async () => {
  for (const change of [{ PREMIUM_ACCESS_AUD: undefined }, { DB: undefined }, { PREMIUM_ACCESS_AUD: 'app-audience' }, { ACCESS_TEAM_DOMAIN: '' }]) {
    const response = await call({ ...configuration(), ...change });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'workspace_not_configured');
  }
  const config = configuration();
  delete config.AUTH_ALLOWLIST_EMAILS;
  assert.equal((await call(config)).status, 200);
  const admin = new Request(origin + '/api/admin/summary', { headers: { 'Cf-Access-Jwt-Assertion': await token() } });
  assert.equal((await handleRequest(admin, config, { now, fetcher })).status, 503);
});

test('workspace verifies signatures and the separate audience rather than trusting email headers', async () => {
  const config = configuration();
  const signed = await token({ aud: ['premium-audience'], ...actors.owner });
  const parts = signed.split('.');
  const tampered = `${parts[0]}.${base64url({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), email: actors.outside.email })}.${parts[2]}`;
  for (const jwt of ['', tampered, await token(), await token({ aud: ['premium-audience'], exp: now / 1000 }), await token({ aud: ['premium-audience'], iss: 'https://evil.example' })]) {
    const response = await call(config, '/api/workspaces', 'GET', undefined, 'owner', { 'Cf-Access-Jwt-Assertion': jwt, 'Cf-Access-Authenticated-User-Email': actors.owner.email });
    assert.equal(response.status, 401);
  }
  const identity = await verifyIdentity(await request(), config, now, fetcher, 'PREMIUM_ACCESS_AUD');
  assert.deepEqual(identity, { subject: actors.owner.sub, email: actors.owner.email });
  const premiumAdmin = new Request(origin + '/api/admin/summary', { headers: { 'Cf-Access-Jwt-Assertion': signed } });
  assert.equal((await handleRequest(premiumAdmin, config, { now, fetcher })).status, 401);
});

test('all mutations require exact same-origin JSON and bounded bodies', async () => {
  const config = configuration();
  for (const [headers, body, status] of [
    [{ Origin: '' }, { name: 'test' }, 403],
    [{ Origin: 'https://evil.example' }, { name: 'test' }, 403],
    [{ Origin: origin + '.evil.example' }, { name: 'test' }, 403],
    [{ 'Sec-Fetch-Site': 'cross-site' }, { name: 'test' }, 403],
    [{ 'Content-Type': 'text/plain' }, { name: 'test' }, 415],
    [{ 'Content-Type': 'application/x-www-form-urlencoded' }, { name: 'test' }, 415],
    [{}, '{broken', 400], [{}, ' '.repeat(8193), 413],
  ]) assert.equal((await call(config, '/api/workspaces', 'POST', body, 'owner', headers)).status, status);
  assert.equal(config.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 0);
  assert.equal((await call(config, '/api/workspaces', 'GET', undefined, 'owner', { Origin: 'https://evil.example' })).status, 403);
});

test('workspace names reject role injection and creation quota is enforced transactionally', async () => {
  const config = configuration();
  for (const body of [{ name: 'test', role: 'owner' }, { name: '', owner: actors.outside.sub }, { name: ' ' }, { name: 'x'.repeat(81) }, { name: 'bad\u0000name' }, []]) {
    assert.equal((await call(config, '/api/workspaces', 'POST', body)).status, 400);
  }
  for (let i = 0; i < 4; i++) await createWorkspace(config, 'owner', `공간 ${i}`);
  const competing = await Promise.all([call(config, '/api/workspaces', 'POST', { name: '동시 A' }), call(config, '/api/workspaces', 'POST', { name: '동시 B' })]);
  assert.deepEqual(competing.map(response => response.status).sort(), [201, 409]);
  assert.equal(config.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 5);
  assert.equal(config.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_members').get().n, 5);
});

test('pending invitations bind to a verified subject only once and never send email', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  const member = await invite(config, workspace, 'editor');
  assert.equal(member.status, 'pending');
  const detail = await workspaceDetail(config, workspace, 'editor');
  assert.equal(detail.workspace.role, 'editor');
  const active = detail.members.find(row => row.id === member.id);
  assert.equal(active.status, 'active');
  assert.equal(active.version, member.version + 1);
  const changedSubject = await token({ aud: ['premium-audience'], email: actors.editor.email, sub: 'different-subject' });
  const denied = await call(config, `/api/workspaces/${workspace.id}`, 'GET', undefined, 'editor', { 'Cf-Access-Jwt-Assertion': changedSubject });
  assert.equal(denied.status, 404);
  const changedEmail = await token({ aud: ['premium-audience'], email: actors.outside.email, sub: actors.editor.sub });
  assert.equal((await call(config, `/api/workspaces/${workspace.id}`, 'GET', undefined, 'editor', { 'Cf-Access-Jwt-Assertion': changedEmail })).status, 404);
  assert.equal(config.DB.sqlite.prepare('SELECT subject FROM workspace_members WHERE id = ?').get(member.id).subject, actors.editor.sub);
});

test('viewer can read but cannot create scenarios, grant roles or rename workspaces', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  await invite(config, workspace, 'viewer');
  const saved = await createScenario(config, workspace);
  const detail = await workspaceDetail(config, workspace, 'viewer');
  const viewer = detail.members.find(row => row.email === actors.viewer.email);
  assert.equal(detail.scenarios[0].id, saved.id);
  for (const [suffix, method, body, etag] of [
    ['/scenarios', 'POST', scenario(), {}],
    [`/scenarios/${saved.id}`, 'PUT', scenario('tampered'), match(saved)],
    [`/scenarios/${saved.id}`, 'DELETE', {}, match(saved)],
    [`/members/${viewer.id}`, 'PUT', { role: 'owner' }, match(viewer)],
    ['/members', 'POST', { email: actors.outside.email, role: 'owner' }, {}],
    ['', 'PUT', { name: 'takeover' }, match(detail.workspace)],
    ['', 'DELETE', {}, match(detail.workspace)],
  ]) assert.equal((await call(config, `/api/workspaces/${workspace.id}${suffix}`, method, body, 'viewer', etag)).status, 403);
  assert.equal((await workspaceDetail(config, workspace)).scenarios[0].name, saved.name);
});

test('editor can synchronize scenarios but cannot change membership or workspace ownership', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  await invite(config, workspace, 'editor');
  const saved = await createScenario(config, workspace, 'editor');
  const updatedResponse = await call(config, `/api/workspaces/${workspace.id}/scenarios/${saved.id}`, 'PUT', scenario('편집안'), 'editor', match(saved));
  assert.equal(updatedResponse.status, 200);
  const updated = (await updatedResponse.json()).scenario;
  assert.equal(updated.version, 2);
  assert.equal(updatedResponse.headers.get('ETag'), '"2"');
  assert.equal((await workspaceDetail(config, workspace)).scenarios[0].name, '편집안');
  assert.equal((await call(config, `/api/workspaces/${workspace.id}/members`, 'POST', { email: actors.outside.email, role: 'owner' }, 'editor')).status, 403);
  assert.equal((await call(config, `/api/workspaces/${workspace.id}/scenarios/${saved.id}`, 'DELETE', {}, 'editor', match(updated))).status, 200);
  assert.equal((await workspaceDetail(config, workspace)).scenarios.length, 0);
});

test('outsiders cannot read, mutate or enumerate any workspace subresource', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  const saved = await createScenario(config, workspace);
  const owner = (await workspaceDetail(config, workspace)).members[0];
  for (const [suffix, method, body, etag] of [
    ['', 'GET'], ['/members', 'GET'], ['/scenarios', 'GET'], [`/scenarios/${saved.id}`, 'GET'],
    ['/scenarios', 'POST', scenario(), {}],
    [`/scenarios/${saved.id}`, 'PUT', scenario('bad'), match(saved)],
    [`/scenarios/${saved.id}`, 'DELETE', {}, match(saved)],
    ['/members', 'POST', { email: actors.outside.email, role: 'owner' }, {}],
    [`/members/${owner.id}`, 'PUT', { role: 'viewer' }, match(owner)],
  ]) assert.equal((await call(config, `/api/workspaces/${workspace.id}${suffix}`, method, body, 'outside', etag)).status, 404);
});

test('record IDs from another workspace cannot be used through an owned workspace route', async () => {
  const config = configuration();
  const first = await createWorkspace(config);
  const second = await createWorkspace(config, 'outside');
  const saved = await createScenario(config, second, 'outside');
  const otherOwner = (await workspaceDetail(config, second, 'outside')).members[0];
  for (const [suffix, method, body, etag] of [
    [`/scenarios/${saved.id}`, 'GET'], [`/scenarios/${saved.id}`, 'PUT', scenario('bad'), match(saved)],
    [`/scenarios/${saved.id}`, 'DELETE', {}, match(saved)], [`/members/${otherOwner.id}`, 'PUT', { role: 'viewer' }, match(otherOwner)],
  ]) assert.equal((await call(config, `/api/workspaces/${first.id}${suffix}`, method, body, 'owner', etag)).status, 404);
  assert.equal((await workspaceDetail(config, second, 'outside')).scenarios[0].name, saved.name);
});

test('the last active owner cannot be removed or demoted even with a pending owner invitation', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  await invite(config, workspace, 'second', 'owner');
  const owner = (await workspaceDetail(config, workspace)).members.find(row => row.email === actors.owner.email);
  for (const [method, body] of [['PUT', { role: 'viewer' }], ['DELETE', {}]]) {
    const response = await call(config, `/api/workspaces/${workspace.id}/members/${owner.id}`, method, body, 'owner', match(owner));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'last_owner_required');
  }
  assert.equal((await workspaceDetail(config, workspace)).workspace.role, 'owner');
});

test('concurrent owner demotions preserve one active owner at the SQL layer', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  await invite(config, workspace, 'second', 'owner');
  await workspaceDetail(config, workspace, 'second');
  const detail = await workspaceDetail(config, workspace);
  const one = detail.members.find(row => row.email === actors.owner.email);
  const two = detail.members.find(row => row.email === actors.second.email);
  const results = await Promise.all([
    call(config, `/api/workspaces/${workspace.id}/members/${one.id}`, 'PUT', { role: 'editor' }, 'owner', match(one)),
    call(config, `/api/workspaces/${workspace.id}/members/${two.id}`, 'PUT', { role: 'editor' }, 'second', match(two)),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(config.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE role = 'owner' AND subject IS NOT NULL").get().n, 1);
});

test('owner can change and remove members with a matching membership version', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  const member = await invite(config, workspace, 'viewer');
  const response = await call(config, `/api/workspaces/${workspace.id}/members/${member.id}`, 'PUT', { role: 'editor' }, 'owner', match(member));
  assert.equal(response.status, 200);
  const updated = (await response.json()).member;
  assert.equal(updated.role, 'editor');
  assert.equal((await call(config, `/api/workspaces/${workspace.id}/members/${member.id}`, 'DELETE', {}, 'owner', match(member))).status, 412);
  assert.equal((await call(config, `/api/workspaces/${workspace.id}/members/${member.id}`, 'DELETE', {}, 'owner', match(updated))).status, 200);
  assert.equal((await call(config, `/api/workspaces/${workspace.id}`, 'GET', undefined, 'viewer')).status, 404);
});

test('scenario updates require valid If-Match and reject concurrent lost updates', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  const saved = await createScenario(config, workspace);
  const path = `/api/workspaces/${workspace.id}/scenarios/${saved.id}`;
  assert.equal((await call(config, path, 'PUT', scenario())).status, 428);
  for (const value of ['1', '*', 'W/"1"', '"1","2"', '"0"']) assert.equal((await call(config, path, 'PUT', scenario(), 'owner', { 'If-Match': value })).status, 400);
  const results = await Promise.all([call(config, path, 'PUT', scenario('A'), 'owner', match(saved)), call(config, path, 'PUT', scenario('B'), 'owner', match(saved))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 412]);
  const current = (await (await call(config, path)).json()).scenario;
  assert.equal(current.version, 2);
  assert.ok(['A', 'B'].includes(current.name));
  assert.equal((await call(config, path, 'DELETE', {}, 'owner', match(saved))).status, 412);
});

test('mutation SQL rechecks permissions after a role is revoked between reads and writes', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  await invite(config, workspace, 'editor');
  const saved = await createScenario(config, workspace, 'editor');
  const originalBatch = config.DB.batch.bind(config.DB);
  let revoked = false;
  config.DB.batch = async statements => {
    if (!revoked && statements.some(statement => statement.sql.startsWith('UPDATE workspace_scenarios'))) {
      revoked = true;
      config.DB.sqlite.prepare("UPDATE workspace_members SET role = 'viewer' WHERE email = ?").run(actors.editor.email);
    }
    return originalBatch(statements);
  };
  const response = await call(config, `/api/workspaces/${workspace.id}/scenarios/${saved.id}`, 'PUT', scenario('revoked change'), 'editor', match(saved));
  assert.equal(response.status, 412);
  assert.equal((await workspaceDetail(config, workspace)).scenarios[0].name, saved.name);
});

test('simulator schema preserves exact decimal strings and rejects unknown or unbounded inputs', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  const path = `/api/workspaces/${workspace.id}/scenarios`;
  const precise = scenario(); precise.simulator.sell = '1000000000000'; precise.simulator.feePct = '3.300001'; precise.simulator.units = '1.5';
  const accepted = await call(config, path, 'POST', precise);
  assert.equal(accepted.status, 201);
  assert.deepEqual((await accepted.json()).scenario.simulator, precise.simulator);
  for (const input of [
    { ...scenario(), role: 'owner' }, { ...scenario(), simulator: { ...simulator(), unknown: 'private' } },
    ...[{ sell: 1 }, { sell: '1e3' }, { sell: '-1' }, { sell: '1000000000000.000001' }, { cost: '00' }, { feePct: '100.000001' },
      { units: '1000000000.000001' }, { units: '1.0000001' }, { units: '1000000001' }, { reservePct: 'NaN' }, { reserveEnabled: 'false' }, { platform: 'amazon' }]
      .map(overrides => ({ name: 'bad', simulator: { ...simulator(), ...overrides } })),
  ]) assert.equal((await call(config, path, 'POST', input)).status, 400);
  assert.equal(validateSimulator({ ...simulator(), units: '0' }).units, '0');
  assert.throws(() => validateSimulator({ sell: '1' }));
});

test('scenario quota and membership duplicate checks do not overwrite existing records', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  await invite(config, workspace, 'viewer');
  assert.equal((await call(config, `/api/workspaces/${workspace.id}/members`, 'POST', { email: actors.viewer.email.toUpperCase(), role: 'owner' })).status, 409);
  for (let i = 0; i < 100; i++) {
    config.DB.sqlite.prepare('INSERT INTO workspace_scenarios(id, workspace_id, name, simulator_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(crypto.randomUUID(), workspace.id, 'quota test', JSON.stringify(simulator()), now, now);
  }
  assert.equal((await call(config, `/api/workspaces/${workspace.id}/scenarios`, 'POST', scenario())).status, 409);
  assert.equal(config.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_scenarios').get().n, 100);
});

test('workspace revision advances on child mutations and stale deletion preserves new scenarios', async () => {
  const config = configuration();
  const workspace = await createWorkspace(config);
  await createScenario(config, workspace);
  const stale = await call(config, `/api/workspaces/${workspace.id}`, 'DELETE', {}, 'owner', match(workspace));
  assert.equal(stale.status, 412);
  const detail = await workspaceDetail(config, workspace);
  assert.equal(detail.workspace.version, workspace.version + 1);
  assert.equal(detail.scenarios.length, 1);
  const renamed = await call(config, `/api/workspaces/${workspace.id}`, 'PUT', { name: '이름 변경' }, 'owner', match(detail.workspace));
  assert.equal(renamed.status, 200);
  const updated = (await renamed.json()).workspace;
  assert.equal(updated.name, '이름 변경');
  assert.equal((await call(config, `/api/workspaces/${workspace.id}`, 'DELETE', {}, 'owner', match(updated))).status, 200);
  assert.equal(config.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 0);
  assert.equal(config.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_members').get().n, 0);
  assert.equal(config.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_scenarios').get().n, 0);
});

test('workspace SQL treats names as data and denies query/path injection', async () => {
  const config = configuration();
  const injected = "name'; DROP TABLE workspaces; --";
  const workspace = await createWorkspace(config, 'owner', injected);
  assert.equal((await workspaceDetail(config, workspace)).workspace.name, injected);
  for (const path of ['/api/workspaces?owner=true', '/api/workspaces/%27%20OR%201=1', `/api/workspaces/${workspace.id}/secrets`, `/api/workspaces/${workspace.id}/members/unknown`, '/api/workspaces/']) {
    assert.ok([400, 404].includes((await call(config, path)).status));
  }
});

test('database errors are unavailable rather than empty workspaces or fake save success', async () => {
  const config = configuration();
  config.DB.batch = async () => { throw new Error('private connection info'); };
  for (const [method, body] of [['GET', undefined], ['POST', { name: 'test' }]]) {
    const response = await call(config, '/api/workspaces', method, body);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'storage_unavailable' });
  }
});

test('workspace assets require premium authentication and have no static fallback bypass', async () => {
  const config = configuration();
  const paths = [];
  config.ASSETS = { fetch: async request => { paths.push(new URL(request.url).pathname); return new Response('<html>workspace</html>', { headers: { 'Content-Type': 'text/html' } }); } };
  const unauthorized = await handleRequest(new Request(origin + '/workspace/'), config, { now, fetcher });
  assert.equal(unauthorized.status, 401);
  assert.equal(paths.length, 0);
  const page = await call(config, '/workspace/');
  assert.equal(page.status, 200);
  assert.deepEqual(paths, ['/workspace/index.html']);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal((await call(config, '/workspace')).status, 308);
  assert.equal((await call(config, '/workspace/worker.mjs')).status, 404);
  assert.equal((await call(config, '/workspace.js')).status, 404);
  assert.equal((await call(config, '/workspace/index.html')).status, 404);
});
