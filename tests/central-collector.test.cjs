const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../central-collector.js'), 'utf8');
const CONSENT = 'orvantro_central_consent_v2:orvantro';
const SESSION = 'orvantro_central_tab_session_v2:orvantro';
function store(initial = {}) { const map = new Map(Object.entries(initial)); return { map, getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,String(v)), removeItem: k => map.delete(k) }; }
function setup(options = {}) {
  const requests = [], events = {}, windowEvents = {};
  const env = { URL, Date, Promise, console, crypto: { randomUUID },
    ORVANTRO_CENTRAL: { site: 'orvantro', endpoint: 'https://api.example.com/collect', enabled: true, ...options.config },
    localStorage: options.localStorage || store(options.local), sessionStorage: options.sessionStorage || store(options.session),
    navigator: options.navigator || {}, document: { readyState: 'loading', visibilityState: options.hidden ? 'hidden' : 'visible', addEventListener: (name, cb) => { events[name] = cb; }, title: 'PRIVATE', referrer: 'https://private.example/?secret=PRIVATE' },
    location: { href: 'https://orvantro.com/?secret=PRIVATE#PRIVATE' },
    fetch: async (url, init) => { requests.push({url,init}); if(options.fail)throw Error('offline');return {ok:true,json:async()=> options.ack || {accepted:true}}; },
    addEventListener: (name,cb) => {windowEvents[name]=cb;}, dispatchEvent: () => {}, CustomEvent: class {},
  };
  env.window=env;vm.createContext(env);vm.runInContext(source,env);
  return { env, requests, events, windowEvents, api:env.OrvantroCentral };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('no network or identifiers without independent consent including old local opt-in', async () => {
  const e=setup({local:{orvantro_local_analytics_enabled_v2:'yes'}});await e.events.DOMContentLoaded();
  assert.equal(e.requests.length,0);assert.equal(e.env.sessionStorage.map.size,0);assert.equal(e.api.getStatus().status,'needs-consent');
});
test('explicit consent sends only four fields with no credentials, URL or product information', async () => {
  const e=setup();e.api.setConsent(true);await tick();assert.equal(e.requests.length,1);
  const request=e.requests[0],body=JSON.parse(request.init.body);
  assert.deepEqual(Object.keys(body).sort(),['eventId','sessionId','site','v']);assert.equal(body.site,'orvantro');assert.equal(body.v,2);
  assert.equal(request.init.credentials,'omit');assert.equal(request.init.referrerPolicy,'no-referrer');assert.ok(!JSON.stringify(e.requests).includes('PRIVATE'));
  assert.equal(e.api.getStatus().status,'sent');
});
test('one pageview per document even with repeated consent and visibility events', async () => {
  const e=setup({local:{[CONSENT]:'yes'}});await e.events.DOMContentLoaded();e.api.setConsent(true);await e.events.visibilitychange();await tick();assert.equal(e.requests.length,1);
});
test('DNT and GPC block even explicit persisted consent', async () => {
  for(const navigator of [{doNotTrack:'1'},{globalPrivacyControl:true}]){const e=setup({local:{[CONSENT]:'yes'},navigator});await e.events.DOMContentLoaded();e.api.setConsent(true);await tick();assert.equal(e.requests.length,0);assert.equal(e.api.getStatus().status,'privacy-preference');}
});
test('disabled or malformed destination never transmits', async () => {
  for(const config of [{enabled:false},{endpoint:''},{endpoint:'http://api.example.com/collect'},{endpoint:'https://api.example.com/collect?key=private'},{endpoint:'https://name:pass@api.example.com/collect'},{site:'arbitrary'}]){const e=setup({config,local:{[CONSENT]:'yes'}});await e.events.DOMContentLoaded();assert.equal(e.requests.length,0);assert.equal(e.api.getStatus().status,'not-configured');}
});
test('hidden page defers recording until visible', async () => {
  const e=setup({hidden:true,local:{[CONSENT]:'yes'}});await e.events.DOMContentLoaded();assert.equal(e.requests.length,0);e.env.document.visibilityState='visible';await e.events.visibilitychange();assert.equal(e.requests.length,1);
});
test('session survives another document within 30 minutes and rotates on expiry', async () => {
  const local=store({[CONSENT]:'yes'}),session=store();let e=setup({localStorage:local,sessionStorage:session});await e.events.DOMContentLoaded();const first=JSON.parse(e.requests[0].init.body);
  e=setup({localStorage:local,sessionStorage:session});await e.events.DOMContentLoaded();const second=JSON.parse(e.requests[0].init.body);assert.equal(first.sessionId,second.sessionId);assert.notEqual(first.eventId,second.eventId);
  const old=JSON.parse(session.getItem(SESSION));old.last=Date.now()-31*60*1000;session.setItem(SESSION,JSON.stringify(old));e=setup({localStorage:local,sessionStorage:session});await e.events.DOMContentLoaded();assert.notEqual(JSON.parse(e.requests[0].init.body).sessionId,first.sessionId);
});
test('revoking consent clears only owned session and prevents future pages', async () => {
  const local=store({[CONSENT]:'yes',product:'keep'}),session=store({product:'keep'});let e=setup({localStorage:local,sessionStorage:session});await e.events.DOMContentLoaded();e.api.setConsent(false);
  assert.equal(session.getItem(SESSION),null);assert.equal(session.getItem('product'),'keep');assert.equal(local.getItem('product'),'keep');
  e=setup({localStorage:local,sessionStorage:session});await e.events.DOMContentLoaded();assert.equal(e.requests.length,0);
});
test('storage errors fail closed without sending a per-page substitute identity', async () => {
  const session={getItem(){throw Error('denied');},setItem(){throw Error('denied');},removeItem(){}};const e=setup({local:{[CONSENT]:'yes'},sessionStorage:session});await e.events.DOMContentLoaded();assert.equal(e.requests.length,0);assert.equal(e.api.getStatus().status,'error');
});
test('an uncertain response is not retried as a new event', async () => {
  const e=setup({fail:true,local:{[CONSENT]:'yes'}});await e.events.DOMContentLoaded();await e.events.visibilitychange();e.api.setConsent(true);await tick();assert.equal(e.requests.length,1);assert.equal(e.api.getStatus().status,'error');
});
test('server privacy rejection is not reported as a collected pageview', async () => {
  const e=setup({local:{[CONSENT]:'yes'},ack:{accepted:false,reason:'privacy_preference'}});await e.events.DOMContentLoaded();assert.equal(e.api.getStatus().status,'privacy-preference');
});
test('consent for Insights does not authorize collection on MarginKit at the same origin', async () => {
  const local=store({'orvantro_central_consent_v2:orvantro-insights':'yes'});
  const e=setup({localStorage:local,config:{site:'marginkit-pro-beta'}});await e.events.DOMContentLoaded();
  assert.equal(e.requests.length,0);assert.equal(e.api.getStatus().status,'needs-consent');
});
