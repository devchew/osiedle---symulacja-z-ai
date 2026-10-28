# sim

Autonomiczna symulacja życia (w stylu The Sims, bez sterowania) w przeglądarce.
**Stan prac, zasady i instrukcja wznowienia: `plan/README.md` i `plan/TASKS.md`.**

- `npm run dev` — dev server, `npm test` — Vitest, `npm run test:e2e` — Playwright, `npm run typecheck`
- Kontrakty między modułami: `src/types.ts` (zmiany logować w `plan/DECISIONS.md`)
- Symulacja (`core/`, `world/`, `agents/`, `social/`) nie może importować DOM ani `render/`/`ui/`.
- Teksty widoczne w grze po polsku, kod i komentarze po angielsku.
