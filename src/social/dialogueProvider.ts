import type { ConversationContext, DayPhase, DialogueLine, DialogueProvider, Gossip, Rng, Tone } from '../types';

// Procedural Polish dialogue. Lines are short (bubble-friendly) and avoid
// gendered past-tense verb forms. Slots: {name} listener name, {pora} time of
// day, {thing} a random household item.

type ToneLines = Record<Tone, readonly string[]>;

export const GREETINGS: ToneLines = {
  positive: ['Cześć, {name}! Jak miło cię widzieć!', 'Hej {name}! Co słychać?', 'O, {name}! Właśnie o tobie myślę!', '{name}! Dobrze, że jesteś!', 'Siema, {name}! Masz chwilkę?'],
  neutral: ['Cześć, {name}.', 'Hej, {name}. Co tam?', 'O, {name}. Jak leci?', 'Hej. Masz minutkę?', 'Cześć. Wszystko w porządku?'],
  negative: ['A, to ty, {name}…', 'Znowu ty, {name}?', 'Czego, {name}?', 'No, cześć. Tylko szybko.', 'Ech, {name}. Słucham.'],
};

/** greetings that depend on the time of day (used sometimes instead of the generic ones) */
const TIME_GREETINGS: Record<DayPhase, readonly string[]> = {
  morning: ['Dzień dobry, {name}!', 'Dobry ranek, {name}! Kawa już była?'],
  day: ['Dzień dobry, {name}!', 'Hej {name}, jak mija dzień?'],
  evening: ['Dobry wieczór, {name}!', 'Hej {name}, jak minął dzień?'],
  night: ['Też nie śpisz, {name}?', 'Ciii… cześć, {name}.'],
};

export const FAREWELLS: ToneLines = {
  positive: ['Super się gadało, {name}!', 'Lecę, ale pogadamy jeszcze!', 'Dzięki za rozmowę, {name}!', 'Do zobaczenia, trzymaj się!', 'To był świetny pomysł, pa!'],
  neutral: ['Dobra, lecę. Na razie.', 'No to do później, {name}.', 'Muszę już iść. Pa.', 'Okej, wracam do swoich spraw.', 'To na razie, {name}.'],
  negative: ['Dobra, koniec tej rozmowy.', 'Mam dość, idę sobie.', 'Szkoda gadać. Cześć.', 'Nie mam na to siły.', 'Daj mi już spokój, {name}.'],
};

/** reactions to the previous line: REACTIONS[previousTone][myTone] */
export const REACTIONS: Record<Tone, ToneLines> = {
  positive: {
    positive: ['No właśnie!', 'Ha, dokładnie!', 'Też tak uważam!'],
    neutral: ['Może i tak.', 'Hm, ciekawe.', 'No, w sumie.'],
    negative: ['Ty to zawsze widzisz różowo.', 'Nie przesadzaj.', 'Eee, bez przesady.'],
  },
  neutral: {
    positive: ['O, dobre pytanie!', 'Fajnie, że pytasz!', 'Chętnie o tym pogadam!'],
    neutral: ['No tak.', 'Hmm, zobaczymy.', 'Mhm.'],
    negative: ['Nie bardzo mnie to obchodzi.', 'Serio, o tym chcesz gadać?', 'Nudy.'],
  },
  negative: {
    positive: ['Głowa do góry!', 'Nie martw się, będzie dobrze.', 'Ej, uśmiechnij się!'],
    neutral: ['Rozumiem.', 'No, bywa.', 'Każdy ma gorsze dni.'],
    negative: ['Właśnie, wszystko do bani.', 'Nawet mi nie mów.', 'Ugh, racja.'],
  },
};

/** filler lines for unknown topics or for variety */
export const SMALL_TALK: ToneLines = {
  positive: ['Znalazł się {thing}! Co za ulga.', 'Dziś wszystko mi wychodzi!', 'Mam dziś świetny humor!', 'Fajnie się tu mieszka, prawda?'],
  neutral: ['Gdzie jest {thing}? Szukam od rana.', 'Ktoś widział {thing}?', 'Trzeba by tu posprzątać.', 'Ciekawe, co jutro.'],
  negative: ['Ktoś znowu ruszał {thing}!', 'Wszystko mnie dziś irytuje.', 'Ten dzień się nie kończy.', 'Ech, nic mi nie wychodzi.'],
};

export const TOPIC_LINES: Record<string, ToneLines> = {
  pogoda: {
    positive: ['Piękny dzień, aż chce się wyjść!', 'Słońce dziś naprawdę dopisuje.', 'Uwielbiam taką pogodę {pora}.'],
    neutral: ['Podobno jutro ma padać.', 'Ciekawe, czy będzie burza.', 'Trochę chłodno {pora}, prawda?'],
    negative: ['Znowu ta szarówka, mam dość.', 'Ta pogoda mnie dobija.', 'Ciągle wieje, nie da się żyć.'],
  },
  jedzenie: {
    positive: ['Mam nowy przepis na naleśniki!', 'Ta zupa z wczoraj to poezja.', 'Może upieczemy razem ciasto?'],
    neutral: ['Co dziś na obiad?', 'Lodówka znowu prawie pusta.', 'Ktoś musi kupić chleb.'],
    negative: ['Ktoś znowu zjadł mój jogurt!', 'Brudne garnki w zlewie, znowu.', 'Ten makaron to klej, nie obiad.'],
  },
  praca: {
    positive: ['W pracy wreszcie spokój, cudnie.', 'Mam dobry tydzień w robocie!', 'Szef pochwalił mój projekt!'],
    neutral: ['Jutro długie spotkanie od rana.', 'Dużo maili, mało czasu.', 'Myślę o zmianie godzin pracy.'],
    negative: ['Ta praca wysysa ze mnie siły.', 'Znowu nadgodziny, serio?', 'Mam dość tych zebrań.'],
  },
  plotki: {
    positive: ['Słyszysz? Sąsiedzi mają szczeniaka!', 'Ponoć ktoś tu się zakochał…', 'Mam świeżą, wesołą nowinę!'],
    neutral: ['Podobno ktoś się wyprowadza.', 'Wiesz coś o nowych sąsiadach?', 'Ktoś zostawił {thing} na klatce.'],
    negative: ['Nie lubię plotek, daj spokój.', 'Znowu ktoś obgaduje innych…', 'Te plotki to stek bzdur.'],
  },
  filmy: {
    positive: ['Ten nowy film to perełka!', 'Obejrzymy coś razem {pora}?', 'Ta komedia rozbawiła mnie do łez.'],
    neutral: ['Masz jakiś film do polecenia?', 'W kinie leci coś o kosmosie.', 'Wolisz seriale czy filmy?'],
    negative: ['Ten film to strata czasu.', 'Zakończenie było beznadziejne.', 'Znowu remake, brak pomysłów.'],
  },
  muzyka: {
    positive: ['Ta piosenka siedzi mi w głowie!', 'Może zagramy coś razem?', 'Kocham ten stary album!'],
    neutral: ['Czego teraz słuchasz?', 'Radio grało dziś same stare hity.', 'Myślę o nauce gry na gitarze.'],
    negative: ['Sąsiad znowu gra na perkusji…', 'Ta muzyka to sam hałas.', 'Nie znoszę tej piosenki.'],
  },
  sport: {
    positive: ['Może pobiegamy razem jutro?', 'Nasza drużyna wygrała!', 'Po treningu czuję się świetnie.'],
    neutral: ['Oglądasz dziś mecz?', 'Myślę o zapisaniu się na basen.', 'Rower trzeba by naprawić.'],
    negative: ['Sędzia był ślepy, serio.', 'Znowu przegrana, szkoda gadać.', 'Bolą mnie nogi po bieganiu.'],
  },
  ogród: {
    positive: ['Pomidory wreszcie dojrzewają!', 'Róże kwitną jak szalone.', 'W ogrodzie jest dziś cudnie.'],
    neutral: ['Trzeba podlać grządki.', 'Może posadzimy zioła?', 'Trawnik prosi się o koszenie.'],
    negative: ['Ślimaki zjadły mi sałatę!', 'Chwasty rosną szybciej niż kwiaty.', 'Kret zrył cały trawnik.'],
  },
  wspomnienia: {
    positive: ['Pamiętasz wakacje nad jeziorem?', 'Dawniej było tyle śmiechu!', 'Mam w głowie piękne wspomnienie.'],
    neutral: ['Kiedyś tu stał stary płot.', 'Ile to już lat minęło…', 'Znalazły się stare zdjęcia.'],
    negative: ['Wolę nie wracać do przeszłości.', 'Tamte czasy nie były łatwe.', 'Niektórych rzeczy żałuję.'],
  },
  'plany na weekend': {
    positive: ['Może wypad za miasto w sobotę?', 'Weekend! Wreszcie odpoczynek!', 'Zróbmy grilla w niedzielę!'],
    neutral: ['Masz jakieś plany na weekend?', 'Chyba zostanę w domu.', 'Trzeba zrobić większe zakupy.'],
    negative: ['Weekend znowu przy sprzątaniu.', 'Nie mam siły na żadne plany.', 'Pewnie znowu będzie padać.'],
  },
  książki: {
    positive: ['Czytam świetny kryminał!', 'Ta książka totalnie wciąga.', 'Polecę ci jedną powieść!'],
    neutral: ['Co teraz czytasz?', 'Biblioteka ma nowe tytuły.', 'Wolisz papier czy czytnik?'],
    negative: ['Ta książka to straszne nudy.', 'Nie mam czasu na czytanie.', 'Zakończenie to rozczarowanie.'],
  },
  gry: {
    positive: ['Zagramy {pora} w planszówkę?', 'Ta gra jest genialna!', 'Szachy? Chętnie się zmierzę!'],
    neutral: ['Grasz w coś ostatnio?', 'Kostki do gry gdzieś zginęły.', 'Znasz zasady tej karcianki?'],
    negative: ['Znowu ktoś oszukiwał w grze!', 'Ta gra strasznie mnie irytuje.', 'Przegrana za przegraną…'],
  },
  zwierzęta: {
    positive: ['Kot sąsiadów przyszedł na pieszczoty!', 'Marzy mi się pies.', 'W ogrodzie mieszka jeż!'],
    neutral: ['Kto karmi ptaki w karmniku?', 'Psy czy koty?', 'Chomik to dobry pomysł?'],
    negative: ['Ten pies szczeka całą noc.', 'Komary mnie zjadają.', 'Kot znowu podrapał kanapę.'],
  },
  podróże: {
    positive: ['Marzę o wyjeździe nad morze!', 'Góry o tej porze są piękne.', 'Zwiedźmy kiedyś coś razem!'],
    neutral: ['Gdzie warto jechać latem?', 'Pociągiem czy autem?', 'Bilety znowu podrożały.'],
    negative: ['Nienawidzę pakowania.', 'Korki na trasie to koszmar.', 'Na wyjazd mnie nie stać.'],
  },
  sny: {
    positive: ['Śniło mi się, że latam!', 'Taki piękny sen tej nocy!', 'We śnie wszystko było kolorowe.'],
    neutral: ['Pamiętasz swoje sny?', 'Śniło mi się coś dziwnego.', 'Ciekawe, co znaczą sny.'],
    negative: ['Znowu koszmary, nie śpię dobrze.', 'Śnił mi się egzamin, brr.', 'Te sny mnie męczą.'],
  },
  polityka: {
    positive: ['Nowy park w mieście to dobry pomysł.', 'Wreszcie naprawią drogę!', 'Rada osiedla ma fajne pomysły.'],
    neutral: ['Słyszysz o nowych przepisach?', 'Wybory już niedługo.', 'Ciekawe, co z tą obwodnicą.'],
    negative: ['Polityka? Szkoda nerwów.', 'Ten pomysł z parkingiem to absurd!', 'Nie zgadzam się z tobą wcale.'],
  },
};

// topics of chats during joint activities (agents/joint.ts sets them)
TOPIC_LINES['wędkowanie'] = {
  positive: ['Tu zawsze coś bierze, zobaczysz!', 'Cisza, woda… tego mi trzeba.', 'Złowimy dziś coś dużego!'],
  neutral: ['Na co łowisz, na robaka?', 'Spławik ani drgnie.', 'Ryby chyba śpią {pora}.'],
  negative: ['Żyłka znowu się plącze…', 'Komary gryzą bardziej niż ryby.', 'Same wodorosty, szkoda gadać.'],
};
TOPIC_LINES['gry na konsoli'] = {
  positive: ['Ten zakręt to moja specjalność!', 'Gramy do skutku, nie?', 'Najlepszy wieczór od dawna!'],
  neutral: ['Kto ma lepszy pad?', 'Zmieniamy postacie?', 'Jeszcze jedna runda i koniec.'],
  negative: ['Pad mi się zacina, serio.', 'Ta gra jest niesprawiedliwa.', 'Znowu ten sam poziom…'],
};
TOPIC_LINES['planszówki'] = {
  positive: ['Uwielbiam takie wieczory przy stole!', 'Jeszcze jedna partia?', 'Dobra karta, oj dobra!'],
  neutral: ['Czyja teraz kolej?', 'Zapisuj punkty, proszę.', 'Hmm, muszę to przemyśleć.'],
  negative: ['Ktoś tu chyba oszukuje…', 'Ech, ta kostka mnie nie lubi.', 'Nie znoszę przegrywać.'],
};

type JointKindKey = 'fishing' | 'console' | 'boardgame';
/** topics of chats during joint activities (see agents/joint.ts JOINT_TOPIC) */
const JOINT_TOPICS = new Set(['wędkowanie', 'gry na konsoli', 'planszówki']);

/** bubbles for joint activities (agents/joint.ts): invitations, answers and game moments; no gendered forms */
export const JOINT_LINES = {
  invite: {
    fishing: ['Kto idzie ze mną na ryby? 🎣', 'Wędki w dłoń, idziemy nad wodę!', 'Ryby biorą, chodźcie! 🎣'],
    console: ['Kto gra na konsoli? 🎮', 'Turniej na konsoli, wchodzicie? 🎮', 'Pady czekają! Kto gra?'],
    boardgame: ['Partyjka czegoś? 🎲', 'Kto zagra w karty? 🃏', 'Planszówka? Rozkładam! 🎲'],
  } as Record<JointKindKey, string[]>,
  accept: ['Wchodzę w to!', 'Jasne, już idę!', 'Pewnie, czemu nie!', 'Super pomysł!'],
  refuseHungry: 'Najpierw coś zjem 🍽️',
  refuseTired: 'Padam z nóg, innym razem',
  refuseDirty: 'Muszę się najpierw umyć',
  refuseBusy: ['Teraz nie mogę, coś kończę', 'Może później!', 'Daj mi skończyć, potem!'],
  refuseMood: {
    fishing: ['Nie dziś, ryby poczekają', 'Wędkowanie to nie dla mnie'],
    console: ['Nie mam dziś ochoty na gry', 'Konsola? Może jutro'],
    boardgame: ['Nie dziś, głowa mnie boli', 'Planszówki? Innym razem'],
  } as Record<JointKindKey, string[]>,
  start: {
    fishing: ['Zarzucamy! 🎣', 'Kto pierwszy, ten lepszy!', 'Cisza, bo spłoszymy ryby!'],
    console: ['Gramy! 🎮', 'Wybieram swoją postać!', 'Trzy, dwa, jeden, start!'],
    boardgame: ['Rozdaję! 🃏', 'Kto zaczyna?', 'Zasady wszyscy znają?'],
  } as Record<JointKindKey, string[]>,
  alone: ['Nikt nie dochodzi… 😕', 'Trudno, solo też fajnie', 'No nic, to solo 🙂'],
  laugh: ['Hahaha! 😂', 'Ale akcja! 😂', 'Nie mogę, ale śmiech!', 'Widzisz to? 😂'],
  draw: ['Remis!', 'Nikt nie wygrywa, jeszcze raz!', 'Po równo!'],
  lose: ['Rewanż!', 'Jeszcze jedna, teraz ja!', 'Dobra, tym razem twoje.'],
  sore: ['To nie fair!', 'Laguje, to się nie liczy!', 'Ech, oszustwo…', 'Pad mi się zaciął!'],
  grillCatch: ['Grillujemy złowione ryby! 🐟🔥', 'Ryby na grilla, kto głodny? 🔥', 'Rozpalam grilla, mamy rybki! 🐟'],
  quarrel: ['To jest nieuczciwe!', 'Z tobą się nie da grać!', 'Mam dość, koniec gry!'],
  fishing: {
    catch: ['Mam! 🐟', 'Bierze! Bierze! 🐟', 'Jest ryba! 🐟', 'Patrz, płotka! 🐟'],
    big: ['Ale sztuka! 🐟🐟', 'Potwór z głębin! 🐟', 'To rekord, serio! 🐟'],
    miss: ['Ryba się zrywa…', 'Ech, ucieka mi!', 'Znowu tylko wodorost'],
    wait: ['Cisza… nic nie bierze', 'Spławik ani drgnie', 'Cierpliwości…'],
  },
  console: {
    win: {
      race: ['Pierwsze miejsce! 🏁', 'Kto mnie dogoni? 🏎️', 'Meta! 🏁'],
      football: ['Gooool! ⚽', 'Co za strzał! ⚽', 'Hat-trick! ⚽'],
      fight: ['K.O.! 🥊', 'Kombo! 🥊', 'Wygrana runda! 🥊'],
    } as Record<string, string[]>,
    coopWin: ['Boss pokonany! 🗡️', 'Poziom zaliczony! ⭐', 'Razem damy radę! 🗡️'],
    coopFail: ['Game over… 💀', 'Od checkpointu jeszcze raz', 'Ten boss jest za mocny!'],
  },
  board: {
    chessMove: ['Szach!', 'Hmm, ciekawy ruch…', 'Ups, moja wieża…', 'Twój ruch'],
    chessWin: ['Szach mat! ♟️', 'Mat w trzech ruchach! ♟️'],
    cardsWin: ['Moje rozdanie! 🃏', 'As w rękawie! 🃏', 'Wygrana lewa! 🃏'],
    euroWin: ['Hotel na Ateny! 🏨', 'Płać czynsz! 💸', 'Kupuję Wiedeń! 🎲', 'Bankrut! Nie ja! 💸'],
  },
};

export const THINGS: readonly string[] = ['pilot', 'parasol', 'klucze', 'mój kubek', 'ładowarka', 'książka kucharska', 'nożyczki', 'czerwony szalik', 'konewka', 'pudełko z ciastkami'];

const PORA: Record<DayPhase, string> = { morning: 'rano', day: 'dziś', evening: 'wieczorem', night: 'w nocy' };

export const MAX_LINE_LENGTH = 60;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function fill(tpl: string, ctx: ConversationContext, rng: Rng): string {
  return tpl
    .replace('{name}', ctx.listener.name)
    .replace('{pora}', PORA[ctx.time.phase])
    .replace('{thing}', () => rng.pick(THINGS));
}

/** tone from mood, cheerfulness, relationship, needs and the previous line */
export function chooseTone(ctx: ConversationContext, rng: Rng): Tone {
  const { speaker } = ctx;
  const prev = ctx.history[ctx.history.length - 1];
  let score = ((speaker.mood - 50) / 50) * 0.7 + speaker.traits.cheerfulness * 0.6 + (clamp(ctx.relationship, -100, 100) / 100) * 0.8;
  if (prev && prev.speakerId !== speaker.id) score += prev.tone === 'positive' ? 0.25 : prev.tone === 'negative' ? -0.3 : 0;
  if (speaker.needs.energy < 15 || speaker.needs.hunger < 15) score -= 0.4;
  const pos = clamp(0.38 + score * 0.3, 0.05, 0.9);
  const neg = clamp(0.2 - score * 0.22, 0.03, 0.75);
  const neu = Math.max(0.1, 1 - pos - neg);
  return (['positive', 'neutral', 'negative'] as const)[rng.weightedIndex([pos, neu, neg])];
}

function pickFresh(pool: readonly string[], used: Set<string>, rng: Rng): string {
  for (let i = 0; i < 4; i++) {
    const c = rng.pick(pool);
    if (!used.has(c)) return c;
  }
  return rng.pick(pool);
}

function compose(ctx: ConversationContext, tone: Tone, rng: Rng): Composed {
  const used = new Set(ctx.history.map((l) => l.text));
  const f = (pool: readonly string[]): string => fill(pickFresh(pool, used, rng), ctx, rng);

  if (ctx.turn === 0 && !ctx.isLast) {
    if (tone !== 'negative' && rng.chance(0.35)) return { text: f(TIME_GREETINGS[ctx.time.phase]) };
    return { text: f(GREETINGS[tone]) };
  }
  if (ctx.isLast) return { text: f(FAREWELLS[tone]) };

  const prev = ctx.history[ctx.history.length - 1];
  if (prev?.gossip && prev.speakerId !== ctx.speaker.id && rng.chance(0.8)) return gossipReaction(prev.gossip, tone, rng);

  if (prev && prev.speakerId !== ctx.speaker.id && isNewsLine(prev.text) && rng.chance(0.8)) return newsReaction(prev.text, tone, rng);

  const story = chooseGossip(ctx, rng);
  if (story) return tellGossip(story, ctx, used, rng);

  const headline = chooseNews(ctx, rng);
  if (headline) return tellNews(headline, used, rng);

  const topical = TOPIC_LINES[ctx.topic];
  const body = topical && rng.chance(0.85) ? f(topical[tone]) : f(SMALL_TALK[tone]);
  if (prev && prev.speakerId !== ctx.speaker.id) {
    const reaction = f(REACTIONS[prev.tone][tone]);
    const roll = rng.next();
    if (roll < 0.2) return { text: reaction };
    if (roll < 0.55) {
      const combined = `${reaction} ${body}`;
      if (combined.length <= MAX_LINE_LENGTH) return { text: combined };
    }
  }
  return { text: body };
}

// ---------------------------------------------------------------- gossip

/** gossip lines may be a bit longer than ordinary ones */
export const MAX_GOSSIP_LINE = 70;

type Valence = 'good' | 'plain' | 'bad';
const valenceOf = (g: Gossip): Valence => (g.valence > 0.25 ? 'good' : g.valence < -0.25 ? 'bad' : 'plain');

/** retelling a story the listener does not know; {g} = Gossip.text */
export const GOSSIP_TELL: Record<Valence, readonly string[]> = {
  good: ['Wiesz, że {g}? Super!', 'Podobno {g}!', 'Mówią, że {g}!', 'Słychać, że {g}. Brawo!'],
  plain: ['Wiesz, że {g}?', 'Podobno {g}.', 'Mówią, że {g}…'],
  bad: ['Mówią, że {g}… Ech.', 'Podobno {g}. No wiesz!', 'Wiesz, że {g}? Ha!', 'Tylko nikomu: {g}!'],
};

/** "remember when" for a moment both lived through */
export const GOSSIP_SHARED: Record<Valence, readonly string[]> = {
  good: ['Pamiętasz, jak {g}? Cudnie!', 'A pamiętasz, jak {g}?'],
  plain: ['Pamiętasz, jak {g}?', 'A pamiętasz, jak {g}?'],
  bad: ['Pamiętasz, jak {g}? Ha!', 'Pamiętasz, jak {g}? Ech…'],
};

/** listener's reaction to a story */
export const GOSSIP_REACTIONS: Record<Valence | 'shared', readonly string[]> = {
  good: ['No proszę!', 'Ale super!', 'Serio? Brawo!', 'Kto by pomyślał!'],
  plain: ['No proszę…', 'Serio?', 'Kto by pomyślał!', 'Ciekawe…'],
  bad: ['Serio?!', 'Nie wierzę!', 'No coś ty!', 'Ojej…', 'To ci dopiero!'],
  shared: ['Jasne, że pamiętam!', 'Pewnie! Co to był za dzień!', 'Ha, jak dziś!', 'Oj tak, pamiętam!'],
};

const FOLLOW_UPS: readonly string[] = ['Skąd to wiesz?', 'Tylko nie mów nikomu.', 'Muszę to zobaczyć.', 'No, no…'];

/** shortens a gossip phrase to `max` chars at a word boundary */
export function fitGossip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '')}…`;
}

/** chance that the speaker brings up a story on this turn */
export function gossipChance(ctx: ConversationContext, shared: boolean): number {
  const t = ctx.speaker.traits;
  let p = 0.24 + t.sociability * 0.14 + t.cheerfulness * 0.05;
  if (ctx.topic === 'plotki') p += 0.3;
  // long hours side by side (fishing, cards, a console evening): plenty of time for stories
  if (JOINT_TOPICS.has(ctx.topic)) p += 0.3;
  if (shared && ctx.topic === 'wspomnienia') p += 0.3;
  if (ctx.turn >= 2) p += 0.08; // mid-conversation, after the warm-up
  return clamp(p, 0.05, 0.8);
}

function chooseGossip(ctx: ConversationContext, rng: Rng): Gossip | null {
  if (!ctx.gossip || ctx.gossip.length === 0) return null;
  // one story per conversation from each speaker is plenty
  if (ctx.history.some((l) => l.gossip && l.speakerId === ctx.speaker.id)) return null;
  const told = new Set(ctx.history.filter((l) => l.gossip).map((l) => l.gossip!.text));
  const fresh = ctx.gossip.filter((g) => !told.has(g.text));
  if (fresh.length === 0) return null;
  const g = fresh.length > 1 && rng.chance(0.3) ? rng.pick(fresh) : fresh[0];
  return rng.chance(gossipChance(ctx, !!g.shared)) ? g : null;
}

function tellGossip(g: Gossip, ctx: ConversationContext, used: Set<string>, rng: Rng): Composed {
  const v = valenceOf(g);
  const tpl = pickFresh((g.shared ? GOSSIP_SHARED : GOSSIP_TELL)[v], used, rng);
  const room = MAX_GOSSIP_LINE - (tpl.length - 3);
  const text = tpl.replace('{g}', fitGossip(g.text, room));
  let tone: Tone = 'neutral';
  if (v === 'good') tone = 'positive';
  else if (v === 'bad' && ctx.speaker.traits.cheerfulness < -0.3) tone = 'negative';
  else if (g.shared && v !== 'bad') tone = 'positive';
  return { text, tone, gossip: g };
}

function gossipReaction(g: Gossip, tone: Tone, rng: Rng): Composed {
  const pool = g.shared ? GOSSIP_REACTIONS.shared : GOSSIP_REACTIONS[valenceOf(g)];
  let text = rng.pick(pool);
  if (!g.shared && rng.chance(0.3)) text = `${text} ${rng.pick(FOLLOW_UPS)}`;
  const t: Tone = g.valence > 0.25 || g.shared ? 'positive' : tone === 'negative' ? 'negative' : 'neutral';
  return { text, tone: t };
}

// ---------------------------------------------------------------- TV news

/** a headline seen on TV; {h} = „headline” (verbatim, shortened at a word boundary). No gendered forms. */
export const NEWS_TELL: readonly string[] = [
  'W wiadomościach mówili: {h}',
  'Podobno w telewizji: {h}',
  'W telewizji podają: {h}',
  'Widzisz, co w wiadomościach? {h}',
  'Leci w wiadomościach: {h}',
];

/** reactions to a headline, by its kind (in-sim bulletins carry a prefix, see world/news.ts) */
export const NEWS_REACTIONS = {
  good: ['Dobre wieści!', 'No proszę, brawo!', 'Wreszcie coś miłego!', 'To się nazywa news!'],
  urgent: ['Ojej, to niedobrze.', 'No coś takiego!', 'Oby szybko to ogarnąć.', 'To ci dopiero!'],
  wet: ['Ech, trzeba wziąć parasol.', 'No to zostaję w domu.', 'Znowu leje? Ech.'],
  dry: ['Super, w sam raz na spacer!', 'No to idziemy do ogrodu!', 'Wreszcie ładna pogoda!'],
  world: ['No coś takiego!', 'Świat zwariował.', 'Ciekawe, co z tego wyniknie.', 'Kto by pomyślał…', 'Nie nadążam za tym wszystkim.'],
  grumpy: ['Wolę nie oglądać wiadomości.', 'Same nowiny, a nic się nie zmienia.', 'Ech, szkoda nerwów.'],
} as const;

const NEWS_PREFIXES = NEWS_TELL.map((t) => t.slice(0, t.indexOf('{h}')));

/** true for a line that retells a TV headline */
export function isNewsLine(text: string): boolean {
  return text.includes('„') && NEWS_PREFIXES.some((p) => text.startsWith(p));
}

/** the headline quoted in a line, without a trailing "…" */
function quoted(text: string): string | null {
  const m = /„([^”]+)”/.exec(text);
  return m ? m[1].replace(/…$/, '').trim() : null;
}

/** a news line from a template: the headline is shortened so that the whole line fits `max` chars */
export function newsLine(tpl: string, headline: string, max = MAX_GOSSIP_LINE): string {
  const room = max - (tpl.length - 3) - 2;
  return tpl.replace('{h}', `„${fitGossip(headline, room)}”`);
}

/** chance that the speaker brings up a headline on this turn */
export function newsChance(ctx: ConversationContext): number {
  let p = 0.2 + ctx.speaker.traits.sociability * 0.06;
  if (ctx.topic === 'polityka' || ctx.topic === 'plotki') p += 0.2;
  // between rounds / casts people chat about what they saw on TV, too
  if (JOINT_TOPICS.has(ctx.topic)) p += 0.15;
  if (ctx.topic === 'pogoda' && ctx.news?.some((n) => n.startsWith('Pogoda:'))) p += 0.2;
  if (ctx.turn >= 2) p += 0.05;
  return clamp(p, 0.05, 0.5);
}

function chooseNews(ctx: ConversationContext, rng: Rng): string | null {
  if (!ctx.news?.length || ctx.turn === 0 || ctx.isLast) return null;
  // one headline per speaker per conversation
  if (ctx.history.some((l) => l.speakerId === ctx.speaker.id && isNewsLine(l.text))) return null;
  const said = ctx.history.map((l) => (isNewsLine(l.text) ? quoted(l.text) : null)).filter((q): q is string => !!q);
  const fresh = ctx.news.filter((n) => !said.some((q) => n.startsWith(q)));
  if (!fresh.length) return null;
  const h = fresh.length > 1 && rng.chance(0.3) ? rng.pick(fresh) : fresh[0];
  return rng.chance(newsChance(ctx)) ? h : null;
}

function tellNews(headline: string, used: Set<string>, rng: Rng): Composed {
  const tpl = pickFresh(NEWS_TELL, used, rng);
  const tone: Tone = headline.startsWith('Dobre wieści:') ? 'positive' : 'neutral';
  return { text: newsLine(tpl, headline), tone };
}

function newsReaction(text: string, tone: Tone, rng: Rng): Composed {
  const h = quoted(text) ?? '';
  if (/^(Dobre wieści|Z osiedla):/.test(h)) return { text: rng.pick(NEWS_REACTIONS.good), tone: tone === 'negative' ? 'neutral' : 'positive' };
  if (h.startsWith('Pilne:')) return { text: rng.pick(NEWS_REACTIONS.urgent), tone: 'neutral' };
  if (h.startsWith('Pogoda:')) {
    const wet = /deszcz|burz|pada/.test(h) && !/bez deszczu/.test(h);
    return { text: rng.pick(wet ? NEWS_REACTIONS.wet : NEWS_REACTIONS.dry), tone: wet ? 'neutral' : 'positive' };
  }
  if (tone === 'negative') return { text: rng.pick(NEWS_REACTIONS.grumpy), tone: 'negative' };
  return { text: rng.pick(NEWS_REACTIONS.world), tone: 'neutral' };
}

interface Composed {
  text: string;
  /** overrides the chosen tone */
  tone?: Tone;
  gossip?: Gossip;
}

export function createProceduralProvider(): DialogueProvider {
  return {
    name: 'procedural',
    nextLine(ctx: ConversationContext, rng: Rng): DialogueLine {
      const chosen = chooseTone(ctx, rng);
      const c = compose(ctx, chosen, rng);
      const line: DialogueLine = { speakerId: ctx.speaker.id, text: c.text, tone: c.tone ?? chosen };
      if (c.gossip) line.gossip = c.gossip;
      return line;
    },
  };
}
