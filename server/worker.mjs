import { HttpError, json, readLimited } from './http.mjs';
import { authorize } from './auth.mjs';
import { handlePremium } from './premium.mjs';
import { handleGithubAuth, pruneAuth } from './github-auth.mjs';
import { audienceOf, DEVICES, DIMENSIONS } from './audience.mjs';
import { handleIntegrations, integrationCron } from './integrations.mjs';
export { authorize, verifyIdentity } from './auth.mjs';

const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const KST_OFFSET = 9 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENCODER = new TextEncoder();
export const SITES = Object.freeze({
  orvantro: Object.freeze({ origin: 'https://orvantro.com', path: '/' }),
  'marginkit-pro-beta': Object.freeze({ origin: 'https://judanvy8-netizen.github.io', path: '/marginkit-pro-beta/' }),
  'orvantro-insights': Object.freeze({ origin: 'https://judanvy8-netizen.github.io', path: '/orvantro-insights/' }),
});
const ORIGINS = new Set(Object.values(SITES).map(site => site.origin));

function cors(origin) {
  return ORIGINS.has(origin) ? {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  } : {};
}

function originOf(request) { return request.headers.get('Origin') || ''; }
export function dayInSeoul(now) { return new Date(now + KST_OFFSET).toISOString().slice(0, 10); }
function isoOrNull(value) { return Number.isFinite(value) ? new Date(value).toISOString() : null; }

function collectorConfig(env) {
  if (!env.DB || typeof env.ANALYTICS_HASH_SECRET !== 'string' || env.ANALYTICS_HASH_SECRET.length < 32) {
    throw new HttpError(503, 'collection_not_configured');
  }
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, ENCODER.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateEvent(value, origin) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_event');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'eventId,sessionId,site,v' || ![1, 2].includes(value.v) ||
      !Object.hasOwn(SITES, value.site) || !UUID.test(value.eventId) || !UUID.test(value.sessionId)) {
    throw new HttpError(400, 'invalid_event');
  }
  if (SITES[value.site].origin !== origin) throw new HttpError(403, 'site_origin_mismatch');
  return { v: value.v, site: value.site, eventId: value.eventId.toLowerCase(), sessionId: value.sessionId.toLowerCase() };
}

async function collect(request, env, now) {
  const origin = originOf(request);
  if (!ORIGINS.has(origin)) throw new HttpError(403, 'origin_not_allowed');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  if (request.headers.get('Sec-GPC') === '1' || request.headers.get('DNT') === '1') {
    return json({ accepted: false, reason: 'privacy_preference' }, 202, cors(origin));
  }
  collectorConfig(env);
  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!['application/json', 'text/plain'].includes(contentType)) throw new HttpError(415, 'unsupported_content_type');
  let value;
  try { value = JSON.parse(await readLimited(request)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json'); }
  const event = validateEvent(value, origin);
  const day = dayInSeoul(now);
  const received = Math.floor(now / 60_000) * 60_000;
  // v1 consent did not cover coarse audience dimensions
  const audience = event.v === 2 ? audienceOf(request) : { country: null, device: null, platform: null, browser: null };
  const [eventKey, sessionKey] = await Promise.all([
    hmac(env.ANALYTICS_HASH_SECRET, `event|${event.site}|${event.eventId}`),
    hmac(env.ANALYTICS_HASH_SECRET, `session|${day}|${event.site}|${event.sessionId}`),
  ]);
  const result = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO analytics_events(event_key, session_key, site, day, received_at, country, device, platform, browser) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(eventKey, sessionKey, event.site, day, received, ...DIMENSIONS.map(key => audience[key])),
    env.DB.prepare(`INSERT INTO analytics_collection(site, first_received_at, last_received_at) VALUES (?1, ?2, ?2)
      ON CONFLICT(site) DO UPDATE SET
      first_received_at = MIN(first_received_at, excluded.first_received_at),
      last_received_at = MAX(last_received_at, excluded.last_received_at)
      WHERE (SELECT received_at FROM analytics_events WHERE event_key = ?3) = ?2`)
      .bind(event.site, received, eventKey),
  ]);
  if (result.some(item => item.success === false)) throw new HttpError(503, 'storage_unavailable');
  return json({ accepted: true, duplicate: Number(result[0].meta?.changes) === 0 }, 202, cors(origin));
}

function summaryRange(url, now) {
  const raw = url.searchParams.get('range') || '14';
  if (!['7', '14', '30'].includes(raw)) throw new HttpError(400, 'invalid_range');
  const site = url.searchParams.get('site') || 'all';
  if (site !== 'all' && !Object.hasOwn(SITES, site)) throw new HttpError(400, 'invalid_site');
  const country = url.searchParams.get('country') || 'all', device = url.searchParams.get('device') || 'all';
  if (!['all', 'unknown', 'uncollected'].includes(country) && !/^[A-Z]{2}$/.test(country)) throw new HttpError(400, 'invalid_country');
  if (!['all', ...DEVICES].includes(device)) throw new HttpError(400, 'invalid_device');
  if ([...url.searchParams.keys()].some(key => !['range', 'site', 'country', 'device'].includes(key)) ||
      ['range', 'site', 'country', 'device'].some(key => url.searchParams.getAll(key).length > 1)) {
    throw new HttpError(400, 'invalid_query');
  }
  const days = Number(raw);
  return { days, from: dayInSeoul(now - (days - 1) * DAY_MS), to: dayInSeoul(now), site, country, device };
}

async function summary(url, env, now) {
  if (!env.DB) throw new HttpError(503, 'storage_not_configured');
  const range = summaryRange(url, now);
  const clause = "day >= ?1 AND day <= ?2 AND (?3 = 'all' OR site = ?3) AND (?4 = 'all' OR COALESCE(country, 'uncollected') = ?4) AND (?5 = 'all' OR COALESCE(device, 'uncollected') = ?5)";
  const values = [range.from, range.to, range.site, range.country, range.device];
  const statements = [
    env.DB.prepare(`SELECT COUNT(*) AS pageviews, COUNT(DISTINCT session_key) AS sessions, COUNT(DISTINCT day) AS activeDays FROM analytics_events WHERE ${clause}`).bind(...values),
    env.DB.prepare(`SELECT day AS date, COUNT(*) AS pageviews, COUNT(DISTINCT session_key) AS sessions FROM analytics_events WHERE ${clause} GROUP BY day ORDER BY day`).bind(...values),
    env.DB.prepare(`SELECT site, COUNT(*) AS pageviews, COUNT(DISTINCT session_key) AS sessions FROM analytics_events WHERE ${clause} GROUP BY site ORDER BY site`).bind(...values),
    env.DB.prepare('SELECT MIN(first_received_at) AS startedAt, MAX(last_received_at) AS lastReceivedAt FROM analytics_collection WHERE (?1 = \'all\' OR site = ?1)').bind(range.site),
  ];
  for (const dimension of DIMENSIONS) statements.push(env.DB.prepare(`SELECT COALESCE(${dimension}, 'uncollected') AS value, COUNT(*) AS pageviews, COUNT(DISTINCT session_key) AS sessions FROM analytics_events WHERE ${clause} GROUP BY ${dimension} ORDER BY pageviews DESC, value LIMIT 256`).bind(...values));
  const results = await env.DB.batch(statements);
  if (results.length !== statements.length || results.some(item => item.success === false || !Array.isArray(item.results))) {
    throw new HttpError(503, 'storage_unavailable');
  }
  const totals = results[0].results[0];
  const provenance = results[3].results[0];
  const byDay = new Map(results[1].results.map(row => [row.date, row]));
  const bySite = new Map(results[2].results.map(row => [row.site, row]));
  const daily = Array.from({ length: range.days }, (_, index) => {
    const date = dayInSeoul(now - (range.days - 1 - index) * DAY_MS);
    const row = byDay.get(date);
    return { date, pageviews: Number(row?.pageviews || 0), sessions: Number(row?.sessions || 0) };
  });
  return {
    source: 'central', status: Number(totals.pageviews) ? 'ok' : 'empty', generatedAt: new Date(now).toISOString(),
    timeZone: 'Asia/Seoul', range: { days: range.days, from: range.from, to: range.to },
    measurement: {
      startedAt: isoOrNull(provenance?.startedAt), lastReceivedAt: isoOrNull(provenance?.lastReceivedAt),
      retentionDays: RETENTION_DAYS, sessionDefinition: 'site_day_tab_session',
    },
    metrics: { pageviews: Number(totals.pageviews), sessions: Number(totals.sessions), activeDays: Number(totals.activeDays) },
    daily,
    filters: { site: range.site, country: range.country, device: range.device },
    breakdowns: Object.fromEntries(DIMENSIONS.map((dimension, index) => [dimension, results[4 + index].results.map(row => ({ value: row.value, pageviews: Number(row.pageviews), sessions: Number(row.sessions) }))])),
    bySite: Object.entries(SITES).filter(([site]) => range.site === 'all' || site === range.site).map(([site, config]) => ({
      site, path: config.path, pageviews: Number(bySite.get(site)?.pageviews || 0), sessions: Number(bySite.get(site)?.sessions || 0),
    })),
  };
}

function sameOrigin(request) {
  const origin = originOf(request);
  return !origin || origin === new URL(request.url).origin;
}

async function adminAsset(request, env) {
  if (!env.ASSETS?.fetch) throw new HttpError(503, 'dashboard_not_configured');
  const url = new URL(request.url);
  const paths = new Map([['/admin', '/admin/index.html'], ['/admin/', '/admin/index.html'], ['/admin/admin.js', '/admin/admin.js'], ['/admin/admin.css', '/admin/admin.css']]);
  if (!paths.has(url.pathname)) throw new HttpError(404, 'not_found');
  url.pathname = paths.get(url.pathname);
  url.search = '';
  const response = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, headers });
}

export async function handleRequest(request, env, options = {}) {
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher || fetch;
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith('/api/automation/') || ['/api/admin/integrations','/api/admin/integrations/sync','/api/admin/report','/api/admin/report/settings'].includes(url.pathname)) {
      return await handleIntegrations(request, env, { now, fetcher });
    }
    if (url.pathname.startsWith('/auth/')) {
      if (env.AUTH_PROVIDER !== 'github') {
        if (url.pathname === '/auth/logout') return new Response(null, { status: 303, headers: { Location: '/cdn-cgi/access/logout', 'Cache-Control': 'no-store' } });
        throw new HttpError(404, 'not_found');
      }
      return await handleGithubAuth(request, env, { now, fetcher });
    }
    if (url.pathname === '/api/workspaces' || url.pathname.startsWith('/api/workspaces/') || url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) {
      return await handlePremium(request, env, { now, fetcher });
    }
    if (url.pathname === '/collect') return await collect(request, env, now);
    if (url.pathname === '/health' && ['GET', 'HEAD'].includes(request.method)) {
      return json({ service: 'orvantro-insights', status: 'ok' });
    }
    if (url.pathname === '/api/public/summary') {
      if (env.PUBLIC_STATS_ENABLED !== 'true') throw new HttpError(404, 'not_found');
      if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return json(await summary(url, env, now), 200, { 'Access-Control-Allow-Origin': '*' });
    }
    if (url.pathname === '/api/admin/summary' || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
      if (!sameOrigin(request)) throw new HttpError(403, 'cross_origin_admin_denied');
      await authorize(request, env, now, fetcher);
      if (url.pathname === '/api/admin/summary') return json(await summary(url, env, now));
      if (url.pathname === '/admin') return new Response(null, { status: 308, headers: { Location: '/admin/', 'Cache-Control': 'no-store' } });
      return await adminAsset(request, env);
    }
    throw new HttpError(404, 'not_found');
  } catch (error) {
    const expected = error instanceof HttpError;
    if (env.AUTH_PROVIDER === 'github' && expected && error.status === 401 && request.method === 'GET' &&
        ['/admin', '/admin/', '/workspace', '/workspace/'].includes(url.pathname)) {
      return new Response(null, { status: 303, headers: { Location: `/auth/login?next=${url.pathname.startsWith('/workspace') ? 'workspace' : 'admin'}`, 'Cache-Control': 'no-store' } });
    }
    // Never log requests, payloads, JWTs, identifiers or provider error text.
    return json({ error: expected ? error.code : 'storage_unavailable' }, expected ? error.status : 503,
      url.pathname === '/collect' ? cors(originOf(request)) : url.pathname === '/api/public/summary' ? { 'Access-Control-Allow-Origin': '*' } : {});
  }
}

export async function pruneExpired(env, now = Date.now()) {
  if (!env.DB) return;
  const oldest = dayInSeoul(now - (RETENTION_DAYS - 1) * DAY_MS);
  // Bounded hourly work; queries already exclude expired rows if cleanup is delayed.
  await env.DB.prepare(`DELETE FROM analytics_events WHERE event_key IN
    (SELECT event_key FROM analytics_events WHERE day < ?1 ORDER BY day LIMIT 5000)`).bind(oldest).run();
  await pruneAuth(env, now);
}

export default {
  fetch(request, env) { return handleRequest(request, env); },
  scheduled(controller, env, ctx) { ctx.waitUntil(Promise.all([pruneExpired(env, controller.scheduledTime), integrationCron(env, controller.scheduledTime)])); },
};
