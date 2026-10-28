import type { ConversationContext, DayPhase, DialogueLine, DialogueProvider, Rng, Tone } from '../types';

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

function compose(ctx: ConversationContext, tone: Tone, rng: Rng): string {
  const used = new Set(ctx.history.map((l) => l.text));
  const f = (pool: readonly string[]): string => fill(pickFresh(pool, used, rng), ctx, rng);

  if (ctx.turn === 0 && !ctx.isLast) {
    if (tone !== 'negative' && rng.chance(0.35)) return f(TIME_GREETINGS[ctx.time.phase]);
    return f(GREETINGS[tone]);
  }
  if (ctx.isLast) return f(FAREWELLS[tone]);

  const topical = TOPIC_LINES[ctx.topic];
  const body = topical && rng.chance(0.85) ? f(topical[tone]) : f(SMALL_TALK[tone]);
  const prev = ctx.history[ctx.history.length - 1];
  if (prev && prev.speakerId !== ctx.speaker.id) {
    const reaction = f(REACTIONS[prev.tone][tone]);
    const roll = rng.next();
    if (roll < 0.2) return reaction;
    if (roll < 0.55) {
      const combined = `${reaction} ${body}`;
      if (combined.length <= MAX_LINE_LENGTH) return combined;
    }
  }
  return body;
}

export function createProceduralProvider(): DialogueProvider {
  return {
    name: 'procedural',
    nextLine(ctx: ConversationContext, rng: Rng): DialogueLine {
      const tone = chooseTone(ctx, rng);
      return { speakerId: ctx.speaker.id, text: compose(ctx, tone, rng), tone };
    },
  };
}
