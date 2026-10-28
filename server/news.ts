import type { ServerResponse } from 'node:http';
import type { Connect } from 'vite';

// Server-side proxy for real Polish news headlines (RSS), shown on the TV in the simulation.
// Runs inside the Vite dev / preview server (via the plugin) or the production server (server/prod.ts): the browser asks GET /api/news, the proxy
// fetches the configured RSS feeds (no API keys), parses the item titles with a small
// tolerant parser, dedupes, caches for 15 minutes and returns at most 30 headlines.
// Headlines are passed on verbatim (whitespace trimmed, entities decoded), with their source.
// Self-contained on purpose (no imports from src/), so the dev server never depends on game code.

export const NEWS_URL = '/api/news';

/**
 * Default feeds: official RSS of public Polish news outlets. Each was checked with curl on
 * 2026-10-28 (HTTP 200, RSS 2.0, 20–50 items, UTF-8, titles in CDATA or plain text).
 */
export const DEFAULT_FEEDS: readonly string[] = [
  'https://www.polsatnews.pl/rss/wszystkie.xml',
  'https://tvn24.pl/najnowsze.xml',
  'https://www.rmf24.pl/feed',
  'https://www.rp.pl/rss_main',
];

/** display names by host (otherwise the feed's channel title is used) */
export const KNOWN_SOURCES: Record<string, string> = {
  'polsatnews.pl': 'Polsat News',
  'tvn24.pl': 'TVN24',
  'rmf24.pl': 'RMF24',
  'rp.pl': 'Rzeczpospolita',
  'fakty.interia.pl': 'Interia',
  'wiadomosci.onet.pl': 'Onet',
  'wiadomosci.wp.pl': 'WP',
  'bankier.pl': 'Bankier.pl',
  'money.pl': 'money.pl',
  'wprost.pl': 'Wprost',
  'pap.pl': 'PAP',
};

export const NEWS_MAX_ITEMS = 30;
export const NEWS_PER_FEED = 10;
export const NEWS_MAX_FEEDS = 8;
export const NEWS_CACHE_MS = 15 * 60_000;
/** after a failed refresh, an older list is still served for this long */
export const NEWS_STALE_MS = 6 * 60 * 60_000;
/** retry a refresh no sooner than this after a failure */
export const NEWS_RETRY_MS = 60_000;
export const NEWS_TIMEOUT_MS = 6000;
export const NEWS_MAX_BYTES = 2 * 1024 * 1024;
export const NEWS_MIN_TITLE = 12;
export const NEWS_MAX_TITLE = 180;

/**
 * The game is a cosy life sim whose residents chat about what they saw on TV, so headlines
 * about violent death and similar are left out (skipped, never rewritten).
 */
const SENSITIVE =
  /(?<!\p{L})(zgin[ąęe]\p{L}*|nie żyj[eą]|[śs]mier[ćc]\p{L}*|śmiertel\p{L}*|zabi[jlt]\p{L}*|zabójst\p{L}*|zamordow\p{L}*|morderst\p{L}*|zwłok\p{L}*|gwałt\p{L}*|zgwałc\p{L}*|samobój\p{L}*|pedofil\p{L}*|katastrof\p{L}*|ofiar[ayę]?(?!\p{L})|ofiarami|tragedi\p{L}*|tragiczn\p{L}*|zamach\p{L}*|terroryst\p{L}*|potrąc\p{L}*|wypad(?:ek|ku|ki|kach|kiem)|rann[iy]|pobi[tł]\p{L}*|porwa[nł]\p{L}*)/iu;

export interface NewsHeadline {
  title: string;
  source: string;
  /** ISO 8601, when the feed gave a parsable date */
  pubDate?: string;
}

export interface NewsResponse {
  items: NewsHeadline[];
  /** ISO time of the last successful refresh, null when never */
  fetchedAt: string | null;
  sources: string[];
  /** true when NEWS_FEEDS=off */
  disabled?: boolean;
}

// ------------------------------------------------------------ parsing

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bdquo: '„', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»',
  rsquo: '’', lsquo: '‘', sbquo: '‚', oacute: 'ó', Oacute: 'Ó', eacute: 'é', aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä',
  bull: '•', middot: '·', deg: '°', euro: '€', copy: '©', reg: '®', shy: '',
};

/** decodes XML/HTML entities: named (common subset), decimal and hex; unknown ones stay as they are */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

/** text content of an element body: CDATA unwrapped, tags stripped, entities decoded, whitespace collapsed */
export function textContent(raw: string): string {
  let out = '';
  const re = /<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g;
  let last = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    out += decodeEntities(raw.slice(last, m.index).replace(/<[^>]*>/g, ' '));
    // CDATA content is literal text, but feeds often put escaped HTML in it anyway
    out += decodeEntities(m[1].replace(/<[^>]*>/g, ' '));
    last = re.lastIndex;
  }
  out += decodeEntities(raw.slice(last).replace(/<[^>]*>/g, ' '));
  return out
    // escaped HTML (&lt;b&gt;) is common in titles: drop the tags it decoded to
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, ' ')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** body of the first <tag …>…</tag> (namespace prefixes allowed, e.g. dc:date), or null */
function element(block: string, names: readonly string[]): string | null {
  for (const name of names) {
    const n = name.replace(':', '\\:');
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}\\s*>`, 'i').exec(block);
    if (m) return m[1];
  }
  return null;
}

function parseDate(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(textContent(raw));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export interface ParsedFeed {
  /** channel / feed title, '' when missing */
  title: string;
  items: { title: string; pubDate?: string }[];
}

/**
 * Tolerant RSS 2.0 / RSS 1.0 / Atom parser for titles and dates. Never throws: malformed
 * XML yields whatever items could be recognised (possibly none).
 */
export function parseFeed(xml: string): ParsedFeed {
  if (typeof xml !== 'string' || !xml) return { title: '', items: [] };
  // comments can contain anything, including fake items
  const src = xml.replace(/<!--[\s\S]*?-->/g, '');
  const blocks: string[] = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let firstAt = -1;
  for (let m = re.exec(src); m && blocks.length < 200; m = re.exec(src)) {
    if (firstAt < 0) firstAt = m.index;
    blocks.push(m[2]);
  }
  const head = firstAt >= 0 ? src.slice(0, firstAt) : src;
  // the channel title comes before the first item; skip <image><title>
  const channelTitle = textContent(element(head.replace(/<image[\s>][\s\S]*?<\/image\s*>/gi, ''), ['title']) ?? '');
  const items: ParsedFeed['items'] = [];
  for (const b of blocks) {
    const raw = element(b.replace(/<image[\s>][\s\S]*?<\/image\s*>/gi, ''), ['title']);
    if (raw === null) continue;
    const title = textContent(raw);
    if (!title) continue;
    items.push({ title, pubDate: parseDate(element(b, ['pubDate', 'published', 'updated', 'dc:date'])) });
  }
  return { title: channelTitle, items };
}

/** "Najnowsze wiadomości - TVN24" → host-based name when known, else the cleaned channel title, else the host */
export function sourceName(url: string, channelTitle = ''): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* invalid URL */
  }
  for (const [h, name] of Object.entries(KNOWN_SOURCES)) if (host === h || host.endsWith(`.${h}`)) return name;
  const t = channelTitle.trim().slice(0, 40);
  return t || host || 'RSS';
}

const normalise = (t: string): string => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

/** usable as a TV headline: sane length, not about violent death and the like */
export function isUsableTitle(title: string): boolean {
  return title.length >= NEWS_MIN_TITLE && title.length <= NEWS_MAX_TITLE && !SENSITIVE.test(title);
}

/** merges feeds: ≤ NEWS_PER_FEED from each, usable titles only, deduped, newest first, ≤ NEWS_MAX_ITEMS */
export function mergeHeadlines(feeds: { source: string; items: { title: string; pubDate?: string }[] }[]): NewsHeadline[] {
  const seen = new Set<string>();
  const all: (NewsHeadline & { order: number })[] = [];
  feeds.forEach((f, fi) => {
    let taken = 0;
    for (const it of f.items) {
      if (taken >= NEWS_PER_FEED) break;
      if (!isUsableTitle(it.title)) continue;
      const key = normalise(it.title);
      if (seen.has(key)) continue;
      seen.add(key);
      taken++;
      // undated items: keep feed order, interleaved by position
      all.push({ title: it.title, source: f.source, ...(it.pubDate ? { pubDate: it.pubDate } : {}), order: taken * 100 + fi });
    }
  });
  all.sort((a, b) => {
    const ta = a.pubDate ? Date.parse(a.pubDate) : -Infinity;
    const tb = b.pubDate ? Date.parse(b.pubDate) : -Infinity;
    return tb - ta || a.order - b.order;
  });
  return all.slice(0, NEWS_MAX_ITEMS).map(({ order: _order, ...h }) => h);
}

/** parses NEWS_FEEDS ("url1, url2"); "off" disables, empty → defaults; only http(s) URLs */
export function parseFeedList(raw: string | undefined): string[] {
  const t = (raw ?? '').trim();
  if (/^(off|none|false|0)$/i.test(t)) return [];
  const urls = t
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    });
  const unique = [...new Set(urls)].slice(0, NEWS_MAX_FEEDS);
  return unique.length ? unique : [...DEFAULT_FEEDS];
}

/** decodes a feed body honouring the XML declaration's encoding (e.g. ISO-8859-2) */
export function decodeBody(buf: ArrayBuffer, contentType = ''): string {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1] ?? /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(enc.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ------------------------------------------------------------ fetching + cache

export interface NewsServiceOptions {
  feeds: readonly string[];
  /** injectable for tests */
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  log?: (msg: string) => void;
}

export interface NewsService {
  get(): Promise<NewsResponse>;
}

/** fetches one feed; never throws (null on any failure) */
async function fetchFeed(url: string, doFetch: typeof fetch, timeoutMs: number, log: (m: string) => void) {
  try {
    const res = await doFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; osiedle-sim/0.1; local news ticker)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log(`${url}: HTTP ${res.status}`);
      return null;
    }
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > NEWS_MAX_BYTES) {
      log(`${url}: too large (${len} B)`);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > NEWS_MAX_BYTES) return null;
    const feed = parseFeed(decodeBody(buf, res.headers.get('content-type') ?? ''));
    if (!feed.items.length) log(`${url}: no items`);
    return { source: sourceName(url, feed.title), items: feed.items };
  } catch (err) {
    const name = (err as Error)?.name;
    log(`${url}: ${name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : (err as Error)?.message ?? 'error'}`);
    return null;
  }
}

export function createNewsService(opts: NewsServiceOptions): NewsService {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? NEWS_TIMEOUT_MS;
  const cacheMs = opts.cacheMs ?? NEWS_CACHE_MS;
  const log = opts.log ?? ((m: string) => console.warn(`[news] ${m}`));
  let cache: { items: NewsHeadline[]; sources: string[]; at: number } | null = null;
  let lastAttempt = -Infinity;
  let inFlight: Promise<void> | null = null;

  const view = (): NewsResponse => {
    const fresh = cache && now() - cache.at <= NEWS_STALE_MS ? cache : null;
    return {
      items: fresh ? fresh.items : [],
      fetchedAt: fresh ? new Date(fresh.at).toISOString() : null,
      sources: fresh ? fresh.sources : [],
    };
  };

  const refresh = async (): Promise<void> => {
    lastAttempt = now();
    const results = await Promise.all(opts.feeds.map((u) => fetchFeed(u, doFetch, timeoutMs, log)));
    const ok = results.filter((r): r is NonNullable<typeof r> => r !== null && r.items.length > 0);
    const items = mergeHeadlines(ok);
    // a failed refresh keeps the previous (stale) list
    if (items.length) cache = { items, sources: [...new Set(items.map((i) => i.source))], at: now() };
  };

  return {
    async get() {
      if (!opts.feeds.length) return { items: [], fetchedAt: null, sources: [], disabled: true };
      const t = now();
      const due = !cache || t - cache.at >= cacheMs;
      if (due && t - lastAttempt >= (cache ? NEWS_RETRY_MS : 0) && !inFlight) {
        inFlight = refresh()
          .catch((err) => log(`refresh failed: ${(err as Error)?.message}`))
          .finally(() => {
            inFlight = null;
          });
      }
      // concurrent requests share one refresh
      if (inFlight) await inFlight;
      return view();
    },
  };
}

// ------------------------------------------------------------ HTTP

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function createNewsHandler(service: NewsService, log: (m: string) => void = () => {}): Connect.NextHandleFunction {
  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== NEWS_URL) {
      next();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    service
      .get()
      .then((body) => sendJson(res, 200, body))
      .catch((err) => {
        log(`error: ${(err as Error)?.message}`);
        sendJson(res, 200, { items: [], fetchedAt: null, sources: [] } satisfies NewsResponse);
      });
  };
}

/** Vite plugin: registers GET /api/news on both the dev and the preview server */
