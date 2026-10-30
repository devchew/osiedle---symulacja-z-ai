---
name: review-prs
description: Review open pull requests for merge safety and mark them with the safe-to-merge / needs-work label. Use when asked to check, watch or review open PRs.
---

# Przegląd otwartych PR przed merge

GitHub nie pozwala zatwierdzić własnego PR (autor = właściciel konta), więc werdykt to **label + komentarz**:
`safe-to-merge` (można mergować — robi to człowiek) albo `needs-work`. Nigdy nie mergujemy i nie pushujemy do cudzych gałęzi.

## Kroki

1. Bramki mechaniczne (dry-run, nic nie zapisuje): `node scripts/review-prs.mjs`
   Sprawdza: nie-draft i base `master`, brak konfliktów, `Closes #<nr>`, CI (`test`, `docker`), komentarz
   Coolify „ready" świeższy niż ostatni commit, smoke-test preview (HTTP, `/api/live/*`, Chromium bez błędów
   konsoli, zrzuty w `test-results/pr-review/<nr>/` — obejrzyj je).
   PR z bramką `pending` (CI w toku, preview się buduje) pomijamy i wracamy później.
2. Dla PR bez `fail` przejrzyj diff: `gh pr diff <nr>` (+ `gh pr view <nr>`), wg listy poniżej.
3. Zapisz werdykt: `node scripts/review-prs.mjs --pr <nr> --diff ok|fail --notes "krótkie uwagi" --apply`
   (komentarz z markerem jest aktualizowany, nie duplikowany; zawiera SHA przejrzanego commita).
   PR z `fail` w bramkach mechanicznych: `--apply` oznacza `needs-work` z konkretnymi powodami.
4. Nowy commit po oznaczeniu nie zdejmuje labela — porównaj SHA w komentarzu z `headRefOid` i w razie
   różnicy przejrzyj PR ponownie.

## Lista przeglądu diffu (CONTRIBUTING.md / CLAUDE.md)

- Symulacja (`core/ world/ agents/ social/`): bez DOM, `render/`, `ui/`; bez `Math.random()` / `Date.now()` (tylko `world.rng`).
- Nowy stan w `WeakMap` zarejestrowany w `src/core/state.ts`; brak cykli importów.
- Zmiana `src/types.ts` / `src/live/protocol.ts` ⇒ wpis w `plan/DECISIONS.md`; zmiana snapshotu ⇒ `SNAPSHOT_VERSION` i
  wzmianka o resecie w opisie PR.
- Zmiana zachowań ⇒ test (`tests/tools/trace.test.ts`); zmiana UI ⇒ zrzuty w opisie PR.
- Teksty w grze po polsku, bez form z rodzajem, imiona w mianowniku; kod i komentarze po angielsku.
- AI: domyślnie tylko modele `:free`, klucz tylko na serwerze, limit + fallback proceduralny.
- Brak sekretów, `.env`, dużych plików; uwaga na zmiany w `.github/`, `Dockerfile`, `compose.yaml`, zależnościach,
  wolumenie `/app/data` i nowych zmiennych env — wyróżnij je w `--notes` (produkcja = Coolify z `master`).
