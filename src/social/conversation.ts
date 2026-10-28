import type { Agent, Conversation, DialogueLine, Rng, Traits } from '../types';

export interface TopicDef {
  /** Polish nominative, used as Conversation.topic */
  name: string;
  /** "o + locative" phrase, e.g. "o muzyce" */
  about: string;
  /** how much each trait makes the topic more likely (positive = trait high) */
  affinity: Partial<Record<keyof Traits, number>>;
}

export const TOPIC_DEFS: readonly TopicDef[] = [
  { name: 'pogoda', about: 'o pogodzie', affinity: { sociability: -0.3 } },
  { name: 'jedzenie', about: 'o jedzeniu', affinity: { activity: -0.3 } },
  { name: 'praca', about: 'o pracy', affinity: { activity: 0.5, cheerfulness: -0.2 } },
  { name: 'plotki', about: 'o plotkach z osiedla', affinity: { sociability: 0.8 } },
  { name: 'filmy', about: 'o filmach', affinity: { activity: -0.4 } },
  { name: 'muzyka', about: 'o muzyce', affinity: { cheerfulness: 0.4, sociability: 0.2 } },
  { name: 'sport', about: 'o sporcie', affinity: { activity: 0.9 } },
  { name: 'ogród', about: 'o ogrodzie', affinity: { neatness: 0.5, activity: 0.3 } },
  { name: 'wspomnienia', about: 'o dawnych czasach', affinity: { sociability: -0.2, activity: -0.2 } },
  { name: 'plany na weekend', about: 'o planach na weekend', affinity: { cheerfulness: 0.5, sociability: 0.3 } },
  { name: 'książki', about: 'o książkach', affinity: { sociability: -0.6, neatness: 0.2 } },
  { name: 'gry', about: 'o grach', affinity: { activity: -0.5, cheerfulness: 0.2 } },
  { name: 'zwierzęta', about: 'o zwierzętach', affinity: { cheerfulness: 0.5 } },
  { name: 'podróże', about: 'o podróżach', affinity: { activity: 0.5, sociability: 0.3 } },
  { name: 'sny', about: 'o snach', affinity: { activity: -0.6 } },
  { name: 'polityka', about: 'o polityce', affinity: { cheerfulness: -0.8 } },
];

export const TOPICS: readonly string[] = TOPIC_DEFS.map((t) => t.name);

const TOPIC_BY_NAME = new Map(TOPIC_DEFS.map((t) => [t.name, t]));

/** "o muzyce"; falls back to "o: <topic>" for unknown topics (e.g. LLM-chosen) */
export function topicAbout(topic: string): string {
  return TOPIC_BY_NAME.get(topic)?.about ?? `o: ${topic}`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function topicWeight(t: TopicDef, a: Traits, b: Traits): number {
  let w = 1;
  for (const key of Object.keys(t.affinity) as (keyof Traits)[]) {
    const avg = (a[key] + b[key]) / 2;
    w += (t.affinity[key] ?? 0) * avg;
  }
  return Math.max(0.15, w);
}

/** how a pair's bond colours the conversation (see social/relationships.ts) */
export type ConversationMood = 'romantic' | 'tense';

/** topic weight multipliers per mood: couples talk plans and memories, rivals argue politics and work */
export const MOOD_TOPIC_WEIGHTS: Record<ConversationMood, Partial<Record<string, number>>> = {
  romantic: { 'plany na weekend': 2.5, wspomnienia: 2, podróże: 1.8, muzyka: 1.5, filmy: 1.5, sny: 1.5, polityka: 0.3, praca: 0.5 },
  tense: { polityka: 2.5, praca: 1.6, sport: 1.6, plotki: 1.3, 'plany na weekend': 0.5, wspomnienia: 0.5 },
};

/**
 * new conversation between initiator `a` and partner `b`; the topic is biased by both
 * agents' traits and, optionally, by their bond (`mood`)
 */
export function startConversation(id: number, a: Agent, b: Agent, tick: number, rng: Rng, mood?: ConversationMood): Conversation {
  const extra = mood ? MOOD_TOPIC_WEIGHTS[mood] : undefined;
  const weights = TOPIC_DEFS.map((t) => topicWeight(t, a.traits, b.traits) * (extra?.[t.name] ?? 1));
  const topic = TOPIC_DEFS[rng.weightedIndex(weights)].name;
  const chatty = (a.traits.sociability + b.traits.sociability) / 2; // -1..1
  const maxLines = clamp(Math.round(rng.range(4, 7) + chatty * 1.5), 4, 8);
  return {
    id,
    participants: [a.id, b.id],
    topic,
    lines: [],
    nextLineIn: rng.int(1, 3),
    pending: false,
    maxLines,
    startedAt: tick,
  };
}

/** probability (0.03..0.97) that `target` accepts a chat proposed by `initiator` */
export function chatAcceptanceChance(target: Agent, initiator: Agent, relationship: number): number {
  let p = 0.55;
  p += target.traits.sociability * 0.18;
  p += ((target.mood - 50) / 50) * 0.12;
  p += ((50 - target.needs.social) / 50) * 0.12; // lonely agents are keener
  p += (clamp(relationship, -100, 100) / 100) * 0.3;
  p += initiator.traits.cheerfulness * 0.05;
  if (target.needs.energy < 20) p -= 0.25 * (1 - target.needs.energy / 20);
  if (target.needs.hunger < 20) p -= 0.2 * (1 - target.needs.hunger / 20);
  return clamp(p, 0.03, 0.97);
}

export function willAcceptChat(target: Agent, initiator: Agent, relationship: number, rng: Rng): boolean {
  return rng.chance(chatAcceptanceChance(target, initiator, relationship));
}

const TONE_VALUE = { positive: 1.5, neutral: 0.3, negative: -2 } as const;

/** relationship change for both participants after a conversation, roughly -8..+8 */
export function conversationDelta(a: Agent, b: Agent, lines: readonly DialogueLine[]): number {
  let sum = 0;
  for (const l of lines) sum += TONE_VALUE[l.tone];
  const diff =
    Math.abs(a.traits.cheerfulness - b.traits.cheerfulness) + Math.abs(a.traits.sociability - b.traits.sociability); // 0..4
  const compat = 1.5 - diff * 0.75; // +1.5 .. -1.5
  const raw = clamp(sum, -7, 7) + (lines.length > 0 ? compat : 0);
  return Math.round(clamp(raw, -8, 8) * 10) / 10;
}

const OUTCOMES: { min: number; templates: string[] }[] = [
  { min: 5, templates: ['świetna rozmowa {about} 💞', 'nadają na tych samych falach — gadka {about}', 'długa, serdeczna rozmowa {about}'] },
  { min: 1.5, templates: ['miła rozmowa {about}', 'sympatyczna pogawędka {about}', 'przyjemna wymiana zdań {about}'] },
  { min: -1.5, templates: ['krótka pogawędka {about}', 'zwykła rozmowa {about}', 'kilka zdań {about}'] },
  { min: -5, templates: ['napięta rozmowa {about}', 'nie zgadzają się w sprawie: {topic}', 'chłodna wymiana zdań {about}'] },
  { min: -Infinity, templates: ['kłótnia podczas rozmowy {about} 💢', 'ostra sprzeczka {about}', 'spięcie — temat: {topic}'] },
];

/** Polish event sentence, e.g. "Ola ↔ Bartek: miła rozmowa o muzyce" (no name declension needed) */
export function describeConversation(a: Agent, b: Agent, conv: Conversation, delta: number): string {
  const outcome = OUTCOMES.find((o) => delta >= o.min) ?? OUTCOMES[OUTCOMES.length - 1];
  const tpl = outcome.templates[Math.abs(conv.id) % outcome.templates.length];
  const text = tpl.replace('{about}', topicAbout(conv.topic)).replace('{topic}', conv.topic);
  return `${a.name} ↔ ${b.name}: ${text}`;
}
