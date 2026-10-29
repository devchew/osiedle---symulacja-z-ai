# Osiedle — autonomiczna symulacja życia w przeglądarce

> **Od 2026-10-29 zadania prowadzimy w GitHub Issues**, a zasady pracy opisuje `CONTRIBUTING.md`.
> Ten folder to archiwum fal 0–10 (`TASKS.md`) i dziennik decyzji (`DECISIONS.md`, nadal aktualizowany).

Plansza 2D (widok z góry) z domem i ogrodem. Postacie same żyją: mają potrzeby, wybierają
aktywności (utility AI), chodzą (A*), rozmawiają i budują relacje. Użytkownik tylko obserwuje.

Stack: Vite + TypeScript + Canvas 2D, Vitest (logika), Playwright (rendering).

## Zasady pracy
- **Pełna autonomia**: użytkownik się nie wtrąca. Po akceptacji planu pracę wykonuje Claude
  (z agentami) bez pytań o kolejne kroki; decyzje loguje w `DECISIONS.md`. Raport dopiero, gdy
  jest coś wartego pokazania (działa w przeglądarce, testy + zrzuty ekranu).
- **Równoległość**: praca w falach; w fali każdy agent posiada rozłączne pliki. Kontrakty
  w `src/types.ts` — ich zmiana = wpis w `DECISIONS.md`.
- `TASKS.md` aktualizuje tylko orkiestrator (główna sesja), po weryfikacji fali.
- Weryfikacja fali: `npm test`, `npm run typecheck`, `npm run test:e2e` (od fali 2), commit na `feat/simulation`.

## Jak wznowić pracę w nowej sesji
1. Przeczytaj `plan/TASKS.md` — pierwsza fala z `[ ]` lub `[~]` to bieżąca praca.
2. `git log --oneline` — commity mają prefiks fali (np. `wave1:`).
3. `npm install && npm test` — upewnij się, że stan jest zielony.
4. Kontynuuj według TASKS.md; po zakończeniu fali zaktualizuj checkboxy i notatki.

## Architektura
```
src/types.ts      kontrakty (Vec2, Grid, ObjectDef, Agent, Action, World, DialogueProvider…)
src/core/         rng (mulberry32), time (1 tick = 1 minuta gry, start 07:00), loop (fixed timestep)
src/world/        siatka, mapa domu, katalog obiektów, world.ts (tick całej symulacji)
src/agents/       postać, potrzeby, A*, ruch, brain (utility AI), actions (maszyna stanów)
src/social/       relacje, rozmowy, DialogueProvider (proceduralny; LLM w fali 3)
src/render/       kamera, rysowanie, dymki, oświetlenie dnia/nocy
src/ui/           HUD, inspektor postaci, log zdarzeń
tests/            Vitest      e2e/  Playwright
```
Symulacja nie dotyka DOM — da się ją uruchomić headless (testy soak).
