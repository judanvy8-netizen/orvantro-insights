// ORVANTRO daily automation — owner account orvantro@gmail.com
// No Gmail inbox access, no public web app, no Google tokens sent to Cloudflare
const ORVANTRO = {
  origin: 'https://orvantro-insights-api.orvantro.workers.dev',
  channel: 'UCt_ppRhsYcZeEqZpz3TiNHA', recipient: 'orvantro@gmail.com'
};

function installDailyReport() {
  const props = PropertiesService.getScriptProperties();
  if (!/^[A-Za-z0-9_-]{43,100}$/.test(props.getProperty('ORVANTRO_BRIDGE_TOKEN') || '')) throw new Error('서버 연결 키를 스크립트 속성에 먼저 설정해 주세요');
  bridge_('/report');
  syncYouTube_();
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'dailyOrvantroReport');
  if (!exists) ScriptApp.newTrigger('dailyOrvantroReport').timeBased().atHour(9).everyDays(1).inTimezone('Asia/Seoul').create();
  bridge_('/heartbeat', {v:1});
  console.log('일일 예약 설정 완료 · 오전 9시~10시 한국 시간 · 실제 실행 이력에서 확인 가능');
}

function dailyOrvantroReport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    bridge_('/heartbeat',{v:1});
    const pendingDay = props.getProperty('ACK_DAY');
    if (pendingDay) {
      bridge_('/report/complete',{day:pendingDay,status:props.getProperty('ACK_STATUS')});
      props.deleteProperty('ACK_DAY'); props.deleteProperty('ACK_STATUS');
    }
    // A social API outage must not suppress the independent visitor report
    try { syncYouTube_(); } catch (_) { console.log('YouTube 갱신 실패 · 마지막 성공 자료의 시각과 함께 보고합니다'); }
    const report = bridge_('/report');
    if (report.enabled !== true || props.getProperty('SENT_DAY') === report.day) return;
    if (report.to !== ORVANTRO.recipient || !/^\d{4}-\d{2}-\d{2}$/.test(report.day) || typeof report.text !== 'string' || report.text.length > 20000 || typeof report.subject !== 'string' || report.subject.length > 150) throw new Error('리포트 응답 확인 필요');
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('무료 이메일 한도 도달 · 추가 과금 없이 중단');
    const claim = bridge_('/report/claim',{day:report.day});
    if (claim.claimed !== true) { console.log('발송 중이거나 이미 처리된 리포트 · 중복 발송하지 않음'); return; }
    let status;
    try {
      MailApp.sendEmail({to:ORVANTRO.recipient,subject:report.subject,body:report.text,name:'ORVANTRO Insights'});
      status='sent';props.setProperty('SENT_DAY',report.day);
    } catch (_) {
      // Provider acceptance may be ambiguous — never blindly retry a send
      status='uncertain';
    }
    props.setProperties({ACK_DAY:report.day,ACK_STATUS:status});
    bridge_('/report/complete',{day:report.day,status:status});
    props.deleteProperty('ACK_DAY');props.deleteProperty('ACK_STATUS');
    console.log(status === 'sent' ? '일일 리포트 발송 요청 완료' : '발송 결과 불확실 · 중복 방지를 위해 재발송 중단');
  } finally { lock.releaseLock(); }
}

function previewDailyReport() {
  // Preview only; does not send mail or claim a delivery
  const report=bridge_('/report'); console.log(report.subject+'\n'+report.text);
}

function syncYouTube_() {
  const response = YouTube.Channels.list('statistics',{id:ORVANTRO.channel,maxResults:1});
  const channel = response.items && response.items.find(item => item.id === ORVANTRO.channel);
  if (!channel || !channel.statistics) throw new Error('YouTube 채널 통계 확인 필요');
  const stats = channel.statistics;
  return bridge_('/youtube',{channelId:channel.id,subscribers:stats.hiddenSubscriberCount ? null : stats.subscriberCount,views:stats.viewCount,videos:stats.videoCount});
}

function bridge_(path, value) {
  if (!['/heartbeat','/youtube','/report','/report/claim','/report/complete'].includes(path)) throw new Error('허용되지 않은 경로');
  const token=PropertiesService.getScriptProperties().getProperty('ORVANTRO_BRIDGE_TOKEN');
  const options={method:value===undefined?'get':'post',headers:{Authorization:'Bearer '+token},followRedirects:false,muteHttpExceptions:true};
  if(value!==undefined){options.contentType='application/json';options.payload=JSON.stringify(value);}
  let response;
  try { response=UrlFetchApp.fetch(ORVANTRO.origin+'/api/automation'+path,options); } catch (_) { throw new Error('ORVANTRO 서버 연결 실패'); }
  if(response.getResponseCode()!==200)throw new Error('ORVANTRO 서버 요청 거부 '+response.getResponseCode());
  let result;try{result=JSON.parse(response.getContentText());}catch(_){throw new Error('ORVANTRO 응답 형식 확인 필요');}
  return result;
}
