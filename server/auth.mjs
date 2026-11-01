import { HttpError, readLimited } from './http.mjs';
import { verifyGithubSession } from './github-auth.mjs';
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });
const jwksCache = new Map();
const jwksRequests = new Map();

function authConfig(env, audienceKey) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env[audienceKey];
  if (typeof team !== 'string' || !/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(team) ||
      typeof audience !== 'string' || !audience || audience.length > 256 ||
      (audienceKey === 'PREMIUM_ACCESS_AUD' && audience === env.ACCESS_AUD)) {
    throw new HttpError(503, audienceKey === 'PREMIUM_ACCESS_AUD' ? 'workspace_not_configured' : 'admin_not_configured');
  }
  return { issuer: `https://${team}`, audience };
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(401, 'unauthorized');
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch { throw new HttpError(401, 'unauthorized'); }
}

function decodePart(value) {
  try { return JSON.parse(DECODER.decode(decodeBase64Url(value))); }
  catch { throw new HttpError(401, 'unauthorized'); }
}

async function loadJwks(issuer, fetcher, now, force = false) {
  const cached = jwksCache.get(issuer);
  if (!force && cached && cached.expires > now) return cached.keys;
  // Unknown-key tokens cannot force an outbound fetch on every anonymous request.
  if (force && cached && cached.fetchedAt > now - 30_000) return cached.keys;
  if (jwksRequests.has(issuer)) return jwksRequests.get(issuer);
  const pending = fetchJwks(issuer, fetcher, now);
  jwksRequests.set(issuer, pending);
  try { return await pending; } finally { jwksRequests.delete(issuer); }
}

async function fetchJwks(issuer, fetcher, now) {
  let response;
  try {
    response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' },
    });
  } catch { throw new HttpError(503, 'identity_provider_unavailable'); }
  if (!response.ok) throw new HttpError(503, 'identity_provider_unavailable');
  let document;
  try { document = JSON.parse(await readLimited(response, 65_536)); }
  catch { throw new HttpError(503, 'identity_provider_unavailable'); }
  if (!Array.isArray(document.keys) || document.keys.length > 32) throw new HttpError(503, 'identity_provider_unavailable');
  const keys = document.keys.filter(key => key && key.kty === 'RSA' &&
    typeof key.kid === 'string' && key.kid.length <= 256 &&
    typeof key.n === 'string' && typeof key.e === 'string' &&
    (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig') &&
    (!key.key_ops || key.key_ops.includes('verify')));
  if (!keys.length) throw new HttpError(503, 'identity_provider_unavailable');
  // This cache is bounded to the single configured Access tenant in normal operation.
  if (jwksCache.size >= 4 && !jwksCache.has(issuer)) jwksCache.delete(jwksCache.keys().next().value);
  jwksCache.set(issuer, { keys, expires: now + 5 * 60_000, fetchedAt: now });
  return keys;
}

export async function verifyIdentity(request, env, now = Date.now(), fetcher = fetch, audienceKey = 'ACCESS_AUD') {
  if (env.AUTH_PROVIDER === 'github') return verifyGithubSession(request, env, now);
  if (!['ACCESS_AUD', 'PREMIUM_ACCESS_AUD'].includes(audienceKey)) throw new HttpError(503, 'identity_not_configured');
  const config = authConfig(env, audienceKey);
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16_384) throw new HttpError(401, 'unauthorized');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'unauthorized');
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (!header || header.alg !== 'RS256' || header.crit !== undefined || header.b64 !== undefined ||
      typeof header.kid !== 'string' || header.kid.length > 256 ||
      !payload || payload.iss !== config.issuer || !Array.isArray(payload.aud) || !payload.aud.includes(config.audience) ||
      !Number.isInteger(payload.exp) || payload.exp <= nowSeconds ||
      (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > nowSeconds + 30)) ||
      (payload.iat !== undefined && (!Number.isInteger(payload.iat) || payload.iat > nowSeconds + 30)) ||
      typeof payload.email !== 'string' || payload.email.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(payload.email) ||
      typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 || /[\u0000-\u0020\u007f]/.test(payload.sub)) {
    throw new HttpError(401, 'unauthorized');
  }
  let keys = await loadJwks(config.issuer, fetcher, now);
  let jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) {
    keys = await loadJwks(config.issuer, fetcher, now, true);
    jwk = keys.find(key => key.kid === header.kid);
  }
  if (!jwk) throw new HttpError(401, 'unauthorized');
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64Url(parts[2]), ENCODER.encode(`${parts[0]}.${parts[1]}`));
  } catch { throw new HttpError(401, 'unauthorized'); }
  if (!valid) throw new HttpError(401, 'unauthorized');
  return { subject: payload.sub, email: payload.email.toLowerCase() };
}

export async function authorize(request, env, now = Date.now(), fetcher = fetch) {
  if (env.AUTH_PROVIDER === 'github') {
    const identity = await verifyGithubSession(request, env, now);
    if (identity.subject !== `github:${env.AUTH_GITHUB_OWNER_ID}`) throw new HttpError(403, 'operator_not_allowed');
    return identity;
  }
  const emails = String(env.AUTH_ALLOWLIST_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!emails.length || emails.some(email => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email))) {
    throw new HttpError(503, 'admin_not_configured');
  }
  const identity = await verifyIdentity(request, env, now, fetcher);
  if (!emails.includes(identity.email)) throw new HttpError(403, 'operator_not_allowed');
  return identity;
}

