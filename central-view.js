(function () {
  'use strict';
  function boot() {
    var config = window.INSIGHTS_CENTRAL || {}, status = document.getElementById('centralStatus');
    var scope = document.getElementById('centralScope'), metrics = document.getElementById('centralMetrics');
    var admin = document.getElementById('adminLink'), base;
    var diagnostics = document.getElementById('diagnostics');
    if (diagnostics) diagnostics.addEventListener('toggle', function () { if (diagnostics.open) window.dispatchEvent(new Event('resize')); });
    if (!status || !scope || !metrics || !admin) return;
    try { base = new URL(config.baseUrl); if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw Error('invalid'); }
    catch (_) { status.textContent = '중앙 집계 서버 연결 전'; scope.textContent = '운영자 인증과 저장 서버를 연결하면 실제 수집된 통계를 확인할 수 있습니다 · 현재 실측 수집은 꺼져 있습니다'; admin.hidden = true; return; }
    admin.href = new URL('/admin', base).href; admin.hidden = false;
    status.textContent = '공개 집계 상태 확인 중';
    fetch(new URL('/api/public/summary?range=14', base).href, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }).then(async function (response) {
      if (response.status === 403 || response.status === 404) { status.textContent = '공개 통계 비공개'; scope.textContent = '운영자 로그인 후 실제 집계를 확인할 수 있습니다 · 집계가 비공개인 상태를 방문자 0명으로 표시하지 않습니다'; return; }
      if (!response.ok) throw Error('unavailable');
      var data = await response.json();
      if (data.source !== 'central' || !data.metrics || !Number.isSafeInteger(data.metrics.pageviews) || data.metrics.pageviews < 0 || !Number.isSafeInteger(data.metrics.sessions) || data.metrics.sessions < 0) throw Error('invalid');
      status.textContent = data.status === 'empty' ? '연결 정상 · 최근 14일 수집 기록 없음' : '최근 14일 공개 집계';
      scope.textContent = '동의한 브라우저에서 수신한 기록 · 서울 시간 기준 · 일별 방문 세션 합계는 실제 사람 수가 아닙니다';
      document.getElementById('centralPv').textContent = data.metrics.pageviews.toLocaleString('ko-KR');
      document.getElementById('centralSessions').textContent = data.metrics.sessions.toLocaleString('ko-KR');
      metrics.hidden = false;
    }).catch(function () { status.textContent = '공개 집계 연결 확인 필요'; scope.textContent = '집계를 읽지 못했습니다 · 연결 오류를 방문자 0명으로 표시하지 않습니다'; metrics.hidden = true; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
