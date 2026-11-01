import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

const schema = (await Promise.all(['0001_analytics.sql', '0002_workspaces.sql', '0003_github_login.sql'].map(file => readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')))).join('\n');
export const now = Date.parse('2026-11-01T10:00:00Z');
const encoder = new TextEncoder();
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
export const publicKey = { ...await crypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'key-a', alg: 'RS256', use: 'sig' };

class D1Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.owner, this.sql, values); }
  execute() {
    const statement = this.owner.sqlite.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.values), meta: {} };
    const result = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async run() { return this.execute(); }
}

export class D1Database {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys = ON'); this.sqlite.exec(schema); }
  prepare(sql) { return new D1Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  rows() { return this.sqlite.prepare('SELECT * FROM analytics_events').all(); }
}

export function env() {
  return {
    DB: new D1Database(), ANALYTICS_HASH_SECRET: 'test-only-secret-not-valid-for-production-123456',
    ACCESS_TEAM_DOMAIN: 'test-orvantro.cloudflareaccess.com', ACCESS_AUD: 'app-audience',
    AUTH_ALLOWLIST_EMAILS: 'owner@example.test', PUBLIC_STATS_ENABLED: 'false',
  };
}

export function event(overrides = {}) { return { v: 1, site: 'orvantro', eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(), ...overrides }; }
export function collectionRequest(value, headers = {}, method = 'POST') {
  return new Request('https://stats.example.test/collect', {
    method, headers: { Origin: 'https://orvantro.com', 'Content-Type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}),
  });
}

export function base64url(value) { return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url'); }
export async function token(overrides = {}, header = {}) {
  const head = base64url({ alg: 'RS256', kid: 'key-a', typ: 'JWT', ...header });
  const body = base64url({ iss: 'https://test-orvantro.cloudflareaccess.com', aud: ['app-audience'], sub: 'operator-subject', email: 'owner@example.test', exp: Math.floor(now / 1000) + 3600, iat: Math.floor(now / 1000), ...overrides });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, encoder.encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
}
export const fetcher = async url => {
  assert.equal(url, 'https://test-orvantro.cloudflareaccess.com/cdn-cgi/access/certs');
  return Response.json({ keys: [publicKey] });
};
