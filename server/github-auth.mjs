import { HttpError, readLimited } from './http.mjs';

const ENCODER = new TextEncoder();
const SESSION = '__Host-orvantro_session';
const FLOW = '__Host-orvantro_oauth';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_MS = 8 * 60 * 60 * 1000;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', ENCODER.encode(value)))); }
function cookie(request, name) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : '';
}
function setCookie(name, value, seconds) { return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`; }
function config(env, request) {
  let origin;
  try { origin = new URL(env.AUTH_ORIGIN); } catch { throw new HttpError(503, 'identity_not_configured'); }
  if (env.AUTH_PROVIDER !== 'github' || !env.DB || origin.protocol !== 'https:' || origin.origin !== env.AUTH_ORIGIN ||
      new URL(request.url).origin !== origin.origin || !/^[A-Za-z0-9._-]{5,100}$/.test(env.GITHUB_CLIENT_ID || '') ||
      typeof env.GITHUB_CLIENT_SECRET !== 'string' || env.GITHUB_CLIENT_SECRET.length < 20 ||
      !/^[1-9][0-9]{0,19}$/.test(env.AUTH_GITHUB_OWNER_ID || '')) throw new HttpError(503, 'identity_not_configured');
  return { origin: origin.origin, callback: `${origin.origin}/auth/callback` };
}
function sameOrigin(request, origin) {
  if (request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'same_origin_required');
}
function headers() {
  return new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
}
function redirect(location, cookies = []) {
  const result = headers(); result.set('Location', location);
  for (const value of cookies) result.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers: result });
}
function page(destination, logout = false) {
  const nonce = randomToken();
  const result = headers();
  result.set('Content-Type', 'text/html; charset=utf-8');
  // A no-referrer policy makes native form POSTs carry Origin: null in browsers
  // Keep same-origin form provenance while still withholding referrers externally
  result.set('Referrer-Policy', 'same-origin');
  result.set('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self' https://github.com/login/oauth/authorize; base-uri 'none'; frame-ancestors 'none'`);
  const title = logout ? '로그아웃' : destination === 'admin' ? '운영자 로그인' : '팀 작업공간 로그인';
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} · ORVANTRO</title><style nonce="${nonce}">:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#05070d;color:#e9f3fa;font:16px/1.7 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:520px;border:1px solid #24384a;padding:42px;background:#0b1422}small{letter-spacing:.16em;color:#4ec1f0}h1{font-size:32px;letter-spacing:-.05em}p{color:#9bb1c4;font-size:14px}button{width:100%;padding:14px;margin-top:20px;border:0;background:#4ec1f0;color:#07121b;font:inherit;font-weight:700;cursor:pointer}a{color:#9bb1c4;display:inline-block;margin-top:24px;font-size:13px}button:focus-visible,a:focus-visible{outline:2px solid white;outline-offset:5px}</style><main><small>ORVANTRO / ACCOUNT</small><h1>${title}</h1><p>${logout ? '이 브라우저의 ORVANTRO 로그인 세션을 종료합니다' : '운영자 또는 초대된 팀 멤버만 접근할 수 있습니다<br>GitHub의 확인된 기본 이메일로 초대를 확인합니다'}</p><form method="post" action="/auth/${logout ? 'logout' : 'login'}"><input type="hidden" name="next" value="${destination}"><button type="submit">${logout ? '로그아웃' : 'GitHub로 계속하기'}</button></form><a href="https://orvantro.com/">ORVANTRO 홈으로 ↗</a></main></html>`, { headers: result });
}
async function dbRows(env, sql, values = []) {
  const [result] = await env.DB.batch([env.DB.prepare(sql).bind(...values)]);
  if (!result?.success || !Array.isArray(result.results)) throw new HttpError(503, 'storage_unavailable');
  return result.results;
}
async function githubJson(fetcher, url, options, stage) {
  let response;
  // Workers supports manual/follow only; reject all non-2xx responses without following redirects
  try { response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(8000) }); }
  catch { throw new HttpError(503, `github_${stage}_connection_failed`); }
  if (!response.ok) throw new HttpError(503, `github_${stage}_http_${response.status}`);
  try { return JSON.parse(await readLimited(response, 65_536)); }
  catch { throw new HttpError(503, `github_${stage}_invalid_response`); }
}
export async function verifyGithubSession(request, env, now = Date.now()) {
  config(env, request);
  const token = cookie(request, SESSION);
  if (!TOKEN.test(token)) throw new HttpError(401, 'unauthorized');
  const [row] = await dbRows(env, 'SELECT subject, email FROM auth_sessions WHERE token_hash = ?1 AND expires_at > ?2', [await digest(token), now]);
  if (!row) throw new HttpError(401, 'unauthorized');
  return { subject: row.subject, email: row.email };
}
export async function handleGithubAuth(request, env, { now = Date.now(), fetcher = fetch } = {}) {
  const settings = config(env, request);
  const url = new URL(request.url);
  const next = url.searchParams.get('next') === 'workspace' ? 'workspace' : 'admin';
  if (url.pathname === '/auth/login') {
    if (request.method === 'GET') return page(next);
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    sameOrigin(request, settings.origin);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'form_required');
    const form = new URLSearchParams(await readLimited(request, 256));
    const destination = form.get('next') === 'workspace' ? 'workspace' : 'admin';
    const state = randomToken(), verifier = randomToken();
    const created = await dbRows(env, `INSERT INTO auth_flows(state_hash, verifier, destination, expires_at)
      SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM auth_flows WHERE expires_at > ?5) < 100
      RETURNING state_hash`, [await digest(state), verifier, destination, now + 600_000, now]);
    if (!created.length) throw new HttpError(429, 'login_busy');
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: settings.callback,
      scope: 'user:email', state, code_challenge: await digest(verifier), code_challenge_method: 'S256' }).toString();
    return redirect(authorize.href, [setCookie(FLOW, state, 600)]);
  }
  if (url.pathname === '/auth/callback') {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const state = url.searchParams.get('state');
    if (!TOKEN.test(state || '') || cookie(request, FLOW) !== state || url.searchParams.getAll('state').length !== 1) throw new HttpError(401, 'invalid_login_state');
    // Delete-and-return atomically consumes state before any provider request, preventing callback replay.
    const [flow] = await dbRows(env, 'DELETE FROM auth_flows WHERE state_hash = ?1 AND expires_at > ?2 RETURNING verifier, destination', [await digest(state), now]);
    if (!flow) throw new HttpError(401, 'login_expired');
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !/^[A-Za-z0-9_-]{8,256}$/.test(code || '') || url.searchParams.getAll('code').length !== 1) throw new HttpError(401, 'login_cancelled');
    const tokenData = await githubJson(fetcher, 'https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ORVANTRO-Login' },
      body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
        code, redirect_uri: settings.callback, code_verifier: flow.verifier }).toString(),
    }, 'token');
    if (typeof tokenData.access_token !== 'string' || tokenData.access_token.length > 1024 ||
        /[\r\n]/.test(tokenData.access_token) || String(tokenData.token_type).toLowerCase() !== 'bearer') throw new HttpError(401, 'login_failed');
    const providerHeaders = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'ORVANTRO-Login', 'X-GitHub-Api-Version': '2022-11-28' };
    const user = await githubJson(fetcher, 'https://api.github.com/user', { headers: providerHeaders }, 'profile');
    const emails = await githubJson(fetcher, 'https://api.github.com/user/emails?per_page=100', { headers: providerHeaders }, 'email');
    const email = Array.isArray(emails) && emails.find(item => item?.primary === true && item.verified === true && typeof item.email === 'string')?.email.toLowerCase();
    if (!Number.isSafeInteger(user.id) || user.id < 1 || !email || email.length > 254 || !EMAIL.test(email)) throw new HttpError(403, 'verified_email_required');
    const subject = `github:${user.id}`;
    const owner = String(user.id) === env.AUTH_GITHUB_OWNER_ID;
    if (!owner) {
      if (flow.destination === 'admin') throw new HttpError(403, 'operator_not_allowed');
      const invited = await dbRows(env, 'SELECT id FROM workspace_members WHERE subject = ?1 OR (subject IS NULL AND email = ?2) LIMIT 1', [subject, email]);
      if (!invited.length) throw new HttpError(403, 'invitation_required');
    }
    // Provider tokens are used only for identity verification, never stored or returned to the browser.
    const session = randomToken();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_sessions WHERE subject = ?1 AND token_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE subject = ?1 ORDER BY created_at DESC LIMIT 9)').bind(subject),
      env.DB.prepare('INSERT INTO auth_sessions(token_hash, subject, email, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(await digest(session), subject, email, now + SESSION_MS, now),
    ]);
    return redirect(`/${flow.destination}/`, [setCookie(SESSION, session, SESSION_MS / 1000), setCookie(FLOW, '', 0)]);
  }
  if (url.pathname === '/auth/logout') {
    if (request.method === 'GET') return page(next, true);
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    sameOrigin(request, settings.origin);
    const session = cookie(request, SESSION);
    if (TOKEN.test(session)) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?1').bind(await digest(session)).run();
    return redirect('/auth/login', [setCookie(SESSION, '', 0), setCookie(FLOW, '', 0)]);
  }
  throw new HttpError(404, 'not_found');
}

export async function pruneAuth(env, now) {
  if (env.AUTH_PROVIDER !== 'github') return;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_flows WHERE state_hash IN (SELECT state_hash FROM auth_flows WHERE expires_at <= ?1 LIMIT 1000)').bind(now),
    env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at <= ?1 LIMIT 1000)').bind(now),
  ]);
}
