# Jak pracujemy nad Osiedlem

Ten dokument opisuje zasady pracy w repozytorium — dla ludzi i dla agentów AI (Claude Code itp.).
Krótka ściąga dla agentów jest w `CLAUDE.md`.

## Produkt w jednym akapicie

Strona pokazuje **cztery stałe miejsca** (Dom z ogrodem, Kamienica, Domek nad jeziorem, Akademik). Każde
to jeden wspólny świat, który działa **24/7 na serwerze w czasie rzeczywistym** (zegar Europe/Warsaw,
prawdziwa pogoda z przypisanego miasta). Odwiedzający tylko oglądają i przełączają miejsca — nie tworzą
ani nie modyfikują światów. Drugi, niezależny tryb to **sandbox** („🔮 Co będzie dalej?”): kopia
bieżącego świata w przeglądarce, z pauzą i przyspieszaniem, żyjąca tylko w sesji.

## Zadania: GitHub Issues

- **Źródłem prawdy o zadaniach są Issues** w tym repozytorium. Nowy pomysł lub błąd = nowe issue
  (kontekst, zakres, kryteria akceptacji, wskazówki gdzie w kodzie zacząć).
- Etykiety obszarów: `obszar: symulacja`, `obszar: serwer`, `obszar: UI`, `obszar: AI`,
  `obszar: treść`, `dług techniczny` + standardowe `bug`, `enhancement`, `accessibility`.
- `plan/TASKS.md` to **archiwum** dotychczasowych fal (historia, metryki, kontekst). Nie dopisujemy tam
  nowych zadań.
- `plan/DECISIONS.md` pozostaje **dziennikiem decyzji** — każda zmiana kontraktu, protokołu, balansu
  czy kierunku produktu dostaje wiersz (data, decyzja, powód).

## Gałęzie, commity, PR

1. Gałąź od `master`: `feat/<nr-issue>-krotki-opis`, `fix/<nr>-…`, `chore/<nr>-…`.
2. Małe, spójne commity; wiadomość po angielsku w trybie rozkazującym, np. `Fix pier tiles drawn as path`.
3. PR do `master` z `Closes #<nr>`, opisem zmian i sposobem weryfikacji (wyniki testów, zrzuty ekranu dla UI).
4. **`master` jest wdrażany** (Coolify buduje obraz z `Dockerfile`) — nie pushujemy na `master`
   niezweryfikowanych zmian. Wszystkie testy muszą być zielone przed merge.
5. Nigdy nie commitujemy sekretów (`.env` jest w `.gitignore` i `.dockerignore`).

## Uruchamianie

```bash
npm install
npm run dev                 # http://localhost:5173 — światy na żywo działają w procesie Vite
LIVE_SPEED=60 npm run dev   # świat przyspieszony: 1 minuta gry na sekundę (testy ręczne)
```

| Adres | Co to jest |
|---|---|
| `/`, `/dom`, `/kamienica`, `/jezioro`, `/akademik` | widok na żywo (`#Ola` zaznacza mieszkańca) |
| `/sandbox?from=kamienica` | sandbox — kopia świata z kontrolą czasu |
| `/lab?seed=7&tick=2000&map=akademik&agents=6` | ukryte laboratorium: lokalna symulacja z seeda, zapisy, log aktywności (L), dialogi AI — do debugowania i testów e2e |

Zmienne środowiskowe (serwer / dev): `OPENROUTER_API_KEY`, `OPENROUTER_MODELS`, `OPENROUTER_DAILY_LIMIT`,
`NEWS_FEEDS` (`off`), `LIVE_WORLDS` (`off`), `LIVE_AI` (`off`/`on`), `LIVE_WEATHER` (`off`),
`LIVE_SPEED`, `LIVE_FIXED_TIME` (np. `2026-10-29T12:00`), `DATA_DIR` (`./data`, w Dockerze `/app/data`, `off`).

## Weryfikacja — zawsze przed PR

```bash
npm run typecheck
npm test                    # Vitest: logika, soak (7 dni × kilka seedów), determinizm, serwer
npm run test:e2e            # Playwright (buduje i serwuje aplikację; świat na żywo zamrożony LIVE_FIXED_TIME)
```

Przy zmianach zachowań mieszkańców dodatkowo:

```bash
SEED=42 TICKS=4500 npx vitest run tests/tools/trace.test.ts   # analiza „chaosu” → test-results/trace-analysis-42.txt
DAYS=7 SEED=1,2,3 npx vitest run tests/tools/diag.test.ts     # metryki dnia → test-results/diag.txt
node scripts/observe.mjs "http://localhost:5173/lab?seed=42" 15 test-results/observe   # 15 min w Chromium
```

Przy zmianach UI: zrzuty ekranu z Playwright (`test-results/shots/`) obejrzyj przed PR.

**CI** (`.github/workflows/ci.yml`) uruchamia to samo na każdym PR i pushu do `master`: typecheck, Vitest,
e2e (przy błędzie artefakt `test-results`) oraz budowę obrazu (`--target test` i `runtime`). Tag `v*`
publikuje obraz `runtime` do GHCR (`ghcr.io/<repo>`).

## Zasady architektury

- **Symulacja** (`src/core`, `src/world`, `src/agents`, `src/social`) nie importuje DOM ani `render/`/`ui/`
  — działa headless (testy, serwer).
- **Kontrakty**: `src/types.ts` (typy świata) i `src/live/protocol.ts` (klient ↔ serwer). Zmiana = wpis
  w `plan/DECISIONS.md`; w kontraktach preferujemy pola opcjonalne (zmiany addytywne).
- **Determinizm**: w symulacji tylko `world.rng` (albo własne strumienie z seeda — pogoda, projekty,
  pamiętniki), nigdy `Math.random()`/`Date.now()`. Ten sam seed i te same wejścia ⇒ ten sam świat.
  Moduły „obserwujące” (pamiętnik, trace) nie mogą zmieniać symulacji (są na to testy równości).
- **Stan modułów** trzymany w `WeakMap` musi być zarejestrowany w `registerWorldState`
  (`src/core/state.ts`) — inaczej nie przetrwa snapshotu (restart serwera, sandbox). Test:
  `tests/snapshot.test.ts`.
- **Bez cykli importów** w `src` (test: `tests/imports.test.ts`; kolejność ładowania nie zmienia świata:
  `tests/loadOrder.test.ts`). Gdy moduł świata musi wywołać logikę agentów, `world.ts` przekazuje funkcję
  jawnie (np. `tickIncidents(world, endAction)`); wspólne stałe idą do modułów-liści (np. `agents/meals.ts`).
- **Serwer** (`server/`): rdzenie handlerów bez zależności od Vite (`llm.ts`, `news.ts`, `worlds*.ts`),
  pluginy Vite tylko je opakowują; produkcja to `server/prod.ts` zbundlowany do `dist-server/prod.js`.

## Treść i język

- Teksty w grze **po polsku**, kod i komentarze **po angielsku**.
- **Bez form z rodzajem** w tekstach o mieszkańcach i do nich (np. zamiast „poszedł/poszła” — czas
  teraźniejszy lub konstrukcje bezosobowe). Imiona w mianowniku („Ola ↔ Bartek: …”, „Ola: …”).
  W testach pamiętnika jest detektor form z rodzajem.
- Prawdziwe nagłówki wiadomości pokazujemy **dosłownie, ze źródłem** — nie przerabiamy i nie dopisujemy
  faktów (także w promptach AI).

## AI i koszty

- AI przez OpenRouter, **domyślnie wyłącznie darmowe modele** (`:free`); płatny model tylko jawnie
  w `OPENROUTER_MODELS`. Konto ma twardy limit wydatków.
- Dzienny budżet zapytań jest wspólny dla 4 światów i przeglądarki — nowe użycia AI muszą mieć limit
  i proceduralny fallback.
- Klucz tylko po stronie serwera, nigdy w bundlu ani w logach.

## Wdrożenie

- Obraz wieloetapowy (`Dockerfile`: build → test → runtime), `compose.yaml` dla Coolify.
- **Trwały wolumen na `/app/data`** — tam światy na żywo zapisują stan co 5 min i przy zatrzymaniu.
  Bez wolumenu każdy deploy zaczyna światy od nowa.
- Zmiana formatu snapshotu ⇒ podbij `SNAPSHOT_VERSION`; niezgodny plik serwer odkłada jako `.bak`
  i zaczyna świat od nowa (opisz to w PR — to „reset” osiedli na produkcji).
