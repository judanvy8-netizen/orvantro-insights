const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const tracker = fs.readFileSync(path.join(ROOT, 'orvantro-analytics.js'), 'utf8');
const insights = fs.readFileSync(path.join(ROOT, 'insights.js'), 'utf8');
const KEY = 'orvantro_local_analytics_v2';
const CONSENT = 'orvantro_local_analytics_enabled_v2';
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function storage(values = {}) {
  const map = new Map(Object.entries(values));
  return { map, getItem(k) { return map.get(k) ?? null; }, setItem(k, v) { map.set(k, String(v)); }, removeItem(k) { map.delete(k); } };
}
function environment(initial = {}) {
  const nodes = new Map(), callbacks = {}, net = [], deletions = [];
  const canvas = new Proxy({}, { get(t, k) { return t[k] || (() => {}); }, set(t, k, v) { t[k] = v; return true; } });
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', dataset: {}, style: {}, hidden: false,
      clientWidth: 800, clientHeight: 220, handlers: {}, getContext() { return canvas; }, addEventListener(n, fn) { this.handlers[n] = fn; } });
    return nodes.get(id);
  }
  const env = { localStorage: storage(initial), sessionStorage: storage(), document: {
      readyState: 'loading', hidden: false, title: 'private title', referrer: 'https://secret.example/?token=secret',
      getElementById: node, querySelector: node, addEventListener(n, fn) { callbacks[n] = fn; }
    }, addEventListener(n, fn) { callbacks[n] = fn; }, location: { origin: 'https://judanvy8-netizen.github.io', pathname: '/orvantro-insights/', href: 'https://private.example/person?token=SECRET#secret' },
    navigator: { sendBeacon(...a) { net.push(a); }, geolocation: { getCurrentPosition() { throw new Error('geolocation'); } } },
    fetch(...a) { net.push(a); return Promise.reject(new Error('Network forbidden')); },
    ORVANTRO_ANALYTICS: { site: 'orvantro-insights' }, URL, URLSearchParams, Promise, Date, console, setTimeout,
    indexedDB: { deleteDatabase(name) { deletions.push(name); const req = {}; queueMicrotask(() => req.onsuccess?.()); return req; } },
    confirm() { return true; }, nodes, callbacks, net, deletions };
  env.window = env; vm.createContext(env); return env;
}
function loadTracker(env) { vm.runInContext(tracker, env); return env.OrvantroAnalytics; }
function loadInsights(env) {
  // Expose pure helpers only inside this test VM; production code has no test endpoint.
  const source = insights.replace("  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);", "  window.testOnly = { normalizeImported, aggregate, linearForecast, prospectNotes, chooseDatasetFrom, render, boot, state, importJson, clearImport };\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);");
  vm.runInContext(source, env); return env.testOnly;
}
const row = (extra = {}) => ({ t: Date.now() - 1000, type: 'orvantro_pageview', site: 'feeroi', path: '/feeroi/', ...extra });
(async () => {
  await check('collector copies identical when sibling repositories are present', () => {
    for (const repo of ['orvantro', 'orvantro-insights', 'marginkit-pro-beta', 'markit-pro-beta', 'feeroi', 'sellerbill']) {
      const file = path.join(ROOT, '..', repo, 'orvantro-analytics.js');
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, 'utf8'), tracker);
    }
  });
  await check('default-off creates no identifier, event or network request', () => {
    const e = environment(); const a = loadTracker(e); e.callbacks.DOMContentLoaded();
    assert.equal(a.isEnabled(), false); assert.equal(a.getRing().length, 0); assert.equal(e.localStorage.map.size, 0); assert.equal(e.net.length, 0);
  });
  await check('explicit opt-in stores only time/site/canonical route, ignores sensitive properties', () => {
    const e = environment(); const a = loadTracker(e); assert.equal(a.setEnabled(true), true);
    a.track('pageview', { href: 'SECRET', email: 'private@example.com', body: 'private' });
    const rows = a.getRing(); assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(Object.keys(rows[0]).sort()), JSON.stringify(['path', 'site', 't', 'type']));
    assert.equal(rows[0].path, '/orvantro-insights/'); assert.equal(e.net.length, 0);
    assert.ok(!JSON.stringify([...e.localStorage.map]).includes('SECRET'));
  });
  await check('revocation stops next-page recording and persists without clearing product data', () => {
    const shared = storage({ product_costs: 'untouched' }); const e = environment(); e.localStorage = shared;
    const a = loadTracker(e); a.setEnabled(true); a.setEnabled(false);
    const next = environment(); next.localStorage = shared; loadTracker(next); next.callbacks.DOMContentLoaded();
    assert.equal(next.OrvantroAnalytics.getRing().length, 1); assert.equal(shared.getItem('product_costs'), 'untouched');
  });
  await check('storage unavailable fails closed', () => {
    const e = environment(); e.localStorage = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
    const a = loadTracker(e); assert.equal(a.setEnabled(true), false); assert.equal(a.isEnabled(), false); assert.equal(a.getRing().length, 0);
  });
  await check('record bounds, expiry and future timestamps cannot pollute local view', () => {
    const rows = Array.from({ length: 900 }, (_, i) => row({ t: Date.now() - 2000 - i }));
    const e = environment({ [CONSENT]: 'yes', [KEY]: JSON.stringify(rows) }); const a = loadTracker(e); e.callbacks.DOMContentLoaded();
    assert.equal(a.getRing().length, 800);
    e.localStorage.setItem(KEY, JSON.stringify([row({ t: 1 }), row({ t: Date.now() + 100000 }), row({ site: '__proto__' }), row({ secret: 'SECRET' })]));
    assert.equal(a.getRing().length, 1); assert.ok(!JSON.stringify(a.getRing()).includes('SECRET'));
  });
  await check('clear deletes only owned analytics keys and legacy DB', async () => {
    const e = environment({ product_costs: 'keep', orvantro_vid: 'old', orvantro_analytics_ring: 'old', orvantro_insights_import: 'old' }); const a = loadTracker(e);
    assert.equal(await a.clearRing(), true); assert.equal(e.localStorage.getItem('product_costs'), 'keep'); assert.equal(e.localStorage.getItem('orvantro_vid'), null); assert.equal(e.deletions.join(','), 'orvantro_analytics');
  });
  await check('expired raw records are pruned on next visit even when recording is off', () => {
    const e = environment({ [KEY]: JSON.stringify([row({ t: 1 })]) });
    const a = loadTracker(e); e.callbacks.DOMContentLoaded();
    assert.equal(a.isEnabled(), false); assert.equal(e.localStorage.getItem(KEY), null);
  });
  await check('malformed import rows filtered and future/invalid dates rejected', () => {
    const e = environment(); const t = loadInsights(e);
    const rows = t.normalizeImported([null, [], {}, row({ t: 'bad' }), row({ t: Date.now() + 100000 }), row()]);
    assert.equal(rows.length, 1); assert.throws(() => t.normalizeImported(Array(10001).fill({}))); assert.throws(() => t.normalizeImported({ events: {} }));
  });
  await check('untrusted country labels cannot inject option HTML', () => {
    const e = environment(); loadTracker(e); const t = loadInsights(e);
    t.state.events = t.normalizeImported([row({ country_code: 'KR', country: '<img src=x onerror=alert(1)>', site: '__proto__', visitor_id: '__proto__' })]);
    t.render(); const html = e.nodes.get('filterCountry').innerHTML;
    assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img')); assert.equal(t.aggregate(t.state.events).unique, 1);
  });
  await check('empty or insufficient history cannot produce invented forecast or engagement claim', () => {
    const e = environment(); const t = loadInsights(e);
    assert.equal(t.linearForecast({}, 14).length, 0); assert.equal(t.linearForecast({ '2026-01-01': 100 }, 14).length, 0);
    const agg = t.aggregate([]); assert.equal(agg.bounceProxy, null); assert.equal(t.prospectNotes(agg, []).length, 1);
    assert.ok(t.prospectNotes(t.aggregate([row()]), []).every(n => !n.body.includes('양호')));
  });
  await check('local pageviews do not invent visitors, countries or referrals', () => {
    const e = environment(); const t = loadInsights(e); const agg = t.aggregate([row(), row()]);
    assert.equal(agg.pageviews, 2); assert.equal(agg.unique, 0); assert.equal(Object.keys(agg.byCountry).length, 0); assert.equal(Object.keys(agg.byRef).length, 0);
  });
  await check('import strips URL query/hash, invalid durations and non-string values', () => {
    const e = environment(); const t = loadInsights(e); const rows = t.normalizeImported([row({ path: '/report?token=SECRET#secret', referrer: 'https://example.com/private?token=SECRET', engaged_ms: 'Infinity', country_code: {} })]);
    assert.equal(rows[0].path, '/report'); assert.equal(rows[0].referrer, 'https://example.com'); assert.equal(rows[0].engaged_ms, 0); assert.equal(rows[0].country_code, '');
  });
  await check('import and sample remain distinct from local data and never auto-save', () => {
    const e = environment(); loadTracker(e); const t = loadInsights(e);
    t.state.imported = [row()]; t.chooseDatasetFrom([row(), row()]); assert.equal(t.state.events.length, 1);
    assert.equal(e.localStorage.map.size, 0); t.state.imported = []; t.chooseDatasetFrom([]); assert.equal(t.state.events.length, 0);
    t.state.forceSample = true; t.chooseDatasetFrom([]); assert.equal(t.state.mode, 'sample'); assert.ok(t.state.events.length > 0);
    t.render(); assert.equal(e.nodes.get('emptyGuide').hidden, true);
  });
  await check('full Insights boot and local controls render without network', async () => {
    const e = environment(); loadTracker(e); const t = loadInsights(e); await t.boot();
    assert.equal(e.nodes.get('kpiPageviews').textContent, '0'); assert.equal(e.nodes.get('kpiVisitors').textContent, '미수집');
    e.nodes.get('btnEnableLocal').handlers.click(); await new Promise(r => setTimeout(r, 0));
    assert.equal(e.OrvantroAnalytics.isEnabled(), true); assert.equal(e.nodes.get('kpiPageviews').textContent, '1');
    e.nodes.get('btnDisableLocal').handlers.click(); assert.equal(e.OrvantroAnalytics.isEnabled(), false); assert.equal(e.net.length, 0);
  });
  console.log(`SUMMARY ${passed}/${passed} passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
