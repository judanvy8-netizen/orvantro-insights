const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const tracker = fs.readFileSync(path.join(ROOT, 'orvantro-analytics.js'), 'utf8');
const insights = fs.readFileSync(process.env.INSIGHTS_SOURCE || path.join(ROOT, 'insights.js'), 'utf8');
const KEY = 'orvantro_local_analytics_v2';
const CONSENT = 'orvantro_local_analytics_enabled_v2';
let passed = 0, failed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); } }
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
    TextEncoder, ORVANTRO_ANALYTICS: { site: 'orvantro-insights' }, URL, URLSearchParams, Promise, Date, console, setTimeout,
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
  await check('unknown return status remains unknown, explicit false is new', () => {
    const e = environment(), t = loadInsights(e);
    const rows = t.normalizeImported([row({visitor_id:'u'}), row({visitor_id:'n',returning:false}), row({visitor_id:'r',returning:true})]);
    assert.equal(rows[0].returning, null);
    const a=t.aggregate(rows); assert.equal(a.brandNew,1); assert.equal(a.returning,1); assert.equal(a.unknownVisitors,1); assert.equal(a.returningRate,.5);
    const unknown=t.aggregate([rows[0]]); assert.equal(unknown.returningRate,null);
    assert.ok(t.prospectNotes(unknown,[]).every(n=>n.title!=='신규 비중'));
  });
  await check('same visitor is not double-counted new and returning; nested flags honored', () => {
    const e=environment(),t=loadInsights(e);
    const a=t.aggregate(t.normalizeImported([row({visitor_id:'v',returning:false}),row({visitor_id:'v',returning:true}),row({visitor_id:'n',properties:{returning:false}})]));
    assert.equal(a.unique,2);assert.equal(a.brandNew,1);assert.equal(a.returning,1);assert.equal(a.unknownVisitors,0);
  });
  await check('zero duration counts, missing and invalid durations do not fabricate zero', () => {
    const e=environment(),t=loadInsights(e);
    const rows=t.normalizeImported([row({engaged_ms:0}),row({engaged_ms:10000}),row(),row({engaged_ms:null}),row({engaged_ms:''}),row({engaged_ms:false}),row({engaged_ms:-1}),row({engaged_ms:'Infinity'})]);
    const a=t.aggregate(rows);assert.equal(a.engageN,2);assert.equal(a.avgEngage,5000);assert.equal(a.engageBuckets['0–5s'],1);assert.equal(a.bounceProxy,.5);
    assert.equal(t.aggregate(t.normalizeImported([row()])).avgEngage,null);
    loadTracker(e);t.state.events=[rows[0]];t.render();assert.equal(e.nodes.get('kpiEngage').textContent,'0s');
  });
  await check('sample country resets before rendering local/imported/empty data, repeatedly', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);await t.boot();
    for(let i=0;i<2;i++){
      e.nodes.get('btnUseSample').handlers.click();t.state.filters.country='JP';t.render();
      assert.equal(e.nodes.get('filterCountry').value,'JP');
      e.OrvantroAnalytics.setEnabled(true);await e.nodes.get('btnLive').handlers.click();
      assert.equal(t.state.filters.country,'all');assert.equal(e.nodes.get('filterCountry').value,'all');assert.equal(e.nodes.get('kpiPageviews').textContent,'1');
    }
    t.state.filters.country='JP';t.state.imported=t.normalizeImported([row({country_code:'KR'})]);t.chooseDatasetFrom([]);t.render();assert.equal(t.state.filters.country,'all');assert.equal(e.nodes.get('kpiPageviews').textContent,'1');
    t.state.filters.country='KR';t.render();assert.equal(t.state.filters.country,'KR');
    t.state.imported=[];t.chooseDatasetFrom([]);t.render();assert.equal(t.state.filters.country,'all');
    assert.equal(e.net.length,0);
  });
  await check('unknown counts render consistently in detail and KPI', () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);t.state.mode='imported';t.state.events=t.normalizeImported([row({visitor_id:'u'})]);t.render();
    assert.equal(e.nodes.get('kpiReturning').textContent,'미수집');assert.ok(e.nodes.get('kpiReturningHint').textContent.includes('미상 1명'));
    assert.ok(e.nodes.get('uniqTableBody').innerHTML.includes('<td>0</td><td>0</td><td>1</td><td>—</td>'));
  });
  await check('empty to sample reveals canvas before measuring and drawing, repeatedly', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);
    const canvas=e.document.getElementById('trendChart');
    Object.defineProperties(canvas,{
      clientWidth:{get(){return this.style.display==='none'?0:800;}},
      clientHeight:{get(){return this.style.display==='none'?0:220;}}
    });
    await t.boot();assert.equal(canvas.style.display,'none');
    for(let i=0;i<2;i++){
      e.nodes.get('btnUseSample').handlers.click();
      assert.equal(canvas.style.display,'block');assert.equal(canvas.width,800);assert.equal(canvas.height,220);
      assert.equal(e.nodes.get('trendEmpty').hidden,true);
      await e.nodes.get('btnLive').handlers.click();assert.equal(canvas.style.display,'none');
    }
  });
  await check('chart empty-state CSS honors hidden without removing visible empty state', () => {
    const css=fs.readFileSync(path.join(ROOT,'insights.css'),'utf8');
    assert.match(css,/\.chart-empty\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/);
    assert.match(css,/\.chart-empty\s*\{[^}]*display:\s*grid/);
  });
  await check('empty source is no data, demo/import work with collection off and source stays explicit', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);await t.boot();
    assert.equal(e.nodes.get('kpiPageviews').textContent,'—');
    assert.match(e.nodes.get('sourceStatus').textContent,/데이터 없음/);
    assert.match(e.nodes.get('sourceScope').textContent,/0명/);
    e.nodes.get('btnUseSample').handlers.click();assert.match(e.nodes.get('sourceStatus').textContent,/DEMO/);
    assert.equal(e.OrvantroAnalytics.isEnabled(),false);assert.equal(e.localStorage.map.size,0);
    t.state.forceSample=false;t.state.imported=t.normalizeImported([row()]);t.chooseDatasetFrom([]);t.render();
    assert.match(e.nodes.get('sourceStatus').textContent,/IMPORTED/);assert.equal(e.OrvantroAnalytics.isEnabled(),false);
    t.state.imported=[];t.chooseDatasetFrom(t.normalizeImported([row()]));t.render();
    assert.match(e.nodes.get('sourceStatus').textContent,/LOCAL/);assert.equal(e.nodes.get('kpiPageviews').textContent,'1');
    t.state.filters.product='marginkit-pro-beta';t.render();assert.equal(e.nodes.get('kpiPageviews').textContent,'0');
    assert.match(e.nodes.get('kpiPageviewsHint').textContent,/필터/);assert.equal(e.net.length,0);
  });
  await check('imports enforce UTF-8 byte limit, preserve last dataset on errors, and explain rejected rows', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);await t.boot();
    e.document.getElementById('importJson').value=JSON.stringify([row(),null,row({t:Date.now()+86400000})]);await t.importJson();
    assert.equal(t.state.imported.length,1);assert.match(e.nodes.get('importFeedback').textContent,/2개 제외/);
    e.document.getElementById('importJson').value=JSON.stringify([row({country:'가'.repeat(700000)})]);await t.importJson();
    assert.equal(t.state.imported.length,1);assert.match(e.nodes.get('importFeedback').textContent,/2MB/);
    e.document.getElementById('importJson').value='{bad';await t.importJson();assert.equal(t.state.imported.length,1);
    assert.match(e.nodes.get('importFeedback').textContent,/유지/);assert.equal(e.net.length,0);assert.equal(e.localStorage.map.size,0);
  });
  await check('malicious import text is escaped, numeric bounds and country validation remain strict', () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);const hostile='<img src=x onerror=alert(1)>';
    const rows=t.normalizeImported([row({site:hostile,path:hostile,country:hostile,country_code:'KR-extra',utm_source:hostile,device_type:hostile,engaged_ms:86400001,returning:'false'}),row({engaged_ms:86400000,country_code:'kr'})]);
    assert.equal(rows[0].country_code,'');assert.equal(rows[0].engaged_ms,null);assert.equal(rows[0].returning,null);assert.equal(rows[1].engaged_ms,86400000);assert.equal(rows[1].country_code,'KR');
    for(const country_code of ['ß','ſg']) assert.equal(t.normalizeImported([row({country_code})])[0].country_code,'');
    t.state.mode='imported';t.state.events=rows;t.render();
    for(const id of ['siteBars','pathFunnel','utmTableBody','deviceBars','filterProduct']) assert.ok(!e.nodes.get(id).innerHTML.includes('<img'));
    assert.throws(()=>t.normalizeImported(Array(10001).fill(row())));
  });
  await check('import source exposes sample tags and supports imported product filtering', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);await t.boot();
    e.document.getElementById('importJson').value=JSON.stringify([row({site:'my-product',_sample:true})]);await t.importJson();
    assert.match(e.nodes.get('sourceScope').textContent,/샘플 표시 1개/);
    assert.ok(e.nodes.get('filterProduct').innerHTML.includes('my-product'));
    t.state.filters.product='my-product';t.render();assert.equal(e.nodes.get('kpiPageviews').textContent,'1');
    await t.clearImport();assert.equal(t.state.filters.product,'all');
  });
  await check('raw import byte limit applies before trimming whitespace', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);await t.boot();
    e.document.getElementById('importJson').value=' '.repeat(2000001)+JSON.stringify([row()]);t.importJson();
    assert.equal(t.state.imported.length,0);assert.match(e.nodes.get('importFeedback').textContent,/2MB/);
  });
  await check('unavailable canvas does not reject an otherwise valid import', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);await t.boot();
    const canvas=e.document.getElementById('trendChart');
    for(const getContext of [()=>null,()=>{throw Error('unavailable');}]){
      canvas.getContext=getContext;e.document.getElementById('importJson').value=JSON.stringify([row({site:'canvas-case'})]);t.importJson();
      assert.equal(t.state.imported.length,1);assert.match(e.nodes.get('importFeedback').textContent,/1개 사용/);
      assert.equal(e.nodes.get('kpiPageviews').textContent,'1');assert.match(e.nodes.get('trendEmpty').textContent,/차트/);
    }
  });
  await check('pending clear does not discard newer import or sample selection', async () => {
    const e=environment();loadTracker(e);const t=loadInsights(e);await t.boot();
    for(const next of ['import','sample']){
      let finish;e.OrvantroAnalytics.clearRing=()=>new Promise(resolve=>{finish=resolve;});
      const pending=e.nodes.get('btnClearLocal').handlers.click();
      if(next==='import'){e.document.getElementById('importJson').value=JSON.stringify([row({site:'newer'})]);t.importJson();}
      else e.nodes.get('btnUseSample').handlers.click();
      finish(true);await pending;
      assert.equal(t.state.mode,next==='import'?'imported':'sample');
      if(next==='import'){assert.equal(t.state.imported[0].site,'newer');assert.ok(e.document.getElementById('importJson').value.includes('newer'));}
    }
    e.OrvantroAnalytics.clearRing=()=>Promise.resolve(true);
    await e.nodes.get('btnClearLocal').handlers.click();
    assert.equal(e.nodes.get('importFeedback').textContent,'');
  });
  console.log(`SUMMARY ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
})().catch(e=>{console.error(e);process.exitCode=1;});
