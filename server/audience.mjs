// Coarse classifications only; raw IP, user-agent and device identifiers are never stored
export const DEVICES = ['desktop', 'mobile', 'tablet', 'unknown', 'uncollected'];
export const DIMENSIONS = ['country', 'device', 'platform', 'browser'];
export function audienceOf(request) {
  const raw = request.cf?.country;
  const country = typeof raw === 'string' && /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : 'unknown';
  const ua = (request.headers.get('User-Agent') || '').slice(0, 1024);
  let platform = 'unknown', device = 'unknown', browser = 'unknown';
  if (!/bot|crawl|spider|headless|curl|wget/i.test(ua)) {
    if (/iPad/.test(ua)) { platform = 'iOS'; device = 'tablet'; }
    else if (/iPhone|iPod/.test(ua)) { platform = 'iOS'; device = 'mobile'; }
    else if (/Android/.test(ua)) { platform = 'Android'; device = /Mobile/.test(ua) ? 'mobile' : 'tablet'; }
    else if (/CrOS/.test(ua)) { platform = 'ChromeOS'; device = 'desktop'; }
    else if (/Windows NT/.test(ua)) { platform = 'Windows'; device = 'desktop'; }
    else if (/Macintosh|Mac OS X/.test(ua)) { platform = 'macOS'; device = 'desktop'; }
    else if (/Linux|X11/.test(ua)) { platform = 'Linux'; device = 'desktop'; }
    if (/Edg(?:e|A|iOS)?\//.test(ua)) browser = 'Edge';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
    else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
    else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
    else if (/Version\/.+Safari\//.test(ua)) browser = 'Safari';
  }
  return { country, device, platform, browser };
}
