import test from 'node:test';
import assert from 'node:assert/strict';
import { now, env, event, collectionRequest, base64url, token, publicKey, fetcher } from './support.mjs';
import { handleRequest, pruneExpired, dayInSeoul } from '../worker.mjs';

async function adminRequest(query = '', jwt = null, path = '/api/admin/summary') {
  return new Request(`https://stats.example.test${path}${query}`, { headers: { 'Cf-Access-Jwt-Assertion': jwt ?? await token() } });
}
async function summary(environment, time = now, query = '?range=7') {
  return handleRequest(await adminRequest(query), environment, { now: time, fetcher });
}

test('successful collection persists only derived hashes, registered site and server time', async () => {
  const configuration = env();
  const input = event();
  const response = await handleRequest(collectionRequest(input), configuration, { now });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false });
  const row = configuration.DB.rows()[0];
  assert.deepEqual(Object.keys(row), ['event_key', 'session_key', 'site', 'day', 'received_at', 'country', 'device', 'platform', 'browser']);
  assert.equal(row.day, '2026-11-01');
  assert.equal(row.received_at, now);
  assert.match(row.session_key, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(row).includes(input.sessionId));
  assert.ok(!JSON.stringify(row).includes(input.eventId));
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://orvantro.com');
});

test('event retry is idempotent and does not move last received time forward', async () => {
  const configuration = env();
  const input = event();
  await handleRequest(collectionRequest(input), configuration, { now });
  const retried = await handleRequest(collectionRequest(input), configuration, { now: now + 120_000 });
  assert.equal((await retried.json()).duplicate, true);
  assert.equal(configuration.DB.rows().length, 1);
  const record = configuration.DB.sqlite.prepare('SELECT * FROM analytics_collection').get();
  assert.equal(record.last_received_at, now);
});

test('summary counts pageviews and site-day sessions rather than pretending to count people', async () => {
  const configuration = env();
  const sessionId = crypto.randomUUID();
  for (let index = 0; index < 2; index++) await handleRequest(collectionRequest(event({ sessionId })), configuration, { now });
  await handleRequest(collectionRequest(event({ sessionId, site: 'marginkit-pro-beta' }), { Origin: 'https://judanvy8-netizen.github.io' }), configuration, { now });
  const response = await summary(configuration);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.metrics, { pageviews: 3, sessions: 2, activeDays: 1 });
  assert.equal(data.measurement.sessionDefinition, 'site_day_tab_session');
  assert.equal(data.measurement.startedAt, new Date(now).toISOString());
  assert.equal(data.daily.length, 7);
  assert.equal(data.bySite.find(site => site.site === 'orvantro').path, '/');
  assert.equal(data.bySite.find(site => site.site === 'marginkit-pro-beta').sessions, 1);
  assert.ok(!JSON.stringify(data).includes(sessionId));
});

test('empty initialized storage is distinct from unavailable storage', async () => {
  const configuration = env();
  const data = await (await summary(configuration)).json();
  assert.equal(data.status, 'empty');
  assert.equal(data.source, 'central');
  assert.equal(data.measurement.startedAt, null);
  assert.equal(data.metrics.pageviews, 0);
  configuration.DB.batch = async () => { throw new Error('sensitive provider failure'); };
  const unavailable = await summary(configuration);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'storage_unavailable' });
});

test('collector rejects invalid origin, missing origin and site-origin mismatch', async () => {
  const configuration = env();
  for (const origin of ['', 'https://evil.example', 'https://orvantro.com.evil.example']) {
    const response = await handleRequest(collectionRequest(event(), { Origin: origin }), configuration, { now });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const mismatch = await handleRequest(collectionRequest(event({ site: 'marginkit-pro-beta' })), configuration, { now });
  assert.equal(mismatch.status, 403);
  assert.equal(configuration.DB.rows().length, 0);
});

test('collector rejects free-form fields, timestamps, invalid IDs and sites', async () => {
  const configuration = env();
  for (const input of [event({ path: '/orders/private?email=customer@example.test' }), event({ timestamp: now }), event({ eventId: '1' }), event({ site: '__proto__' }), event({ v: 99 }), [], null]) {
    assert.equal((await handleRequest(collectionRequest(input), configuration, { now })).status, 400);
  }
  assert.equal(configuration.DB.rows().length, 0);
});

test('request body is bounded even when no Content-Length is supplied', async () => {
  const configuration = env();
  assert.equal((await handleRequest(collectionRequest('x'.repeat(2049)), configuration, { now })).status, 413);
  assert.equal((await handleRequest(collectionRequest(event(), { 'Content-Length': '99999999' }), configuration, { now })).status, 413);
  assert.equal((await handleRequest(collectionRequest('{bad json'), configuration, { now })).status, 400);
  assert.equal((await handleRequest(collectionRequest(event(), { 'Content-Type': 'application/x-www-form-urlencoded' }), configuration, { now })).status, 415);
  assert.equal(configuration.DB.rows().length, 0);
});

test('plain-text sendBeacon payload works and preflight has only an exact origin', async () => {
  const configuration = env();
  assert.equal((await handleRequest(collectionRequest(event(), { 'Content-Type': 'text/plain;charset=UTF-8' }), configuration, { now })).status, 202);
  const preflight = await handleRequest(collectionRequest(null, {}, 'OPTIONS'), configuration, { now });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://orvantro.com');
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(configuration.DB.rows().length, 1);
});

test('privacy preferences stop collection server-side', async () => {
  const configuration = env();
  for (const headers of [{ 'Sec-GPC': '1' }, { DNT: '1' }]) {
    const response = await handleRequest(collectionRequest(event(), headers), configuration, { now });
    assert.deepEqual(await response.json(), { accepted: false, reason: 'privacy_preference' });
  }
  assert.equal(configuration.DB.rows().length, 0);
});

test('configuration fails closed, including absent operator allowlist', async () => {
  const configuration = env();
  delete configuration.ANALYTICS_HASH_SECRET;
  assert.equal((await handleRequest(collectionRequest(event()), configuration, { now })).status, 503);
  delete configuration.AUTH_ALLOWLIST_EMAILS;
  assert.equal((await summary(configuration)).status, 503);
  assert.equal((await handleRequest(await adminRequest('', null, '/admin/'), configuration, { now, fetcher })).status, 503);
});

test('operator routes require a signed token rather than trusting an email header', async () => {
  const configuration = env();
  const response = await handleRequest(new Request('https://stats.example.test/api/admin/summary', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' } }), configuration, { now, fetcher });
  assert.equal(response.status, 401);
});

test('JWT signature, issuer, audience, expiry and not-before are enforced', async () => {
  const configuration = env();
  const valid = await token();
  const parts = valid.split('.');
  const tampered = `${parts[0]}.${base64url({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), email: 'other@example.test' })}.${parts[2]}`;
  for (const jwt of [tampered, await token({ iss: 'https://evil.example' }), await token({ aud: ['other'] }), await token({ exp: now / 1000 }), await token({ nbf: now / 1000 + 600 }), await token({}, { alg: 'none' }), await token({}, { crit: ['unhandled'] })]) {
    const response = await handleRequest(await adminRequest('', jwt), configuration, { now, fetcher });
    assert.equal(response.status, 401);
  }
});

test('valid Cloudflare identity still requires the operator email allowlist', async () => {
  const configuration = env();
  const response = await handleRequest(await adminRequest('', await token({ email: 'someone@example.test' })), configuration, { now, fetcher });
  assert.equal(response.status, 403);
});

test('identity provider outage is unavailable, not empty analytics', async () => {
  const configuration = env();
  configuration.ACCESS_TEAM_DOMAIN = 'unavailable.cloudflareaccess.com';
  const jwt = await token({ iss: 'https://unavailable.cloudflareaccess.com' });
  const response = await handleRequest(await adminRequest('', jwt), configuration, { now, fetcher: async () => { throw new Error('network failure'); } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'identity_provider_unavailable' });
});

test('unknown JWT key IDs cannot force repeated JWKS downloads', async () => {
  const configuration = env();
  configuration.ACCESS_TEAM_DOMAIN = 'key-limit.cloudflareaccess.com';
  let downloads = 0;
  const limitedFetcher = async () => { downloads++; return Response.json({ keys: [publicKey] }); };
  for (let index = 0; index < 4; index++) {
    const jwt = await token({ iss: 'https://key-limit.cloudflareaccess.com' }, { kid: `unknown-${index}` });
    const response = await handleRequest(await adminRequest('', jwt), configuration, { now, fetcher: limitedFetcher });
    assert.equal(response.status, 401);
  }
  assert.equal(downloads, 1);
});

test('public statistics are off by default and never disclose identifiers when enabled', async () => {
  const configuration = env();
  const request = new Request('https://stats.example.test/api/public/summary?range=7');
  const disabled = await handleRequest(request, configuration, { now });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.headers.get('Access-Control-Allow-Origin'), '*');
  const input = event();
  await handleRequest(collectionRequest(input), configuration, { now });
  configuration.PUBLIC_STATS_ENABLED = 'true';
  const response = await handleRequest(request, configuration, { now });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(input.eventId));
  assert.ok(!text.includes(input.sessionId));
  assert.ok(!text.includes(configuration.AUTH_ALLOWLIST_EMAILS));
  assert.ok(!text.includes('session_key'));
  assert.equal(JSON.parse(text).metrics.pageviews, 1);
});

test('Seoul midnight rotates session hashes and daily grouping', async () => {
  const configuration = env();
  const sessionId = crypto.randomUUID();
  const before = Date.parse('2026-11-01T14:59:00Z');
  const after = Date.parse('2026-11-01T15:00:00Z');
  await handleRequest(collectionRequest(event({ sessionId })), configuration, { now: before });
  await handleRequest(collectionRequest(event({ sessionId })), configuration, { now: after });
  assert.equal(dayInSeoul(before), '2026-11-01');
  assert.equal(dayInSeoul(after), '2026-11-02');
  const rows = configuration.DB.rows();
  assert.notEqual(rows[0].session_key, rows[1].session_key);
  const jwt = await token({ exp: after / 1000 + 3600 });
  const response = await handleRequest(await adminRequest('?range=7', jwt), configuration, { now: after, fetcher });
  const data = await response.json();
  assert.equal(data.metrics.sessions, 2);
  assert.deepEqual(data.daily.slice(-2).map(day => day.pageviews), [1, 1]);
});

test('retention excludes old events and bounded cleanup deletes them without changing provenance', async () => {
  const configuration = env();
  const oldTime = now - 31 * 86_400_000;
  await handleRequest(collectionRequest(event()), configuration, { now: oldTime });
  await handleRequest(collectionRequest(event()), configuration, { now });
  const data = await (await summary(configuration, now, '?range=30')).json();
  assert.equal(data.metrics.pageviews, 1);
  assert.equal(data.measurement.startedAt, new Date(oldTime).toISOString());
  await pruneExpired(configuration, now);
  assert.equal(configuration.DB.rows().length, 1);
});

test('invalid summary filters are rejected without SQL interpolation', async () => {
  const configuration = env();
  for (const query of ['?range=365', '?range=7&range=30', '?site=unknown', '?site=all%27%3BDROP%20TABLE%20analytics_events', '?range=7&email=private']) {
    assert.equal((await summary(configuration, now, query)).status, 400);
  }
  assert.equal(configuration.DB.rows().length, 0);
});

test('assets are authorized before dispatch and unmapped paths never bypass the worker', async () => {
  const configuration = env();
  const paths = [];
  configuration.ASSETS = { fetch: async request => { paths.push(new URL(request.url).pathname); return new Response('<html>operator</html>', { headers: { 'Content-Type': 'text/html' } }); } };
  const denied = await handleRequest(new Request('https://stats.example.test/admin/'), configuration, { now, fetcher });
  assert.equal(denied.status, 401);
  assert.equal(paths.length, 0);
  const page = await handleRequest(await adminRequest('', null, '/admin/'), configuration, { now, fetcher });
  assert.equal(page.status, 200);
  assert.deepEqual(paths, ['/admin/index.html']);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal((await handleRequest(new Request('https://stats.example.test/admin.js'), configuration, { now, fetcher })).status, 404);
  assert.equal((await handleRequest(await adminRequest('', null, '/admin/worker.mjs'), configuration, { now, fetcher })).status, 404);
});

test('admin API denies cross-origin reads even with a valid operator JWT', async () => {
  const configuration = env();
  const request = await adminRequest();
  request.headers.set('Origin', 'https://evil.example');
  assert.equal((await handleRequest(request, configuration, { now, fetcher })).status, 403);
});

test('health reports liveness without identifiers, secrets or records', async () => {
  const response = await handleRequest(new Request('https://stats.example.test/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'orvantro-insights', status: 'ok' });
});
