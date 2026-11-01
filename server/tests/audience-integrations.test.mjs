import test from 'node:test';
import assert from 'node:assert/strict';
import { env, now, event, collectionRequest, token, fetcher } from './support.mjs';
import { handleRequest } from '../worker.mjs';
import { audienceOf } from '../audience.mjs';
import { syncSocial, dailyReport } from '../integrations.mjs';
const bridgeToken='test-bridge-token-with-at-least-forty-three-characters';
async function bridgeEnv(){const e=env();e.AUTOMATION_TOKEN_HASH=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bridgeToken))).toString('hex');return e;}
const bridge=(path,data,headers={})=>new Request('https://stats.example.test/api/automation'+path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+bridgeToken,'Content-Type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
async function admin(path,data){return new Request('https://stats.example.test'+path,{method:data===undefined?'GET':'POST',headers:{'Cf-Access-Jwt-Assertion':await token(),Origin:'https://stats.example.test','Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});}
function located(ua,country='KR',version=2){const req=collectionRequest(event({v:version}),{'User-Agent':ua,'CF-IPCountry':'US'});Object.defineProperty(req,'cf',{value:{country}});return req;}
test('new consent stores only coarse classifications and never trusts forged country headers',async()=>{
  const e=env(),req=located('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
  assert.equal((await handleRequest(req,e,{now})).status,202);const r=e.DB.rows()[0];
  assert.deepEqual([r.country,r.device,r.platform,r.browser],['KR','desktop','Windows','Chrome']);
  assert.ok(!JSON.stringify(r).includes('Mozilla'));
  assert.equal(audienceOf(collectionRequest(event(),{'CF-IPCountry':'US'})).country,'unknown');
  await handleRequest(located('Mozilla/5.0 (Windows NT 10.0)','KR',1),e,{now});
  assert.equal(e.DB.rows()[1].country,null);
});
test('classification covers tablets, mobile browsers, bots and unsupported country',()=>{
  assert.equal(audienceOf(located('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Mobile/15 Safari/604')).device,'tablet');
  assert.equal(audienceOf(located('Mozilla/5.0 (Linux; Android 14) Chrome/131 Mobile Safari/537 EdgA/131')).browser,'Edge');
  assert.equal(audienceOf(located('Googlebot','XX')).device,'unknown');
  assert.equal(audienceOf(located('curl/8','T1')).country,'unknown');
});
test('country/device filters apply to all metrics and historical rows remain uncollected',async()=>{
  const e=env();for(const req of [located('Mozilla/5.0 (Windows NT 10.0)','KR'),located('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)','US'),located('old','KR',1)])await handleRequest(req,e,{now});
  const filtered=await(await handleRequest(await admin('/api/admin/summary?country=KR&device=desktop'),e,{now,fetcher})).json();
  assert.equal(filtered.metrics.pageviews,1);assert.equal(filtered.breakdowns.country[0].value,'KR');assert.equal(filtered.daily.reduce((n,r)=>n+r.pageviews,0),1);
  const all=await(await handleRequest(await admin('/api/admin/summary'),e,{now,fetcher})).json();assert.ok(all.breakdowns.country.some(r=>r.value==='uncollected'));
  for(const query of ['?country=KR&country=US','?device=phone','?country=KR%27%20OR%201=1'])assert.equal((await handleRequest(await admin('/api/admin/summary'+query),e,{now,fetcher})).status,400);
});
test('SNS collection is pinned to the intended guild, bounded, idempotent and never calls paid X without approval',async()=>{
  const e=env();e.X_BEARER_TOKEN='must-not-be-used';let calls=0;
  const remote=async(url,options)=>{calls++;assert.equal(options.redirect,'manual');assert.equal(new URL(url).hostname,'discord.com');return Response.json({guild:{id:'1564706724999463019'},approximate_member_count:3,approximate_presence_count:1});};
  await Promise.all([syncSocial(e,now,remote),syncSocial(e,now,remote)]);assert.equal(calls,1);
  const stored=e.DB.sqlite.prepare('SELECT * FROM social_snapshots').all();assert.equal(stored.length,1);assert.deepEqual(JSON.parse(stored[0].metrics_json),{members:3,online:1});
  await syncSocial(e,now+16*60000,async()=>new Response(null,{status:302,headers:{Location:'https://evil.test'}}));
  assert.equal(e.DB.sqlite.prepare('SELECT error FROM integration_status').get().error,'provider_unavailable');assert.equal(e.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM social_snapshots').get().n,1);
});
test('automation bridge cannot access admin routes and rejects wrong tokens, browser callers and arbitrary uploads',async()=>{
  const e=await bridgeEnv();
  assert.equal((await handleRequest(bridge('/report',undefined,{Authorization:'Bearer '+'x'.repeat(50)}),e,{now})).status,401);
  assert.equal((await handleRequest(bridge('/report',undefined,{Origin:'https://evil.test'}),e,{now})).status,403);
  assert.equal((await handleRequest(new Request('https://stats.example.test/api/admin/integrations',{headers:{Authorization:'Bearer '+bridgeToken}}),e,{now,fetcher})).status,401);
  assert.equal((await handleRequest(bridge('/youtube',{channelId:'other',subscribers:1,views:1,videos:1}),e,{now})).status,400);
  assert.equal((await handleRequest(bridge('/youtube',{channelId:'UCt_ppRhsYcZeEqZpz3TiNHA',subscribers:null,views:'5',videos:'2'}),e,{now})).status,200);
  assert.equal(JSON.parse(e.DB.sqlite.prepare('SELECT metrics_json FROM social_snapshots').get().metrics_json).subscribers,null);
});
test('daily email claims are atomic, fixed-recipient and cannot be replayed or re-sent after uncertainty',async()=>{
  const e=await bridgeEnv(),input={day:'2026-10-31'};
  const reports=await Promise.all([handleRequest(bridge('/report/claim',input),e,{now}),handleRequest(bridge('/report/claim',input),e,{now})]);
  assert.equal((await Promise.all(reports.map(r=>r.json()))).filter(r=>r.claimed).length,1);
  await handleRequest(bridge('/report/complete',{...input,status:'uncertain'}),e,{now});
  assert.equal((await(await handleRequest(bridge('/report/claim',input),e,{now})).json()).claimed,false);
  assert.equal((await dailyReport(e,now)).to,'orvantro@gmail.com');
  assert.equal((await handleRequest(bridge('/report/claim',{...input,to:'evil@example.test'}),e,{now})).status,400);
});
test('owner can pause email but cross-origin mutations fail and paused reports cannot be claimed',async()=>{
  const e=await bridgeEnv();
  assert.equal((await handleRequest(await admin('/api/admin/report/settings',{enabled:false}),e,{now,fetcher})).status,200);
  assert.equal((await(await handleRequest(bridge('/report/claim',{day:'2026-10-31'}),e,{now})).json()).claimed,false);
  const bad=await admin('/api/admin/report/settings',{enabled:true});bad.headers.set('Origin','https://evil.test');assert.equal((await handleRequest(bad,e,{now,fetcher})).status,403);
  const state=await(await handleRequest(await admin('/api/admin/integrations'),e,{now,fetcher})).json();assert.equal(state.email.enabled,false);assert.equal(state.channels.find(c=>c.id==='x').status,'cost_approval_required');
});
