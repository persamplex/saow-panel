// child-worker.js — DNS via DoH (adblock DoH if blockAds, else Google clean DoH)
// Force plain DNS/53 only: block DoT (853) and known DoH endpoints so client must use port 53 (MITM'd).
import { connect } from 'cloudflare:sockets';

const VERSION = '4.37.0';
const API_SECRET = 'saow-pan2';
let MOTHER_URL = null;
const MEM_LOG_MAX = 200;
const D1_LOG_MAX_ROWS = 500;

/**
 * حالت لاگ — پیش‌فرض خاموش تا D1/CPU تحت فشار نباشد.
 * env:
 *   LOG_MODE=off   → هیچ (پیش‌فرض)
 *   LOG_MODE=mem   → فقط حافظه + console (بدون نوشتن D1)
 *   LOG_MODE=full  → حافظه + console + D1
 * معادل: LOG=0|1|mem|full  یا ENABLE_LOGS=true
 */
let logMode = 'mem'; // off | mem | full

function refreshLogMode(env) {
  try {
    const raw = String(env?.LOG_MODE ?? env?.LOG ?? env?.ENABLE_LOGS ?? '')
      .toLowerCase()
      .trim();
    if (!raw || raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
      logMode = 'off';
    } else if (raw === 'mem' || raw === 'memory' || raw === 'console') {
      logMode = 'mem';
    } else if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'full' || raw === 'yes') {
      logMode = 'full';
    } else {
      logMode = 'off';
    }
  } catch (_) {
    logMode = 'off';
  }
}

const REPORT_THRESHOLD = 8 * 1024 * 1024; // هر ۸ مگ یک‌بار usage → کمتر D1
const STATUS_HTML_URL = 'https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/node-status.html';
const IP_IDLE_MS = 10 * 60 * 1000;
const SOFT_REJECT_DELAY_MS = 50;
const IP_CACHE_TTL_MS = 5 * 1000; // کش کوتاه — تا D1 زودتر دوباره چک شود
const IP_CLEANUP_PROB = 0.08; // فقط ~۸٪ درخواست‌ها cleanup idle

// ====================== DoH ======================
// DoH با فیلتر تبلیغات (برای یوزرهایی که blockAds=true دارند)
const DOH_URL = 'https://hard.dnsforge.de/dns-query';
// DoH تمیز بدون فیلتر (برای یوزرهایی که blockAds=false دارند)
const DOH_CLEAN_URL = 'https://dns.google/dns-query';
// Fallback وقتی dnsforge جواب نداد (برای دیباگ / پایداری) — Cloudflare
const DOH_FALLBACK_URL = 'https://1.1.1.1/dns-query';

const DOH_CACHE_TTL_MS = 10 * 60 * 1000; // ۱۰ دقیقه کش نتیجهٔ بلاک/اجازه
const DOH_TIMEOUT_MS = 1800; // کوتاه تا دیلی حس نشود؛ fallback سریع
const DOH_FALLBACK_TIMEOUT_MS = 1200;

// همه DNS از طریق DoH — انتخاب upstream بر اساس blockAds یوزر

// ====================== In-memory ======================
let usersByUuid = new Map();
const activeConns = new Map();
/** uuid -> Set<{ close: Function }> */
const activeSessions = new Map();
const limiters = new Map();
const ipCache = new Map(); // `${userId}|${ip}` -> { at, ok }
const memIps = new Map(); // userId -> Map<ip, lastSeen>  (اعمال limit حتی اگر D1 fail شود)
const dohCache = new Map(); // host -> { blocked: boolean, at: number }

// ====================== Egress ProxyIP (edgetunnel-compatible) ======================
/**
 * همان مدل cmliu/edgetunnel:
 *   1) به ProxyIP وصل شو (نه به مقصد)
 *   2) صبر کن socket.opened
 *   3) ClientHello با SNI مقصد را روی همان سوکت بنویس (در لایهٔ بالاتر)
 *   4) اگر چند ProxyIP بود، یکی‌یکی / موازی امتحان کن
 *   5) دامنهٔ ProxyIP → DNS TXT سپس A (مثل 解析地址端口)
 * socks5:// و http:// هم پشتیبانی می‌شوند.
 */
let egressProxy = '';
let egressDomains = [];

const DEFAULT_EGRESS_DOMAINS = [
  '*.chatgpt.com', 'chatgpt.com', '*.openai.com', 'openai.com', 'chat.openai.com',
  'speedtest.net', '*.speedtest.net', 'www.speedtest.net', 'speed.cloudflare.com',
  '*.ookla.com', 'ookla.com',
];

const EGRESS_NEVER = [
  'google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
  'youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com', 'ggpht.com',
  'gmail.com', 'dns.google', 'dns.google.com',
  'wikipedia.org', 'wikimedia.org',
];

function isNeverEgressHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const d0 of EGRESS_NEVER) {
    if (h === d0 || h.endsWith('.' + d0)) return true;
  }
  if (h.includes('.google.') || h.endsWith('.google') || h === 'google') return true;
  return false;
}

function parseProxyFull(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  let protocol = 'proxyip';
  let user = '', pass = '';
  const m = /^(socks5|socks|http|https|proxyip):\/\//i.exec(s);
  if (m) {
    protocol = m[1].toLowerCase();
    if (protocol === 'socks') protocol = 'socks5';
    if (protocol === 'https') protocol = 'http';
    s = s.slice(m[0].length);
  }
  const at = s.lastIndexOf('@');
  if (at > 0) {
    const cred = s.slice(0, at);
    s = s.slice(at + 1);
    const c = cred.indexOf(':');
    if (c >= 0) { user = cred.slice(0, c); pass = cred.slice(c + 1); }
    else user = cred;
  }
  let host = s, port = protocol === 'socks5' ? 1080 : (protocol === 'http' ? 8080 : 443);
  if (s.includes('.tp')) {
    const tp = s.match(/\.tp(\d+)/i);
    if (tp) port = parseInt(tp[1], 10) || port;
  }
  if (s.includes(':') && !s.startsWith('[') && (s.match(/:/g) || []).length === 1) {
    const i = s.lastIndexOf(':');
    const n = parseInt(s.slice(i + 1), 10);
    if (n > 0) { port = n; host = s.slice(0, i); }
  }
  host = host.trim();
  if (!host) return null;
  if (protocol === 'proxyip' && (port === 1080 || port === 1081 || port === 9050 || port === 7890)) {
    protocol = 'socks5';
  }
  return { host, port, protocol, user, pass };
}

function matchEgressHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || !egressDomains.length) return false;
  if (isNeverEgressHost(h)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return false;
  for (const d0 of egressDomains) {
    let d = String(d0 || '').trim().toLowerCase().replace(/\.$/, '');
    if (!d || d === '*' || d === '*.*') continue;
    if (d.startsWith('*.')) {
      const base = d.slice(2);
      if (!base || (!base.includes('.') && base.length < 4)) continue;
      if (h === base || h.endsWith('.' + base)) return true;
      continue;
    }
    if (!d.includes('.') && d.length < 5) continue;
    if (h === d || h.endsWith('.' + d)) return true;
  }
  return false;
}

function loadEgressFromEnv(env) {
  try {
    const p = String(env?.PROXYIP || env?.EGRESS_PROXY || '').trim();
    egressProxy = p;
    const d = String(env?.EGRESS_DOMAINS || '').trim();
    if (p && d) {
      egressDomains = d.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
    } else if (p) {
      egressDomains = DEFAULT_EGRESS_DOMAINS.slice();
    } else {
      egressDomains = [];
    }
  } catch (_) {}
}

function applyEgressFromSync(body) {
  try {
    const eg = body?.egress_proxy;
    if (!eg) return;
    if (eg.proxy != null) egressProxy = String(eg.proxy).trim();
    if (!egressProxy) {
      egressDomains = [];
      return;
    }
    if (Array.isArray(eg.domains) && eg.domains.length) {
      egressDomains = eg.domains.map((x) => String(x).trim()).filter(Boolean);
    } else if (typeof eg.domains === 'string' && eg.domains.trim()) {
      egressDomains = eg.domains.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);
    } else if (!egressDomains.length) {
      egressDomains = DEFAULT_EGRESS_DOMAINS.slice();
    }
  } catch (_) {}
}

/** DoH ساده برای resolve کردن دامنهٔ ProxyIP (TXT + A مثل edgetunnel) */
async function dohJsonQuery(name, type) {
  const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      cf: { cacheTtl: 60, cacheEverything: false },
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.Answer) ? j.Answer : [];
  } catch {
    return [];
  }
}

function parseHostPortString(str, defaultPort = 443) {
  let s = String(str || '').trim().toLowerCase();
  if (!s) return null;
  let port = defaultPort;
  let host = s;
  if (s.includes('.tp')) {
    const tp = s.match(/\.tp(\d+)/i);
    if (tp) port = parseInt(tp[1], 10) || port;
  }
  if (s.includes(']:')) {
    const parts = s.split(']:');
    host = parts[0] + ']';
    port = parseInt(parts[1], 10) || port;
  } else if ((s.match(/:/g) || []).length === 1 && !s.startsWith('[')) {
    const i = s.lastIndexOf(':');
    const n = parseInt(s.slice(i + 1), 10);
    if (n > 0) { port = n; host = s.slice(0, i); }
  }
  return [host, port];
}

/**
 * مثل 解析地址端口 در edgetunnel:
 * لیست ProxyIP را باز می‌کند؛ دامنه → TXT سپس A
 */
async function resolveProxyIPList(proxyRaw) {
  const parts = String(proxyRaw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^(socks5|socks|http|https|proxyip):\/\//i, ''));
  const out = [];
  const ipv4 = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)(\.(25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/;

  for (const single of parts) {
    const parsed = parseHostPortString(single, 443);
    if (!parsed) continue;
    let [addr, port] = parsed;

    if (ipv4.test(addr) || addr.startsWith('[')) {
      out.push([addr, port]);
      continue;
    }

    // TXT records (لیست IPهای واقعی)
    const txtAns = await dohJsonQuery(addr, 'TXT');
    const txtHosts = [];
    for (const a of txtAns) {
      let data = String(a.data || '').replace(/^"|"$/g, '');
      data = data.replace(/\\010/g, ',').replace(/\n/g, ',');
      for (const piece of data.split(',')) {
        const p = parseHostPortString(piece.trim(), port);
        if (p) txtHosts.push(p);
      }
    }
    if (txtHosts.length) {
      out.push(...txtHosts);
      continue;
    }

    const aAns = await dohJsonQuery(addr, 'A');
    const ips = aAns.filter((r) => r.type === 1 && r.data).map((r) => [r.data, port]);
    if (ips.length) {
      out.push(...ips);
      continue;
    }

    // خود دامنه
    out.push([addr, port]);
  }

  // یکتا
  const seen = new Set();
  const unique = [];
  for (const [h, p] of out) {
    const k = h + ':' + p;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push([h, p]);
  }
  return unique;
}

async function openTcp(hostname, port, timeoutMs = 8000) {
  const socket = connect({ hostname: String(hostname).replace(/^\[|\]$/g, ''), port: Number(port) || 443 });
  if (socket.opened && typeof socket.opened.then === 'function') {
    await Promise.race([
      socket.opened,
      new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), timeoutMs)),
    ]);
  }
  return socket;
}

async function readHttpConnectResponse(reader) {
  const chunks = [];
  let total = 0;
  while (total < 8192) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      chunks.push(value);
      total += value.byteLength;
      const all = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.byteLength; }
      const text = new TextDecoder().decode(all);
      if (text.includes('\r\n\r\n')) {
        const line = text.split('\r\n')[0] || '';
        if (!/ 200 /.test(line)) throw new Error('HTTP CONNECT ' + line);
        return;
      }
    }
  }
  throw new Error('HTTP CONNECT no response');
}

async function connectViaHttpProxy(proxyHost, proxyPort, targetHost, targetPort) {
  const socket = await openTcp(proxyHost, proxyPort);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`;
  await writer.write(new TextEncoder().encode(req));
  await readHttpConnectResponse(reader);
  try { writer.releaseLock(); } catch (_) {}
  try { reader.releaseLock(); } catch (_) {}
  return socket;
}

async function connectViaSocks5(proxyHost, proxyPort, targetHost, targetPort, user, pass) {
  const socket = await openTcp(proxyHost, proxyPort);
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  async function readExact(n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error('socks5 eof');
      out.set(value, o);
      o += value.byteLength;
    }
    return out;
  }

  if (user) await writer.write(new Uint8Array([0x05, 0x02, 0x00, 0x02]));
  else await writer.write(new Uint8Array([0x05, 0x01, 0x00]));

  const greet = await readExact(2);
  if (greet[0] !== 0x05) throw new Error('not socks5');
  if (greet[1] === 0x02) {
    const u = new TextEncoder().encode(user || '');
    const p = new TextEncoder().encode(pass || '');
    const auth = new Uint8Array(3 + u.length + p.length);
    auth[0] = 0x01; auth[1] = u.length; auth.set(u, 2);
    auth[2 + u.length] = p.length; auth.set(p, 3 + u.length);
    await writer.write(auth);
    const ar = await readExact(2);
    if (ar[1] !== 0x00) throw new Error('socks5 auth failed');
  } else if (greet[1] === 0xff) {
    throw new Error('socks5 no acceptable method');
  } else if (greet[1] !== 0x00) {
    throw new Error('socks5 method ' + greet[1]);
  }

  const hostBytes = new TextEncoder().encode(targetHost);
  const req = new Uint8Array(4 + 1 + hostBytes.length + 2);
  req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
  req[4] = hostBytes.length;
  req.set(hostBytes, 5);
  req[5 + hostBytes.length] = (targetPort >> 8) & 0xff;
  req[6 + hostBytes.length] = targetPort & 0xff;
  await writer.write(req);

  const hdr = await readExact(4);
  if (hdr[0] !== 0x05 || hdr[1] !== 0x00) {
    throw new Error('socks5 connect status ' + (hdr[1] ?? '?'));
  }
  const atyp = hdr[3];
  if (atyp === 0x01) await readExact(6);
  else if (atyp === 0x03) {
    const l = await readExact(1);
    await readExact(l[0] + 2);
  } else if (atyp === 0x04) await readExact(18);
  else throw new Error('socks5 atyp');

  try { writer.releaseLock(); } catch (_) {}
  try { reader.releaseLock(); } catch (_) {}
  return socket;
}

/**
 * ProxyIP خام — مثل connectProxyIP در edgetunnel
 * فقط TCP به پروکسی؛ بدون HTTP CONNECT / بدون عوض کردن SNI
 */
async function connectViaProxyIPList(proxyRaw) {
  const list = await resolveProxyIPList(proxyRaw);
  if (!list.length) throw new Error('no proxyip resolved');

  // تا ۸ تا را امتحان کن (shuffle سبک)
  const candidates = list.slice();
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const tryList = candidates.slice(0, Math.min(8, candidates.length));

  let lastErr = null;
  // concurrent 2
  for (let i = 0; i < tryList.length; i += 2) {
    const batch = tryList.slice(i, i + 2);
    const tasks = batch.map(async ([h, p]) => {
      const sock = await openTcp(h, p, 6000);
      return { sock, h, p };
    });
    try {
      const winner = await Promise.any(tasks.map(t => t.then(r => r)));
      wlog('route', 'ProxyIP connected', { via: winner.h, port: winner.p });
      // بقیه را نبند — Promise.any بقیه را reject می‌کند؛ سوکت‌های باز را best-effort ببند
      for (const t of tasks) {
        t.then(r => {
          if (r.sock !== winner.sock) {
            try { r.sock.close?.(); } catch (_) {}
          }
        }).catch(() => {});
      }
      return winner.sock;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('all proxyip failed');
}

async function connectOutbound(hostname, port) {
  const targetHost = String(hostname || '');
  const targetPort = Number(port) || 443;
  const direct = () => openTcp(targetHost, targetPort);

  if (isNeverEgressHost(targetHost)) return direct();
  if (!egressProxy || !matchEgressHost(targetHost)) return direct();

  const ep = parseProxyFull(egressProxy);
  if (!ep || !ep.host) return direct();

  wlog('route', 'EGRESS', {
    target: targetHost, targetPort, proxy: egressProxy.slice(0, 80), protocol: ep.protocol,
  });

  try {
    if (ep.protocol === 'socks5') {
      return await connectViaSocks5(ep.host, ep.port, targetHost, targetPort, ep.user, ep.pass);
    }
    if (ep.protocol === 'http') {
      return await connectViaHttpProxy(ep.host, ep.port, targetHost, targetPort);
    }
    // proxyip — مدل edgetunnel
    return await connectViaProxyIPList(egressProxy);
  } catch (e) {
    wlog('warn', 'EGRESS failed → direct', e?.message || String(e));
    return direct();
  }
}

/** خواندن عدد از چند نام فیلد ممکن */
function pickNum(obj, keys, fallback) {
  for (const k of keys) {
    if (obj == null || !(k in obj)) continue;
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * نرمال‌سازی فیلدهای محدودیت از mother یا ردیف D1
 * ipLimit: undefined → پیش‌فرض 1 | صریحاً 0 → نامحدود
 * speedLimitKBps: undefined/0 → نامحدود | >0 → KB/s
 */
function normalizeUserLimits(raw) {
  const o = raw || {};
  // IP
  let ipLimit;
  if (['ipLimit', 'ip_limit', 'maxIp', 'max_ip', 'ipCount'].some((k) => k in o && o[k] !== null && o[k] !== undefined && o[k] !== '')) {
    ipLimit = Math.max(0, pickNum(o, ['ipLimit', 'ip_limit', 'maxIp', 'max_ip', 'ipCount'], 1));
  } else {
    ipLimit = 1; // پیش‌فرض: ۱ آی‌پی
  }

  // Speed: پشتیبانی از KBps و Mbps و نام‌های مختلف
  let speedLimitKBps = 0;
  if (['speedLimitKBps', 'speed_limit_kbps', 'speedLimit', 'speed_kbps', 'limitKBps'].some((k) => k in o && o[k] != null && o[k] !== '')) {
    speedLimitKBps = Math.max(0, pickNum(o, ['speedLimitKBps', 'speed_limit_kbps', 'speedLimit', 'speed_kbps', 'limitKBps'], 0));
  } else if (['speedLimitMbps', 'speed_mbps', 'mbps'].some((k) => k in o && o[k] != null && o[k] !== '')) {
    const mbps = Math.max(0, pickNum(o, ['speedLimitMbps', 'speed_mbps', 'mbps'], 0));
    speedLimitKBps = mbps * 128; // 1 Mbps ≈ 128 KB/s
  }

  return { ipLimit, speedLimitKBps };
}

// آمار سبک DNS (per-isolate)
let dnsStats = { total: 0, ok: 0, fail: 0, fallback: 0, dotBlocked: 0, dohBlocked: 0 };

/** حلقه لاگ در حافظهٔ همین isolate — برای وقتی Observability کار نمی‌کند */
const memLogs = [];

let nodeDisabled = false;
let lastSyncAt = 0;
let childId = 'child-unknown';
let dbReady = false;
let _env = null;
let _ctx = null;

/**
 * لاگ واحد — وابسته به logMode:
 *   off  → هیچ
 *   mem  → حافظه + console
 *   full → حافظه + console + D1
 * level: info | warn | error | dns | block | route | auth
 */
function wlog(level, msg, extra) {
  if (logMode === 'off') return null;
  const ts = Date.now();
  let extraStr = '';
  try {
    if (extra !== undefined) {
      extraStr = typeof extra === 'string' ? extra : JSON.stringify(extra);
      if (extraStr.length > 1500) extraStr = extraStr.slice(0, 1500) + '…';
    }
  } catch (_) {
    extraStr = String(extra);
  }
  const line = { ts, level: String(level || 'info'), msg: String(msg || ''), extra: extraStr };
  try {
    memLogs.push(line);
    while (memLogs.length > MEM_LOG_MAX) memLogs.shift();
  } catch (_) {}
  try {
    console.log(`[${level}]`, msg, extraStr || '');
  } catch (_) {}
  // D1 فقط در حالت full
  if (logMode === 'full') {
    try {
      if (_env?.DB && _ctx && typeof _ctx.waitUntil === 'function') {
        _ctx.waitUntil(dbInsertLog(_env, line).catch(() => {}));
      }
    } catch (_) {}
  }
  return line;
}

async function dbInsertLog(env, line) {
  if (!env?.DB) return;
  try {
    await ensureDb(env);
    await env.DB.prepare(
      `INSERT INTO node_logs (ts, level, msg, extra) VALUES (?, ?, ?, ?)`
    ).bind(line.ts, line.level, line.msg, line.extra || '').run();
    // پاکسازی گاه‌به‌گاه
    if (Math.random() < 0.02) {
      await env.DB.prepare(
        `DELETE FROM node_logs WHERE id NOT IN (
          SELECT id FROM node_logs ORDER BY id DESC LIMIT ?
        )`
      ).bind(D1_LOG_MAX_ROWS).run();
    }
  } catch (_) {}
}

async function dbLoadLogs(env, limit = 100) {
  const out = {
    mem: memLogs.slice(-limit),
    d1: [],
    version: VERSION,
    childId,
    logMode,
    dnsStats: { ...dnsStats },
  };
  if (!env?.DB) return out;
  try {
    await ensureDb(env);
    const rows = await env.DB.prepare(
      `SELECT id, ts, level, msg, extra FROM node_logs ORDER BY id DESC LIMIT ?`
    ).bind(Math.min(500, Math.max(1, limit))).all();
    out.d1 = rows.results || [];
  } catch (e) {
    out.d1Error = String(e?.message || e);
  }
  return out;
}

async function dbClearLogs(env) {
  if (!env?.DB) return false;
  try {
    await ensureDb(env);
    await env.DB.prepare(`DELETE FROM node_logs`).run();
    memLogs.length = 0;
    return true;
  } catch (_) {
    return false;
  }
}

// ====================== D1 ======================
async function ensureDb(env) {
  if (!env?.DB) return false;
  if (dbReady) return true;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_state (
        key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_users (
        uuid TEXT PRIMARY KEY, id TEXT, name TEXT, enabled INTEGER DEFAULT 1,
        expiry TEXT, quota_bytes INTEGER DEFAULT 0, daily_quota_bytes INTEGER DEFAULT 0,
        speed_limit_kbps INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 1, block_ads INTEGER DEFAULT 1
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_active_ips (
        user_id TEXT NOT NULL, ip TEXT NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY (user_id, ip)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_usage_delta (
        user_id TEXT PRIMARY KEY, up INTEGER DEFAULT 0, down INTEGER DEFAULT 0
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT,
        msg TEXT,
        extra TEXT
      )`),
    ]);

    // مهاجرت: جدول‌های قدیمی ممکن است ستون block_ads نداشته باشند
    try {
      const cols = await env.DB.prepare(`PRAGMA table_info(node_users)`).all();
      const names = new Set((cols.results || []).map((r) => r.name));
      if (!names.has('block_ads')) {
        await env.DB.prepare(
          `ALTER TABLE node_users ADD COLUMN block_ads INTEGER DEFAULT 1`
        ).run();
      }
      const need = [
        ['daily_quota_bytes', 'INTEGER DEFAULT 0'],
        ['speed_limit_kbps', 'INTEGER DEFAULT 0'],
        ['ip_limit', 'INTEGER DEFAULT 1'],
      ];
      for (const [col, def] of need) {
        if (!names.has(col)) {
          await env.DB.prepare(`ALTER TABLE node_users ADD COLUMN ${col} ${def}`).run();
        }
      }
    } catch (_) {}

    dbReady = true;
    return true;
  } catch (_) {
    return false;
  }
}

async function saveUsersToDb(env, users, disabled) {
  if (!(await ensureDb(env))) return;
  try {
    const stmts = [
      env.DB.prepare('DELETE FROM node_users'),
      env.DB.prepare(
        `INSERT INTO node_state (key, value, updated_at) VALUES ('node_disabled', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).bind(disabled ? '1' : '0', Date.now()),
      env.DB.prepare(
        `INSERT INTO node_state (key, value, updated_at) VALUES ('last_sync', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).bind(String(Date.now()), Date.now()),
    ];
    for (const u of users) {
      if (!u?.uuid || !u?.id) continue;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO node_users
           (uuid, id, name, enabled, expiry, quota_bytes, daily_quota_bytes, speed_limit_kbps, ip_limit, block_ads)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          String(u.uuid).toLowerCase(), String(u.id), u.name || '',
          u.enabled === false ? 0 : 1, u.expiry || null,
          Number(u.quotaBytes) || 0, Number(u.dailyQuotaBytes) || 0,
          normalizeUserLimits(u).speedLimitKBps,
          normalizeUserLimits(u).ipLimit,
          u.blockAds === false ? 0 : 1
        )
      );
    }
    await env.DB.batch(stmts);
  } catch (_) {}
}

async function loadUsersFromDb(env) {
  if (!(await ensureDb(env))) return false;
  try {
    const rows = await env.DB.prepare('SELECT * FROM node_users').all();
    const list = rows.results || [];
    if (!list.length) return false;
    const newMap = new Map();
    for (const r of list) {
      const uuid = String(r.uuid).toLowerCase();
      {
        const lim = normalizeUserLimits({
          speed_limit_kbps: r.speed_limit_kbps,
          ip_limit: r.ip_limit,
          speedLimitKBps: r.speed_limit_kbps,
          ipLimit: r.ip_limit,
        });
        const ipLimit = (r.ip_limit === null || r.ip_limit === undefined)
          ? 1
          : Math.max(0, Number(r.ip_limit) || 0);
        newMap.set(uuid, {
          id: String(r.id), uuid, name: r.name || '',
          enabled: !!r.enabled, expiry: r.expiry || null,
          quotaBytes: r.quota_bytes || 0, dailyQuotaBytes: r.daily_quota_bytes || 0,
          speedLimitKBps: Math.max(0, Number(r.speed_limit_kbps) || 0),
          ipLimit,
          blockAds: !!r.block_ads,
        });
      }
    }
    usersByUuid = newMap;
    const dis = await env.DB.prepare(`SELECT value FROM node_state WHERE key='node_disabled'`).first();
    nodeDisabled = dis?.value === '1';
    const ls = await env.DB.prepare(`SELECT value FROM node_state WHERE key='last_sync'`).first();
    lastSyncAt = ls?.value ? Number(ls.value) : Date.now();
    return true;
  } catch (_) {
    return false;
  }
}

async function ensureUsersLoaded(env) {
  try {
    if (usersByUuid.size > 0 && lastSyncAt > 0) return;
    await loadUsersFromDb(env || _env);
  } catch (_) {}
}

async function dbAddUsage(env, userId, up, down) {
  if (!env?.DB || !userId || up + down <= 0) return;
  try {
    await ensureDb(env);
    await env.DB.prepare(`
      INSERT INTO node_usage_delta (user_id, up, down) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        up = up + excluded.up, down = down + excluded.down
    `).bind(userId, up, down).run();
  } catch (_) {}
}

async function dbLoadActiveIps(env) {
  if (!env?.DB) return [];
  try {
    await ensureDb(env);
    const cutoff = Date.now() - IP_IDLE_MS;
    await env.DB.prepare(`DELETE FROM node_active_ips WHERE last_seen < ?`).bind(cutoff).run();
    const rows = await env.DB.prepare(`SELECT user_id, ip FROM node_active_ips`).all();
    const map = new Map();
    for (const r of rows.results || []) {
      if (!map.has(r.user_id)) map.set(r.user_id, []);
      map.get(r.user_id).push(r.ip);
    }
    return Array.from(map.entries()).map(([user_id, ips]) => ({ user_id, ips }));
  } catch {
    return [];
  }
}

async function dbLoadAndClearUsage(env) {
  if (!env?.DB) return [];
  try {
    await ensureDb(env);
    const rows = await env.DB.prepare(
      `SELECT user_id, up, down FROM node_usage_delta WHERE up + down > 0`
    ).all();
    const list = (rows.results || []).map((r) => ({
      user_id: r.user_id, up: Number(r.up) || 0, down: Number(r.down) || 0,
    }));
    if (list.length) await env.DB.prepare(`DELETE FROM node_usage_delta`).run();
    return list;
  } catch {
    return [];
  }
}

/**
 * محدودیت IP همزمان — D1 اول (بین isolate)، حافظه دوم.
 * ترتیب: cleanup → لیست فعال → اگر IP هست OK → اگر ظرفیت پر است رد → insert → تأیید دوباره
 * limit <= 0 → نامحدود
 */
async function tryAcquireIp(env, userId, ip, limit) {
  const maxIps = Number(limit);
  if (!Number.isFinite(maxIps) || maxIps <= 0) return { ok: true, unlimited: true };
  if (!userId || !ip) return { ok: true, fallback: true };

  const ipStr = String(ip).trim();
  if (!isValidPublicIp(ipStr) || ipStr === '0.0.0.0') {
    return { ok: true, skipped: true, reason: 'invalid-or-unknown-ip' };
  }
  const key = userId + '|' + ipStr;
  const now = Date.now();
  const cutoff = now - IP_IDLE_MS;

  let m = memIps.get(userId);
  if (!m) {
    m = new Map();
    memIps.set(userId, m);
  }
  for (const [x, ts] of m) {
    if (now - ts > IP_IDLE_MS) m.delete(x);
  }

  const cached = ipCache.get(key);
  if (cached && cached.ok && now - cached.at < IP_CACHE_TTL_MS) {
    m.set(ipStr, now);
    return { ok: true, cached: true, limit: maxIps };
  }

  if (!env?.DB) {
    if (!m.has(ipStr) && m.size >= maxIps) {
      return { ok: false, reason: 'ip limit', current: m.size, limit: maxIps, via: 'memory' };
    }
    m.set(ipStr, now);
    ipCache.set(key, { at: now, ok: true });
    return { ok: true, via: 'memory-only', current: m.size, limit: maxIps };
  }

  try {
    await ensureDb(env);

    await env.DB.prepare(
      `DELETE FROM node_active_ips WHERE user_id = ? AND last_seen < ?`
    ).bind(userId, cutoff).run();

    const listed = await env.DB.prepare(
      `SELECT ip, last_seen FROM node_active_ips WHERE user_id = ? ORDER BY last_seen ASC`
    ).bind(userId).all();
    const rows = listed.results || [];
    const known = new Set(rows.map((r) => String(r.ip)));

    if (known.has(ipStr)) {
      await env.DB.prepare(
        `UPDATE node_active_ips SET last_seen = ? WHERE user_id = ? AND ip = ?`
      ).bind(now, userId, ipStr).run();
      m.set(ipStr, now);
      ipCache.set(key, { at: now, ok: true });
      return { ok: true, existing: true, current: known.size, limit: maxIps };
    }

    if (rows.length >= maxIps) {
      return {
        ok: false,
        reason: 'ip limit',
        current: rows.length,
        limit: maxIps,
        held: rows.map((r) => r.ip),
        via: 'd1-pre',
      };
    }

    await env.DB.prepare(
      `INSERT INTO node_active_ips (user_id, ip, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen`
    ).bind(userId, ipStr, now).run();

    const listed2 = await env.DB.prepare(
      `SELECT ip, last_seen FROM node_active_ips WHERE user_id = ? AND last_seen >= ? ORDER BY last_seen ASC`
    ).bind(userId, cutoff).all();
    const rows2 = listed2.results || [];

    if (rows2.length > maxIps) {
      const keep = new Set(rows2.slice(0, maxIps).map((r) => String(r.ip)));
      for (const r of rows2) {
        const x = String(r.ip);
        if (!keep.has(x)) {
          await env.DB.prepare(
            `DELETE FROM node_active_ips WHERE user_id = ? AND ip = ?`
          ).bind(userId, x).run();
        }
      }
      if (!keep.has(ipStr)) {
        m.delete(ipStr);
        ipCache.delete(key);
        return {
          ok: false,
          reason: 'ip limit',
          current: rows2.length,
          limit: maxIps,
          via: 'd1-race',
        };
      }
    }

    m.set(ipStr, now);
    ipCache.set(key, { at: now, ok: true });
    if (ipCache.size > 500) ipCache.delete(ipCache.keys().next().value);
    return { ok: true, current: Math.min(rows2.length, maxIps), limit: maxIps, via: 'd1' };
  } catch (_) {
    if (!m.has(ipStr) && m.size >= maxIps) {
      return { ok: false, reason: 'ip limit', current: m.size, limit: maxIps, via: 'memory-fallback' };
    }
    m.set(ipStr, now);
    ipCache.set(key, { at: now, ok: true });
    return { ok: true, via: 'memory-fallback', current: m.size, limit: maxIps };
  }
}

function touchActiveIp(env, userId, ip) {
  if (!userId || !ip) return;
  const ipStr = String(ip);
  const now = Date.now();
  const m = memIps.get(userId);
  if (m) m.set(ipStr, now);
  const key = userId + '|' + ipStr;
  const cached = ipCache.get(key);
  if (cached && now - cached.at < IP_CACHE_TTL_MS) return;
  ipCache.set(key, { at: now, ok: true });
  if (!env?.DB) return;
  const run = env.DB.prepare(`
    UPDATE node_active_ips SET last_seen = ? WHERE user_id = ? AND ip = ?
  `).bind(now, userId, ipStr).run().catch(() => {});
  if (_ctx && typeof _ctx.waitUntil === 'function') _ctx.waitUntil(run);
}

// ====================== Helpers ======================
function generateChildId(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return 'child-' + hostname.replace(/[^a-z0-9.-]/g, '').replace(/\./g, '-');
  } catch {
    return 'child-unknown';
  }
}

/**
 * IP واقعی کلاینت روی Cloudflare Workers
 * فقط CF-Connecting-IP قابل‌اعتماد است؛ XFF را فقط اگر شبیه IP عمومی معتبر بود استفاده می‌کنیم.
 */
function isValidPublicIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const s = ip.trim();
  const m4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const a = [+m4[1], +m4[2], +m4[3], +m4[4]];
    if (a.some((n) => n > 255)) return false;
    if (a[0] === 0) return false;
    if (a[0] === 10) return false;
    if (a[0] === 127) return false;
    if (a[0] === 169 && a[1] === 254) return false;
    if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return false;
    if (a[0] === 192 && a[1] === 168) return false;
    if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return false;
    if (a[0] === 104 && a[1] >= 16 && a[1] <= 31) return false;
    if (a[0] === 172 && a[1] >= 64 && a[1] <= 71) return false;
    if (a[0] === 173 && a[1] === 245) return false;
    if (a[0] === 103 && a[1] === 21 && a[2] === 244) return false;
    if (a[0] === 141 && a[1] === 101) return false;
    if (a[0] === 108 && a[1] === 162) return false;
    if (a[0] === 190 && a[1] === 93) return false;
    if (a[0] === 188 && a[1] === 114) return false;
    if (a[0] === 197 && a[1] === 234) return false;
    if (a[0] === 198 && a[1] === 41) return false;
    if (a[0] === 162 && a[1] === 158) return false;
    if (a[0] === 205 && a[1] >= 251) return false;
    return true;
  }
  if (s.includes(':')) {
    const low = s.toLowerCase();
    if (low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return false;
    const mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isValidPublicIp(mapped[1]);
    return true;
  }
  return false;
}

function getClientIP(request) {
  try {
    const cfIp = (request.headers.get('CF-Connecting-IP') || request.headers.get('cf-connecting-ip') || '').trim();
    if (isValidPublicIp(cfIp)) return cfIp;

    const trueIp = (request.headers.get('True-Client-IP') || request.headers.get('true-client-ip') || '').trim();
    if (isValidPublicIp(trueIp)) return trueIp;

    const xff = request.headers.get('X-Forwarded-For') || request.headers.get('x-forwarded-for') || '';
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        if (isValidPublicIp(p)) return p;
      }
    }
  } catch (_) {}
  return '0.0.0.0';
}

function extractSecret(request) {
  const h = request.headers;
  const auth = h.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (h.get('x-mother-secret') || h.get('x-api-key') || h.get('x-secret') || '').trim();
}

function requireMotherAuth(request) {
  const secret = extractSecret(request);
  return !!(secret && secret === API_SECRET);
}

function isExpired(expiry) {
  if (!expiry) return false;
  const t = Date.parse(expiry);
  return Number.isFinite(t) && Date.now() > t;
}

function getUserByUuid(uuid) {
  if (!uuid) return null;
  const cfg = usersByUuid.get(String(uuid).toLowerCase());
  if (!cfg || !cfg.enabled || isExpired(cfg.expiry)) return null;
  return cfg;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function isIpLiteral(host) {
  const h = String(host || '').trim();
  if (!h) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(':')) return true;
  return false;
}

// ====================== Rate Limiter (token bucket, per uuid) ======================
/** kbps <= 0 → بدون محدودیت */
function createRateLimiter(kbps) {
  const bytesPerSec = kbps > 0 ? kbps * 1024 : 0;
  if (!bytesPerSec) return { enabled: false, async take() {} };

  const burst = Math.max(bytesPerSec * 2, 64 * 1024);
  let tokens = burst;
  let last = Date.now();
  let tail = Promise.resolve();

  const doTake = async (n) => {
    n = Math.max(0, n | 0);
    if (!n) return;
    for (;;) {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * bytesPerSec);
      last = now;
      if (tokens >= n) {
        tokens -= n;
        return;
      }
      const need = n - tokens;
      const waitMs = Math.min(150, Math.max(5, Math.ceil((need / bytesPerSec) * 1000)));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  };

  return {
    enabled: true,
    kbps,
    take(n) {
      const run = tail.then(() => doTake(n));
      tail = run.catch(() => {});
      return run;
    },
  };
}

function getLimiter(uuid, kbps) {
  const k = Math.max(0, Number(kbps) || 0);
  if (k <= 0) return { enabled: false, async take() {} };
  let entry = limiters.get(uuid);
  if (!entry || entry.kbps !== k) {
    entry = { kbps: k, limiter: createRateLimiter(k) };
    limiters.set(uuid, entry);
  }
  return entry.limiter;
}

// ====================== DoH Ad-Block & Resolve ======================
function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** ساخت یک کوئری DNS ساده برای رکورد A */
function buildDnsQueryA(hostname) {
  const labels = String(hostname).toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const nameParts = [];
  for (const label of labels) {
    const enc = new TextEncoder().encode(label);
    if (enc.length > 63) return null;
    nameParts.push(enc.length);
    for (let i = 0; i < enc.length; i++) nameParts.push(enc[i]);
  }
  nameParts.push(0);

  const id = Math.floor(Math.random() * 65535);
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint16(0, id);
  view.setUint16(2, 0x0100);
  view.setUint16(4, 1);

  const question = new Uint8Array(nameParts.length + 4);
  question.set(nameParts, 0);
  const qView = new DataView(question.buffer);
  qView.setUint16(nameParts.length, 1);
  qView.setUint16(nameParts.length + 2, 1);

  const packet = new Uint8Array(header.length + question.length);
  packet.set(header, 0);
  packet.set(question, header.length);
  return packet;
}

/** پارس پاسخ DoH و تشخیص بلاک بودن (0.0.0.0 یا بدون A) */
function isBlockedFromDnsResponse(buf) {
  if (!buf || buf.byteLength < 12) return false;
  const view = new DataView(buf);
  const flags = view.getUint16(2);
  const rcode = flags & 0x0f;
  if (rcode !== 0) return false;

  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  if (ancount === 0) return true;

  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    while (offset < buf.byteLength) {
      const len = view.getUint8(offset);
      if (len === 0) { offset += 1; break; }
      if ((len & 0xc0) === 0xc0) { offset += 2; break; }
      offset += 1 + len;
    }
    offset += 4;
  }

  let hasRealA = false;
  for (let i = 0; i < ancount && offset + 10 < buf.byteLength; i++) {
    while (offset < buf.byteLength) {
      const len = view.getUint8(offset);
      if (len === 0) { offset += 1; break; }
      if ((len & 0xc0) === 0xc0) { offset += 2; break; }
      offset += 1 + len;
    }
    if (offset + 10 > buf.byteLength) break;
    const rtype = view.getUint16(offset); offset += 2;
    offset += 2;
    offset += 4;
    const rdlen = view.getUint16(offset); offset += 2;
    if (rtype === 1 && rdlen === 4 && offset + 4 <= buf.byteLength) {
      const a = view.getUint8(offset);
      const b = view.getUint8(offset + 1);
      const c = view.getUint8(offset + 2);
      const d = view.getUint8(offset + 3);
      if (a === 0 && b === 0 && c === 0 && d === 0) {
        return true;
      }
      hasRealA = true;
    }
    offset += rdlen;
  }
  return !hasRealA;
}

async function queryDohBlocked(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || isIpLiteral(h)) return false;

  const now = Date.now();
  const cached = dohCache.get(h);
  if (cached && now - cached.at < DOH_CACHE_TTL_MS) {
    return cached.blocked;
  }

  try {
    const query = buildDnsQueryA(h);
    if (!query) return false;

    const dnsParam = base64UrlEncode(query);
    const url = `${DOH_URL}?dns=${dnsParam}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/dns-message',
        'User-Agent': 'cf-child/' + VERSION,
      },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    clearTimeout(timer);

    if (!res.ok) {
      dohCache.set(h, { blocked: false, at: now });
      return false;
    }

    const buf = await res.arrayBuffer();
    const blocked = isBlockedFromDnsResponse(buf);

    dohCache.set(h, { blocked, at: now });
    if (dohCache.size > 2000) {
      const first = dohCache.keys().next().value;
      dohCache.delete(first);
    }
    return blocked;
  } catch (_) {
    dohCache.set(h, { blocked: false, at: now });
    return false;
  }
}

async function isAdHost(host) {
  return queryDohBlocked(host);
}

/** upstream: اگر blockAds فعال → DOH_URL (فیلتردار)، وگرنه DOH_CLEAN_URL */
function pickDohUrl(blockAds) {
  return blockAds ? DOH_URL : DOH_CLEAN_URL;
}

/** استخراج نام دامنه (QNAME) از یک کوئری DNS باینری */
function parseDnsQname(buf) {
  try {
    if (!buf || buf.byteLength < 13) return null;
    const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let offset = 12; // بعد از هدر
    const labels = [];
    for (let i = 0; i < 64; i++) {
      if (offset >= view.byteLength) return null;
      const len = view[offset];
      if (len === 0) {
        offset += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        offset += 2;
        break;
      }
      if (len > 63 || offset + 1 + len > view.byteLength) return null;
      let label = '';
      for (let j = 0; j < len; j++) label += String.fromCharCode(view[offset + 1 + j]);
      labels.push(label);
      offset += 1 + len;
    }
    if (!labels.length) return null;
    let qtype = 0;
    if (offset + 4 <= view.byteLength) {
      qtype = (view[offset] << 8) | view[offset + 1];
    }
    const typeMap = { 1: 'A', 28: 'AAAA', 5: 'CNAME', 15: 'MX', 16: 'TXT', 2: 'NS', 12: 'PTR' };
    return {
      name: labels.join('.'),
      type: typeMap[qtype] || String(qtype),
      qtype,
    };
  } catch (_) {
    return null;
  }
}

/**
 * رزولوشن واقعی DNS از طریق DoH.
 * اگر primary (dnsforge) fail شد → فوراً fallback به 1.1.1.1 تا دیلی حس نشود.
 */
async function fetchDohOnce(upstream, q, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': 'cf-child/' + VERSION,
      },
      body: q,
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    clearTimeout(timer);
    if (res.ok) {
      return new Uint8Array(await res.arrayBuffer());
    }
    // GET fallback
    const dnsParam = base64UrlEncode(q);
    const res2 = await fetch(`${upstream}?dns=${dnsParam}`, {
      method: 'GET',
      headers: { 'Accept': 'application/dns-message', 'User-Agent': 'cf-child/' + VERSION },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res2.ok) return null;
    return new Uint8Array(await res2.arrayBuffer());
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

async function dohResolve(dnsQueryBytes, blockAds = true) {
  if (!dnsQueryBytes || dnsQueryBytes.byteLength < 12) {
    wlog('dns', 'REJECT empty/short query', dnsQueryBytes?.byteLength);
    return null;
  }
  const q = dnsQueryBytes instanceof Uint8Array ? dnsQueryBytes : new Uint8Array(dnsQueryBytes);
  const primary = pickDohUrl(!!blockAds);
  dnsStats.total += 1;

  const qinfo = parseDnsQname(q);
  const qname = qinfo ? `${qinfo.name} (${qinfo.type})` : '?';

  wlog('dns', 'START resolve', {
    qname,
    primary,
    blockAds: !!blockAds,
    qlen: q.byteLength,
    total: dnsStats.total,
  });

  // primary (dnsforge وقتی blockAds)
  let resp = await fetchDohOnce(primary, q, DOH_TIMEOUT_MS);
  if (resp && resp.byteLength >= 12) {
    dnsStats.ok += 1;
    wlog('dns', 'OK primary', { qname, primary, len: resp.byteLength, ok: dnsStats.ok });
    return resp;
  }

  wlog('dns', 'primary FAILED → fallback', { qname, primary });

  // fallback سریع به 1.1.1.1
  resp = await fetchDohOnce(DOH_FALLBACK_URL, q, DOH_FALLBACK_TIMEOUT_MS);
  if (resp && resp.byteLength >= 12) {
    dnsStats.ok += 1;
    dnsStats.fallback += 1;
    wlog('dns', 'FALLBACK OK', { qname, len: resp.byteLength, fallback: dnsStats.fallback });
    return resp;
  }

  dnsStats.fail += 1;
  wlog('dns', 'FAIL both', { qname, primary, fail: dnsStats.fail });
  return null;
}

// ====================== Known DNS / DoH hosts ======================
/**
 * فقط این‌ها روی پورت 53 به‌عنوان DNS ساده پذیرفته و MITM می‌شوند.
 * هر پورت 53 به آدرس دیگر رد می‌شود.
 */
const DNS_PLAIN_HOSTS = new Set([
  '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9',
  '149.112.112.112',
  'dns.google', 'dns.google.com',
  'cloudflare-dns.com', 'one.one.one.one', 'dns.cloudflare.com',
  'dns.adguard.com', 'dns.quad9.net',
  'dns.dnsforge.de', 'hard.dnsforge.de',
  'dns.nextdns.io', 'dns.controld.com',
  'doh.opendns.com', 'resolver1.opendns.com', 'resolver2.opendns.com',
]);

/**
 * هاست‌های DoH/DoT/Encrypted-DNS — روی هر پورتی غیر از 53 کاملاً بسته می‌شوند
 * تا کلاینت مجبور شود فقط plain DNS/53 بفرستد و MITM شود.
 */
const DOH_BLOCK_HOSTS = new Set([
  // Cloudflare DoH/DoT
  '1.1.1.1', '1.0.0.1', '1.1.1.2', '1.0.0.2', '1.1.1.3', '1.0.0.3',
  'cloudflare-dns.com', 'one.one.one.one', 'dns.cloudflare.com',
  'mozilla.cloudflare-dns.com', 'security.cloudflare-dns.com', 'family.cloudflare-dns.com',
  'chrome.cloudflare-dns.com', 'dns64.cloudflare-dns.com',
  // Google
  '8.8.8.8', '8.8.4.4', 'dns.google', 'dns.google.com', 'dns.google.com.',
  // Quad9
  '9.9.9.9', '9.9.9.10', '9.9.9.11', '149.112.112.112', '149.112.112.10',
  'dns.quad9.net', 'dns9.quad9.net', 'dns10.quad9.net', 'dns11.quad9.net',
  // AdGuard
  'dns.adguard.com', 'dns-family.adguard.com', 'dns-unfiltered.adguard.com',
  'dns.adguard-dns.com', 'family.adguard-dns.com', 'unfiltered.adguard-dns.com',
  // NextDNS / ControlD / OpenDNS
  'dns.nextdns.io', 'dns.controld.com',
  'doh.opendns.com', 'resolver1.opendns.com', 'resolver2.opendns.com',
  '208.67.222.222', '208.67.220.220',
  // dnsforge / others
  'dns.dnsforge.de', 'hard.dnsforge.de', 'soft.dnsforge.de',
  // common public DoH
  'doh.dns.sb', 'doh.pub', 'dns.alidns.com', 'doh.360.cn',
  'dns.sb', 'doh.li', 'dns.twnic.tw', 'doh.powerdns.org',
  'dns.switch.ch', 'dns.osl.basekampen.net',
  'cloudflare-dns.com.', 'dns.google.',
  // Mullvad / LibreDNS / BlahDNS / etc
  'doh.mullvad.net', 'adblock.doh.mullvad.net',
  'doh.libredns.gr', 'doh.blahdns.com',
  'dns.rubyfish.cn', 'doh.tiar.app',
  // Apple / private relay-ish
  'mask.icloud.com', 'mask-h2.icloud.com',
  // DoH over common CDNs sometimes used
  'dns.aa.net.uk', 'dns.digitale-gesellschaft.ch',
]);

/** پورت‌های معروف Encrypted DNS (غیر از 53) */
const ENCRYPTED_DNS_PORTS = new Set([853, 784, 8853, 5353]);

function isKnownDnsHost(addr) {
  return DNS_PLAIN_HOSTS.has(String(addr || '').toLowerCase());
}

function isDohEndpoint(addr) {
  return DOH_BLOCK_HOSTS.has(String(addr || '').toLowerCase());
}

/**
 * آیا این مقصد باید به‌عنوان Encrypted-DNS / DoH / DoT بلاک شود؟
 * - پورت 853 (و چند پورت معروف دیگر) همیشه بلاک
 * - هاست‌های DoH روی هر پورت غیر از 53 بلاک
 * نتیجه: فقط plain DNS روی 53 به هاست‌های مجاز → MITM
 */
function shouldBlockEncryptedDns(addr, port) {
  const a = String(addr || '').toLowerCase();
  const p = Number(port);
  if (ENCRYPTED_DNS_PORTS.has(p) || p === 853) {
    return { block: true, reason: 'encrypted-dns-port', port: p };
  }
  // DoH معمولاً روی 443/80 است — هاست‌های شناخته‌شده را ببند
  if (p !== 53 && isDohEndpoint(a)) {
    return { block: true, reason: 'doh-endpoint', host: a, port: p };
  }
  return { block: false };
}

// ====================== VLESS ======================
function parseVlessHeader(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 19 || view.getUint8(0) !== 0) return { ok: false };
  const uuidBytes = new Uint8Array(buffer, 1, 16);
  let offset = 17;
  const addonLen = view.getUint8(offset);
  offset += 1 + addonLen;
  if (offset + 4 > buffer.byteLength) return { ok: false };
  const cmd = view.getUint8(offset);
  offset += 1;
  if (cmd !== 1 && cmd !== 2) return { ok: false };
  const port = view.getUint16(offset);
  offset += 2;
  const atype = view.getUint8(offset);
  offset += 1;
  let address = '';
  if (atype === 1) {
    if (offset + 4 > buffer.byteLength) return { ok: false };
    address = Array.from(new Uint8Array(buffer, offset, 4)).join('.');
    offset += 4;
  } else if (atype === 2) {
    const dlen = view.getUint8(offset);
    offset += 1;
    if (offset + dlen > buffer.byteLength) return { ok: false };
    address = new TextDecoder().decode(new Uint8Array(buffer, offset, dlen));
    offset += dlen;
  } else if (atype === 3) {
    if (offset + 16 > buffer.byteLength) return { ok: false };
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(view.getUint16(offset + i * 2).toString(16));
    address = parts.join(':');
    offset += 16;
  } else return { ok: false };

  const uuidHex = Array.from(uuidBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const uuid = [
    uuidHex.slice(0, 8), uuidHex.slice(8, 12), uuidHex.slice(12, 16),
    uuidHex.slice(16, 20), uuidHex.slice(20),
  ].join('-');

  return {
    ok: true, cmd, address, port, uuid,
    rest: buffer.byteLength > offset ? buffer.slice(offset) : null,
  };
}

// ====================== Sync ======================
async function handleSync(request, env) {
  if (!requireMotherAuth(request)) {
    return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid json' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  if (body?.type !== 'full_sync') {
    return new Response(JSON.stringify({ ok: false, reason: 'unknown type' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  nodeDisabled = !!(body.node && body.node.disabled);
  const users = Array.isArray(body.users) ? body.users : [];
  const newMap = new Map();
  for (const u of users) {
    if (!u?.uuid || !u?.id) continue;
    const uuid = String(u.uuid).toLowerCase();
    {
      const lim = normalizeUserLimits(u);
      newMap.set(uuid, {
        id: String(u.id), uuid, name: u.name || '',
        enabled: u.enabled !== false, expiry: u.expiry || null,
        quotaBytes: Number(u.quotaBytes) || Number(u.quota_bytes) || 0,
        dailyQuotaBytes: Number(u.dailyQuotaBytes) || Number(u.daily_quota_bytes) || 0,
        speedLimitKBps: lim.speedLimitKBps,
        ipLimit: lim.ipLimit,
        blockAds: u.blockAds !== false && u.block_ads !== 0 && u.block_ads !== false,
      });
    }
  }

  usersByUuid = newMap;
  lastSyncAt = Date.now();
  applyEgressFromSync(body);
  ipCache.clear();
  memIps.clear();
  limiters.clear();

  for (const [uuid, sessions] of [...activeSessions.entries()]) {
    const cfg = usersByUuid.get(uuid);
    const shouldDrop = !cfg || !cfg.enabled || isExpired(cfg.expiry);
    if (shouldDrop) {
      for (const s of sessions) {
        try { s.close(); } catch {}
      }
      activeSessions.delete(uuid);
      activeConns.delete(uuid);
    }
  }

  if (nodeDisabled) {
    for (const [uuid, sessions] of [...activeSessions.entries()]) {
      for (const s of sessions) {
        try { s.close(); } catch {}
      }
      activeSessions.delete(uuid);
      activeConns.delete(uuid);
    }
  }

  await saveUsersToDb(env, users, nodeDisabled);

  const usageReport = await dbLoadAndClearUsage(env);
  const activeIpsReport = await dbLoadActiveIps(env);
  let activeUsersCount = 0;
  for (const c of activeConns.values()) if (c > 0) activeUsersCount++;
  if (activeIpsReport.length > activeUsersCount) activeUsersCount = activeIpsReport.length;

  return new Response(JSON.stringify({
    ok: true, child_id: childId, version: VERSION, capacity: 64,
    active_users: activeUsersCount, healthy: !nodeDisabled,
    last_sync_received: lastSyncAt, usage: usageReport, active_ips: activeIpsReport,
    meta: {
      users_loaded: usersByUuid.size, node_disabled: nodeDisabled,
      usage_entries: usageReport.length, ip_entries: activeIpsReport.length,
      doh: DOH_URL, dohClean: DOH_CLEAN_URL, dohFallback: DOH_FALLBACK_URL,
      egress: { proxy: egressProxy || null, domainsCount: egressDomains.length },
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ====================== VLESS XHTTP (stream-one) ======================
async function handleVlessXhttp(request, env, ctx) {
  const t0 = Date.now();
  const clientIP = getClientIP(request);

  try {
    await ensureUsersLoaded(env);
  } catch (_) {}

  if (nodeDisabled) {
    return new Response('Node disabled', { status: 503 });
  }
  if (!request.body) {
    return new Response('body required', { status: 400 });
  }

  const envRef = env;
  const bodyReader = request.body.getReader();

  let headerBuf = new Uint8Array(0);
  let remoteEarly = null;
  let parsed = null;

  const appendBuf = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  try {
    while (headerBuf.length < 512) {
      const { done, value } = await bodyReader.read();
      if (done && (!value || !value.byteLength)) break;
      if (value && value.byteLength) {
        headerBuf = appendBuf(headerBuf, value instanceof Uint8Array ? value : new Uint8Array(value));
      }
      if (headerBuf.length >= 24) {
        const tryParse = parseVlessHeader(
          headerBuf.buffer.slice(headerBuf.byteOffset, headerBuf.byteOffset + headerBuf.byteLength)
        );
        if (tryParse.ok) {
          parsed = tryParse;
          if (parsed.rest && parsed.rest.byteLength > 0) {
            remoteEarly = new Uint8Array(parsed.rest);
          }
          break;
        }
      }
      if (done) break;
      if (headerBuf.length > 4096) break;
    }
  } catch (_) {
    return new Response('bad request', { status: 400 });
  }

  if (!parsed || !parsed.ok) {
    try { bodyReader.releaseLock(); } catch {}
    return new Response('invalid vless', { status: 400 });
  }

  const userUuid = parsed.uuid.toLowerCase();
  const cfg = getUserByUuid(userUuid);
  if (!cfg) {
    wlog('auth', 'REJECT user', { uuid: userUuid, loaded: usersByUuid.size });
    try { bodyReader.releaseLock(); } catch {}
    return new Response('unauthorized', { status: 403 });
  }
  const userId = cfg.id;
  wlog('auth', 'OK', { id: userId, name: cfg.name, blockAds: cfg.blockAds, ipLimit: cfg.ipLimit, uuid: userUuid.slice(0, 8) });

  const addrLower = String(parsed.address || '').toLowerCase();
  const port = parsed.port;

  // فقط plain DNS روی پورت 53 به هاست‌های مجاز → MITM
  // بقیهٔ مسیرهای resolve (DoT/DoH/پورت‌های encrypted) بسته می‌شوند
  const isDnsRequest =
    port === 53 && (isKnownDnsHost(addrLower) || isIpLiteral(addrLower));

  wlog('route', 'CONN target', {
    addr: parsed.address,
    port,
    cmd: parsed.cmd,
    isDns: isDnsRequest,
    knownDns: isKnownDnsHost(addrLower),
  });

  // ----- بلاک Encrypted DNS / DoT / DoH -----
  const encBlock = shouldBlockEncryptedDns(parsed.address, port);
  if (encBlock.block) {
    if (encBlock.reason === 'encrypted-dns-port' || port === 853) {
      dnsStats.dotBlocked += 1;
      wlog('block', 'encrypted-port', {
        reason: encBlock.reason,
        addr: parsed.address,
        port,
        uuid: userUuid.slice(0, 8),
        ip: clientIP,
        count: dnsStats.dotBlocked,
      });
    } else {
      dnsStats.dohBlocked += 1;
      wlog('block', 'doh/encrypted', {
        reason: encBlock.reason,
        addr: parsed.address,
        port,
        uuid: userUuid.slice(0, 8),
        ip: clientIP,
        count: dnsStats.dohBlocked,
      });
    }
    try { bodyReader.releaseLock(); } catch {}
    return new Response('encrypted dns blocked', { status: 403 });
  }

  // پورت 53 به هاست غیرمجاز → بلاک (نمی‌گذاریم بدون MITM برود)
  if (port === 53 && !isDnsRequest) {
    dnsStats.dohBlocked += 1;
    wlog('block', 'plain-53 unknown host', {
      addr: parsed.address,
      port,
      uuid: userUuid.slice(0, 8),
      ip: clientIP,
    });
    try { bodyReader.releaseLock(); } catch {}
    return new Response('dns host not allowed', { status: 403 });
  }

  if (parsed.cmd === 2 && !isDnsRequest) {
    try { bodyReader.releaseLock(); } catch {}
    return new Response('udp not supported', { status: 400 });
  }
  if (parsed.cmd !== 1 && parsed.cmd !== 2) {
    try { bodyReader.releaseLock(); } catch {}
    return new Response('only TCP', { status: 400 });
  }

  // IP limit
  const acq = await tryAcquireIp(envRef, userId, clientIP, cfg.ipLimit);
  if (!acq.ok) {
    try { bodyReader.releaseLock(); } catch {}
    return new Response('ip limit', { status: 429 });
  }

  const userBlockAds = cfg.blockAds === true;
  const limiter = getLimiter(userUuid, cfg.speedLimitKBps);
  let bytesUp = 0;
  let bytesDown = 0;
  let sessionBytes = 0;
  let lastReported = 0;
  let closed = false;

  activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);
  const sessionRef = {
    close: () => { closed = true; },
  };
  if (!activeSessions.has(userUuid)) activeSessions.set(userUuid, new Set());
  activeSessions.get(userUuid).add(sessionRef);

  const flushUsage = () => {
    if (!userId || bytesUp + bytesDown === 0) return;
    const u = bytesUp;
    const d = bytesDown;
    bytesUp = 0;
    bytesDown = 0;
    ctx.waitUntil(dbAddUsage(envRef, userId, u, d).catch(() => {}));
  };

  const maybeReport = () => {
    if (sessionBytes - lastReported >= REPORT_THRESHOLD) {
      flushUsage();
      lastReported = sessionBytes;
      if (userId) touchActiveIp(envRef, userId, clientIP);
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeConns.set(userUuid, Math.max(0, (activeConns.get(userUuid) || 1) - 1));
    flushUsage();
    if (activeSessions.has(userUuid)) {
      const set = activeSessions.get(userUuid);
      set.delete(sessionRef);
      if (set.size === 0) activeSessions.delete(userUuid);
    }
  };

  // ========== DNS mode via DoH (MITM) ==========
  if (isDnsRequest) {
    wlog('dns', 'MITM START xhttp', {
      addr: parsed.address,
      port,
      cmd: parsed.cmd,
      blockAds: userBlockAds,
      uuid: userUuid.slice(0, 8),
      ip: clientIP,
    });
    try {
      const queries = [];
      if (remoteEarly && remoteEarly.byteLength > 0) {
        queries.push(remoteEarly);
      }
      for (;;) {
        const { done, value } = await bodyReader.read();
        if (value && value.byteLength) {
          queries.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
        if (done) break;
      }
      let all = new Uint8Array(0);
      for (const q of queries) all = appendBuf(all, q);

      const parts = [];
      let usedLengthPrefix = false;
      if (all.byteLength >= 2) {
        let off = 0;
        while (off + 2 <= all.byteLength) {
          const len = (all[off] << 8) | all[off + 1];
          if (len < 12 || off + 2 + len > all.byteLength) break;
          parts.push(all.subarray(off + 2, off + 2 + len));
          off += 2 + len;
          usedLengthPrefix = true;
        }
      }
      if (!parts.length && all.byteLength >= 12) {
        parts.push(all);
        usedLengthPrefix = false;
      }

      const outChunks = [];
      outChunks.push(new Uint8Array([0, 0]));
      for (const query of parts) {
        if (limiter.enabled) await limiter.take(query.byteLength);
        bytesUp += query.byteLength;
        sessionBytes += query.byteLength;
        const resp = await dohResolve(query, userBlockAds);
        if (!resp || resp.byteLength < 12) continue;
        let out;
        if (usedLengthPrefix) {
          out = new Uint8Array(2 + resp.byteLength);
          out[0] = (resp.byteLength >> 8) & 0xff;
          out[1] = resp.byteLength & 0xff;
          out.set(resp, 2);
        } else {
          out = resp;
        }
        if (limiter.enabled) await limiter.take(out.byteLength);
        bytesDown += out.byteLength;
        sessionBytes += out.byteLength;
        outChunks.push(out);
      }
      maybeReport();
      cleanup();

      let totalLen = 0;
      for (const c of outChunks) totalLen += c.byteLength;
      const body = new Uint8Array(totalLen);
      let o = 0;
      for (const c of outChunks) {
        body.set(c, o);
        o += c.byteLength;
      }
      wlog('dns', 'MITM DONE xhttp', {
        parts: parts.length,
        outLen: totalLen,
        ms: Date.now() - t0,
        stats: { ...dnsStats },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      });
    } catch (e) {
      wlog('error', 'MITM FAIL xhttp', e?.message || String(e));
      cleanup();
      return new Response('dns fail', { status: 502 });
    }
  }

  // ad-block for non-DNS destinations
  if (cfg.blockAds === true && (await isAdHost(parsed.address))) {
    cleanup();
    try { bodyReader.releaseLock(); } catch {}
    return new Response('ad blocked', { status: 403 });
  }

  // TCP connect
  let remoteSocket;
  try {
    remoteSocket = await connectOutbound(parsed.address, parsed.port);
  } catch (_) {
    cleanup();
    try { bodyReader.releaseLock(); } catch {}
    return new Response('connect fail', { status: 502 });
  }

  const remoteWriter = remoteSocket.writable.getWriter();

  const uploadDone = (async () => {
    try {
      if (remoteEarly && remoteEarly.byteLength > 0) {
        if (limiter.enabled) await limiter.take(remoteEarly.byteLength);
        bytesUp += remoteEarly.byteLength;
        sessionBytes += remoteEarly.byteLength;
        await remoteWriter.write(remoteEarly);
        maybeReport();
      }
      while (!closed) {
        const { done, value } = await bodyReader.read();
        if (value && value.byteLength) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (limiter.enabled) await limiter.take(chunk.byteLength);
          bytesUp += chunk.byteLength;
          sessionBytes += chunk.byteLength;
          maybeReport();
          await remoteWriter.write(chunk);
        }
        if (done) break;
        if (userUuid && !getUserByUuid(userUuid)) {
          closed = true;
          break;
        }
      }
    } catch (_) {
    } finally {
      try { await remoteWriter.close(); } catch {}
      try { bodyReader.releaseLock(); } catch {}
    }
  })();

  const { readable, writable } = new TransformStream();
  const downWriter = writable.getWriter();

  const downloadDone = (async () => {
    try {
      await downWriter.write(new Uint8Array([0, 0]));
      const reader = remoteSocket.readable.getReader();
      while (!closed) {
        const { done, value } = await reader.read();
        if (value && value.byteLength) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (userUuid && !getUserByUuid(userUuid)) {
            closed = true;
            break;
          }
          if (limiter.enabled) await limiter.take(chunk.byteLength);
          bytesDown += chunk.byteLength;
          sessionBytes += chunk.byteLength;
          maybeReport();
          await downWriter.write(chunk);
        }
        if (done) break;
      }
      try { reader.releaseLock(); } catch {}
    } catch (_) {
    } finally {
      try { await downWriter.close(); } catch {}
      try { remoteSocket.close(); } catch {}
      cleanup();
    }
  })();

  ctx.waitUntil(
    Promise.allSettled([uploadDone, downloadDone]).then(() => {
      cleanup();
    })
  );

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ====================== VLESS WebSocket (legacy fallback) ======================
async function handleVlessWebSocket(request, env, ctx) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  try {
    await ensureUsersLoaded(env);
  } catch {}
  if (nodeDisabled) return new Response('Node disabled', { status: 503 });

  let pair, client, server;
  try {
    pair = new WebSocketPair();
    [client, server] = Object.values(pair);
    server.binaryType = 'arraybuffer';
    server.accept();
  } catch (_) {
    return new Response('ws error', { status: 500 });
  }

  const envRef = env;
  const clientIP = getClientIP(request);

  let closed = false;
  let joined = false;
  let userUuid = null;
  let userId = null;
  let bytesUp = 0;
  let bytesDown = 0;
  let sessionBytes = 0;
  let lastReported = 0;
  let remoteSocket = null;
  let remoteWriter = null;
  let limiter = { enabled: false, async take() {} };
  let sessionRef = null;
  let isDnsMode = false;
  let userBlockAds = true;

  const flushUsage = () => {
    if (!userId || bytesUp + bytesDown === 0) return;
    const u = bytesUp, d = bytesDown;
    bytesUp = 0;
    bytesDown = 0;
    ctx.waitUntil(dbAddUsage(envRef, userId, u, d).catch(() => {}));
  };

  const maybeReport = () => {
    if (sessionBytes - lastReported >= REPORT_THRESHOLD) {
      flushUsage();
      lastReported = sessionBytes;
      if (userId) touchActiveIp(envRef, userId, clientIP);
    }
  };

  const safeClose = (reason = '') => {
    if (closed) return;
    closed = true;
    if (userUuid && joined) {
      activeConns.set(userUuid, Math.max(0, (activeConns.get(userUuid) || 1) - 1));
      if (userId) flushUsage();
      if (sessionRef && activeSessions.has(userUuid)) {
        const set = activeSessions.get(userUuid);
        set.delete(sessionRef);
        if (set.size === 0) activeSessions.delete(userUuid);
      }
    }
    try { remoteWriter?.releaseLock(); } catch {}
    try { remoteSocket?.close(); } catch {}
    try {
      if (server.readyState === 1 || server.readyState === 2) server.close(1000, reason);
    } catch {}
  };

  const sendOk = () => {
    try { server.send(new Uint8Array([0, 0])); } catch {}
  };

  let earlyData = null;
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  if (earlyHeader) {
    try {
      const b64 = earlyHeader.replace(/-/g, '+').replace(/_/g, '/');
      earlyData = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {}
  }

  const processChunk = async (chunk) => {
    if (closed || !(chunk instanceof Uint8Array) || chunk.byteLength === 0) return;

    if (remoteWriter) {
      if (userUuid && !getUserByUuid(userUuid)) {
        return safeClose('revoked');
      }
      try {
        if (limiter.enabled) await limiter.take(chunk.byteLength);
        bytesUp += chunk.byteLength;
        sessionBytes += chunk.byteLength;
        maybeReport();
        await remoteWriter.write(chunk);
      } catch {
        safeClose('write fail');
      }
      return;
    }

    // DNS MITM mode
    if (isDnsMode) {
      if (userUuid && !getUserByUuid(userUuid)) {
        return safeClose('revoked');
      }
      try {
        const queries = [];
        let usedLengthPrefix = false;

        if (chunk.byteLength >= 2) {
          let off = 0;
          while (off + 2 <= chunk.byteLength) {
            const len = (chunk[off] << 8) | chunk[off + 1];
            if (len < 12 || off + 2 + len > chunk.byteLength) break;
            queries.push(chunk.subarray(off + 2, off + 2 + len));
            off += 2 + len;
            usedLengthPrefix = true;
          }
        }
        if (queries.length === 0) {
          queries.push(chunk);
          usedLengthPrefix = false;
        }

        for (const query of queries) {
          if (limiter.enabled) await limiter.take(query.byteLength);
          bytesUp += query.byteLength;
          sessionBytes += query.byteLength;
          maybeReport();

          const resp = await dohResolve(query, userBlockAds);
          if (!resp || resp.byteLength < 12) continue;

          let out;
          if (usedLengthPrefix) {
            out = new Uint8Array(2 + resp.byteLength);
            out[0] = (resp.byteLength >> 8) & 0xff;
            out[1] = resp.byteLength & 0xff;
            out.set(resp, 2);
          } else {
            out = resp;
          }

          if (limiter.enabled) await limiter.take(out.byteLength);
          bytesDown += out.byteLength;
          sessionBytes += out.byteLength;
          maybeReport();
          try {
            server.send(out);
          } catch {
            safeClose('ws send fail');
            return;
          }
        }
      } catch (_) {
        safeClose('dns fail');
      }
      return;
    }

    // VLESS header
    const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    const parsed = parseVlessHeader(buf);
    if (!parsed.ok) {
      return safeClose('bad header');
    }

    userUuid = parsed.uuid.toLowerCase();
    const cfg = getUserByUuid(userUuid);
    if (!cfg) {
      return safeClose('user not found');
    }
    userId = cfg.id;

    const addrLower = String(parsed.address || '').toLowerCase();
    const port = parsed.port;
    // فقط plain DNS روی 53 به هاست مجاز → MITM
    const isDnsRequest =
      port === 53 && (isKnownDnsHost(addrLower) || isIpLiteral(addrLower));

    // Block Encrypted DNS / DoT / DoH
    const encBlock = shouldBlockEncryptedDns(parsed.address, port);
    if (encBlock.block) {
      if (encBlock.reason === 'encrypted-dns-port' || port === 853) {
        dnsStats.dotBlocked += 1;
        wlog('block', 'encrypted-port ws', {
          reason: encBlock.reason,
          addr: parsed.address,
          port,
          uuid: userUuid.slice(0, 8),
          ip: clientIP,
          count: dnsStats.dotBlocked,
        });
      } else {
        dnsStats.dohBlocked += 1;
        wlog('block', 'doh/encrypted ws', {
          reason: encBlock.reason,
          addr: parsed.address,
          port,
          uuid: userUuid.slice(0, 8),
          ip: clientIP,
          count: dnsStats.dohBlocked,
        });
      }
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('encrypted dns blocked');
    }

    // پورت 53 به هاست غیرمجاز
    if (port === 53 && !isDnsRequest) {
      dnsStats.dohBlocked += 1;
      wlog('block', 'plain-53 unknown host ws', {
        addr: parsed.address,
        port,
        uuid: userUuid.slice(0, 8),
        ip: clientIP,
      });
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('dns host not allowed');
    }

    if (parsed.cmd === 2 && !isDnsRequest) {
      sendOk();
      return safeClose('udp not supported');
    }
    if (parsed.cmd !== 1 && parsed.cmd !== 2) {
      sendOk();
      return safeClose('only TCP');
    }

    const acq = await tryAcquireIp(envRef, userId, clientIP, cfg.ipLimit);
    if (!acq.ok) {
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('ip limit');
    }

    joined = true;
    userBlockAds = cfg.blockAds === true;
    activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);
    limiter = getLimiter(userUuid, cfg.speedLimitKBps);

    sessionRef = { close: () => safeClose('revoked') };
    if (!activeSessions.has(userUuid)) activeSessions.set(userUuid, new Set());
    activeSessions.get(userUuid).add(sessionRef);

    const host = parsed.address;
    // port از بالا (const port = parsed.port) استفاده می‌شود

    if (!isDnsRequest && cfg.blockAds === true && (await isAdHost(host))) {
      joined = false;
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('ad blocked');
    }

    // DNS MITM
    if (isDnsRequest) {
      isDnsMode = true;
      wlog('dns', 'MITM START ws', {
        addr: host,
        port,
        blockAds: userBlockAds,
        uuid: userUuid.slice(0, 8),
        ip: clientIP,
      });
      sendOk();
      if (parsed.rest && parsed.rest.byteLength > 0) {
        const first = new Uint8Array(parsed.rest);
        await processChunk(first);
      }
      return;
    }

    // TCP normal
    try {
      remoteSocket = await connectOutbound(host, port);
      remoteWriter = remoteSocket.writable.getWriter();
      sendOk();

      if (parsed.rest && parsed.rest.byteLength > 0) {
        const first = new Uint8Array(parsed.rest);
        if (limiter.enabled) await limiter.take(first.byteLength);
        bytesUp += first.byteLength;
        sessionBytes += first.byteLength;
        await remoteWriter.write(first);
      }

      remoteSocket.readable
        .pipeTo(new WritableStream({
          async write(remoteChunk) {
            if (server.readyState !== 1) return;
            if (userUuid && !getUserByUuid(userUuid)) {
              safeClose('revoked');
              return;
            }
            if (limiter.enabled) await limiter.take(remoteChunk.byteLength);
            bytesDown += remoteChunk.byteLength;
            sessionBytes += remoteChunk.byteLength;
            maybeReport();
            try { server.send(remoteChunk); } catch { safeClose('ws send fail'); }
          },
          close() { safeClose('remote closed'); },
          abort() { safeClose('remote abort'); },
        }))
        .catch(() => safeClose('remote pipe'));
    } catch {
      safeClose('connect fail');
    }
  };

  server.addEventListener('message', (ev) => {
    try {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        processChunk(new Uint8Array(data)).catch(() => { try { safeClose(); } catch {} });
      } else if (data instanceof Blob) {
        data.arrayBuffer()
          .then((b) => processChunk(new Uint8Array(b)))
          .catch(() => { try { safeClose(); } catch {} });
      } else if (typeof data === 'string') {
        processChunk(new TextEncoder().encode(data)).catch(() => { try { safeClose(); } catch {} });
      }
    } catch {
      try { safeClose(); } catch {}
    }
  });
  server.addEventListener('close', () => { try { safeClose(); } catch {} });
  server.addEventListener('error', () => { try { safeClose(); } catch {} });

  if (earlyData && earlyData.byteLength > 0) {
    try {
      ctx.waitUntil(processChunk(earlyData).catch(() => {}));
    } catch {
      processChunk(earlyData).catch(() => {});
    }
  }

  return new Response(null, { status: 101, webSocket: client });
}

// ====================== Status ======================
async function serveStatusPage(id) {
  try {
    const res = await fetch(STATUS_HTML_URL, {
      headers: { 'User-Agent': 'cf-child/' + VERSION },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error('fetch failed');
    let html = await res.text();
    const inject = `<script>window.__SAOW_VERSION__=${JSON.stringify(VERSION)};window.__SAOW_CHILD_ID__=${JSON.stringify(id)};</script>`;
    html = html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html;
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
    });
  } catch {
    return new Response(
      `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>Saow Node</title></head>
       <body style="background:#05060f;color:#e2e8f0;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
         <div style="text-align:center">
           <h1>SAOW</h1><p>Edge Node (Push + D1 + DoH)</p>
           <p>Version: <b>${VERSION}</b></p>
           <p style="opacity:.5">${id}</p>
         </div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// ====================== Main ======================
export default {
  async fetch(request, env, ctx) {
    try {
      _env = env;
      _ctx = ctx;
      refreshLogMode(env);
      if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || '';
      loadEgressFromEnv(env);

      const url = new URL(request.url);
      const path = url.pathname;
      childId = generateChildId(request.url);
      const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

      if (request.method === 'POST' && (path === '/sync' || path === '/sync/')) {
        return handleSync(request, env);
      }

      if (path === '/health') {
        await ensureUsersLoaded(env);
        const ips = await dbLoadActiveIps(env);
        let activeUsersCount = 0;
        for (const c of activeConns.values()) if (c > 0) activeUsersCount++;
        return new Response(JSON.stringify({
          ok: true, id: childId, version: VERSION, mode: 'push-d1-doh-xhttp',
          transport: ['xhttp', 'ws'],
          activeUsers: Math.max(activeUsersCount, ips.length),
          usersLoaded: usersByUuid.size, activeIpEntries: ips.length,
          nodeDisabled, lastSyncAt: lastSyncAt || null, hasDB: !!env.DB,
          doh: DOH_URL, dohClean: DOH_CLEAN_URL, dohFallback: DOH_FALLBACK_URL,
          dohCacheSize: dohCache.size,
          egress: { proxy: egressProxy || null, domains: egressDomains.slice(0, 20) },
          dns: { ...dnsStats },
          memLogSize: memLogs.length,
          logMode,
          limits: Array.from(usersByUuid.values()).slice(0, 20).map((u) => ({
            id: u.id,
            ipLimit: u.ipLimit,
            speedLimitKBps: u.speedLimitKBps,
            blockAds: u.blockAds,
          })),
          memIpUsers: memIps.size,
        }), { headers: { 'content-type': 'application/json' } });
      }

      // ---- لاگ داخلی (حافظه + D1) ----
      // GET  /log          → آخرین لاگ‌ها
      // GET  /log?limit=50
      // GET  /log?clear=1  → پاک کردن
      // POST /log          → ثبت دستی {level,msg,extra}
      if (path === '/log' || path === '/log/') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        if (url.searchParams.get('clear') === '1' || url.searchParams.get('clear') === 'true') {
          const ok = await dbClearLogs(env);
          memLogs.length = 0;
          return new Response(JSON.stringify({ ok, cleared: true, version: VERSION }), {
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          });
        }
        if (request.method === 'POST') {
          try {
            const body = await request.json().catch(() => ({}));
            wlog(body.level || 'info', body.msg || body.message || 'manual', body.extra);
          } catch (_) {
            wlog('info', 'manual-post');
          }
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        const data = await dbLoadLogs(env, limit);
        return new Response(JSON.stringify(data, null, 2), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      // XHTTP stream-one
      if (request.method === 'POST' && request.body) {
        wlog('route', 'POST → XHTTP', {
          path,
          ip: getClientIP(request),
          host: request.headers.get('host'),
        });
        return handleVlessXhttp(request, env, ctx);
      }

      // WebSocket legacy
      if (isWs) {
        wlog('route', 'WS → VLESS', {
          path,
          ip: getClientIP(request),
          host: request.headers.get('host'),
        });
        return handleVlessWebSocket(request, env, ctx);
      }

      // لاگ درخواست‌های ناشناس برای دیباگ
      if (path !== '/' && path !== '/version' && path !== '/health' && path !== '/favicon.ico' && path !== '/log') {
        wlog('route', 'OTHER', {
          method: request.method,
          path,
          ip: getClientIP(request),
          upgrade: request.headers.get('upgrade'),
        });
      }

      if (path === '/') return serveStatusPage(childId);

      if (path === '/version') {
        await ensureUsersLoaded(env);
        return new Response(JSON.stringify({
          version: VERSION, role: 'node', mode: 'push-d1-doh-xhttp', id: childId,
          usersLoaded: usersByUuid.size, nodeDisabled,
          lastSyncAt: lastSyncAt || null, hasDB: !!env.DB,
          doh: DOH_URL, dohClean: DOH_CLEAN_URL, dohFallback: DOH_FALLBACK_URL,
          dns: { ...dnsStats },
        }), { headers: { 'content-type': 'application/json' } });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      try {
        wlog('error', 'fetch fatal', {
          message: e?.message || String(e),
          stack: String(e?.stack || '').slice(0, 500),
        });
      } catch (_) {}
      return new Response(JSON.stringify({
        error: 'internal',
        message: String(e?.message || e),
        version: VERSION,
      }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  },
  async scheduled() {},
};
