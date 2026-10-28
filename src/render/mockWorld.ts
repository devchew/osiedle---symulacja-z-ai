// Self-contained mock world for the render demo (no dependency on src/world or
// src/agents). A house with five rooms + a garden with a pond, and a handful
// of agents doing different things.

import type { Agent, Bubble, ObjectDef, ObjectInstance, Relationships, Room, TileKind, Vec2, World } from '../types';
import { createRng } from '../core/rng';

export const MOCK_W = 44;
export const MOCK_H = 30;

function def(
  id: string,
  name: string,
  icon: string,
  color: string,
  w: number,
  h: number,
  blocking = true,
  tags?: string[],
): ObjectDef {
  return {
    id,
    name,
    verb: name,
    icon,
    color,
    size: { w, h },
    blocking,
    slots: [{ stand: { x: 0, y: h } }],
    effects: {},
    duration: [10, 30],
    tags,
  };
}

const DEFS: ObjectDef[] = [
  def('fridge', 'Lodówka', '🧊', '#eef3f6', 1, 1),
  def('counter', 'Blat', '🔪', '#e9dfcf', 1, 1),
  def('counter_long', 'Blat', '🔪', '#e9dfcf', 2, 1),
  def('stove', 'Kuchenka', '🍳', '#ddd', 1, 1),
  def('kitchen_sink', 'Zlew', '🚰', '#eee', 1, 1),
  def('dining_table', 'Stół', '🍽️', '#c08a57', 3, 2),
  def('chair', 'Krzesło', '🪑', '#c99a68', 1, 1),
  def('sofa', 'Kanapa', '🛋️', '#6c8ebf', 3, 1),
  def('armchair', 'Fotel', '🛋️', '#d9825b', 1, 1),
  def('tv', 'Telewizor', '📺', '#222', 3, 1),
  def('bookshelf', 'Regał', '📚', '#8b5e3c', 2, 1),
  def('piano', 'Pianino', '🎹', '#222', 2, 1),
  def('guitar', 'Gitara', '🎸', '#d48a3c', 1, 1, false),
  def('rug', 'Dywan', '🟥', '#c9665a', 5, 3, false),
  def('rug_bath', 'Dywanik', '🟦', '#7fb0c9', 2, 1, false),
  def('rug_bed', 'Dywan', '🟪', '#9b87c4', 4, 2, false),
  def('lamp', 'Lampa', '💡', '#fbefd0', 1, 1),
  def('plant', 'Roślina', '🪴', '#5fa356', 1, 1),
  def('toilet', 'Toaleta', '🚽', '#fff', 1, 1),
  def('sink', 'Umywalka', '🚰', '#fff', 1, 1),
  def('bathtub', 'Wanna', '🛁', '#fff', 2, 1),
  def('shower', 'Prysznic', '🚿', '#cfe', 2, 2),
  def('bed_double', 'Łóżko', '🛏️', '#e58f84', 2, 3, true, ['sleep']),
  def('bed_single', 'Łóżko', '🛏️', '#7fb38a', 3, 1, true, ['sleep']),
  def('wardrobe', 'Szafa', '👔', '#a8754b', 2, 1),
  def('computer_desk', 'Komputer', '💻', '#d4b089', 2, 1),
  def('exercise_bike', 'Rowerek', '🚴', '#e05a4f', 1, 1),
  def('treadmill', 'Bieżnia', '🏃', '#5cb85c', 1, 2),
  def('bench', 'Ławka', '🪑', '#b07a4a', 2, 1),
  def('grill', 'Grill', '🍖', '#333', 1, 1),
  def('fishing_spot', 'Pomost', '🎣', '#b98a5a', 1, 1, false),
  def('tree', 'Drzewo', '🌳', '#5f9e4c', 1, 1),
  def('bush', 'Krzak', '🌿', '#4f8f45', 2, 1),
  def('flower_bed', 'Grządka', '🌷', '#7a5a3c', 3, 1),
  def('arcade', 'Automat', '🕹️', '#8e6cc1', 1, 1),
];

function buildTiles(): { tiles: TileKind[]; rooms: Room[] } {
  const W = MOCK_W;
  const H = MOCK_H;
  const tiles: TileKind[] = new Array(W * H).fill('grass');
  const set = (x: number, y: number, k: TileKind): void => {
    if (x >= 0 && y >= 0 && x < W && y < H) tiles[y * W + x] = k;
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, k: TileKind): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, k);
  };
  // house shell
  rect(2, 2, 28, 20, 'wall');
  rect(3, 3, 11, 9, 'tile'); // kitchen
  rect(13, 3, 27, 12, 'floor'); // living room
  rect(10, 11, 12, 12, 'floor'); // hall
  rect(3, 11, 8, 19, 'tile'); // bathroom
  rect(10, 14, 18, 19, 'floor'); // bedroom
  rect(20, 14, 27, 19, 'floor'); // office
  // doors
  for (const [x, y] of [
    [12, 6],
    [11, 10],
    [9, 12],
    [11, 13],
    [23, 13],
    [28, 8],
    [20, 20],
  ])
    set(x, y, 'door');
  // paths
  rect(29, 8, 32, 8, 'path');
  rect(32, 8, 32, 24, 'path');
  rect(20, 21, 20, 24, 'path');
  rect(4, 24, 42, 24, 'path');
  rect(36, 24, 36, 28, 'path');
  // pond
  const pcx = 38;
  const pcy = 14;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (x - pcx) / 3.8;
      const dy = (y - pcy) / 2.9;
      if (dx * dx + dy * dy <= 1) set(x, y, 'water');
    }
  set(41, 17, 'water');
  set(42, 15, 'water');
  const rooms: Room[] = [
    { id: 'kitchen', name: 'Kuchnia', rect: { x: 3, y: 3, w: 9, h: 7 } },
    { id: 'living', name: 'Salon', rect: { x: 13, y: 3, w: 15, h: 10 } },
    { id: 'bathroom', name: 'Łazienka', rect: { x: 3, y: 11, w: 6, h: 9 } },
    { id: 'bedroom', name: 'Sypialnia', rect: { x: 10, y: 14, w: 9, h: 6 } },
    { id: 'office', name: 'Gabinet', rect: { x: 20, y: 14, w: 8, h: 6 } },
    { id: 'garden', name: 'Ogród', rect: { x: 29, y: 0, w: 15, h: 30 } },
  ];
  return { tiles, rooms };
}

const OBJECTS: [string, number, number][] = [
  // kitchen
  ['fridge', 3, 3],
  ['counter_long', 4, 3],
  ['stove', 6, 3],
  ['kitchen_sink', 7, 3],
  ['counter', 8, 3],
  ['dining_table', 5, 6],
  ['chair', 4, 6],
  ['chair', 4, 7],
  ['chair', 8, 6],
  ['chair', 8, 7],
  ['plant', 11, 3],
  // living room
  ['rug', 16, 5],
  ['tv', 17, 3],
  ['sofa', 17, 9],
  ['armchair', 21, 7],
  ['bookshelf', 13, 3],
  ['piano', 24, 3],
  ['guitar', 26, 5],
  ['lamp', 14, 9],
  ['lamp', 27, 11],
  ['plant', 27, 3],
  ['arcade', 24, 11],
  // bathroom
  ['toilet', 3, 11],
  ['sink', 5, 11],
  ['bathtub', 7, 11],
  ['shower', 3, 18],
  ['rug_bath', 5, 15],
  // bedroom
  ['rug_bed', 11, 17],
  ['bed_double', 12, 14],
  ['bed_single', 16, 19],
  ['wardrobe', 16, 14],
  ['lamp', 10, 14],
  ['plant', 18, 16],
  // office
  ['computer_desk', 21, 14],
  ['bookshelf', 25, 14],
  ['exercise_bike', 27, 18],
  ['treadmill', 20, 18],
  ['lamp', 27, 14],
  // garden
  ['bench', 35, 18],
  ['fishing_spot', 33, 14],
  ['grill', 24, 22],
  ['bench', 22, 26],
  ['flower_bed', 4, 22],
  ['flower_bed', 12, 22],
  ['bush', 29, 4],
  ['bush', 39, 26],
  ['bush', 26, 27],
  ['tree', 31, 2],
  ['tree', 41, 3],
  ['tree', 42, 9],
  ['tree', 30, 19],
  ['tree', 41, 21],
  ['tree', 2, 27],
  ['tree', 9, 27],
  ['tree', 16, 28],
  ['tree', 34, 27],
  ['tree', 0, 12],
  ['lamp', 33, 23],
];

export interface MockAgentScript {
  /** closed loop of waypoints for walking agents */
  loop?: Vec2[];
  speed?: number;
  /** progress along the loop in tiles */
  dist: number;
  lines?: { kind: Bubble['kind']; text: string; tone?: Bubble['tone'] }[];
  lineIdx: number;
}

function agent(id: number, name: string, color: string, x: number, y: number, facing: -1 | 1): Agent {
  return {
    id,
    name,
    color,
    traits: { sociability: 0, activity: 0, neatness: 0, cheerfulness: 0 },
    needs: { hunger: 70, energy: 70, fun: 70, social: 70, hygiene: 70, comfort: 70 },
    mood: 70,
    pos: { x, y },
    prevPos: { x, y },
    facing,
    path: [],
    action: null,
    bubble: null,
    stats: { conversations: 0, objectsUsed: 0, ticksIdle: 0 },
  };
}

export function createMockWorld(seed = 7): { world: World; scripts: Map<number, MockAgentScript> } {
  const { tiles, rooms } = buildTiles();
  const objectDefs: Record<string, ObjectDef> = {};
  for (const d of DEFS) objectDefs[d.id] = d;
  const objects: ObjectInstance[] = OBJECTS.map(([type, x, y], i) => ({ uid: i + 1, type, pos: { x, y }, reservedBy: [null] }));
  const solid = tiles.map((k) => k === 'wall' || k === 'water');
  const uidOf = (type: string): number => objects.find((o) => o.type === type)?.uid ?? 0;

  const agents: Agent[] = [
    agent(1, 'Ania', '#e8737a', 17, 7, 1),
    agent(2, 'Bartek', '#4f8fd6', 19, 7, -1),
    agent(3, 'Celina', '#b07ad6', 12.5, 15.2, 1),
    agent(4, 'Darek', '#3fae8f', 21.5, 15, 1),
    agent(5, 'Ewa', '#f2a541', 32, 12, 1),
    agent(6, 'Filip', '#7a8cff', 33, 14, 1),
    agent(7, 'Gosia', '#ef6fae', 10, 12, 1),
  ];
  const [ania, bartek, celina, darek, ewa, filip, gosia] = agents;
  ania.action = { kind: 'talk', phase: 'talking', partnerId: 2, conversationId: 1, ticksLeft: 50, label: 'Rozmawia', icon: '💬' };
  bartek.action = { kind: 'talk', phase: 'talking', partnerId: 1, conversationId: 1, ticksLeft: 50, label: 'Rozmawia', icon: '💬' };
  celina.action = { kind: 'use', phase: 'using', objectUid: uidOf('bed_double'), slot: 0, ticksLeft: 300, label: 'Śpi', icon: '😴' };
  darek.action = { kind: 'use', phase: 'using', objectUid: uidOf('computer_desk'), slot: 0, ticksLeft: 60, label: 'Gra na komputerze', icon: '💻' };
  darek.facing = 1;
  ewa.action = { kind: 'wander', phase: 'walking', ticksLeft: 999, label: 'Spaceruje', icon: '🚶' };
  filip.action = { kind: 'use', phase: 'using', objectUid: uidOf('fishing_spot'), slot: 0, ticksLeft: 80, label: 'Łowi ryby', icon: '🎣' };
  gosia.action = { kind: 'use', phase: 'walking', objectUid: uidOf('fridge'), slot: 0, ticksLeft: 999, label: 'Idzie do lodówki', icon: '🍽️' };

  const scripts = new Map<number, MockAgentScript>();
  scripts.set(1, {
    dist: 0,
    lineIdx: 0,
    lines: [
      { kind: 'speech', text: 'Widziałeś wczoraj ten mecz? Coś niesamowitego!', tone: 'positive' },
      { kind: 'speech', text: 'Serio? Ja myślałam, że przegrają w pierwszej połowie.', tone: 'neutral' },
    ],
  });
  scripts.set(2, {
    dist: 0,
    lineIdx: 0,
    lines: [
      { kind: 'speech', text: 'No pewnie! Ostatnia minuta i gol z rzutu wolnego.', tone: 'positive' },
      { kind: 'speech', text: 'Sędzia był beznadziejny, nie zaczynaj.', tone: 'negative' },
    ],
  });
  scripts.set(4, {
    dist: 0,
    lineIdx: 0,
    lines: [
      { kind: 'thought', text: 'Ciekawe, co dziś na obiad…' },
      { kind: 'thought', text: 'Jeszcze jeden poziom i idę spać.' },
    ],
  });
  scripts.set(5, {
    dist: 0,
    lineIdx: 0,
    speed: 0.22,
    loop: [
      { x: 32, y: 9 },
      { x: 32, y: 24 },
      { x: 40, y: 24 },
      { x: 40, y: 27 },
      { x: 36, y: 28 },
      { x: 36, y: 24 },
      { x: 32, y: 24 },
    ],
    lines: [{ kind: 'thought', text: 'Ale piękny dzień na spacer.' }],
  });
  scripts.set(6, {
    dist: 0,
    lineIdx: 0,
    lines: [
      { kind: 'speech', text: 'Znowu nic nie bierze! Te ryby mnie nienawidzą.', tone: 'negative' },
      { kind: 'thought', text: 'Może spróbuję innej przynęty.' },
    ],
  });
  scripts.set(7, {
    dist: 0,
    lineIdx: 0,
    speed: 0.25,
    loop: [
      { x: 11, y: 12 },
      { x: 11, y: 10 },
      { x: 10, y: 9 },
      { x: 10, y: 5 },
      { x: 4, y: 5 },
      { x: 4, y: 4 },
      { x: 4, y: 5 },
      { x: 11, y: 5 },
      { x: 11, y: 6 },
      { x: 14, y: 6 },
      { x: 15, y: 11 },
      { x: 26, y: 12 },
      { x: 23, y: 12 },
      { x: 23, y: 16 },
      { x: 23, y: 12 },
      { x: 13, y: 12 },
    ],
  });

  const pairs = new Map<string, number>();
  const relationships: Relationships = {
    get: (a, b) => pairs.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? 0,
    adjust: (a, b, d) => {
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      const v = Math.max(-100, Math.min(100, (pairs.get(k) ?? 0) + d));
      pairs.set(k, v);
      return v;
    },
    all: () =>
      [...pairs.entries()].map(([k, value]) => {
        const [a, b] = k.split(':').map(Number);
        return { a, b, value };
      }),
  };

  const world: World = {
    seed,
    rng: createRng(seed),
    tick: 0,
    grid: { width: MOCK_W, height: MOCK_H, tiles, solid, rooms },
    objectDefs,
    objects,
    agents,
    relationships,
    conversations: [],
    events: [],
    dialogue: { name: 'mock', nextLine: (ctx) => ({ speakerId: ctx.speaker.id, text: '…', tone: 'neutral' }) },
  };
  return { world, scripts };
}

function loopLength(loop: Vec2[]): number {
  let len = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

function pointOnLoop(loop: Vec2[], dist: number): Vec2 {
  const total = loopLength(loop);
  let d = ((dist % total) + total) % total;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= seg) {
      const t = seg ? d / seg : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    d -= seg;
  }
  return { ...loop[0] };
}

/** advances the mock world by one tick (one game minute) */
export function stepMockWorld(world: World, scripts: Map<number, MockAgentScript>): void {
  world.tick++;
  for (const a of world.agents) {
    a.prevPos = { ...a.pos };
    const s = scripts.get(a.id);
    if (!s) continue;
    if (s.loop) {
      s.dist += s.speed ?? 0.2;
      const p = pointOnLoop(s.loop, s.dist);
      if (Math.abs(p.x - a.pos.x) > 0.01) a.facing = p.x > a.pos.x ? 1 : -1;
      a.pos = p;
    }
    if (a.bubble) {
      a.bubble.ttl--;
      if (a.bubble.ttl <= 0) a.bubble = null;
    }
    if (!a.bubble && s.lines?.length) {
      // talkers alternate: Ania on even windows, Bartek on odd windows
      const window = Math.floor(world.tick / 14);
      const talkTurn = a.id === 1 ? window % 2 === 0 : a.id === 2 ? window % 2 === 1 : (world.tick + a.id * 9) % 40 < 22;
      if (talkTurn) {
        const l = s.lines[s.lineIdx % s.lines.length];
        s.lineIdx++;
        a.bubble = { kind: l.kind, text: l.text, tone: l.tone, ttl: 12 };
      }
    }
  }
}
