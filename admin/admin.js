(function () {
  'use strict';
  var latest = null, controller = null, integrations = null;
  var names = { orvantro: 'ORVANTRO', 'marginkit-pro-beta': 'MarginKit', 'orvantro-insights': 'Insights' };
  var $ = function (id) { return document.getElementById(id); };
  var number = function (n) { return new Intl.NumberFormat('ko-KR').format(n); };
  function dateTime(value) { return value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '수집된 기록 없음'; }
  function text(tag, value, cls) { var node = document.createElement(tag); node.textContent = value; if (cls) node.className = cls; return node; }
  function nonNegative(n) { return Number.isSafeInteger(n) && n >= 0; }
  function validate(data) {
    if (!data || data.source !== 'central' || !['ok', 'empty'].includes(data.status) || !data.metrics ||
      !['pageviews', 'sessions', 'activeDays'].every(function (key) { return nonNegative(data.metrics[key]); }) ||
      !Array.isArray(data.daily) || data.daily.length > 30 || !Array.isArray(data.bySite) || data.bySite.length > 3 ||
      !data.daily.every(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.date) && nonNegative(r.pageviews) && nonNegative(r.sessions); }) ||
      !data.bySite.every(function (r) { return Object.prototype.hasOwnProperty.call(names, r.site) && nonNegative(r.pageviews) && nonNegative(r.sessions); })) throw Error('invalid-response');
    if(!data.breakdowns || !['country','device','platform','browser'].every(function(key){return Array.isArray(data.breakdowns[key]) && data.breakdowns[key].length<=256 && data.breakdowns[key].every(function(r){return typeof r.value==='string' && r.value.length<40 && nonNegative(r.pageviews) && nonNegative(r.sessions);});}))throw Error('invalid-response');
    return data;
  }
  function chart(rows) {
    var host = $('trend'); host.replaceChildren();
    if (!rows.length || rows.every(function (r) { return r.pageviews === 0; })) { host.append(text('p', '선택한 기간에 수집된 페이지 조회가 없습니다', 'muted')); return; }
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 600 220'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '일별 페이지 조회 막대 그래프, 아래 표에서 숫자를 확인할 수 있음');
    function node(tag, attrs) { var el = document.createElementNS(ns, tag); Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); }); svg.append(el); return el; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.pageviews; })), step = 540 / rows.length;
    [0, .5, 1].forEach(function (ratio) { var y = 185 - ratio * 160; node('line', {x1:42,x2:592,y1:y,y2:y}); var label = node('text',{x:34,y:y+4,'text-anchor':'end'}); label.textContent = number(Math.round(max*ratio)); });
    rows.forEach(function (r, i) { var h=r.pageviews/max*160; var bar=node('rect',{x:47+i*step,y:185-h,width:Math.max(2,step-5),height:h,rx:1}); var title=document.createElementNS(ns,'title'); title.textContent=r.date+' · '+number(r.pageviews)+'회';bar.append(title); if(i===0||i===rows.length-1||i===Math.floor(rows.length/2)){var label=node('text',{x:47+i*step+step/2,y:210,'text-anchor':'middle'});label.textContent=r.date.slice(5);} });
    host.append(svg);
  }
  function render(data) {
    $('pageviews').textContent=number(data.metrics.pageviews);$('sessions').textContent=number(data.metrics.sessions);$('activeDays').textContent=number(data.metrics.activeDays);
    $('status').className='status';$('status').textContent=data.status==='empty'?'연결 정상 · 선택한 기간에 수집된 기록 없음':'중앙 집계 연결 정상 · 샘플과 로컬 기록은 포함하지 않음';
    $('updated').textContent='갱신 '+dateTime(data.generatedAt)+' · 서울 기준';
    $('startedAt').textContent=dateTime(data.measurement && data.measurement.startedAt);$('lastAt').textContent=dateTime(data.measurement && data.measurement.lastReceivedAt);
    $('dailyRows').replaceChildren();data.daily.forEach(function(r){var row=document.createElement('tr');[r.date,number(r.pageviews),number(r.sessions)].forEach(function(v){row.append(text('td',v));});$('dailyRows').append(row);});
    $('sites').replaceChildren();var max=Math.max(1,...data.bySite.map(function(r){return r.pageviews;}));
    data.bySite.forEach(function(r){var item=text('div','','site'),head=text('div','','site-head');head.append(text('span',names[r.site]),text('strong',number(r.pageviews)));item.append(head,text('small',number(r.sessions)+' 일별 방문 세션'));var bar=text('div','','bar'),fill=document.createElement('i');fill.style.width=(r.pageviews/max*100)+'%';bar.append(fill);item.append(bar);$('sites').append(item);});
    if(!data.bySite.length)$('sites').append(text('p','수집된 사이트 기록 없음','muted'));chart(data.daily);renderAudience();$('export').disabled=false;$('exportAudience').disabled=false;
  }
  function clear(message) {
    latest=null;$('audienceRows').replaceChildren();$('exportAudience').disabled=true;['pageviews','sessions','activeDays','startedAt','lastAt'].forEach(function(id){$(id).textContent='—';});
    $('dailyRows').replaceChildren();$('sites').replaceChildren(text('p','집계 데이터를 읽지 못했습니다','muted'));$('trend').replaceChildren(text('p','연결 후 실제 수집값을 표시합니다','muted'));
    $('status').className='status error';$('status').textContent=message;$('export').disabled=true;$('updated').textContent='서울 기준 · Asia/Seoul';
  }
  async function refresh() {
    if(controller)controller.abort();var current=new AbortController();controller=current;$('refresh').disabled=true;$('export').disabled=true;
    $('status').className='status';$('status').textContent='중앙 집계 확인 중';
    try{var response=await fetch('/api/admin/summary?range='+encodeURIComponent($('range').value)+'&site='+encodeURIComponent($('site').value)+'&country='+encodeURIComponent($('country').value)+'&device='+encodeURIComponent($('device').value),{credentials:'same-origin',cache:'no-store',signal:current.signal});
      if(response.status===401||response.status===403)throw Error('auth');if(!response.ok)throw Error('unavailable');
      var data=validate(await response.json());if(current!==controller)return;latest=data;render(data);
    }catch(error){if(error.name==='AbortError')return;clear(error.message==='auth'?'운영자 인증을 확인할 수 없습니다 · 다시 로그인해 주세요':'집계 서버에 연결할 수 없습니다 · 오류를 0명으로 표시하지 않습니다');}
    finally{if(current===controller)$('refresh').disabled=false;}
  }
  function exportCsv(){if(!latest)return;var lines=[['date','pageviews','daily_tab_sessions','timezone'],...latest.daily.map(function(r){return[r.date,r.pageviews,r.sessions,'Asia/Seoul'];})];var blob=new Blob(['\ufeff'+lines.map(function(r){return r.join(',');}).join('\r\n')],{type:'text/csv;charset=utf-8'});var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='orvantro-insights-'+latest.range.from+'-'+latest.range.to+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
  ['range','site','country','device'].forEach(function(id){$(id).addEventListener('change',refresh);});$('refresh').addEventListener('click',refresh);$('export').addEventListener('click',exportCsv);

  var categories={country:'국가',device:'기기 유형',platform:'운영체제',browser:'브라우저'};
  var valueNames={unknown:'알 수 없음',uncollected:'미수집',desktop:'데스크톱',mobile:'모바일',tablet:'태블릿'};
  var regions=typeof Intl.DisplayNames==='function'?new Intl.DisplayNames(['ko'],{type:'region'}):null;
  function audienceLabel(key,value){if(valueNames[value])return valueNames[value];if(key==='country'&&regions&&/^[A-Z]{2}$/.test(value)){try{return regions.of(value)+' · '+value;}catch(_){}}return value;}
  function renderAudience(){
    if(!latest)return;var key=$('dimension').value,query=$('segmentSearch').value.trim().toLowerCase();
    $('dimensionLabel').textContent=categories[key];$('audienceRows').replaceChildren();
    latest.breakdowns.country.forEach(function(row){if(!Array.from($('country').options).some(function(o){return o.value===row.value;})){var option=text('option',audienceLabel('country',row.value));option.value=row.value;$('country').append(option);}});
    latest.breakdowns[key].filter(function(r){return audienceLabel(key,r.value).toLowerCase().includes(query);}).forEach(function(r){
      var row=document.createElement('tr');[audienceLabel(key,r.value),number(r.pageviews),number(r.sessions),(latest.metrics.pageviews?r.pageviews/latest.metrics.pageviews*100:0).toFixed(1)+'%'].forEach(function(v){row.append(text('td',v));});$('audienceRows').append(row);
    });
    if(!$('audienceRows').children.length){var row=document.createElement('tr'),cell=text('td','표시할 분류 기록 없음','segment-empty');cell.colSpan=4;row.append(cell);$('audienceRows').append(row);}
  }
  function exportAudience(){if(!latest)return;var key=$('dimension').value,lines=[['dimension','value','pageviews','daily_tab_sessions','from','to','site','country_filter','device_filter'],...latest.breakdowns[key].map(function(r){return[key,r.value,r.pageviews,r.sessions,latest.range.from,latest.range.to,latest.filters.site,latest.filters.country,latest.filters.device];})];var blob=new Blob(['\ufeff'+lines.map(function(r){return r.map(function(v){return '"'+String(v).replace(/"/g,'""')+'"';}).join(',');}).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='orvantro-'+key+'-'+latest.range.to+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
  var channelNames={youtube:'YouTube',instagram:'Instagram',discord:'Discord',x:'X'};
  var metricNames={subscribers:'구독자',views:'누적 조회',videos:'공개 동영상',followers:'팔로워',posts:'게시물',members:'전체 인원(근사)',online:'온라인 인원(근사)'};
  var statusNames={ok:'자동 수집 연결됨',waiting:'첫 수집 대기',stale:'최근 수집 지연',error:'갱신 실패 · 마지막 성공값 보존',connection_required:'API 연결 승인 필요',cost_approval_required:'비용 승인 대기 · 유료 호출 꺼짐'};
  var runNames={sending:'발송 중 또는 확인 필요',sent:'발송 요청 완료',failed:'발송 실패',uncertain:'발송 결과 불확실 · 재발송 중단'};
  function metricText(metrics){return metrics?Object.entries(metrics).map(function(pair){return (metricNames[pair[0]]||pair[0])+' '+(pair[1]===null?'비공개':number(pair[1]));}).join(' · '):'수집된 수치 없음';}
  async function api(path,body){var response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'same-origin',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('request_failed');return response.json();}
  function renderIntegrations(data){
    if(!data||!Array.isArray(data.channels)||data.channels.length!==4||!data.email||!Array.isArray(data.history))throw Error('invalid_response');
    integrations=data;$('socialCards').replaceChildren();
    data.channels.forEach(function(c){var card=text('article','','social-card');card.append(text('h3',channelNames[c.id]||c.id),text('p',statusNames[c.status]||'확인 필요'),text('p',metricText(c.metrics)),text('p','마지막 성공 '+dateTime(c.lastSuccess),'muted'),text('p',c.note,'muted'));if(c.error)card.append(text('p','연결 상태 '+c.error,'muted'));var link=text('a','채널 열기 ↗');if(['https://www.youtube.com/@ORVANTRO','https://www.instagram.com/orvantro/','https://discord.gg/zu9W5uWmrr','https://x.com/orvantro'].includes(c.url)){link.href=c.url;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}$('socialCards').append(card);});
    $('socialHistory').replaceChildren();data.history.forEach(function(r){var row=document.createElement('tr');[r.day,channelNames[r.channel],dateTime(r.observedAt),metricText(r.metrics)].forEach(function(v){row.append(text('td',v));});$('socialHistory').append(row);});
    var email=data.email,last=email.runs&&email.runs[0];
    $('emailStatus').textContent=(email.enabled?(email.connected?'예약 실행 연결됨 · 마지막 확인 '+dateTime(email.lastHeartbeat):'Google 예약 실행 연결 승인 대기'):'예약 이메일 일시 중지됨')+(last?' · '+last.day+' '+(runNames[last.status]||last.status):' · 아직 발송 기록 없음');
    $('emailToggle').disabled=false;$('emailToggle').textContent=email.enabled?'예약 이메일 일시 중지':'예약 이메일 다시 켜기';
    $('socialStatus').textContent='연결 상태 갱신 '+dateTime(new Date().toISOString())+' · 자동 수집은 하루 단위 · 수동 갱신은 15분 간격';
  }
  async function loadIntegrations(){try{renderIntegrations(await api('/api/admin/integrations'));}catch(_){$('socialStatus').textContent='SNS 연결 상태를 읽지 못했습니다 · 새로고침해 주세요';$('emailStatus').textContent='예약 상태 확인 실패';$('emailToggle').disabled=true;}}
  $('dimension').addEventListener('change',renderAudience);$('segmentSearch').addEventListener('input',renderAudience);$('exportAudience').addEventListener('click',exportAudience);
  $('syncSocial').addEventListener('click',async function(){this.disabled=true;try{renderIntegrations(await api('/api/admin/integrations/sync',{}));}catch(_){$('socialStatus').textContent='갱신 요청 실패 · 마지막 기록은 보존됩니다';}finally{this.disabled=false;}});
  $('emailToggle').addEventListener('click',async function(){if(!integrations)return;this.disabled=true;try{await api('/api/admin/report/settings',{enabled:!integrations.email.enabled});await loadIntegrations();}catch(_){$('emailStatus').textContent='설정 저장 실패 · 현재 상태를 다시 확인해 주세요';this.disabled=false;}});
  $('previewReport').addEventListener('click',async function(){this.disabled=true;try{var report=await api('/api/admin/report');$('reportPreview').textContent=report.text;$('reportPreview').hidden=false;}catch(_){$('reportPreview').textContent='리포트 조회 실패';$('reportPreview').hidden=false;}finally{this.disabled=false;}});
  refresh();loadIntegrations();

})();
