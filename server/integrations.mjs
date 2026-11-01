import { HttpError, json, readLimited } from './http.mjs';
import { authorize } from './auth.mjs';
const DAY = 86400000;
const RECEIVER = 'orvantro@gmail.com';
const ORIGIN = 'https://orvantro-insights-api.orvantro.workers.dev';
const CHANNEL_ID = 'UCt_ppRhsYcZeEqZpz3TiNHA';
const CHANNELS = {
  youtube: { name: 'YouTube', url: 'https://www.youtube.com/@ORVANTRO', note: '구독자는 공식 API의 반올림 값 · 조회는 누적 채널 조회' },
  instagram: { name: 'Instagram', url: 'https://www.instagram.com/orvantro/', note: '프로페셔널 계정과 공식 API 연결 승인 필요' },
  discord: { name: 'Discord', url: 'https://discord.gg/zu9W5uWmrr', note: '공식 초대 API의 대략적인 전체·온라인 인원 · 메시지는 읽지 않음' },
  x: { name: 'X', url: 'https://x.com/orvantro', note: '유료 API · 비용 승인 전에는 호출하지 않음' },
};
const LABELS = { subscribers: '구독자', views: '누적 조회', videos: '공개 동영상', followers: '팔로워', posts: '게시물', members: '전체 인원(근사)', online: '온라인 인원(근사)' };
const day = now => new Date(now + 9*3600000).toISOString().slice(0,10);
const stamp = value => value == null ? null : new Date(value).toISOString();
const isoDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
async function rows(env, sql, ...values) {
  const result = await env.DB.batch([env.DB.prepare(sql).bind(...values)]);
  if (!result[0]?.success || !Array.isArray(result[0].results)) throw new HttpError(503, 'storage_unavailable');
  return result[0].results;
}
async function body(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) throw new HttpError(415, 'json_required');
  try { return JSON.parse(await readLimited(request, 4096)); } catch(e) { if(e instanceof HttpError) throw e; throw new HttpError(400,'invalid_json'); }
}
function exact(value, keys) { if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new HttpError(400, 'invalid_input'); }
function count(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!(typeof value === 'number' || typeof value === 'string') || !/^\d{1,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new HttpError(502, 'invalid_provider_data');
  return Number(value);
}
async function provider(url, fetcher, headers = {}) {
  let res;
  try { res = await fetcher(url, { headers, redirect:'manual', signal:AbortSignal.timeout(8000) }); } catch { throw new HttpError(502, 'provider_connection'); }
  if (!res.ok) throw new HttpError(502, res.status === 429 ? 'provider_rate_limit' : res.status === 401 || res.status === 403 ? 'provider_authorization' : 'provider_unavailable');
  try { return JSON.parse(await readLimited(res, 32768)); } catch { throw new HttpError(502,'invalid_provider_data'); }
}
async function save(env, channel, metrics, now) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO social_snapshots(channel, day, observed_at, metrics_json) VALUES (?1,?2,?3,?4)
      ON CONFLICT(channel,day) DO UPDATE SET observed_at=excluded.observed_at, metrics_json=excluded.metrics_json WHERE excluded.observed_at >= observed_at`).bind(channel,day(now),now,JSON.stringify(metrics)),
    env.DB.prepare(`INSERT INTO integration_status(channel,last_attempt,last_success,error) VALUES (?1,?2,?2,NULL)
      ON CONFLICT(channel) DO UPDATE SET last_attempt=?2,last_success=?2,error=NULL`).bind(channel,now),
  ]);
}
export async function syncSocial(env, now=Date.now(), fetcher=fetch) {
  for (const channel of ['discord','instagram','x']) {
    if (channel==='instagram' && (!env.INSTAGRAM_ACCESS_TOKEN || !/^\d{5,30}$/.test(env.INSTAGRAM_USER_ID || ''))) continue;
    if (channel==='x' && (env.X_COST_APPROVED !== 'true' || !env.X_BEARER_TOKEN)) continue;
    // Atomic throttle protects rate limits even across overlapping cron/manual requests
    const claim=await rows(env, `INSERT INTO integration_status(channel,last_attempt) VALUES (?1,?2)
      ON CONFLICT(channel) DO UPDATE SET last_attempt=?2 WHERE last_attempt <= ?3 RETURNING channel`,channel,now,now-15*60000);
    if(!claim.length) continue;
    try {
      let metrics;
      if(channel==='discord') {
        const data=await provider('https://discord.com/api/v10/invites/zu9W5uWmrr?with_counts=true&with_expiration=true',fetcher);
        if(data.guild?.id !== '1564706724999463019') throw new HttpError(502,'channel_mismatch');
        metrics={members:count(data.approximate_member_count),online:count(data.approximate_presence_count)};
      } else if(channel==='instagram') {
        const data=await provider(`https://graph.instagram.com/v24.0/${env.INSTAGRAM_USER_ID}?fields=id,username,followers_count,media_count`,fetcher,{Authorization:`Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`});
        if(data.username?.toLowerCase()!=='orvantro') throw new HttpError(502,'channel_mismatch');
        metrics={followers:count(data.followers_count),posts:count(data.media_count)};
      } else {
        const result=await provider('https://api.x.com/2/users/by/username/orvantro?user.fields=public_metrics',fetcher,{Authorization:`Bearer ${env.X_BEARER_TOKEN}`});
        if(result.data?.username?.toLowerCase()!=='orvantro') throw new HttpError(502,'channel_mismatch');
        metrics={followers:count(result.data.public_metrics?.followers_count),posts:count(result.data.public_metrics?.tweet_count)};
      }
      await save(env,channel,metrics,now);
    } catch(e) {
      await env.DB.prepare('UPDATE integration_status SET error=?1 WHERE channel=?2').bind(e instanceof HttpError ? e.code : 'sync_failed',channel).run();
    }
  }
}
async function state(env, now) {
  const [snapshots,statuses,settings,runs] = await Promise.all([
    rows(env,'SELECT * FROM social_snapshots WHERE day >= ?1 ORDER BY day DESC, channel',day(now-29*DAY)),
    rows(env,'SELECT * FROM integration_status'),rows(env,'SELECT enabled FROM report_settings WHERE id=1'),
    rows(env,'SELECT day,status,updated_at FROM report_runs ORDER BY day DESC LIMIT 7'),
  ]);
  return { channels:Object.entries(CHANNELS).map(([id,info])=>{
    const snapshot=snapshots.find(row=>row.channel===id), status=statuses.find(row=>row.channel===id);
    let configured=id==='discord' || id==='youtube' && !!status?.last_success || id==='instagram' && !!env.INSTAGRAM_ACCESS_TOKEN && !!env.INSTAGRAM_USER_ID || id==='x' && env.X_COST_APPROVED==='true' && !!env.X_BEARER_TOKEN;
    return {id,...info,status:!configured?(id==='x'?'cost_approval_required':'connection_required'):status?.error?'error':snapshot?(now-snapshot.observed_at>36*3600000?'stale':'ok'):'waiting',error:status?.error || null,lastAttempt:stamp(status?.last_attempt),lastSuccess:stamp(status?.last_success),observedAt:stamp(snapshot?.observed_at),metrics:snapshot?JSON.parse(snapshot.metrics_json):null};
  }), history:snapshots.map(s=>({channel:s.channel,day:s.day,observedAt:stamp(s.observed_at),metrics:JSON.parse(s.metrics_json)})),
  email:{recipient:RECEIVER,enabled:settings[0]?.enabled===1,timeZone:'Asia/Seoul',hour:9,connected:statuses.some(s=>s.channel==='google_bridge' && s.last_success),lastHeartbeat:stamp(statuses.find(s=>s.channel==='google_bridge')?.last_success),runs:runs.map(r=>({...r,updated_at:stamp(r.updated_at)}))} };
}
function label(value) {
  if(value==null || value==='uncollected') return '미수집';
  if(value==='unknown') return '알 수 없음';
  return ({desktop:'데스크톱',mobile:'모바일',tablet:'태블릿'})[value] || value;
}
export async function dailyReport(env, now) {
  const reportDay=day(now-DAY);
  const [totals,sites,countries,devices,integrations,collection] = await Promise.all([
    rows(env,'SELECT COUNT(*) AS pageviews,COUNT(DISTINCT session_key) AS sessions FROM analytics_events WHERE day=?1',reportDay),
    rows(env,'SELECT site,COUNT(*) AS pageviews,COUNT(DISTINCT session_key) AS sessions FROM analytics_events WHERE day=?1 GROUP BY site ORDER BY pageviews DESC',reportDay),
    rows(env,'SELECT country AS value,COUNT(*) AS pageviews FROM analytics_events WHERE day=?1 GROUP BY country ORDER BY pageviews DESC LIMIT 20',reportDay),
    rows(env,'SELECT device AS value,COUNT(*) AS pageviews FROM analytics_events WHERE day=?1 GROUP BY device ORDER BY pageviews DESC',reportDay),
    state(env,now),
    rows(env,'SELECT MIN(first_received_at) AS first FROM analytics_collection'),
  ]);
  const collected=collection[0]?.first!=null && reportDay>=day(collection[0].first);
  const lines=[`ORVANTRO 일일 운영 요약 · ${reportDay} (한국 시간)`,'',
    collected ? `페이지 조회 ${totals[0].pageviews}회 · 일별 방문 세션 ${totals[0].sessions}회` : '집계 시작 전 · 방문 수를 확인할 수 없음',
    '동의한 브라우저의 수신 성공 기록 기준 · 방문 세션은 고유 사람 수가 아님'];
  if(collected) lines.push('', '사이트별',...sites.map(r=>`${r.site}: ${r.pageviews}회 / 세션 ${r.sessions}회`),'', '접속 국가 (접속망 기준)',...countries.map(r=>`${label(r.value)}: ${r.pageviews}회`),'','기기 (추정)',...devices.map(r=>`${label(r.value)}: ${r.pageviews}회`));
  lines.push('','SNS 최신 현황 (일일 증가량이 아닌 누적 규모)');
  for(const channel of integrations.channels) {
    lines.push(`${channel.name}: ${channel.metrics ? Object.entries(channel.metrics).map(([key,value])=>`${LABELS[key] || key} ${value==null?'비공개':value}`).join(' · ') : '수집 기록 없음'}`);
    lines.push(`상태 ${channel.status} · 마지막 성공 ${channel.lastSuccess || '없음'} · ${channel.note}`);
  }
  lines.push('',`운영자 대시보드 ${ORIGIN}/admin/`,'전날 집계이며 과거 미수집 기록과 오류를 0으로 채우지 않음','예약 이메일은 운영자 대시보드에서 중지할 수 있음');
  return {day:reportDay,to:RECEIVER,subject:`[ORVANTRO] ${reportDay} 방문 · SNS 일일 요약`,text:lines.join('\n'),enabled:integrations.email.enabled};
}
async function bridgeAuth(request,env) {
  if(!/^[a-f0-9]{64}$/.test(env.AUTOMATION_TOKEN_HASH || '')) throw new HttpError(503,'automation_not_configured');
  const token=(request.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{43,100})$/)?.[1];
  if(!token) throw new HttpError(401,'unauthorized');
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  let diff=0;for(let i=0;i<64;i++)diff|=hex.charCodeAt(i)^env.AUTOMATION_TOKEN_HASH.charCodeAt(i);
  if(diff)throw new HttpError(401,'unauthorized');
}
export async function handleIntegrations(request,env,{now,fetcher}) {
  const url=new URL(request.url), path=url.pathname;
  if(!env.DB)throw new HttpError(503,'storage_not_configured');
  if(url.search)throw new HttpError(400,'invalid_query');
  if(path.startsWith('/api/automation/')) {
    if(request.headers.has('Origin'))throw new HttpError(403,'browser_request_denied');
    await bridgeAuth(request,env);
    if(path==='/api/automation/report' && request.method==='GET') return json(await dailyReport(env,now));
    if(request.method!=='POST')throw new HttpError(405,'method_not_allowed');
    const input=await body(request);
    if(path==='/api/automation/heartbeat') {
      exact(input,['v']);if(input.v!==1)throw new HttpError(400,'invalid_input');
      await env.DB.prepare(`INSERT INTO integration_status(channel,last_attempt,last_success) VALUES ('google_bridge',?1,?1) ON CONFLICT(channel) DO UPDATE SET last_attempt=?1,last_success=?1,error=NULL`).bind(now).run();
      return json({ok:true});
    }
    if(path==='/api/automation/youtube') {
      exact(input,['channelId','subscribers','views','videos']);
      if(input.channelId!==CHANNEL_ID)throw new HttpError(400,'channel_mismatch');
      const prior=await rows(env,"SELECT last_success FROM integration_status WHERE channel='youtube'");
      if(prior[0]?.last_success>now-15*60000)return json({ok:true,throttled:true});
      await save(env,'youtube',{subscribers:count(input.subscribers,true),views:count(input.views),videos:count(input.videos)},now);
      return json({ok:true});
    }
    if(path==='/api/automation/report/claim') {
      exact(input,['day']);if(input.day!==day(now-DAY))throw new HttpError(400,'invalid_day');
      const claim=await rows(env,`INSERT OR IGNORE INTO report_runs(day,status,created_at,updated_at)
        SELECT ?1,'sending',?2,?2 WHERE EXISTS(SELECT 1 FROM report_settings WHERE id=1 AND enabled=1) RETURNING day`,input.day,now);
      return json({claimed:claim.length===1});
    }
    if(path==='/api/automation/report/complete') {
      exact(input,['day','status']);
      if(!isoDay(input.day)||input.day<day(now-7*DAY)||input.day>day(now-DAY)||!['sent','uncertain','failed'].includes(input.status))throw new HttpError(400,'invalid_result');
      await env.DB.prepare("UPDATE report_runs SET status=?1,updated_at=?2 WHERE day=?3 AND status='sending'").bind(input.status,now,input.day).run();
      return json({ok:true});
    }
    throw new HttpError(404,'not_found');
  }
  const origin=request.headers.get('Origin');
  if(origin && origin!==url.origin || request.method!=='GET' && origin!==url.origin)throw new HttpError(403,'cross_origin_admin_denied');
  await authorize(request,env,now,fetcher);
  if(path==='/api/admin/integrations' && request.method==='GET')return json(await state(env,now));
  if(path==='/api/admin/report' && request.method==='GET')return json(await dailyReport(env,now));
  if(path==='/api/admin/integrations/sync' && request.method==='POST') {
    exact(await body(request),[]);await syncSocial(env,now,fetcher);return json(await state(env,now));
  }
  if(path==='/api/admin/report/settings' && request.method==='POST') {
    const input=await body(request);exact(input,['enabled']);if(typeof input.enabled!=='boolean')throw new HttpError(400,'invalid_input');
    await env.DB.prepare('UPDATE report_settings SET enabled=?1 WHERE id=1').bind(input.enabled?1:0).run();return json({enabled:input.enabled});
  }
  throw new HttpError(405,'method_not_allowed');
}
export async function integrationCron(env,now,fetcher=fetch) {
  if(!env.DB)return;
  if(new Date(now+9*3600000).getUTCHours()===8)await syncSocial(env,now,fetcher);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM social_snapshots WHERE day < ?1').bind(day(now-29*DAY)),
    env.DB.prepare('DELETE FROM report_runs WHERE day < ?1').bind(day(now-29*DAY)),
  ]);
}
