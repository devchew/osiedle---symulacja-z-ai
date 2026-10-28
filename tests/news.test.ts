import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRng } from '../src/core/rng';
import { timeFromTick } from '../src/core/time';
import {
  NEWS_MAX_ITEMS,
  NEWS_URL,
  createNewsHandler,
  createNewsService,
  decodeBody,
  decodeEntities,
  isUsableTitle,
  mergeHeadlines,
  parseFeed,
  parseFeedList,
  sourceName,
  DEFAULT_FEEDS,
} from '../server/newsProxy';
import {
  LOCAL_SOURCE,
  NEWS_FOR_MAX,
  ROTATE_TICKS,
  activeTvs,
  bulletinFor,
  currentHeadline,
  fitHeadline,
  forecastBulletin,
  hasRealNews,
  loadRealNews,
  localBulletins,
  newsFor,
  quotedHeadline,
  sanitizeFeed,
  setNewsFeed,
  tickNews,
} from '../src/world/news';
import { NEWS_TELL, createProceduralProvider, isNewsLine, newsLine } from '../src/social/dialogueProvider';
import { LLM_MAX_NEWS, buildLineRequest, newsCandidates } from '../src/social/llmProvider';
import { buildUserPrompt, validateLineRequest } from '../server/llmProxy';
import { pushEvent } from '../src/world/events';
import { createWorld, tickWorld } from '../src/world/world';
import type { Agent, ConversationContext, Traits, World } from '../src/types';

// ------------------------------------------------------------------ fixtures

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Najnowsze wiadomości - Testowo</title>
<image><title>Logo kanału</title><url>https://example.pl/logo.png</url></image>
<!-- <item><title>Komentarz, nie wiadomość</title></item> -->
<item>
  <title><![CDATA[Sejm przyjął ustawę o „zielonych” dachach]]></title>
  <link>https://example.pl/1</link>
  <pubDate>Wed, 28 Oct 2026 21:25:00 +0100</pubDate>
</item>
<item>
  <title>Pogoda &amp; ruch: mgły w 12 województwach &#8211; uwaga kierowcy&#x21;</title>
  <pubDate>Wed, 28 Oct 2026 20:00:00 GMT</pubDate>
</item>
<item><title>   Krótki
   tytuł z   nową linią i &oacute; &bdquo;cytatem&rdquo; </title></item>
<item><title></title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Atomowe Wiadomości</title>
  <entry>
    <title type="html">Nowa linia tramwajowa &lt;b&gt;otwarta&lt;/b&gt; w Krakowie</title>
    <updated>2026-10-28T19:00:00Z</updated>
  </entry>
  <entry><title>Festiwal dyni przyciąga tłumy w Lublinie</title><published>2026-10-28T18:00:00Z</published></entry>
</feed>`;

const BROKEN = `<rss><channel><title>Zepsuty</title>
<item><title><![CDATA[Pierwsza dobra wiadomość dnia]]></title></item>
<item><title>Niedomknięty tytuł <b>bez końca</item>
<item><title><![CDATA[Druga dobra wiadomość dnia</title></item>
<item><title>Trzecia & ostatnia wiadomość</title>`;

// ------------------------------------------------------------------ parser

describe('RSS parser', () => {
  it('parses RSS 2.0 items: CDATA, entities, whitespace; skips comments, images and empty titles', () => {
    const f = parseFeed(RSS);
    expect(f.title).toBe('Najnowsze wiadomości - Testowo');
    expect(f.items.map((i) => i.title)).toEqual([
      'Sejm przyjął ustawę o „zielonych” dachach',
      'Pogoda & ruch: mgły w 12 województwach – uwaga kierowcy!',
      'Krótki tytuł z nową linią i ó „cytatem”',
    ]);
    expect(f.items[0].pubDate).toBe('2026-10-28T20:25:00.000Z');
    expect(f.items[2].pubDate).toBeUndefined();
  });

  it('parses Atom entries (escaped HTML in titles is stripped)', () => {
    const f = parseFeed(ATOM);
    expect(f.title).toBe('Atomowe Wiadomości');
    expect(f.items).toEqual([
      { title: 'Nowa linia tramwajowa otwarta w Krakowie', pubDate: '2026-10-28T19:00:00.000Z' },
      { title: 'Festiwal dyni przyciąga tłumy w Lublinie', pubDate: '2026-10-28T18:00:00.000Z' },
    ]);
  });

  it('tolerates malformed XML and garbage without throwing', () => {
    const f = parseFeed(BROKEN);
    expect(f.items.map((i) => i.title)).toContain('Pierwsza dobra wiadomość dnia');
    for (const junk of ['', '<<<>>>', 'not xml at all', '<item><title>', '<rss><item></item></rss>', '\u0000\u0001']) {
      expect(() => parseFeed(junk)).not.toThrow();
    }
    expect(parseFeed(undefined as unknown as string).items).toEqual([]);
  });

  it('decodes entities (named, decimal, hex) and leaves unknown ones', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#261;&#x119; &hellip; &foo; &#0;')).toBe('a & b <c> ąę … &foo; ');
  });

  it('decodes ISO-8859-2 bodies from the XML declaration', () => {
    const bytes = Uint8Array.from([...Buffer.from('<?xml version="1.0" encoding="ISO-8859-2"?><t>'), 0xb1, 0xea, 0xbf, ...Buffer.from('</t>')]);
    expect(decodeBody(bytes.buffer)).toContain('<t>ąęż</t>');
  });

  it('names sources by host, then channel title', () => {
    expect(sourceName('https://tvn24.pl/najnowsze.xml', 'Najnowsze wiadomości - TVN24')).toBe('TVN24');
    expect(sourceName('https://www.rmf24.pl/feed')).toBe('RMF24');
    expect(sourceName('https://example.org/rss', 'Gazeta Testowa')).toBe('Gazeta Testowa');
    expect(sourceName('https://example.org/rss')).toBe('example.org');
  });

  it('filters headlines about violent death and the like, keeps ordinary news', () => {
    expect(isUsableTitle('Nowy most otwarty dla ruchu w Warszawie')).toBe(true);
    expect(isUsableTitle('Wypadek na autostradzie, nie żyje kierowca')).toBe(false);
    expect(isUsableTitle('Śmierć znanego aktora')).toBe(false);
    expect(isUsableTitle('Krótki')).toBe(false);
  });

  it('merges feeds: dedupes across sources, newest first, caps per feed and in total', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ title: `Wiadomość numer ${i} z kraju`, pubDate: new Date(Date.UTC(2026, 9, 28, 0, i)).toISOString() }));
    const merged = mergeHeadlines([
      { source: 'A', items: [{ title: 'Ten sam tytuł w dwóch miejscach', pubDate: '2026-10-28T23:00:00.000Z' }, ...many] },
      { source: 'B', items: [{ title: 'TEN SAM tytuł w dwóch miejscach!' }, { title: 'Wiadomość tylko ze źródła B' }] },
      ...[1, 2, 3, 4].map((k) => ({ source: `C${k}`, items: many.map((m) => ({ title: `${m.title} ${k}`, pubDate: m.pubDate })) })),
    ]);
    expect(merged.length).toBe(NEWS_MAX_ITEMS);
    expect(merged[0]).toEqual({ title: 'Ten sam tytuł w dwóch miejscach', source: 'A', pubDate: '2026-10-28T23:00:00.000Z' });
    expect(merged.filter((m) => m.title.toLowerCase().startsWith('ten sam'))).toHaveLength(1);
    expect(merged.filter((m) => m.source === 'A').length).toBeLessThanOrEqual(10);
    const dates = merged.filter((m) => m.pubDate).map((m) => Date.parse(m.pubDate!));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it('parses NEWS_FEEDS', () => {
    expect(parseFeedList(undefined)).toEqual([...DEFAULT_FEEDS]);
    expect(parseFeedList('off')).toEqual([]);
    expect(parseFeedList(' https://a.pl/rss , ftp://x, nonsense, https://a.pl/rss,http://b.pl/feed ')).toEqual(['https://a.pl/rss', 'http://b.pl/feed']);
  });
});

// ------------------------------------------------------------------ proxy service / handler

function rssResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}

describe('news service', () => {
  const feeds = ['https://tvn24.pl/najnowsze.xml', 'https://example.org/atom'];

  it('fetches, merges and caches for 15 minutes', async () => {
    let t = 1_000_000;
    let calls = 0;
    const svc = createNewsService({
      feeds,
      now: () => t,
      log: () => {},
      fetch: async (url) => {
        calls++;
        return rssResponse(String(url).includes('tvn24') ? RSS : ATOM);
      },
    });
    const a = await svc.get();
    expect(calls).toBe(2);
    expect(a.items.length).toBe(5);
    expect(a.sources.sort()).toEqual(['Atomowe Wiadomości', 'TVN24']);
    expect(a.items[0].title).toBe('Sejm przyjął ustawę o „zielonych” dachach');
    t += 5 * 60_000;
    await svc.get();
    expect(calls).toBe(2);
    t += 11 * 60_000;
    await svc.get();
    expect(calls).toBe(4);
  });

  it('shares one refresh between concurrent requests', async () => {
    let calls = 0;
    const svc = createNewsService({ feeds, log: () => {}, fetch: async () => (calls++, rssResponse(RSS)) });
    const [a, b] = await Promise.all([svc.get(), svc.get()]);
    expect(calls).toBe(2);
    expect(a.items).toEqual(b.items);
  });

  it('times out slow feeds and still serves the others', async () => {
    const svc = createNewsService({
      feeds,
      timeoutMs: 50,
      log: () => {},
      fetch: (url, init) =>
        String(url).includes('tvn24')
          ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))))
          : Promise.resolve(rssResponse(ATOM)),
    });
    const r = await svc.get();
    expect(r.items.map((i) => i.source)).toEqual(['Atomowe Wiadomości', 'Atomowe Wiadomości']);
  });

  it('survives bad XML, HTTP errors and network errors; keeps a stale list after a failed refresh', async () => {
    let t = 0;
    let mode: 'ok' | 'bad' = 'bad';
    const logs: string[] = [];
    const svc = createNewsService({
      feeds,
      now: () => t,
      log: (m) => logs.push(m),
      fetch: async (url) => {
        if (mode === 'bad') {
          if (String(url).includes('tvn24')) return rssResponse('<html>500 oops', 200);
          throw new Error('ECONNREFUSED');
        }
        return rssResponse(RSS);
      },
    });
    const empty = await svc.get();
    expect(empty).toEqual({ items: [], fetchedAt: null, sources: [] });
    expect(logs.length).toBeGreaterThan(0);
    mode = 'ok';
    t += 2 * 60_000;
    const ok = await svc.get();
    expect(ok.items.length).toBe(3);
    mode = 'bad';
    t += 20 * 60_000;
    const stale = await svc.get();
    expect(stale.items).toEqual(ok.items);
  });

  it('is disabled with NEWS_FEEDS=off', async () => {
    const svc = createNewsService({ feeds: [], fetch: async () => rssResponse(RSS) });
    expect(await svc.get()).toEqual({ items: [], fetchedAt: null, sources: [], disabled: true });
  });
});

describe('GET /api/news handler', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('serves JSON on /api/news, passes other paths on, rejects POST', async () => {
    const svc = createNewsService({ feeds: ['https://tvn24.pl/x'], log: () => {}, fetch: async () => rssResponse(RSS) });
    const handler = createNewsHandler(svc);
    server = createServer((req, res) =>
      handler(req, res, () => {
        res.statusCode = 404;
        res.end('next');
      }),
    );
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}${NEWS_URL}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { title: string; source: string }[] };
    expect(body.items[0]).toMatchObject({ title: 'Sejm przyjął ustawę o „zielonych” dachach', source: 'TVN24' });
    expect((await fetch(`${base}/api/other`)).status).toBe(404);
    expect((await fetch(`${base}${NEWS_URL}`, { method: 'POST' })).status).toBe(405);
  });
});

// ------------------------------------------------------------------ simulation side

/** puts `agent` in front of the first TV, watching */
function watchTv(world: World, agent: Agent, slot = 0): void {
  const tv = world.objects.find((o) => o.type === 'tv')!;
  agent.action = { kind: 'use', phase: 'using', objectUid: tv.uid, slot, ticksLeft: 500, label: 'Ogląda telewizję', icon: '📺' };
}

/** advances the world clock and news only (agents frozen) */
function advance(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    world.tick++;
    tickNews(world);
  }
}

describe('in-sim news (Wiadomości z osiedla)', () => {
  it('turns gossip-worthy events, breakdowns and weather into bulletins', () => {
    expect(bulletinFor({ tick: 0, kind: 'info', text: 'x', agentIds: [], gossip: { text: 'Ola łowi wielką rybę', aboutIds: [1], valence: 0.6 } })).toEqual({
      title: 'Dobre wieści: Ola łowi wielką rybę',
      big: true,
    });
    expect(bulletinFor({ tick: 0, kind: 'info', text: 'x', agentIds: [], gossip: { text: 'Ola przypala obiad', aboutIds: [1], valence: -0.5 } })?.title).toBe('Pilne: Ola przypala obiad');
    expect(bulletinFor({ tick: 0, kind: 'info', text: 'Lodówka przestaje chłodzić 🔧', agentIds: [] })?.title).toBe('Pilne: na osiedlu lodówka przestaje chłodzić');
    expect(bulletinFor({ tick: 0, kind: 'info', text: 'Przychodzi fachowiec i naprawia wannę 🧰', agentIds: [] })?.title).toBe('Z osiedla: Przychodzi fachowiec i naprawia wannę');
    expect(bulletinFor({ tick: 0, kind: 'use', text: 'Ola: je', agentIds: [] })).toBeNull();
    expect(bulletinFor({ tick: 0, kind: 'info', text: 'x', agentIds: [], gossip: { text: 'Ola i Ala są parą', aboutIds: [1], valence: 0.7, shared: true } })).toBeNull();
    expect(bulletinFor({ tick: 0, kind: 'info', text: '📰 Pilne: coś', agentIds: [] })).toBeNull();

    const world = createWorld(5);
    advance(world, 1);
    expect(localBulletins(world)[0].title).toMatch(/^Pogoda: /);
    expect(forecastBulletin(world, 7)).toMatch(/^Pogoda: (rano|przed południem|po południu|wieczorem|w nocy) (deszcz|burza)|^Pogoda: (słonecznie|pochmurno)/);
    pushEvent(world, 'info', 'Kuchenka się psuje 🔧', []);
    advance(world, 1);
    expect(localBulletins(world)[0]).toEqual({ title: 'Pilne: na osiedlu kuchenka się psuje', source: LOCAL_SOURCE, real: false });
  });

  it('a watcher sees the current headline; the programme rotates every ~20 minutes; TV off without viewers', () => {
    const world = createWorld(3);
    const [a, b] = world.agents;
    advance(world, 1);
    expect(currentHeadline(world)).toBeNull();
    pushEvent(world, 'info', 'Prysznic przecieka 🔧', []);
    watchTv(world, a);
    advance(world, 1);
    const first = currentHeadline(world)!;
    expect(first.source).toBe(LOCAL_SOURCE);
    expect(activeTvs(world).length).toBe(1);
    expect(newsFor(world, a)).toEqual([first.title]);
    expect(newsFor(world, b)).toEqual([]);
    advance(world, ROTATE_TICKS);
    const second = currentHeadline(world)!;
    expect(second.title).not.toBe(first.title);
    expect(newsFor(world, a)).toEqual([second.title, first.title]);
    a.action = null;
    advance(world, 1);
    expect(currentHeadline(world)).toBeNull();
    expect(activeTvs(world)).toEqual([]);
  });

  it('newsFor: newest first, at most 3, without ones already discussed', () => {
    const world = createWorld(4);
    const [a, b] = world.agents;
    for (let i = 0; i < 6; i++) pushEvent(world, 'info', `x${i}`, [], { text: `Ktoś numer ${i} robi coś miłego`, aboutIds: [], valence: 0.5 });
    watchTv(world, a);
    advance(world, 1 + ROTATE_TICKS * 5);
    const seen = newsFor(world, a);
    expect(seen).toHaveLength(NEWS_FOR_MAX);
    const latest = currentHeadline(world)!.title;
    expect(seen[0]).toBe(latest);
    // a mentions it in a chat with b → both have discussed it
    world.conversations.push({
      id: 99, participants: [a.id, b.id], topic: 'plotki', startedAt: world.tick, nextLineIn: 5, pending: false, maxLines: 6,
      lines: [{ speakerId: a.id, text: newsLine(NEWS_TELL[0], latest), tone: 'neutral' }],
    });
    advance(world, 1);
    expect(newsFor(world, a)).not.toContain(latest);
    expect(newsFor(world, a)).toHaveLength(NEWS_FOR_MAX);
  });

  it('broken TV shows nothing', () => {
    const world = createWorld(6);
    const tv = world.objects.find((o) => o.type === 'tv')!;
    watchTv(world, world.agents[0]);
    tv.type = 'repair_tv';
    advance(world, 2);
    expect(currentHeadline(world)).toBeNull();
    tv.type = 'tv';
  });

  it('real headlines replace the programme (in-sim bulletins every 4th slot); [] returns to in-sim news', () => {
    const world = createWorld(7);
    const a = world.agents[0];
    setNewsFeed(world, [
      { title: '  Nowy most   otwarty dla ruchu  ', source: 'TVN24' },
      { title: 'Festiwal dyni w Lublinie przyciąga tłumy', source: 'RMF24' },
      { title: 'x', source: 'za krótki' },
    ]);
    expect(hasRealNews(world)).toBe(true);
    watchTv(world, a);
    advance(world, 1);
    expect(currentHeadline(world)).toEqual({ title: 'Nowy most otwarty dla ruchu', source: 'TVN24', real: true });
    const shown = new Set<string>();
    for (let i = 0; i < 4; i++) {
      advance(world, ROTATE_TICKS);
      shown.add(currentHeadline(world)!.source);
    }
    expect(shown.has(LOCAL_SOURCE)).toBe(true);
    setNewsFeed(world, []);
    expect(hasRealNews(world)).toBe(false);
  });

  it('loadRealNews validates the proxy answer and never throws', async () => {
    const world = createWorld(8);
    const ok = await loadRealNews(world, { fetch: async () => new Response(JSON.stringify({ items: [{ title: 'Sejm przyjął budżet na przyszły rok', source: 'PAP' }, { nope: 1 }] })) });
    expect(ok).toBe(true);
    expect(await loadRealNews(createWorld(8), { fetch: async () => new Response('<html>', { status: 200 }) })).toBe(false);
    expect(await loadRealNews(createWorld(8), { fetch: async () => Promise.reject(new Error('offline')) })).toBe(false);
    expect(await loadRealNews(createWorld(8), { fetch: async () => new Response('{}', { status: 503 }) })).toBe(false);
    expect(sanitizeFeed([{ title: 'A\nB  C długi tytuł', source: 5 }, null, 'x'])).toEqual([{ title: 'A B C długi tytuł', source: 'RSS', real: true }]);
  });

  it('a simulated run with in-sim news only is deterministic, and residents talk about the news', () => {
    const run = (seed: number) => {
      const world = createWorld(seed, { agentCount: 6 });
      const lines: string[] = [];
      const counted = new WeakMap<object, number>();
      let onAir = 0;
      for (let t = 0; t < 3 * 1440; t++) {
        tickWorld(world);
        if (currentHeadline(world)) onAir++;
        for (const c of world.conversations) {
          for (const l of c.lines.slice(counted.get(c) ?? 0)) if (isNewsLine(l.text)) lines.push(`${world.tick}:${l.speakerId}:${l.text}`);
          counted.set(c, c.lines.length);
        }
      }
      const snap = world.agents.map((a) => `${a.id}@${a.pos.x},${a.pos.y}:${newsFor(world, a).join('|')}`).join('\n');
      return { snap, lines, onAir, rng: world.rng.state(), log: world.events.filter((e) => e.text.startsWith('📰')).length };
    };
    const a = run(1);
    const b = run(1);
    expect(a).toEqual(b);
    expect(a.onAir).toBeGreaterThan(100);
    const lines = [...a.lines, ...run(42).lines];
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(l.split(':').slice(2).join(':').length).toBeLessThanOrEqual(70);
    // the log stays calm: at most one 📰 line per 6 game hours
    expect(a.log).toBeLessThanOrEqual(12);
  }, 60_000);
});

// ------------------------------------------------------------------ dialogue

function makeAgent(id: number, name: string, traits: Partial<Traits> = {}): Agent {
  return {
    id, name, color: '#f00',
    traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0, ...traits },
    needs: { hunger: 70, energy: 70, fun: 60, social: 50, hygiene: 70, comfort: 70 },
    mood: 60, pos: { x: 0, y: 0 }, prevPos: { x: 0, y: 0 }, facing: 1, path: [], action: null, bubble: null,
    stats: { conversations: 0, objectsUsed: 0, ticksIdle: 0 },
  };
}

const LONG = 'Rada Ministrów przyjęła projekt ustawy o modernizacji infrastruktury kolejowej w województwach wschodnich do roku 2035';

function ctxWith(over: Partial<ConversationContext> = {}): ConversationContext {
  return {
    speaker: makeAgent(1, 'Ola', { sociability: 1 }),
    listener: makeAgent(2, 'Bartek'),
    relationship: 30,
    topic: 'polityka',
    history: [
      { speakerId: 1, text: 'Cześć, Bartek!', tone: 'positive' },
      { speakerId: 2, text: 'Hej.', tone: 'neutral' },
    ],
    turn: 2,
    isLast: false,
    time: timeFromTick(300),
    news: [LONG, 'Pogoda: po południu deszcz, weźcie parasole'],
    ...over,
  };
}

describe('dialogue with news', () => {
  it('news lines quote the headline verbatim (shortened at a word boundary) and fit 70 chars', () => {
    for (const tpl of NEWS_TELL) {
      const line = newsLine(tpl, LONG);
      expect(line.length).toBeLessThanOrEqual(70);
      expect(isNewsLine(line)).toBe(true);
      const q = quotedHeadline(line)!;
      expect(LONG.startsWith(q)).toBe(true);
      expect(line).toMatch(/…”$/);
    }
    expect(fitHeadline('Krótki nagłówek', 60)).toBe('Krótki nagłówek');
    expect(newsLine(NEWS_TELL[1], 'Krótki nagłówek dnia')).toBe('Podobno w telewizji: „Krótki nagłówek dnia”');
  });

  it('the procedural provider sometimes brings up a headline mid-conversation, never in greetings / farewells, no gendered "Słyszałeś"', () => {
    const p = createProceduralProvider();
    const rng = createRng(9);
    let told = 0;
    for (let i = 0; i < 300; i++) {
      const line = p.nextLine(ctxWith(), rng) as { text: string };
      expect(line.text.length).toBeLessThanOrEqual(70);
      expect(line.text).not.toMatch(/Słyszałeś|Słyszałaś|Widziałeś|Widziałaś/);
      if (isNewsLine(line.text)) told++;
    }
    expect(told).toBeGreaterThan(30);
    expect(told).toBeLessThan(250);
    for (let i = 0; i < 100; i++) {
      expect(isNewsLine((p.nextLine(ctxWith({ turn: 0, history: [] }), rng) as { text: string }).text)).toBe(false);
      expect(isNewsLine((p.nextLine(ctxWith({ isLast: true, turn: 5 }), rng) as { text: string }).text)).toBe(false);
    }
  });

  it('does not repeat a headline already told in the conversation; the listener reacts', () => {
    const p = createProceduralProvider();
    const rng = createRng(3);
    const said = newsLine(NEWS_TELL[0], LONG);
    const history = [
      { speakerId: 1, text: 'Cześć!', tone: 'positive' as const },
      { speakerId: 2, text: said, tone: 'neutral' as const },
    ];
    let reactions = 0;
    for (let i = 0; i < 200; i++) {
      const line = p.nextLine(ctxWith({ history, news: [LONG] }), rng) as { text: string };
      expect(line.text).not.toContain('„Rada Ministrów');
      if (/No coś takiego|Świat zwariował|Ciekawe, co z tego|Kto by pomyślał|Nie nadążam|Wolę nie|Same nowiny|szkoda nerwów/i.test(line.text)) reactions++;
    }
    expect(reactions).toBeGreaterThan(100);
  });

  it('LLM request carries ≤ 2 fresh headlines; server validates and puts them into the prompt', () => {
    const ctx = ctxWith({ news: ['Pierwszy nagłówek dnia o pogodzie', 'Drugi nagłówek dnia o sporcie', 'Trzeci nagłówek dnia'] });
    const req = buildLineRequest(ctx);
    expect(req.news).toEqual(['Pierwszy nagłówek dnia o pogodzie', 'Drugi nagłówek dnia o sporcie']);
    expect(req.news!.length).toBeLessThanOrEqual(LLM_MAX_NEWS);
    expect(newsCandidates(ctxWith({ turn: 0 }))).toEqual([]);
    expect(newsCandidates(ctxWith({ isLast: true }))).toEqual([]);
    expect(buildLineRequest(ctxWith({ news: undefined })).news).toBeUndefined();
    const v = validateLineRequest(JSON.parse(JSON.stringify(req)));
    expect(v?.news).toEqual(req.news);
    expect(buildUserPrompt(v!)).toContain('- „Pierwszy nagłówek dnia o pogodzie”');
    expect(validateLineRequest({ ...req, news: ['a', 'b', 'c'] })).toBeNull();
    expect(validateLineRequest({ ...req, news: [42] })).toBeNull();
    expect(buildUserPrompt({ ...v!, isLast: true })).not.toContain('Nagłówki');
  });
});
