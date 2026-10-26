(function () {
  'use strict';

  var PRODUCTS = [
    { id: 'all', label: '전체 제품' },
    { id: 'orvantro', label: 'ORVANTRO Hub' },
    { id: 'marginkit-pro-beta', label: 'MarginKit' },
    { id: 'markit-pro-beta', label: 'Markit / MarginKit Ent.' },
    { id: 'feeroi', label: 'Feeroi' },
    { id: 'sellerbill', label: 'SellerBill' },
    { id: 'orvantro-insights', label: 'Insights' }
  ];

  var state = {
    mode: 'empty', // empty | live | imported | sample
    events: [],
    abacus: {},
    forceSample: false,
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
    if (!raw) return [];
    var list = Array.isArray(raw) ? raw : (raw.events || raw.data || []);
    if (!Array.isArray(list)) return [];
    return list.map(function (e) {
      var props = e.event_properties || e.properties || e;
      var t = e.t || e.time || e.timestamp || Date.now();
      if (typeof t === 'string') t = Date.parse(t) || Date.now();
      return {
        t: t,
        type: e.type || e.event_type || 'orvantro_pageview',
        site: props.site || e.site || 'unknown',
        path: props.path || e.path || '/',
        returning: !!(props.visitor_returning != null ? props.visitor_returning : e.returning),
        country_code: (props.country_code || e.country_code || '').toUpperCase(),
        country: props.country || e.country || '',
        region: props.region || e.region || '',
        city: props.city || e.city || '',
        device_type: props.device_type || e.device_type || '',
        referrer: props.referrer || e.referrer || '',
        utm_source: props.utm_source || e.utm_source || '',
        utm_medium: props.utm_medium || e.utm_medium || '',
        utm_campaign: props.utm_campaign || e.utm_campaign || '',
        engaged_ms: props.engaged_ms || e.engaged_ms || 0,
        visitor_id: e.user_id || e.visitor_id || e.device_id || props.visitor_id || '',
        first_seen: props.first_seen || e.first_seen || 0,
        session_id: props.session_id || e.session_id || '',
        _sample: !!e._sample
      };
    }).filter(function (e) {
      return String(e.type).indexOf('orvantro_') === 0 || e.type === 'pageview';
    });
  }

  function loadLocalRingSync() {
    try {
      if (window.OrvantroAnalytics && OrvantroAnalytics.getRing) {
        return normalizeImported(OrvantroAnalytics.getRing());
      }
      var raw = localStorage.getItem('orvantro_analytics_ring');
      return normalizeImported(raw ? JSON.parse(raw) : []);
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
    var visitors = {};
    var returningVisitors = {};
    var newVisitors = {};
    var byDay = {};
    var bySite = {};
    var byCountry = {};
    var byPath = {};
    var byRef = {};
    var byDevice = {};
    var byUtm = {};
    var engageSum = 0;
    var engageN = 0;
    var engageBuckets = { '0–5s': 0, '5–15s': 0, '15–60s': 0, '60s+': 0 };

    pageviews.forEach(function (e) {
      var vid = e.visitor_id || (e.site + '|' + e.t);
      visitors[vid] = true;
      if (e.returning) returningVisitors[vid] = true;
      else newVisitors[vid] = true;

      var dk = dayKey(e.t);
      byDay[dk] = (byDay[dk] || 0) + 1;
      bySite[e.site || 'unknown'] = (bySite[e.site || 'unknown'] || 0) + 1;
      var cc = e.country_code || '??';
      if (!byCountry[cc]) byCountry[cc] = { code: cc, name: e.country || cc, n: 0 };
      byCountry[cc].n += 1;

      var path = e.path || '/';
      byPath[path] = (byPath[path] || 0) + 1;
      var ref = hostOf(e.referrer);
      byRef[ref] = (byRef[ref] || 0) + 1;
      var dev = e.device_type || 'unknown';
      byDevice[dev] = (byDevice[dev] || 0) + 1;

      if (e.utm_source || e.utm_medium || e.utm_campaign) {
        var uk = [e.utm_source || '—', e.utm_medium || '—', e.utm_campaign || '—'].join('\t');
        byUtm[uk] = (byUtm[uk] || 0) + 1;
      }

      if (e.engaged_ms) {
        var ms = Number(e.engaged_ms) || 0;
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
    var brandNew = Object.keys(newVisitors).length;
    var returningRate = unique ? returning / unique : 0;
    var short = pageviews.filter(function (e) { return e.engaged_ms > 0 && e.engaged_ms < 5000; }).length;
    var bounceProxy = engageN ? short / engageN : 0.35;

    return {
      pageviews: pageviews.length,
      unique: unique,
      returning: returning,
      brandNew: brandNew,
      returningRate: returningRate,
      byDay: byDay,
      bySite: bySite,
      byCountry: byCountry,
      byPath: byPath,
      byRef: byRef,
      byDevice: byDevice,
      byUtm: byUtm,
      engageBuckets: engageBuckets,
      avgEngage: engageN ? engageSum / engageN : 0,
      bounceProxy: bounceProxy,
      engageN: engageN
    };
  }

  function linearForecast(byDay, daysAhead) {
    var keys = Object.keys(byDay).sort();
    if (keys.length < 2) {
      var last = keys.length ? byDay[keys[keys.length - 1]] : 10;
      var flat = [];
      for (var i = 1; i <= daysAhead; i++) {
        var d = new Date();
        d.setDate(d.getDate() + i);
        flat.push({ day: dayKey(d.getTime()), value: last, estimate: true });
      }
      return flat;
    }
    var ys = keys.map(function (k) { return byDay[k]; });
    var n = ys.length;
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) {
      sumX += i;
      sumY += ys[i];
      sumXY += i * ys[i];
      sumXX += i * i;
    }
    var denom = n * sumXX - sumX * sumX;
    var slope = denom ? (n * sumXY - sumX * sumY) / denom : 0;
    var intercept = (sumY - slope * sumX) / n;
    var out = [];
    for (var a = 1; a <= daysAhead; a++) {
      var d2 = new Date();
      d2.setDate(d2.getDate() + a);
      var val = Math.max(0, Math.round(intercept + slope * (n - 1 + a)));
      out.push({ day: dayKey(d2.getTime()), value: val, estimate: true });
    }
    return out;
  }

  function prospectNotes(agg, forecast) {
    var notes = [];
    var fSum = forecast.reduce(function (s, x) { return s + x.value; }, 0);
    var fAvg = forecast.length ? fSum / forecast.length : 0;
    var days = Object.keys(agg.byDay).sort();
    var recent = days.slice(-3).map(function (k) { return agg.byDay[k]; });
    var recentAvg = recent.length ? recent.reduce(function (a, b) { return a + b; }, 0) / recent.length : 0;

    if (fAvg > recentAvg * 1.08) {
      notes.push({ title: '성장 전망', body: '최근 추세 기준 향후 트래픽이 완만히 상승할 가능성이 있습니다. (추정)' });
    } else if (fAvg < recentAvg * 0.92) {
      notes.push({ title: '둔화 신호', body: '최근 대비 전망 평균이 낮습니다. 유입 채널·UTM을 점검해 보세요. (추정)' });
    } else {
      notes.push({ title: '안정 구간', body: '단기 전망은 최근 평균과 비슷한 수준으로 보입니다. (추정)' });
    }

    if (agg.returningRate >= 0.45) {
      notes.push({ title: '재방문 양호', body: '재방문 비율이 높습니다. 제품 고착(habit) 신호가 있습니다.' });
    } else if (agg.unique > 0) {
      notes.push({ title: '신규 비중', body: '고유 방문 대비 재방문이 낮습니다. 온보딩·재방문 유도가 기회입니다.' });
    }

    if (agg.bounceProxy > 0.55) {
      notes.push({ title: '이탈 대리지표', body: '짧은 체류 비중이 큽니다(하트비트 기반 대리지표). 첫 화면 가치 전달을 강화하세요.' });
    } else {
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
      notes.push({ title: '제품 퍼널', body: '트래픽 1위는 ' + productLabel(sites[0]) + '입니다. Hub→제품 전환과 교차 링크를 점검하세요.' });
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
    el.innerHTML = (sample ? '<span class="sample-tag">샘플</span>' : '') + text;
  }

  function drawTrend(canvas, byDay, forecast) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    var h = canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);

    var hist = Object.keys(byDay).sort().map(function (k) {
      return { day: k, value: byDay[k], estimate: false };
    });
    var series = hist.concat(forecast || []);
    if (!series.length) return false;

    var max = Math.max.apply(null, series.map(function (s) { return s.value; })) || 1;
    var pad = 24 * (window.devicePixelRatio || 1);
    var plotW = w - pad * 2;
    var plotH = h - pad * 2;

    function xy(i, val) {
      var x = pad + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
      var y = pad + plotH - (val / max) * plotH;
      return { x: x, y: y };
    }

    ctx.strokeStyle = 'rgba(148,185,210,0.12)';
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
    ctx.strokeStyle = '#2ec4b6';
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
      ctx.fillStyle = series[k].estimate ? '#e8b84a' : '#5ec8f0';
      ctx.beginPath();
      ctx.arc(r.x, r.y, 3.2 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
      ctx.fill();
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

  function renderAbacusStrip() {
    var el = $('abacusStrip');
    var a = state.abacus;
    var chips = [
      { label: '전역 PV (Abacus)', key: 'pageviews' },
      { label: '세션', key: 'sessions' },
      { label: '신규(대략)', key: 'unique_first' },
      { label: '재방문(대략)', key: 'returning' }
    ];
    PRODUCTS.forEach(function (p) {
      if (p.id === 'all') return;
      chips.push({ label: productLabel(p.id) + ' PV', key: 'pv_' + p.id });
    });
    var html = chips.map(function (c) {
      var v = a[c.key];
      if (v == null) return '';
      return '<div class="abacus-chip"><span>' + escapeHtml(c.label) + '</span><strong>' + v + '</strong></div>';
    }).join('');
    el.innerHTML = html || '<div class="abacus-chip"><span>공개 집계</span><strong>연결 대기</strong></div>';
  }

  function render() {
    var filtered = filterEvents(state.events);
    var agg = aggregate(filtered);
    var horizon = state.filters.range >= 14 ? 14 : 7;
    var forecast = linearForecast(agg.byDay, horizon);
    var notes = prospectNotes(agg, forecast);

    $('kpiVisitors').textContent = String(agg.unique);
    $('kpiPageviews').textContent = String(agg.pageviews);
    $('kpiReturning').textContent = Math.round(agg.returningRate * 100) + '%';
    $('kpiEngage').textContent = agg.avgEngage ? (Math.round(agg.avgEngage / 1000) + 's') : '—';
    $('kpiVisitorsHint').textContent = '고유 ' + agg.unique + ' · 신규 ' + agg.brandNew + ' · 재방문 ' + agg.returning;
    $('kpiPageviewsHint').textContent = state.abacus.pageviews != null
      ? ('필터 PV · 전역 Abacus ≈ ' + state.abacus.pageviews)
      : '필터 적용 페이지뷰';
    $('kpiReturningHint').textContent = 'unique vs returning 탐지';
    $('kpiEngageHint').textContent = '하트비트 · bounce 대리 ' + Math.round(agg.bounceProxy * 100) + '%';

    var canvas = $('trendChart');
    var ok = drawTrend(canvas, agg.byDay, forecast);
    $('trendEmpty').hidden = ok;
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
      var vids = {};
      var ret = {};
      var neu = {};
      siteEvents.forEach(function (e) {
        var id = e.visitor_id || 'anon';
        vids[id] = true;
        if (e.returning) ret[id] = true;
        else neu[id] = true;
      });
      var u = Object.keys(vids).length;
      var r = Object.keys(ret).length;
      var n = Object.keys(neu).length;
      return '<tr><td>' + escapeHtml(productLabel(site)) + '</td><td>' + siteEvents.length +
        '</td><td>' + u + '</td><td>' + n + '</td><td>' + r + '</td><td>' +
        (u ? Math.round((r / u) * 100) : 0) + '%</td></tr>';
    }).join('');
    $('uniqTableBody').innerHTML = uniqRows || '<tr><td colspan="6">데이터 없음</td></tr>';

    var forecastRows = forecast.map(function (f) {
      return '<tr><td>' + f.day + ' <span class="est-tag">추정</span></td><td>' + f.value + '</td></tr>';
    }).join('');
    $('forecastTableBody').innerHTML = forecastRows || '<tr><td colspan="2">전망 불가</td></tr>';

    $('outlookList').innerHTML = notes.map(function (n) {
      return '<li><strong>' + escapeHtml(n.title) + '</strong><br>' + escapeHtml(n.body) + '</li>';
    }).join('');

    renderAbacusStrip();

    var sel = $('filterCountry');
    var current = state.filters.country;
    var allCodes = {};
    state.events.forEach(function (e) {
      if (e.country_code) allCodes[e.country_code] = e.country || e.country_code;
    });
    var opts = '<option value="all">전체 국가</option>' +
      Object.keys(allCodes).sort().map(function (c) {
        return '<option value="' + c + '"' + (c === current ? ' selected' : '') + '>' + c +
          (allCodes[c] && allCodes[c] !== c ? ' · ' + allCodes[c] : '') + '</option>';
      }).join('');
    if (sel.dataset.built !== opts) {
      sel.innerHTML = opts;
      sel.value = current;
      sel.dataset.built = opts;
    }

    var guide = $('emptyGuide');
    guide.hidden = !(state.mode === 'empty' || (state.mode === 'sample' && state.forceSample));
    if (state.mode === 'empty') guide.hidden = false;
    if (state.mode === 'live' || state.mode === 'imported') guide.hidden = true;
  }

  async function refreshAbacus() {
    var counters = ['pageviews', 'sessions', 'returning', 'unique_first'];
    var out = {};
    await Promise.all(counters.map(async function (c) {
      try {
        var r = await fetch('https://abacus.jasoncameron.dev/get/orvantro/' + c, { mode: 'cors' });
        if (r.ok) {
          var j = await r.json();
          out[c] = j.value;
        }
      } catch (e) { /* ignore */ }
    }));
    await Promise.all(PRODUCTS.filter(function (p) { return p.id !== 'all'; }).map(async function (p) {
      try {
        var r2 = await fetch('https://abacus.jasoncameron.dev/get/orvantro/pv_' + p.id, { mode: 'cors' });
        if (r2.ok) {
          var j2 = await r2.json();
          out['pv_' + p.id] = j2.value;
        }
      } catch (e2) { /* ignore */ }
    }));
    state.abacus = out;
  }

  function chooseDatasetFrom(localEvents) {
    var local = (localEvents || []).filter(function (e) { return !e._sample; });
    var imported = [];
    try {
      var raw = localStorage.getItem('orvantro_insights_import');
      if (raw) imported = normalizeImported(JSON.parse(raw));
    } catch (e) { /* ignore */ }

    if (state.forceSample) {
      state.mode = 'sample';
      state.events = seededSample();
      setStatus('샘플 시계열입니다. 「라이브 데이터」로 1st-party 저장소로 돌아갈 수 있습니다.', 'warn', true);
      return;
    }

    if (imported.length) {
      state.mode = 'imported';
      state.events = imported.concat(local);
      setStatus('가져온 JSON + 이 브라우저 1st-party 이벤트를 표시합니다. 키 설정 없음.', 'ok', false);
      return;
    }
    if (local.length >= 1) {
      state.mode = 'live';
      state.events = local;
      setStatus(
        '1st-party 저장소(IndexedDB·localStorage)의 ' + local.length +
        '개 이벤트를 표시합니다. Abacus 공개 집계는 상단 칩을 참고하세요.',
        'ok',
        false
      );
      return;
    }

    // Truly empty — prefer guidance over auto-sample; still show empty series + abacus
    state.mode = 'empty';
    state.events = [];
    setStatus(
      '수집된 이벤트가 없습니다. 다른 ORVANTRO 페이지를 열어 첫 이벤트를 만드세요. 샘플은 「샘플 보기」로 켤 수 있습니다.',
      'warn',
      false
    );
  }

  async function reloadData() {
    var local = await loadLocalStore();
    // Give tracker a moment to write this page's pageview
    if (!local.length) {
      await new Promise(function (r) { setTimeout(r, 400); });
      local = await loadLocalStore();
    }
    chooseDatasetFrom(local);
    render();
  }

  function importJson() {
    var text = $('importJson').value.trim();
    if (!text) {
      setStatus('붙여넣을 JSON이 비어 있습니다.', 'bad', false);
      return;
    }
    try {
      var parsed = JSON.parse(text);
      var events = normalizeImported(parsed);
      if (!events.length) throw new Error('empty');
      localStorage.setItem('orvantro_insights_import', JSON.stringify(events));
      state.forceSample = false;
      reloadData();
      setStatus(events.length + '개 이벤트를 가져왔습니다.', 'ok', false);
    } catch (e) {
      setStatus('JSON 형식을 읽을 수 없습니다. 링 버퍼 배열을 붙여 넣으세요.', 'bad', false);
    }
  }

  function clearImport() {
    localStorage.removeItem('orvantro_insights_import');
    $('importJson').value = '';
    state.forceSample = false;
    reloadData();
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
    $('filterProduct').innerHTML = PRODUCTS.map(function (p) {
      return '<option value="' + p.id + '">' + p.label + '</option>';
    }).join('');
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
      '\n\n피드백:\n' + body + '\n\n— ' + location.href
    );
    window.location.href = 'mailto:judanvy8@gmail.com?subject=' + subject + '&body=' + text;
    return false;
  };

  async function boot() {
    // Clear legacy Amplitude secret UX leftovers from older builds
    try { localStorage.removeItem('orvantro_amp_creds'); } catch (e) { /* ignore */ }

    fillProductFilter();
    wireFilters();
    $('btnImport').addEventListener('click', importJson);
    $('btnClearImport').addEventListener('click', clearImport);
    $('btnRefresh').addEventListener('click', async function () {
      await refreshAbacus();
      state.forceSample = false;
      await reloadData();
    });
    $('btnLive').addEventListener('click', async function () {
      state.forceSample = false;
      await reloadData();
    });
    $('btnUseSample').addEventListener('click', function () {
      state.forceSample = true;
      chooseDatasetFrom([]);
      render();
    });

    try {
      await refreshAbacus();
    } catch (e) { /* ignore */ }
    await reloadData();

    window.addEventListener('resize', function () {
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
