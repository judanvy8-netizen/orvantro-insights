import { HttpError, json, readLimited } from './http.mjs';
import { verifyIdentity } from './auth.mjs';

export const LIMITS = Object.freeze({ workspacesPerCreator: 5, membersPerWorkspace: 50, membershipsPerEmail: 50, scenariosPerWorkspace: 100 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = ['owner', 'editor', 'viewer'];
const SIM_KEYS = ['sell', 'cost', 'ship', 'ad', 'fixed', 'feePct', 'units', 'targetPct', 'reservePct', 'reserveEnabled', 'platform'];
const MEMBER_COLUMNS = 'id, email, role, subject, version, created_at, updated_at';
const WORKSPACE_COLUMNS = 'id, name, version, created_at, updated_at';
const SCENARIO_COLUMNS = 'id, name, simulator_json, version, created_at, updated_at';
const IDENTITY_CLAUSE = 'workspace_id = ?1 AND subject = ?2 AND email = ?3';

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new HttpError(400, 'invalid_payload');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'invalid_name');
  return value.trim();
}
function email(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value)) throw new HttpError(400, 'invalid_email');
  return value.toLowerCase();
}
function role(value) {
  if (!ROLES.includes(value)) throw new HttpError(400, 'invalid_role');
  return value;
}
export function validateSimulator(value) {
  exactObject(value, SIM_KEYS);
  if (typeof value.reserveEnabled !== 'boolean' || !['3.3', '5.8', '10.8', '15', 'custom'].includes(value.platform)) throw new HttpError(400, 'invalid_simulator');
  const output = {};
  for (const key of SIM_KEYS.filter(key => !['reserveEnabled', 'platform'].includes(key))) {
    const raw = value[key];
    if (typeof raw !== 'string' || !/^(0|[1-9]\d{0,12})(\.\d{1,6})?$/.test(raw)) throw new HttpError(400, 'invalid_simulator');
    // Bounds use scaled integers so values close to the limit cannot round down
    const [whole, fraction = ''] = raw.split('.');
    const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
    const max = key.endsWith('Pct') ? 100n : key === 'units' ? 1_000_000_000n : 1_000_000_000_000n;
    if (scaled > max * 1_000_000n) throw new HttpError(400, 'invalid_simulator');
    output[key] = raw;
  }
  output.reserveEnabled = value.reserveEnabled;
  output.platform = value.platform;
  return output;
}
function scenarioPayload(value) {
  exactObject(value, ['name', 'simulator']);
  return { name: name(value.name), simulator: validateSimulator(value.simulator) };
}
function version(request) {
  const raw = request.headers.get('If-Match');
  if (!raw) throw new HttpError(428, 'precondition_required');
  if (!/^"[1-9]\d{0,12}"$/.test(raw)) throw new HttpError(400, 'invalid_if_match');
  return Number(raw.slice(1, -1));
}
const iso = value => new Date(value).toISOString();
const workspaceRecord = (row, currentRole) => ({ id: row.id, name: row.name, role: currentRole ?? row.role, version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const memberRecord = row => ({ id: row.id, email: row.email, role: row.role, version: row.version, status: row.subject ? 'active' : 'pending', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const scenarioRecord = row => ({ id: row.id, name: row.name, simulator: JSON.parse(row.simulator_json), version: row.version, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
function entity(value, key, status = 200) { return json({ [key]: value }, status, { ETag: `"${value.version}"` }); }

async function batch(db, statements) {
  let results;
  try { results = await db.batch(statements); }
  catch (error) {
    // SQLite trigger error is mapped without disclosing general database error text
    if (String(error?.message || '').includes('last_owner_required')) throw new HttpError(409, 'last_owner_required');
    throw new HttpError(503, 'storage_unavailable');
  }
  if (results.length !== statements.length || results.some(result => result.success === false || !Array.isArray(result.results))) throw new HttpError(503, 'storage_unavailable');
  return results.map(result => result.results);
}
async function rows(db, sql, values = []) { return (await batch(db, [db.prepare(sql).bind(...values)]))[0]; }
const identityValues = (workspaceId, identity) => [workspaceId, identity.subject, identity.email];
const permissionClause = required => `EXISTS (SELECT 1 FROM workspace_members WHERE ${IDENTITY_CLAUSE}${required === 'owner' ? " AND role = 'owner'" : required === 'write' ? " AND role IN ('owner', 'editor')" : ''})`;

async function claimInvitations(db, identity, now) {
  // A verified email can claim a pending invitation once, then both subject and email must match
  await rows(db, 'UPDATE workspace_members SET subject = ?1, version = version + 1, updated_at = ?2 WHERE email = ?3 AND subject IS NULL', [identity.subject, now, identity.email]);
}
async function access(db, workspaceId, identity, required = 'read') {
  const [membership] = await rows(db, `SELECT role FROM workspace_members WHERE ${IDENTITY_CLAUSE}`, identityValues(workspaceId, identity));
  if (!membership) throw new HttpError(404, 'workspace_not_found');
  if (required === 'owner' && membership.role !== 'owner' || required === 'write' && membership.role === 'viewer') throw new HttpError(403, 'role_not_allowed');
  return membership.role;
}
async function detail(db, workspaceId, identity) {
  const values = identityValues(workspaceId, identity);
  const permission = permissionClause('read');
  const [workspaces, members, scenarios] = await batch(db, [
    db.prepare(`SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE w.id = ?1 AND m.subject = ?2 AND m.email = ?3`).bind(...values),
    db.prepare(`SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE workspace_id = ?1 AND ${permission} ORDER BY created_at, id LIMIT 50`).bind(...values),
    db.prepare(`SELECT ${SCENARIO_COLUMNS} FROM workspace_scenarios WHERE workspace_id = ?1 AND ${permission} ORDER BY updated_at DESC, id LIMIT 100`).bind(...values),
  ]);
  if (!workspaces[0]) throw new HttpError(404, 'workspace_not_found');
  return { workspace: workspaceRecord(workspaces[0]), members: members.map(memberRecord), scenarios: scenarios.map(scenarioRecord) };
}

async function workspaceList(request, env, identity, now, payload) {
  const db = env.DB;
  if (request.method === 'GET') {
    const records = await rows(db, `SELECT w.*, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.subject = ?1 AND m.email = ?2 ORDER BY w.updated_at DESC, w.id LIMIT 50`, [identity.subject, identity.email]);
    return json({ identity, workspaces: records.map(row => workspaceRecord(row)), limits: LIMITS });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  exactObject(payload, ['name']);
  const id = crypto.randomUUID();
  const [created] = await batch(db, [
    db.prepare(`INSERT INTO workspaces(id, name, created_by, version, created_at, updated_at)
      SELECT ?1, ?2, ?3, 1, ?4, ?4 WHERE (SELECT COUNT(*) FROM workspaces WHERE created_by = ?3) < 5
      AND (SELECT COUNT(*) FROM workspace_members WHERE email = ?5) < 50 RETURNING ${WORKSPACE_COLUMNS}`)
      .bind(id, name(payload.name), identity.subject, now, identity.email),
    db.prepare(`INSERT INTO workspace_members(id, workspace_id, email, subject, role, version, created_at, updated_at)
      SELECT ?1, id, ?2, ?3, 'owner', 1, ?4, ?4 FROM workspaces WHERE id = ?5`)
      .bind(crypto.randomUUID(), identity.email, identity.subject, now, id),
  ]);
  if (!created[0]) throw new HttpError(409, 'workspace_limit');
  return entity(workspaceRecord(created[0], 'owner'), 'workspace', 201);
}

async function workspaceItem(request, env, identity, now, workspaceId, payload) {
  const db = env.DB;
  if (request.method === 'GET') {
    const data = await detail(db, workspaceId, identity);
    return json(data, 200, { ETag: `"${data.workspace.version}"` });
  }
  if (!['PUT', 'DELETE'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
  await access(db, workspaceId, identity, 'owner');
  const expected = version(request);
  exactObject(payload, request.method === 'PUT' ? ['name'] : []);
  const values = [...identityValues(workspaceId, identity), expected];
  const permission = permissionClause('owner');
  const result = request.method === 'PUT'
    ? await rows(db, `UPDATE workspaces SET name = ?5, version = version + 1, updated_at = ?6 WHERE id = ?1 AND version = ?4 AND ${permission} RETURNING ${WORKSPACE_COLUMNS}`, [...values, name(payload.name), now])
    : await rows(db, `DELETE FROM workspaces WHERE id = ?1 AND version = ?4 AND ${permission} RETURNING id`, values);
  if (!result[0]) throw new HttpError(412, 'precondition_failed');
  return request.method === 'PUT' ? entity(workspaceRecord(result[0], 'owner'), 'workspace') : json({ deleted: true });
}

async function members(request, env, identity, now, workspaceId, memberId, payload) {
  const db = env.DB;
  if (request.method === 'GET' && !memberId) return json({ members: (await detail(db, workspaceId, identity)).members });
  if (!memberId && request.method !== 'POST' || memberId && !['PUT', 'DELETE'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
  await access(db, workspaceId, identity, 'owner');
  const permission = permissionClause('owner');
  const values = identityValues(workspaceId, identity);
  if (!memberId) {
    exactObject(payload, ['email', 'role']);
    const result = await rows(db, `INSERT OR IGNORE INTO workspace_members(id, workspace_id, email, subject, role, version, created_at, updated_at)
      SELECT ?4, ?1, ?5, NULL, ?6, 1, ?7, ?7 WHERE ${permission}
      AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ?1) < 50
      AND (SELECT COUNT(*) FROM workspace_members WHERE email = ?5) < 50 RETURNING ${MEMBER_COLUMNS}`,
      [...values, crypto.randomUUID(), email(payload.email), role(payload.role), now]);
    if (!result[0]) throw new HttpError(409, 'member_exists_or_limit');
    return entity(memberRecord(result[0]), 'member', 201);
  }
  const expected = version(request);
  exactObject(payload, request.method === 'PUT' ? ['role'] : []);
  const [existing] = await rows(db, 'SELECT id FROM workspace_members WHERE workspace_id = ?1 AND id = ?2', [workspaceId, memberId]);
  if (!existing) throw new HttpError(404, 'record_not_found');
  const result = request.method === 'PUT'
    ? await rows(db, `UPDATE workspace_members SET role = ?6, version = version + 1, updated_at = ?7
      WHERE workspace_id = ?1 AND id = ?4 AND version = ?5 AND ${permission} RETURNING ${MEMBER_COLUMNS}`, [...values, memberId, expected, role(payload.role), now])
    : await rows(db, `DELETE FROM workspace_members WHERE workspace_id = ?1 AND id = ?4 AND version = ?5 AND ${permission} RETURNING id`, [...values, memberId, expected]);
  if (!result[0]) throw new HttpError(412, 'precondition_failed');
  return request.method === 'PUT' ? entity(memberRecord(result[0]), 'member') : json({ deleted: true });
}

async function scenarios(request, env, identity, now, workspaceId, scenarioId, payload) {
  const db = env.DB;
  if (request.method === 'GET') {
    await access(db, workspaceId, identity);
    const values = identityValues(workspaceId, identity);
    if (scenarioId) values.push(scenarioId);
    const records = await rows(db, `SELECT ${SCENARIO_COLUMNS} FROM workspace_scenarios WHERE workspace_id = ?1 AND ${permissionClause('read')}
      ${scenarioId ? 'AND id = ?4' : ''} ORDER BY updated_at DESC, id LIMIT 100`, values);
    if (scenarioId && !records[0]) throw new HttpError(404, 'record_not_found');
    return scenarioId ? entity(scenarioRecord(records[0]), 'scenario') : json({ scenarios: records.map(scenarioRecord) });
  }
  if (!scenarioId && request.method !== 'POST' || scenarioId && !['PUT', 'DELETE'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
  await access(db, workspaceId, identity, 'write');
  const permission = permissionClause('write');
  const values = identityValues(workspaceId, identity);
  if (!scenarioId) {
    const input = scenarioPayload(payload);
    const result = await rows(db, `INSERT INTO workspace_scenarios(id, workspace_id, name, simulator_json, version, created_at, updated_at)
      SELECT ?4, ?1, ?5, ?6, 1, ?7, ?7 WHERE ${permission}
      AND (SELECT COUNT(*) FROM workspace_scenarios WHERE workspace_id = ?1) < 100 RETURNING ${SCENARIO_COLUMNS}`,
      [...values, crypto.randomUUID(), input.name, JSON.stringify(input.simulator), now]);
    if (!result[0]) throw new HttpError(409, 'scenario_limit');
    return entity(scenarioRecord(result[0]), 'scenario', 201);
  }
  const expected = version(request);
  exactObject(payload, request.method === 'PUT' ? ['name', 'simulator'] : []);
  const [existing] = await rows(db, 'SELECT id FROM workspace_scenarios WHERE workspace_id = ?1 AND id = ?2', [workspaceId, scenarioId]);
  if (!existing) throw new HttpError(404, 'record_not_found');
  let result;
  if (request.method === 'PUT') {
    const input = scenarioPayload(payload);
    result = await rows(db, `UPDATE workspace_scenarios SET name = ?6, simulator_json = ?7, version = version + 1, updated_at = ?8
      WHERE workspace_id = ?1 AND id = ?4 AND version = ?5 AND ${permission} RETURNING ${SCENARIO_COLUMNS}`,
      [...values, scenarioId, expected, input.name, JSON.stringify(input.simulator), now]);
  } else {
    result = await rows(db, `DELETE FROM workspace_scenarios WHERE workspace_id = ?1 AND id = ?4 AND version = ?5 AND ${permission} RETURNING id`, [...values, scenarioId, expected]);
  }
  if (!result[0]) throw new HttpError(412, 'precondition_failed');
  return request.method === 'PUT' ? entity(scenarioRecord(result[0]), 'scenario') : json({ deleted: true });
}

async function asset(request, env) {
  if (!env.ASSETS?.fetch) throw new HttpError(503, 'workspace_ui_not_configured');
  const url = new URL(request.url);
  const paths = new Map([['/workspace/', '/workspace/index.html'], ['/workspace/workspace.js', '/workspace/workspace.js'], ['/workspace/workspace.css', '/workspace/workspace.css']]);
  if (url.pathname === '/workspace') return new Response(null, { status: 308, headers: { Location: '/workspace/', 'Cache-Control': 'no-store' } });
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

export async function handlePremium(request, env, { now = Date.now(), fetcher = fetch } = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'cross_origin_workspace_denied');
  const identity = await verifyIdentity(request, env, now, fetcher, 'PREMIUM_ACCESS_AUD');
  if (!env.DB) throw new HttpError(503, 'workspace_not_configured');
  if (url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
    return asset(request, env);
  }
  if (url.search) throw new HttpError(400, 'invalid_query');
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
  let payload;
  if (request.method !== 'GET') {
    if (origin !== url.origin) throw new HttpError(403, 'same_origin_required');
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'same_origin_required');
    if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'json_required');
    try { payload = JSON.parse(await readLimited(request, 8192)); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'invalid_json'); }
  }
  const parts = url.pathname.split('/').slice(3);
  if (parts.length > 3 || parts.some((part, index) => index === 1 ? !['members', 'scenarios'].includes(part) : !UUID.test(part))) throw new HttpError(404, 'not_found');
  await claimInvitations(env.DB, identity, now);
  if (!parts.length) return workspaceList(request, env, identity, now, payload);
  const [workspaceId, resource, recordId] = parts.map(value => value.toLowerCase());
  if (!resource) return workspaceItem(request, env, identity, now, workspaceId, payload);
  return resource === 'members'
    ? members(request, env, identity, now, workspaceId, recordId, payload)
    : scenarios(request, env, identity, now, workspaceId, recordId, payload);
}
