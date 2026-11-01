(function () {
  'use strict';
  var latest = null, controller = null;
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
    if(!data.bySite.length)$('sites').append(text('p','수집된 사이트 기록 없음','muted'));chart(data.daily);$('export').disabled=false;
  }
  function clear(message) {
    latest=null;['pageviews','sessions','activeDays','startedAt','lastAt'].forEach(function(id){$(id).textContent='—';});
    $('dailyRows').replaceChildren();$('sites').replaceChildren(text('p','집계 데이터를 읽지 못했습니다','muted'));$('trend').replaceChildren(text('p','연결 후 실제 수집값을 표시합니다','muted'));
    $('status').className='status error';$('status').textContent=message;$('export').disabled=true;$('updated').textContent='서울 기준 · Asia/Seoul';
  }
  async function refresh() {
    if(controller)controller.abort();var current=new AbortController();controller=current;$('refresh').disabled=true;$('export').disabled=true;
    $('status').className='status';$('status').textContent='중앙 집계 확인 중';
    try{var response=await fetch('/api/admin/summary?range='+encodeURIComponent($('range').value)+'&site='+encodeURIComponent($('site').value),{credentials:'same-origin',cache:'no-store',signal:current.signal});
      if(response.status===401||response.status===403)throw Error('auth');if(!response.ok)throw Error('unavailable');
      var data=validate(await response.json());if(current!==controller)return;latest=data;render(data);
    }catch(error){if(error.name==='AbortError')return;clear(error.message==='auth'?'운영자 인증을 확인할 수 없습니다 · 다시 로그인해 주세요':'집계 서버에 연결할 수 없습니다 · 오류를 0명으로 표시하지 않습니다');}
    finally{if(current===controller)$('refresh').disabled=false;}
  }
  function exportCsv(){if(!latest)return;var lines=[['date','pageviews','daily_tab_sessions','timezone'],...latest.daily.map(function(r){return[r.date,r.pageviews,r.sessions,'Asia/Seoul'];})];var blob=new Blob(['\ufeff'+lines.map(function(r){return r.join(',');}).join('\r\n')],{type:'text/csv;charset=utf-8'});var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='orvantro-insights-'+latest.range.from+'-'+latest.range.to+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
  ['range','site'].forEach(function(id){$(id).addEventListener('change',refresh);});$('refresh').addEventListener('click',refresh);$('export').addEventListener('click',exportCsv);refresh();
})();
