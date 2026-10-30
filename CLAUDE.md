# Osiedle

Autonomiczna symulacja życia (w stylu The Sims, bez sterowania): 4 stałe światy działające na żywo na
serwerze, tylko podgląd. **Zasady pracy: `CONTRIBUTING.md`. Zadania: GitHub Issues**
(`gh issue list`). Decyzje: `plan/DECISIONS.md`. Historia fal 0–10: `plan/TASKS.md` (archiwum).

- Praca w osobnym `git worktree` (`.claude/worktrees/<nr>-opis`), nie w głównym katalogu; na gałęzi `feat|fix|chore/<nr-issue>-opis`, PR do `master` z `Closes #<nr>`; `master` = produkcja (Coolify).
- Przed PR: `npm run typecheck && npm test && npm run test:e2e`; zmiany zachowań → `tests/tools/trace.test.ts`; odtworzenie świata z seeda/ticku → `tests/tools/tracedump.test.ts` (nie ma `/lab`; obserwacja na żywo: `LIVE_SPEED=60 npm run dev` + `scripts/observe.mjs`, opis w `CONTRIBUTING.md`); zmiany UI → obejrzyj zrzuty z `test-results/shots/`.
- Kontrakty: `src/types.ts`, `src/live/protocol.ts` (zmiany → `plan/DECISIONS.md`).
- Symulacja (`core/`, `world/`, `agents/`, `social/`) bez DOM i bez `render/`/`ui/`; tylko `world.rng` (determinizm); stan w WeakMapach rejestrowany w `src/core/state.ts`; bez cykli importów (`tests/imports.test.ts`).
- Teksty w grze po polsku bez form z rodzajem, imiona w mianowniku; kod i komentarze po angielsku.
- AI: OpenRouter, tylko darmowe modele domyślnie, klucz tylko na serwerze, zawsze limit + fallback proceduralny.
