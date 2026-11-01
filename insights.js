(function () {
  'use strict';

  var PRODUCTS = [
    { id: 'all', label: '전체 기록' },
    { id: 'orvantro', label: 'ORVANTRO 홈' },
    { id: 'marginkit-pro-beta', label: 'MarginKit Suite' },
    { id: 'markit-pro-beta', label: '이전 Markit / Enterprise 기록' },
    { id: 'feeroi', label: '이전 FeeROI 기록' },
    { id: 'sellerbill', label: '이전 SellerBill 기록' },
    { id: 'orvantro-insights', label: 'Insights' }
  ];

  var state = {
    mode: 'empty', // empty | live | imported | sample
    events: [],
    imported: [],
    forceSample: false,
    sourceRevision: 0,
    filters: { range: 14, product: 'all', country: 'all' }
  };

  var $ = function (id) { return document.getElementById(id); };

  function dayKey(ts) {
    var d = new Date(ts);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function daysAgo(n) {
    var d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d.getTime();
  }

  function seededSample() {
    var sites = ['orvantro', 'marginkit-pro-beta', 'markit-pro-beta', 'feeroi', 'sellerbill', 'orvantro-insights'];
    var countries = [
      { code: 'KR', name: 'Korea, Republic of' },
      { code: 'US', name: 'United States' },
      { code: 'JP', name: 'Japan' },
      { code: 'VN', name: 'Vietnam' },
      { code: 'SG', name: 'Singapore' },
      { code: 'DE', name: 'Germany' }
    ];
    var paths = ['/', '/#ventures', '/#feedback', '/app', '/pricing'];
    var events = [];
    var visitorPool = [];
    for (var v = 0; v < 48; v++) visitorPool.push('sample-vid-' + v);

    for (var i = 13; i >= 0; i--) {
      var base = 18 + Math.round(8 * Math.sin(i / 2.2)) + (13 - i);
      var dayStart = daysAgo(i);
      for (var j = 0; j < base; j++) {
        var returning = j % 3 !== 0;
        var site = sites[(i + j) % sites.length];
        var c = countries[(i * 3 + j) % countries.length];
        var vid = visitorPool[(i * 5 + j) % visitorPool.length];
        events.push({
          t: dayStart + j * 3600 * 100 + (j % 7) * 60000,
          type: 'orvantro_pageview',
          site: site,
          path: paths[(i + j) % paths.length],
          returning: returning,
          country_code: c.code,
          country: c.name,
          device_type: j % 4 === 0 ? 'mobile' : (j % 7 === 0 ? 'tablet' : 'desktop'),
          referrer: j % 5 === 0 ? 'https://orvantro.com/' : (j % 9 === 0 ? 'https://www.google.com/' : ''),
          utm_source: j % 6 === 0 ? 'newsletter' : (j % 11 === 0 ? 'twitter' : ''),
          utm_medium: j % 6 === 0 ? 'email' : (j % 11 === 0 ? 'social' : ''),
          utm_campaign: j % 6 === 0 ? 'beta-week' : '',
          engaged_ms: 4000 + (j % 9) * 1200,
          visitor_id: vid,
          first_seen: dayStart - (returning ? 86400000 * 3 : 0),
          _sample: true
        });
      }
    }
    return events;
  }

  function normalizeImported(raw) {
    var list = Array.isArray(raw) ? raw : (raw && (raw.events || raw.data));
    if (!Array.isArray(list) || list.length > 10000) throw new Error('Invalid event list');
    function text(v, max) { return typeof v === 'string' ? v.slice(0, max || 160) : ''; }
    return list.filter(function (e) { return e && typeof e === 'object' && !Array.isArray(e); }).map(function (e) {
      var props = e.event_properties || e.properties || e;
      if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
      var sourceTime = e.t != null ? e.t : (e.time != null ? e.time : e.timestamp);
      var t = typeof sourceTime === 'string' ? Date.parse(sourceTime) : sourceTime;
      if (!Number.isFinite(t) || t <= 0 || t > Date.now()) return null;
      var type = text(e.type || e.event_type, 60);
      if (!/^orvantro_[a-z_]+$/.test(type) && type !== 'pageview') return null;
      var cc = text(props.country_code || e.country_code, 80);
      cc = /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : '';
      var path = text(props.path || e.path, 200).split(/[?#]/)[0];
      var referrer = '';
      try { var url = new URL(text(props.referrer || e.referrer, 2000));
        if (url.protocol === 'https:' || url.protocol === 'http:') referrer = url.origin;
      } catch (ignore) { /* no valid referrer */ }
      var rawMs = props.engaged_ms != null ? props.engaged_ms : e.engaged_ms;
      var ms = typeof rawMs === 'number' || (typeof rawMs === 'string' && rawMs.trim() !== '') ? Number(rawMs) : NaN;
      var returnValue = props.visitor_returning;
      if (typeof returnValue !== 'boolean') returnValue = props.returning;
      if (typeof returnValue !== 'boolean') returnValue = e.returning;
      return {
        t: t, type: type, site: text(props.site || e.site, 80) || 'unknown', path: path || '/',
        returning: typeof returnValue === 'boolean' ? returnValue : null,
        country_code: cc, country: text(props.country || e.country, 80),
        device_type: text(props.device_type || e.device_type, 30), referrer: referrer,
        utm_source: text(props.utm_source || e.utm_source, 80),
        utm_medium: text(props.utm_medium || e.utm_medium, 80),
        utm_campaign: text(props.utm_campaign || e.utm_campaign, 80),
        engaged_ms: Number.isFinite(ms) && ms >= 0 && ms <= 86400000 ? ms : null,
        visitor_id: text(e.user_id || e.visitor_id || e.device_id || props.visitor_id, 120),
        session_id: text(props.session_id || e.session_id, 120), _sample: e._sample === true
      };
    }).filter(Boolean);
  }

  function loadLocalRingSync() {
    try {
      if (window.OrvantroAnalytics && OrvantroAnalytics.getRing) {
        return normalizeImported(OrvantroAnalytics.getRing());
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  function loadLocalStore() {
    if (window.OrvantroAnalytics && OrvantroAnalytics.getStore) {
      return OrvantroAnalytics.getStore().then(function (rows) {
        return normalizeImported(rows);
      }).catch(function () {
        return loadLocalRingSync();
      });
    }
    return Promise.resolve(loadLocalRingSync());
  }

  function filterEvents(events) {
    var rangeMs = state.filters.range * 24 * 3600 * 1000;
    var cutoff = Date.now() - rangeMs;
    return events.filter(function (e) {
      if (e.t < cutoff) return false;
      if (state.filters.product !== 'all' && e.site !== state.filters.product) return false;
      if (state.filters.country !== 'all' && e.country_code !== state.filters.country) return false;
      return true;
    });
  }

  function hostOf(ref) {
    if (!ref) return '(direct)';
    try {
      return new URL(ref).hostname || ref;
    } catch (e) {
      return String(ref).slice(0, 40) || '(direct)';
    }
  }

  function aggregate(events) {
    var pageviews = events.filter(function (e) {
      return e.type === 'orvantro_pageview' || e.type === 'pageview';
    });
    var visitors = Object.create(null);
    var returningVisitors = Object.create(null);
    var newVisitors = Object.create(null);
    var byDay = Object.create(null);
    var bySite = Object.create(null);
    var byCountry = Object.create(null);
    var byPath = Object.create(null);
    var byRef = Object.create(null);
    var byDevice = Object.create(null);
    var byUtm = Object.create(null);
    var engageSum = 0;
    var engageN = 0;
    var engageBuckets = { '0–5s': 0, '5–15s': 0, '15–60s': 0, '60s+': 0 };

    pageviews.forEach(function (e) {
      var vid = e.visitor_id;
      if (vid) {
        visitors[vid] = true;
        if (e.returning === true) returningVisitors[vid] = true;
        else if (e.returning === false) newVisitors[vid] = true;
      }

      var dk = dayKey(e.t);
      byDay[dk] = (byDay[dk] || 0) + 1;
      bySite[e.site || 'unknown'] = (bySite[e.site || 'unknown'] || 0) + 1;
      var cc = e.country_code;
      if (cc) {
        if (!byCountry[cc]) byCountry[cc] = { code: cc, name: e.country || cc, n: 0 };
        byCountry[cc].n += 1;
      }

      var path = e.path || '/';
      byPath[path] = (byPath[path] || 0) + 1;
      if (e.referrer) { var ref = hostOf(e.referrer); byRef[ref] = (byRef[ref] || 0) + 1; }
      if (e.device_type) byDevice[e.device_type] = (byDevice[e.device_type] || 0) + 1;

      if (e.utm_source || e.utm_medium || e.utm_campaign) {
        var uk = [e.utm_source || '—', e.utm_medium || '—', e.utm_campaign || '—'].join('\t');
        byUtm[uk] = (byUtm[uk] || 0) + 1;
      }

      if (typeof e.engaged_ms === 'number' && Number.isFinite(e.engaged_ms) && e.engaged_ms >= 0 && e.engaged_ms <= 86400000) {
        var ms = e.engaged_ms;
        engageSum += ms;
        engageN += 1;
        if (ms < 5000) engageBuckets['0–5s'] += 1;
        else if (ms < 15000) engageBuckets['5–15s'] += 1;
        else if (ms < 60000) engageBuckets['15–60s'] += 1;
        else engageBuckets['60s+'] += 1;
      }
    });

    var unique = Object.keys(visitors).length;
    var returning = Object.keys(returningVisitors).length;
    // A visitor observed both new and returning is counted once, as returning.
    var brandNew = Object.keys(newVisitors).filter(function (id) { return !returningVisitors[id]; }).length;
    var knownVisitors = returning + brandNew;
    var returningRate = knownVisitors ? returning / knownVisitors : null;
    var short = engageBuckets['0–5s'];
    var bounceProxy = engageN ? short / engageN : null;

    return {
      pageviews: pageviews.length,
      unique: unique,
      returning: returning,
      brandNew: brandNew,
      knownVisitors: knownVisitors,
      unknownVisitors: unique - knownVisitors,
      returningRate: returningRate,
      byDay: byDay,
      bySite: bySite,
      byCountry: byCountry,
      byPath: byPath,
      byRef: byRef,
      byDevice: byDevice,
      byUtm: byUtm,
      engageBuckets: engageBuckets,
      avgEngage: engageN ? engageSum / engageN : null,
      bounceProxy: bounceProxy,
      engageN: engageN
    };
  }

  function linearForecast(byDay, daysAhead) {
    var keys = Object.keys(byDay).sort();
    if (keys.length < 3) return [];

    var ys = keys.map(function (k) { return byDay[k]; });
    var n = ys.length;
    var firstDate = Date.parse(keys[0] + 'T00:00:00Z');
    var xs = keys.map(function (k) { return (Date.parse(k + 'T00:00:00Z') - firstDate) / 86400000; });
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) {
      sumX += xs[i];
      sumY += ys[i];
      sumXY += xs[i] * ys[i];
      sumXX += xs[i] * xs[i];
    }
    var denom = n * sumXX - sumX * sumX;
    var slope = denom ? (n * sumXY - sumX * sumY) / denom : 0;
    var intercept = (sumY - slope * sumX) / n;
    var out = [];
    for (var a = 1; a <= daysAhead; a++) {
      var d2 = new Date();
      d2.setDate(d2.getDate() + a);
      var val = Math.max(0, Math.round(intercept + slope * ((Date.parse(dayKey(d2.getTime()) + 'T00:00:00Z') - firstDate) / 86400000)));
      out.push({ day: dayKey(d2.getTime()), value: val, estimate: true });
    }
    return out;
  }

  function prospectNotes(agg, forecast) {
    var notes = [];
    if (!agg.pageviews) return [{ title: '관측 데이터 없음', body: '표시할 방문 기록이 없어 추세와 참여도를 판단할 수 없습니다.' }];
    if (!forecast.length) notes.push({ title: '전망 보류', body: '서로 다른 날짜의 관측이 3일 이상 필요합니다. 빈 날짜의 방문 수는 추정하지 않습니다.' });
    var fSum = forecast.reduce(function (s, x) { return s + x.value; }, 0);
    var fAvg = forecast.length ? fSum / forecast.length : 0;
    var days = Object.keys(agg.byDay).sort();
    var recent = days.slice(-3).map(function (k) { return agg.byDay[k]; });
    var recentAvg = recent.length ? recent.reduce(function (a, b) { return a + b; }, 0) / recent.length : 0;

    if (forecast.length && fAvg > recentAvg * 1.08) {
      notes.push({ title: '성장 전망', body: '최근 추세 기준 향후 트래픽이 완만히 상승할 가능성이 있습니다. (추정)' });
    } else if (forecast.length && fAvg < recentAvg * 0.92) {
      notes.push({ title: '둔화 신호', body: '최근 대비 전망 평균이 낮습니다. 유입 채널·UTM을 점검해 보세요. (추정)' });
    } else if (forecast.length) {
      notes.push({ title: '안정 구간', body: '단기 전망은 최근 평균과 비슷한 수준으로 보입니다. (추정)' });
    }

    if (agg.returningRate >= 0.45) {
      notes.push({ title: '재방문 양호', body: '재방문 비율이 높습니다. 제품 고착(habit) 신호가 있습니다.' });
    } else if (agg.knownVisitors > 0) {
      notes.push({ title: '신규 비중', body: '고유 방문 대비 재방문이 낮습니다. 온보딩·재방문 유도가 기회입니다.' });
    }

    if (agg.bounceProxy > 0.55) {
      notes.push({ title: '이탈 대리지표', body: '짧은 체류 비중이 큽니다(하트비트 기반 대리지표). 첫 화면 가치 전달을 강화하세요.' });
    } else if (agg.engageN) {
      notes.push({ title: '참여도', body: '체류 대리지표가 양호한 편입니다. 핵심 플로우 유지에 집중하세요.' });
    }

    var countries = Object.keys(agg.byCountry).map(function (k) { return agg.byCountry[k]; })
      .sort(function (a, b) { return b.n - a.n; });
    if (countries.length) {
      var top = countries[0];
      var share = agg.pageviews ? top.n / agg.pageviews : 0;
      if (share > 0.55) {
        notes.push({ title: '지역 집중', body: top.code + ' 비중이 ' + Math.round(share * 100) + '%입니다. 현지화·피크 시간대 최적화가 전망에 유리합니다.' });
      } else {
        notes.push({ title: '지역 분산', body: '상위 국가가 비교적 분산되어 있습니다. 글로벌 메시지 일관성을 유지하세요.' });
      }
    }

    var sites = Object.keys(agg.bySite).sort(function (a, b) { return agg.bySite[b] - agg.bySite[a]; });
    if (sites.length) {
      notes.push({ title: '제품별 기록', body: '현재 데이터의 페이지뷰 1위는 ' + productLabel(sites[0]) + '입니다. 통합 이전 제품 기록은 별도로 표시됩니다.' });
    }

    var refs = Object.keys(agg.byRef).sort(function (a, b) { return agg.byRef[b] - agg.byRef[a]; });
    if (refs.length && refs[0] !== '(direct)') {
      notes.push({ title: '유입', body: '상위 리퍼러는 ' + refs[0] + '입니다. UTM·캠페인 성과와 함께 보세요.' });
    }

    return notes;
  }

  function setStatus(text, tone, sample) {
    var el = $('statusLine');
    el.dataset.tone = tone || '';
    el.textContent = (sample ? '[샘플] ' : '') + text;
  }

  function drawTrend(canvas, byDay, forecast) {
    var ctx;
    try { ctx = canvas.getContext('2d'); } catch (e) { return false; }
    if (!ctx) return false;
    var w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    var h = canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);

    var hist = Object.keys(byDay).sort().map(function (k) {
      return { day: k, value: byDay[k], estimate: false };
    });
    var series = hist.concat(forecast || []);
    if (!series.length) return false;

    var max = Math.max.apply(null, series.map(function (s) { return s.value; })) || 1;
    max = Math.ceil(max / 3) * 3;
    var pad = 36 * (window.devicePixelRatio || 1);
    var plotW = w - pad * 2;
    var plotH = h - pad * 2;

    function xy(i, val) {
      var x = pad + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
      var y = pad + plotH - (val / max) * plotH;
      return { x: x, y: y };
    }

    ctx.strokeStyle = 'rgba(148,185,210,0.16)';
    ctx.lineWidth = 1;
    for (var g = 0; g < 4; g++) {
      var gy = pad + (plotH / 3) * g;
      ctx.beginPath();
      ctx.moveTo(pad, gy);
      ctx.lineTo(w - pad, gy);
      ctx.stroke();
    }

    var split = hist.length;
    ctx.lineWidth = 2.5 * (window.devicePixelRatio || 1);
    ctx.strokeStyle = '#4ec1f0';
    ctx.beginPath();
    for (var i = 0; i < split; i++) {
      var p = xy(i, series[i].value);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    if (forecast && forecast.length && split > 0) {
      ctx.setLineDash([6 * (window.devicePixelRatio || 1), 6 * (window.devicePixelRatio || 1)]);
      ctx.strokeStyle = '#e8b84a';
      ctx.beginPath();
      var start = xy(split - 1, series[split - 1].value);
      ctx.moveTo(start.x, start.y);
      for (var j = split; j < series.length; j++) {
        var q = xy(j, series[j].value);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (var k = 0; k < series.length; k++) {
      var r = xy(k, series[k].value);
      ctx.fillStyle = series[k].estimate ? '#e8b84a' : '#4ec1f0';
      ctx.beginPath();
      ctx.arc(r.x, r.y, 3.2 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
      ctx.fill();
    }
    // Keep chart values and dates readable; the underlying metrics are unchanged.
    if (typeof ctx.fillText === 'function') {
      var dpr = window.devicePixelRatio || 1;
      ctx.font = (10 * dpr) + 'px Arial, sans-serif';
      ctx.fillStyle = '#9bb1c8';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (var tick = 0; tick < 4; tick++) {
        ctx.fillText(String(Math.round(max * (1 - tick / 3))), pad - 9 * dpr, pad + plotH * tick / 3);
      }
      ctx.textBaseline = 'top';
      for (var label = 0; label < Math.min(4, series.length); label++) {
        var index = Math.round(label * (series.length - 1) / (Math.min(4, series.length) - 1 || 1));
        var point = xy(index, 0);
        ctx.textAlign = label === 0 ? 'left' : label === Math.min(4, series.length) - 1 ? 'right' : 'center';
        ctx.fillText(String(series[index].day).slice(5).replace('-', '/'), point.x, h - pad + 12 * dpr);
      }
    }
    return true;
  }

  function renderBars(container, map, labelFn) {
    var entries = Object.keys(map).map(function (k) {
      return { key: k, n: typeof map[k] === 'number' ? map[k] : map[k].n, label: labelFn ? labelFn(k, map[k]) : k };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 8);

    if (!entries.length) {
      container.innerHTML = '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
      return;
    }
    var max = entries[0].n || 1;
    container.innerHTML = entries.map(function (e) {
      return '<div class="bar-row"><div class="name" title="' + escapeHtml(e.label) + '">' + escapeHtml(e.label) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round((e.n / max) * 100) + '%"></div></div>' +
        '<div class="num">' + e.n + '</div></div>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function productLabel(id) {
    for (var i = 0; i < PRODUCTS.length; i++) {
      if (PRODUCTS[i].id === id) return PRODUCTS[i].label;
    }
    return id;
  }

  function renderGeoMap(agg) {
    var el = $('geoMap');
    var entries = Object.keys(agg.byCountry).map(function (k) { return agg.byCountry[k]; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 12);
    if (!entries.length) {
      el.innerHTML = '';
      return;
    }
    var max = entries[0].n || 1;
    el.innerHTML = entries.map(function (c) {
      var pct = Math.round((c.n / max) * 100);
      return '<div class="geo-cell">' +
        '<div class="cc">' + escapeHtml(c.code) + '</div>' +
        '<div class="meta">' + escapeHtml(c.name || c.code) + '<br>' + c.n + ' PV</div>' +
        '<div class="heat"><span style="width:' + pct + '%"></span></div>' +
        '</div>';
    }).join('');
  }

  function renderFunnel(byPath) {
    var el = $('pathFunnel');
    var entries = Object.keys(byPath).map(function (k) {
      return { path: k, n: byPath[k] };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    if (!entries.length) {
      el.innerHTML = '<div class="chart-empty">경로 데이터가 없습니다.</div>';
      return;
    }
    el.innerHTML = entries.map(function (e, i) {
      return '<div class="funnel-step">' +
        '<div class="idx">' + (i + 1) + '</div>' +
        '<div class="path" title="' + escapeHtml(e.path) + '">' + escapeHtml(e.path) + '</div>' +
        '<div class="n">' + e.n + '</div></div>';
    }).join('');
  }



  function render() {
    fillProductFilter();
    // Validate against the whole selected dataset before filtering, not afterwards.
    if (state.filters.country !== 'all' && !state.events.some(function (e) {
      return e.country_code === state.filters.country;
    })) state.filters.country = 'all';
    var filtered = filterEvents(state.events);
    var agg = aggregate(filtered);
    var horizon = state.filters.range >= 14 ? 14 : 7;
    var forecast = linearForecast(agg.byDay, horizon);
    var notes = prospectNotes(agg, forecast);

    $('kpiVisitors').textContent = agg.unique ? String(agg.unique) : '미수집';
    $('kpiPageviews').textContent = state.mode === 'empty' ? '—' : String(agg.pageviews);
    $('kpiReturning').textContent = agg.knownVisitors ? Math.round(agg.returningRate * 100) + '%' : '미수집';
    $('kpiEngage').textContent = agg.engageN ? (Math.round(agg.avgEngage / 1000) + 's') : '—';
    $('kpiVisitorsHint').textContent = agg.unique ? (state.mode === 'sample' ? '샘플 식별자 · 실제 방문자 아님' : '가져온 식별자 기준 · 실제 인원수와 다를 수 있음') : '선택한 기록에 고유 방문자 정보가 없습니다';
    $('kpiPageviewsHint').textContent = state.mode === 'empty' ? '분석할 데이터 없음 · 실제 방문 0건이라는 뜻이 아님' : '현재 데이터와 필터에 일치하는 페이지뷰 · 전체 방문자 통계 아님';
    $('kpiReturningHint').textContent = agg.unique ? '신규·재방문 확인 식별자만 분모에 포함 · 미상 ' + agg.unknownVisitors + '명' : '선택한 기록에 방문자 식별자가 없습니다';
    $('kpiEngageHint').textContent = agg.engageN ? '0초 포함 · 유효한 참여 시간 값이 있는 페이지뷰만 집계' : '참여 시간을 수집하지 않습니다';

    var canvas = $('trendChart');
    // Empty mode hides the canvas; reveal it before reading layout dimensions.
    canvas.style.display = 'block';
    var ok = drawTrend(canvas, agg.byDay, forecast);
    $('trendEmpty').hidden = ok;
    $('trendEmpty').textContent = agg.pageviews && !ok ? '차트를 표시할 수 없습니다. 아래 표와 지표에서 데이터를 확인하세요.' : '표시할 추세가 없습니다. 기간·필터를 바꿔 보세요.';
    canvas.style.display = ok ? 'block' : 'none';

    renderBars($('siteBars'), agg.bySite, function (k) { return productLabel(k); });
    renderGeoMap(agg);
    renderBars($('countryBars'), agg.byCountry, function (k, v) {
      return (v && v.code ? v.code : k) + (v && v.name && v.name !== k ? ' · ' + v.name : '');
    });
    renderFunnel(agg.byPath);
    renderBars($('refBars'), agg.byRef, function (k) { return k; });
    renderBars($('deviceBars'), agg.byDevice, function (k) { return k; });

    var utmRows = Object.keys(agg.byUtm).sort(function (a, b) { return agg.byUtm[b] - agg.byUtm[a]; })
      .slice(0, 10).map(function (k) {
        var parts = k.split('\t');
        return '<tr><td>' + escapeHtml(parts[0]) + '</td><td>' + escapeHtml(parts[1]) +
          '</td><td>' + escapeHtml(parts[2]) + '</td><td>' + agg.byUtm[k] + '</td></tr>';
      }).join('');
    $('utmTableBody').innerHTML = utmRows || '<tr><td colspan="4">UTM 이벤트 없음</td></tr>';

    var engageTotal = Object.keys(agg.engageBuckets).reduce(function (s, k) { return s + agg.engageBuckets[k]; }, 0) || 1;
    $('engageTableBody').innerHTML = Object.keys(agg.engageBuckets).map(function (k) {
      var n = agg.engageBuckets[k];
      return '<tr><td>' + k + '</td><td>' + n + '</td><td>' + Math.round((n / engageTotal) * 100) + '%</td></tr>';
    }).join('');

    var uniqRows = Object.keys(agg.bySite).sort().map(function (site) {
      var siteEvents = filtered.filter(function (e) {
        return (e.type === 'orvantro_pageview' || e.type === 'pageview') && e.site === site;
      });
      var siteAgg = aggregate(siteEvents);
      var u = siteAgg.unique;
      return '<tr><td>' + escapeHtml(productLabel(site)) + '</td><td>' + siteEvents.length +
        '</td><td>' + (u || '—') + '</td><td>' + (u ? siteAgg.brandNew : '—') + '</td><td>' + (u ? siteAgg.returning : '—') +
        '</td><td>' + (u ? siteAgg.unknownVisitors : '—') + '</td><td>' +
        (siteAgg.knownVisitors ? Math.round(siteAgg.returningRate * 100) + '%' : '—') + '</td></tr>';
    }).join('');
    $('uniqTableBody').innerHTML = uniqRows || '<tr><td colspan="7">데이터 없음</td></tr>';

    var forecastRows = forecast.map(function (f) {
      return '<tr><td>' + f.day + ' <span class="est-tag">추정</span></td><td>' + f.value + '</td></tr>';
    }).join('');
    $('forecastTableBody').innerHTML = forecastRows || '<tr><td colspan="2">전망 불가</td></tr>';

    $('outlookList').innerHTML = notes.map(function (n) {
      return '<li><strong>' + escapeHtml(n.title) + '</strong><br>' + escapeHtml(n.body) + '</li>';
    }).join('');

    renderPrivacy();

    var sel = $('filterCountry');
    var current = state.filters.country;
    var allCodes = Object.create(null);
    state.events.forEach(function (e) {
      if (e.country_code) allCodes[e.country_code] = e.country || e.country_code;
    });
    var opts = '<option value="all">전체 국가</option>' +
      Object.keys(allCodes).sort().map(function (c) {
        return '<option value="' + escapeHtml(c) + '"' + (c === current ? ' selected' : '') + '>' + escapeHtml(c) +
          (allCodes[c] && allCodes[c] !== c ? ' · ' + escapeHtml(allCodes[c]) : '') + '</option>';
      }).join('');
    if (sel.dataset.built !== opts) {
      sel.innerHTML = opts;
      sel.value = current;
      sel.dataset.built = opts;
    }

    var guide = $('emptyGuide');
    guide.hidden = state.mode !== 'empty';
  }

  function renderPrivacy() {
    var api = window.OrvantroAnalytics;
    var enabled = !!(api && api.isEnabled());
    $('btnEnableLocal').disabled = enabled;
    $('btnDisableLocal').disabled = !enabled;
    var sourceLabels = { empty: '데이터 없음 / NO DATA', live: '이 브라우저 기록 / LOCAL', imported: '가져온 JSON / IMPORTED', sample: '샘플 데이터 / DEMO — 실제 통계 아님' };
    $('sourceStatus').textContent = sourceLabels[state.mode];
    $('sourceScope').textContent = state.mode === 'sample'
      ? '화면 탐색용 가상 데이터입니다. 실제 방문·성과가 아니며, 로컬 기록을 켜지 않아도 사용할 수 있습니다.'
      : state.mode === 'imported'
        ? '가져온 JSON만 분석합니다. 파일의 진위·누락 여부는 확인하지 않으며 로컬 기록과 합치지 않습니다. 샘플 표시 ' + state.imported.filter(function (e) { return e._sample; }).length + '개 — 샘플 표시가 없어도 실제 기록이라는 보장은 없습니다.'
        : state.mode === 'live'
          ? '이 브라우저·같은 출처의 저장된 기록만 표시합니다. 다른 기기나 전체 고객의 통계가 아닙니다. 새 기록: ' + (enabled ? '켜짐 / ON' : '꺼짐 / OFF')
          : '분석할 기록이 없습니다. 방문자가 0명이라는 의미가 아닙니다. 샘플 탐색과 JSON 가져오기는 기록을 켜지 않아도 가능합니다.';
    $('privacyStatus').textContent = enabled
      ? '이 브라우저의 같은 출처에서 로컬 기록이 켜져 있습니다. 외부 전송 없음.'
      : '로컬 기록 꺼짐. 자동 방문 수집과 외부 분석 전송을 하지 않습니다.';
  }

  function chooseDatasetFrom(localEvents) {
    var local = (localEvents || []).filter(function (e) { return !e._sample; });
    var imported = state.imported;

    if (state.forceSample) {
      state.mode = 'sample';
      state.events = seededSample();
      setStatus('샘플 시계열입니다. 「로컬 기록」으로 이 브라우저 기록으로 돌아갈 수 있습니다.', 'warn', true);
      return;
    }

    if (imported.length) {
      state.mode = 'imported';
      state.events = imported;
      setStatus('가져온 JSON만 표시합니다. 로컬 기록과 합산하지 않으며 파일 내용의 진위는 확인하지 않습니다.', 'ok', false);
      return;
    }
    if (local.length >= 1) {
      state.mode = 'live';
      state.events = local;
      setStatus(
        '이 브라우저 같은 출처에 저장된 ' + local.length +
        '개 로컬 기록입니다. 전체 방문자나 다른 기기의 통계가 아닙니다.',
        'ok',
        false
      );
      return;
    }

    // Empty is a real state; sample data is only shown on explicit request.
    state.mode = 'empty';
    state.events = [];
    setStatus(
      '로컬 기록이 없습니다. 기록을 켜거나 JSON을 가져올 수 있습니다. 샘플은 위의 「샘플로 둘러보기」를 눌렀을 때만 표시합니다.',
      'warn',
      false
    );
  }

  async function reloadData() {
    var local = await loadLocalStore();


    chooseDatasetFrom(local);
    render();
  }

  function importJson() {
    var rawText = $('importJson').value;
    var text = rawText.trim();
    var feedback = $('importFeedback');
    if (!text) {
      feedback.textContent = 'JSON이 비어 있습니다. 현재 데이터는 유지됩니다.';
      feedback.dataset.tone = 'bad';
      return;
    }
    var events, skipped;
    try {
      // Bound the original UTF-8 input, including whitespace, before parsing.
      if (rawText.length > 2000000 || new TextEncoder().encode(rawText).byteLength > 2000000) throw new Error('too large');
      var parsed = JSON.parse(text);
      events = normalizeImported(parsed);
      if (!events.length) throw new Error('empty');
      var inputRows = Array.isArray(parsed) ? parsed : (parsed.events || parsed.data);
      skipped = inputRows.length - events.length;
    } catch (e) {
      feedback.textContent = '가져오지 못했습니다. UTF-8 2MB 이하, 최대 10,000개 이벤트와 올바른 JSON·날짜를 확인하세요. 현재 데이터는 유지됩니다.';
      feedback.dataset.tone = 'bad';
      return;
    }
    // Only validation failure preserves the old data; rendering is a separate step.
    state.sourceRevision += 1;
    state.imported = events;
    state.forceSample = false;
    chooseDatasetFrom([]);
    try {
      render();
      feedback.textContent = events.length + '개 사용 · ' + skipped + '개 제외 (잘못된 형식·날짜·이벤트). 선택한 기간과 필터에 따라 표시 수가 달라집니다.';
      feedback.dataset.tone = skipped ? 'warn' : 'ok';
    } catch (e) {
      feedback.textContent = events.length + '개 이벤트를 메모리에 가져왔지만 화면 표시 중 오류가 발생했습니다. 이전 데이터로 되돌린 상태는 아닙니다.';
      feedback.dataset.tone = 'warn';
    }
  }

  function clearImport() {
    state.sourceRevision += 1;
    state.imported = [];
    $('importJson').value = '';
    $('importFeedback').textContent = '';
    state.forceSample = false;
    return reloadData();
  }

  function wireFilters() {
    $('filterRange').addEventListener('change', function () {
      state.filters.range = Number(this.value) || 14;
      render();
    });
    $('filterProduct').addEventListener('change', function () {
      state.filters.product = this.value;
      render();
    });
    $('filterCountry').addEventListener('change', function () {
      state.filters.country = this.value;
      render();
    });
  }

  function fillProductFilter() {
    var products = PRODUCTS.slice();
    var known = Object.create(null);
    products.forEach(function (p) { known[p.id] = true; });
    state.events.forEach(function (event) {
      var id = event.site || 'unknown';
      if (!known[id]) { known[id] = true; products.push({ id: id, label: id + ' (가져온 제품)' }); }
    });
    if (!known[state.filters.product]) state.filters.product = 'all';
    $('filterProduct').innerHTML = products.map(function (p) {
      return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label) + '</option>';
    }).join('');
    $('filterProduct').value = state.filters.product;
  }

  window.orvantroSubmitFeedback = function (form) {
    var fd = new FormData(form);
    var product = fd.get('product') || 'ORVANTRO Insights';
    var rating = fd.get('rating') || '';
    var email = fd.get('email') || '';
    var body = fd.get('body') || '';
    var subject = encodeURIComponent('[ORVANTRO 베타 피드백] ' + product + ' / ' + rating);
    var text = encodeURIComponent(
      '제품: ' + product + '\n만족도: ' + rating + '\n회신 이메일: ' + (email || '(없음)') +
      '\n\n피드백:\n' + body + '\n\n— ' + location.origin + location.pathname
    );
    window.location.href = 'mailto:orvantro@gmail.com?subject=' + subject + '&body=' + text;
    return false;
  };

  async function boot() {
    // Clear legacy Amplitude secret UX leftovers from older builds
    try { localStorage.removeItem('orvantro_amp_creds'); } catch (e) { /* ignore */ }

    document.querySelector('#feedback form').addEventListener('submit', function (event) { event.preventDefault(); window.orvantroSubmitFeedback(this); });
    fillProductFilter();
    wireFilters();
    $('btnEnableLocal').addEventListener('click', function () {
      state.sourceRevision += 1;
      var enabled = window.OrvantroAnalytics && OrvantroAnalytics.setEnabled(true);
      state.forceSample = false;
      state.imported = [];
      reloadData().then(function () { if (!enabled) setStatus('브라우저 저장소를 사용할 수 없어 기록을 켜지 못했습니다.', 'bad'); });
    });
    $('btnDisableLocal').addEventListener('click', function () {
      if (window.OrvantroAnalytics) OrvantroAnalytics.setEnabled(false);
      renderPrivacy();
    });
    $('btnClearLocal').addEventListener('click', async function () {
      if (!window.confirm('이 출처의 로컬 방문 기록과 이전 분석 식별자를 지울까요? 제품의 원가·계산 데이터는 유지됩니다.')) return;
      var clearRevision = ++state.sourceRevision;
      var ok = await OrvantroAnalytics.clearRing();
      // A newer source selection wins while legacy IndexedDB deletion is pending.
      if (clearRevision !== state.sourceRevision) { await reloadData(); return; }
      state.forceSample = false; state.imported = []; $('importJson').value = '';
      $('importFeedback').textContent = '';
      await reloadData();
      setStatus(ok ? '이 출처의 분석 기록을 지웠습니다.' : '일부 이전 기록을 지우지 못했습니다. 같은 출처의 다른 탭을 닫은 후 다시 시도하세요.', ok ? 'ok' : 'warn');
    });
    $('btnImport').addEventListener('click', importJson);
    $('btnImportHere').addEventListener('click', importJson);
    $('btnClearImport').addEventListener('click', clearImport);
    $('btnRefresh').addEventListener('click', async function () {
      state.sourceRevision += 1;
      state.forceSample = false;
      await reloadData();
    });
    $('btnLive').addEventListener('click', async function () {
      state.sourceRevision += 1;
      state.forceSample = false;
      state.imported = [];
      await reloadData();
    });
    $('btnUseSample').addEventListener('click', function () {
      state.sourceRevision += 1;
      state.forceSample = true;
      chooseDatasetFrom([]);
      render();
    });

    await reloadData();

    window.addEventListener('storage', function () { if (!state.forceSample && !state.imported.length) reloadData(); else renderPrivacy(); });
    window.addEventListener('resize', function () {
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
