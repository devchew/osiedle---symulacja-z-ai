import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIARY_EXAMPLES, LINE_EXAMPLES, parseCompletion, parseDiaryCompletion } from '../server/llm';
import { LLM_MAX_LINE, type LlmLineRequest } from '../src/social/llmProvider';
import { checkDiaryText, findGenderedForms, type LlmDiaryRequest } from '../src/social/diaryAi';
import { AGENT_NAMES } from '../src/agents/agent';

// Rejection reasons of the AI validators measured offline (#17): hand-written model answers in
// tests/fixtures/llm-responses.json run through the same parsers as the proxy. A new validator rule or
// prompt change shows up here as a changed tally.

interface Sample {
  id: string;
  request: string;
  content: string;
  finish?: string;
  expect: string;
}
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const requests = read<{ lines: { id: string; request: LlmLineRequest }[]; diaries: { id: string; request: LlmDiaryRequest }[] }>('./fixtures/llm-requests.json');
const answers = read<{ lines: Sample[]; diaries: Sample[] }>('./fixtures/llm-responses.json');

const completion = (s: Sample) => ({ model: 'm/x:free', choices: [{ finish_reason: s.finish ?? 'stop', message: { content: s.content } }] });
const category = (reason: string): string => reason.replace(/: .*/, '');

function run(kind: 'lines' | 'diaries', s: Sample): string {
  let reason = 'ok';
  const why = (r: string): void => {
    reason = r;
  };
  if (kind === 'lines') {
    const r = requests.lines.find((x) => x.id === s.request)!.request;
    parseCompletion(completion(s), r.speaker, r.gossip?.length ?? 0, why, [r.speaker, r.listener]);
  } else {
    const r = { ...requests.diaries.find((x) => x.id === s.request)!.request, names: [...AGENT_NAMES] };
    parseDiaryCompletion(completion(s), r, why);
  }
  return reason;
}

describe('AI rejection reasons on fixture answers', () => {
  it('gives each answer the expected verdict', () => {
    for (const kind of ['lines', 'diaries'] as const) {
      for (const s of answers[kind]) expect({ id: s.id, reason: category(run(kind, s)) }).toEqual({ id: s.id, reason: s.expect });
    }
  });

  it('tallies rejections per reason (the measure to compare prompt / validator changes with)', () => {
    const tally = (kind: 'lines' | 'diaries'): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const s of answers[kind]) {
        const c = category(run(kind, s));
        out[c] = (out[c] ?? 0) + 1;
      }
      return out;
    };
    expect(tally('lines')).toEqual({ ok: 8, 'gendered forms': 4, 'bad tone': 1, 'no JSON object': 1, 'no text': 1, 'finish length': 1 });
    expect(tally('diaries')).toEqual({
      ok: 2,
      'gendered forms': 2,
      'preposition before a name': 3,
      'person not in the facts': 1,
      'quote not among the given headlines': 1,
      'too short': 1,
      'no text': 1,
    });
  });

  it('keeps the few-shot examples of the prompts valid for the validators', () => {
    for (const e of LINE_EXAMPLES) {
      expect(e.text.length).toBeLessThanOrEqual(LLM_MAX_LINE);
      expect(findGenderedForms(e.text)).toEqual([]);
    }
    for (const text of DIARY_EXAMPLES) expect(checkDiaryText(text, { names: AGENT_NAMES, allow: AGENT_NAMES })).toEqual({ text });
  });
});
