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
      var cc = text(props.country_code || e.country_code, 2).toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) cc = '';
      var path = text(props.path || e.path, 200).split(/[?#]/)[0];
      var referrer = '';
      try { var url = new URL(text(props.referrer || e.referrer, 2000));
        if (url.protocol === 'https:' || url.protocol === 'http:') referrer = url.origin;
      } catch (ignore) { /* no valid referrer */ }
      var ms = Number(props.engaged_ms != null ? props.engaged_ms : e.engaged_ms);
      return {
        t: t, type: type, site: text(props.site || e.site, 80) || 'unknown', path: path || '/',
        returning: props.visitor_returning === true || e.returning === true,
        country_code: cc, country: text(props.country || e.country, 80),
        device_type: text(props.device_type || e.device_type, 30), referrer: referrer,
        utm_source: text(props.utm_source || e.utm_source, 80),
        utm_medium: text(props.utm_medium || e.utm_medium, 80),
        utm_campaign: text(props.utm_campaign || e.utm_campaign, 80),
        engaged_ms: Number.isFinite(ms) && ms >= 0 && ms <= 86400000 ? ms : 0,
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
        if (e.returning) returningVisitors[vid] = true;
        else newVisitors[vid] = true;
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
    var bounceProxy = engageN ? short / engageN : null;

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
    } else if (agg.unique > 0) {
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



  function render() {
    var filtered = filterEvents(state.events);
    var agg = aggregate(filtered);
    var horizon = state.filters.range >= 14 ? 14 : 7;
    var forecast = linearForecast(agg.byDay, horizon);
    var notes = prospectNotes(agg, forecast);

    $('kpiVisitors').textContent = agg.unique ? String(agg.unique) : '미수집';
    $('kpiPageviews').textContent = String(agg.pageviews);
    $('kpiReturning').textContent = agg.unique ? Math.round(agg.returningRate * 100) + '%' : '미수집';
    $('kpiEngage').textContent = agg.avgEngage ? (Math.round(agg.avgEngage / 1000) + 's') : '—';
    $('kpiVisitorsHint').textContent = agg.unique ? '가져온 식별자 기준 · 실제 인원수와 다를 수 있음' : '로컬 기록에는 고유 방문자 정보가 없습니다';
    $('kpiPageviewsHint').textContent = '현재 선택한 데이터의 페이지뷰 · 전체 방문자 통계 아님';
    $('kpiReturningHint').textContent = agg.unique ? '가져온 식별자가 있는 기록만 집계' : '로컬 기록은 방문자를 식별하지 않습니다';
    $('kpiEngageHint').textContent = agg.engageN ? '참여 시간 값이 있는 페이지뷰만 집계' : '참여 시간을 수집하지 않습니다';

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
      var vids = Object.create(null);
      var ret = Object.create(null);
      var neu = Object.create(null);
      siteEvents.forEach(function (e) {
        var id = e.visitor_id;
        if (!id) return;
        vids[id] = true;
        if (e.returning) ret[id] = true;
        else neu[id] = true;
      });
      var u = Object.keys(vids).length;
      var r = Object.keys(ret).length;
      var n = Object.keys(neu).length;
      return '<tr><td>' + escapeHtml(productLabel(site)) + '</td><td>' + siteEvents.length +
        '</td><td>' + (u || '—') + '</td><td>' + (u ? n : '—') + '</td><td>' + (u ? r : '—') + '</td><td>' +
        (u ? Math.round((r / u) * 100) + '%' : '—') + '</td></tr>';
    }).join('');
    $('uniqTableBody').innerHTML = uniqRows || '<tr><td colspan="6">데이터 없음</td></tr>';

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
      '로컬 기록이 없습니다. 기록을 켜거나 JSON을 가져올 수 있습니다. 샘플은 「샘플 보기」를 눌렀을 때만 표시합니다.',
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
    var text = $('importJson').value.trim();
    if (!text) {
      setStatus('붙여넣을 JSON이 비어 있습니다.', 'bad', false);
      return;
    }
    try {
      if (text.length > 2000000) throw new Error('too large');
      var parsed = JSON.parse(text);
      var events = normalizeImported(parsed);
      if (!events.length) throw new Error('empty');
      state.imported = events;
      state.forceSample = false;
      reloadData();
      setStatus(events.length + '개 이벤트를 가져왔습니다.', 'ok', false);
    } catch (e) {
      setStatus('유효한 이벤트가 없습니다. 2MB 이하, 최대 10,000개 이벤트와 올바른 날짜를 확인하세요.', 'bad', false);
    }
  }

  function clearImport() {
    state.imported = [];
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
      var ok = await OrvantroAnalytics.clearRing();
      state.forceSample = false; state.imported = []; $('importJson').value = '';
      await reloadData();
      setStatus(ok ? '이 출처의 분석 기록을 지웠습니다.' : '일부 이전 기록을 지우지 못했습니다. 같은 출처의 다른 탭을 닫은 후 다시 시도하세요.', ok ? 'ok' : 'warn');
    });
    $('btnImport').addEventListener('click', importJson);
    $('btnClearImport').addEventListener('click', clearImport);
    $('btnRefresh').addEventListener('click', async function () {
      state.forceSample = false;
      await reloadData();
    });
    $('btnLive').addEventListener('click', async function () {
      state.forceSample = false;
      state.imported = [];
      await reloadData();
    });
    $('btnUseSample').addEventListener('click', function () {
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
