import type { ObjectDef, ObjectSlot, RectArea } from '../../types';

// Catalogue of building projects: stages, work needed, object defs per stage and of the
// finished building, preferred building sites per house. Pure data (no imports besides types):
// world/objects.ts merges PROJECT_DEFS into the world's catalogue at module load.
//
// Each stage is its own object type. The renderer's static layer is rebuilt when an object's
// type *length* changes (render/tiles.ts staticSignature), so consecutive stage types — and the
// last stage vs the finished building — must differ in length (checked in tests/projects.test.ts).

export type ProjectKindId = 'altana' | 'warzywnik' | 'domek_na_drzewie' | 'pomost';

export interface StageDef {
  /** object type of the construction site during this stage */
  type: string;
  /** Polish stage name for the UI, e.g. "Fundament" */
  label: string;
  /** progress (0..1) at which this stage is finished */
  until: number;
  /** Polish progressive verb shown while working, e.g. "Kopie fundament pod altanę" */
  verb: string;
  /** log line when this stage begins (not used for the first one) */
  startText: string;
}

export interface ProjectKind {
  id: ProjectKindId;
  /** Polish display name, e.g. "Altana w ogrodzie" */
  name: string;
  /** short name, nominative, e.g. "Altana" */
  short: string;
  /** genitive, e.g. "altany" ("budowa altany", "przy budowie altany") */
  genitive: string;
  /** locative for "pracuję przy …", e.g. "altanie" */
  locative: string;
  /** accusative for "budujemy …", e.g. "altanę" */
  accusative: string;
  icon: string;
  size: { w: number; h: number };
  /** terrain under the footprint: 'grass' (garden) or 'water' (e.g. a pier; work spots stay on land) */
  site: 'grass' | 'water';
  /** work slots (stand tiles around the footprint) */
  slots: ObjectSlot[];
  /** effective worker-minutes needed (team minutes count ×TEAM_BONUS) */
  work: number;
  /** planned length in days (the schedule the residents loosely follow) */
  plannedDays: number;
  stages: StageDef[];
  /** object type of the finished building */
  finishedType: string;
  /** proposal line: "{N} proponuje …" */
  proposal: string;
  /** speech bubble of the proposer */
  pitch: string;
  /** completion log line, before " Ekipa: …" */
  doneText: string;
}

/** per-house areas where a building site is looked for first (whole map as a fallback) */
export const SITE_HINTS: Record<string, RectArea[]> = {
  dom: [
    { x: 35, y: 18, w: 8, h: 6 },
    { x: 30, y: 4, w: 11, h: 5 },
  ],
  kamienica: [
    { x: 17, y: 18, w: 5, h: 5 },
    { x: 23, y: 12, w: 8, h: 5 },
  ],
  jezioro: [
    { x: 25, y: 23, w: 8, h: 6 },
    { x: 7, y: 21, w: 7, h: 6 },
  ],
  akademik: [
    { x: 34, y: 26, w: 10, h: 4 },
    { x: 0, y: 26, w: 8, h: 4 },
  ],
};

const ALTANA_SLOTS: ObjectSlot[] = [
  { stand: { x: 1, y: 3 } },
  { stand: { x: -1, y: 1 } },
  { stand: { x: 3, y: 1 } },
  { stand: { x: 1, y: -1 } },
];

const WARZYWNIK_SLOTS: ObjectSlot[] = [{ stand: { x: 0, y: 2 } }, { stand: { x: 1, y: 2 } }, { stand: { x: 2, y: 2 } }];

// the tree house is built around a tree of its own (drawn with the site), the work spots are the
// gazebo's: the four sides of the 3x3 footprint
const DOMEK_SLOTS: ObjectSlot[] = ALTANA_SLOTS;

// the pier runs east from a west shore: all footprint tiles are water, the work spots are the shore
// tiles next to its west end (one of them diagonal)
const POMOST_SLOTS: ObjectSlot[] = [{ stand: { x: -1, y: 0 } }, { stand: { x: -1, y: 1 } }, { stand: { x: -1, y: -1 } }];

export const PROJECT_KINDS: Record<ProjectKindId, ProjectKind> = {
  altana: {
    id: 'altana',
    name: 'Altana w ogrodzie',
    short: 'Altana',
    genitive: 'altany',
    locative: 'altanie',
    accusative: 'altanę',
    icon: '🛖',
    size: { w: 3, h: 3 },
    site: 'grass',
    slots: ALTANA_SLOTS,
    work: 2200,
    plannedDays: 13,
    stages: [
      {
        type: 'altana_fundament',
        label: 'Fundament',
        until: 0.24,
        verb: 'Kopie fundament pod altanę',
        startText: 'Na placu budowy altany stoją paliki i sznurek',
      },
      {
        type: 'altana_konstrukcja',
        label: 'Konstrukcja',
        until: 0.56,
        verb: 'Stawia konstrukcję altany',
        startText: 'Fundament altany gotowy — czas na konstrukcję 🪵',
      },
      {
        type: 'altana_dach',
        label: 'Dach',
        until: 0.84,
        verb: 'Kładzie dach altany',
        startText: 'Konstrukcja altany stoi — czas na dach 🏗️',
      },
      {
        type: 'altana_malowanie',
        label: 'Malowanie',
        until: 1,
        verb: 'Maluje altanę',
        startText: 'Dach altany na miejscu — czas na malowanie 🖌️',
      },
    ],
    finishedType: 'altana',
    proposal: 'proponuje budowę altany w ogrodzie',
    pitch: 'Zbudujmy razem altanę! 🔨',
    doneText: 'Altana gotowa!',
  },
  warzywnik: {
    id: 'warzywnik',
    name: 'Warzywnik',
    short: 'Warzywnik',
    genitive: 'warzywnika',
    locative: 'warzywniku',
    accusative: 'warzywnik',
    icon: '🥕',
    size: { w: 3, h: 2 },
    site: 'grass',
    slots: WARZYWNIK_SLOTS,
    work: 800,
    plannedDays: 5,
    stages: [
      {
        type: 'warzywnik_przekopywanie',
        label: 'Przekopywanie',
        until: 0.35,
        verb: 'Przekopuje ziemię pod warzywnik',
        startText: 'Wytyczone miejsce na warzywnik',
      },
      {
        type: 'warzywnik_grzadki',
        label: 'Grządki',
        until: 0.7,
        verb: 'Usypuje grządki',
        startText: 'Ziemia przekopana — czas na grządki 🌱',
      },
      {
        type: 'warzywnik_sadzenie',
        label: 'Sadzenie',
        until: 1,
        verb: 'Sadzi warzywa',
        startText: 'Grządki gotowe — czas na sadzenie 🥕',
      },
    ],
    finishedType: 'warzywnik',
    proposal: 'proponuje założenie warzywnika',
    pitch: 'A może własny warzywnik? 🥕',
    doneText: 'Warzywnik gotowy!',
  },
  domek_na_drzewie: {
    id: 'domek_na_drzewie',
    name: 'Domek na drzewie',
    short: 'Domek na drzewie',
    genitive: 'domku na drzewie',
    locative: 'domku na drzewie',
    accusative: 'domek na drzewie',
    icon: '🌳',
    size: { w: 3, h: 3 },
    site: 'grass',
    slots: DOMEK_SLOTS,
    work: 1200,
    plannedDays: 7,
    stages: [
      {
        type: 'domek_belki',
        label: 'Belki',
        until: 0.25,
        verb: 'Mocuje belki w koronie drzewa',
        startText: 'Pod rozłożystym drzewem leżą belki i drabina',
      },
      {
        type: 'domek_platforma',
        label: 'Platforma',
        until: 0.5,
        verb: 'Układa podłogę platformy',
        startText: 'Belki trzymają mocno — czas na platformę 🪵',
      },
      {
        type: 'domek_sciany',
        label: 'Ściany',
        until: 0.78,
        verb: 'Stawia ściany domku',
        startText: 'Platforma w koronie gotowa — czas na ściany 🏗️',
      },
      {
        type: 'domek_dach',
        label: 'Dach',
        until: 1,
        verb: 'Kładzie dach domku',
        startText: 'Ściany domku stoją — czas na dach 🏗️',
      },
    ],
    finishedType: 'domek_na_drzewie',
    proposal: 'proponuje budowę domku na drzewie',
    pitch: 'Zbudujmy domek na drzewie! 🌳',
    doneText: 'Domek na drzewie gotowy!',
  },
  pomost: {
    id: 'pomost',
    name: 'Pomost nad wodą',
    short: 'Pomost',
    genitive: 'pomostu',
    locative: 'pomoście',
    accusative: 'pomost',
    icon: '⚓',
    size: { w: 3, h: 2 },
    site: 'water',
    slots: POMOST_SLOTS,
    work: 900,
    plannedDays: 6,
    stages: [
      {
        type: 'pomost_pale',
        label: 'Pale',
        until: 0.35,
        verb: 'Wbija pale w dno',
        startText: 'Na brzegu leżą pale, sznur i młotek',
      },
      {
        type: 'pomost_deski',
        label: 'Deski',
        until: 0.75,
        verb: 'Przybija deski pomostu',
        startText: 'Pale stoją w wodzie — czas na deski 🪵',
      },
      {
        type: 'pomost_barierki',
        label: 'Barierki',
        until: 1,
        verb: 'Montuje barierki pomostu',
        startText: 'Deski położone — czas na barierki 🔨',
      },
    ],
    finishedType: 'pomost',
    proposal: 'proponuje budowę pomostu nad wodą',
    pitch: 'Przydałby się własny pomost! 🎣',
    doneText: 'Pomost gotowy!',
  },
};

/** order in which projects are proposed (the next one after the previous is finished) */
export const PROJECT_ORDER: readonly ProjectKindId[] = ['altana', 'warzywnik', 'domek_na_drzewie', 'pomost'];

/**
 * what the brain sees per minute of construction work: only the good side (fun, company), so the
 * site stays a candidate for anyone not bored and lonely already ...
 */
const WORK_EFFECTS = { fun: 0.5, social: 0.2 };
/** ... and what it costs, applied by world/projects to every worker each minute (dust, sweat, sore back) */
export const WORK_COSTS = { energy: -0.05, hygiene: -0.05, comfort: -0.04 } as const;

function stageDef(kind: ProjectKind, i: number): ObjectDef {
  const st = kind.stages[i];
  return {
    id: st.type,
    name: `Budowa: ${kind.short.toLowerCase()} (${st.label.toLowerCase()})`,
    verb: st.verb,
    icon: '🔨',
    color: '#b88a55',
    size: kind.size,
    blocking: true,
    slots: kind.slots,
    effects: WORK_EFFECTS,
    duration: [30, 90],
    // co-workers chat (ambient chats); 'exercise' = active residents like it; rain stops it
    social: true,
    tags: ['project', 'outdoor', 'exercise'],
  };
}

const FINISHED: Record<string, ObjectDef> = {
  altana: {
    id: 'altana',
    name: 'Altana',
    verb: 'Odpoczywa w altanie',
    icon: '🛖',
    color: '#c89a62',
    size: { w: 3, h: 3 },
    blocking: true,
    // seats along three benches and the entrance (drawn inside the gazebo)
    slots: [
      { stand: { x: 1, y: 3 }, use: { x: 1, y: 1.75 } },
      { stand: { x: -1, y: 1 }, use: { x: 0.05, y: 1.05 } },
      { stand: { x: 3, y: 1 }, use: { x: 1.95, y: 1.05 } },
      { stand: { x: 1, y: -1 }, use: { x: 1, y: 0.2 } },
    ],
    effects: { comfort: 0.6, social: 0.35, fun: 0.25 },
    duration: [30, 60],
    social: true,
    tags: ['outdoor', 'project_done'],
  },
  warzywnik: {
    id: 'warzywnik',
    name: 'Warzywnik',
    verb: 'Pieli warzywnik',
    icon: '🥕',
    color: '#6e4a2c',
    size: { w: 3, h: 2 },
    blocking: true,
    slots: WARZYWNIK_SLOTS,
    effects: { fun: 0.5, comfort: 0.1 },
    duration: [25, 45],
    tags: ['outdoor', 'quiet', 'project_done'],
  },
  domek_na_drzewie: {
    id: 'domek_na_drzewie',
    name: 'Domek na drzewie',
    verb: 'Siedzi w domku na drzewie',
    icon: '🌳',
    color: '#8fae6a',
    size: { w: 3, h: 3 },
    blocking: true,
    // seats on the platform in the crown, drawn on the deck
    slots: [
      { stand: { x: 1, y: 3 }, use: { x: 1, y: 1.65 } },
      { stand: { x: -1, y: 1 }, use: { x: 0.15, y: 1.3 } },
      { stand: { x: 3, y: 1 }, use: { x: 1.85, y: 1.3 } },
      { stand: { x: 1, y: -1 }, use: { x: 1, y: 0.95 } },
    ],
    effects: { fun: 0.5, comfort: 0.3, social: 0.3 },
    duration: [30, 60],
    social: true,
    tags: ['outdoor', 'project_done'],
  },
  pomost: {
    id: 'pomost',
    name: 'Pomost',
    verb: 'Łowi ryby z pomostu',
    icon: '🎣',
    color: '#b98a57',
    size: { w: 3, h: 2 },
    blocking: true,
    // anglers at the pier head and in the middle, drawn on the deck
    slots: [
      { stand: { x: -1, y: 0 }, use: { x: 1.9, y: 0 } },
      { stand: { x: -1, y: 1 }, use: { x: 1.9, y: 1 } },
      { stand: { x: -1, y: -1 }, use: { x: 0.9, y: 0.5 } },
    ],
    effects: { fun: 0.6, comfort: 0.3 },
    duration: [45, 90],
    social: true,
    tags: ['outdoor', 'quiet', 'project_done'],
  },
};

function buildDefs(): Record<string, ObjectDef> {
  const out: Record<string, ObjectDef> = {};
  for (const kind of Object.values(PROJECT_KINDS)) {
    kind.stages.forEach((_, i) => {
      const d = stageDef(kind, i);
      out[d.id] = d;
    });
    out[kind.finishedType] = FINISHED[kind.finishedType];
  }
  return out;
}

export const PROJECT_DEFS: Record<string, ObjectDef> = buildDefs();

/** project kind and stage index (stage = kind.stages.length for the finished building) of an object type */
export function projectTypeInfo(type: string): { kind: ProjectKind; stage: number } | null {
  for (const kind of Object.values(PROJECT_KINDS)) {
    if (type === kind.finishedType) return { kind, stage: kind.stages.length };
    const i = kind.stages.findIndex((s) => s.type === type);
    if (i >= 0) return { kind, stage: i };
  }
  return null;
}
