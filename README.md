# Osiedle — autonomiczna symulacja życia

Przeglądarkowa symulacja w stylu The Sims, w której nie sterujesz postaciami. Sześcioro mieszkańców
ma potrzeby i osobowości. Sami wybierają, co robić: gotują, śpią we własnych łóżkach, łowią ryby,
grillują, ćwiczą, rozmawiają i budują relacje. Ty tylko obserwujesz.

```bash
npm install
npm run dev          # http://localhost:5173
```

**Sterowanie widokiem:** Spacja = pauza, 1–4 = prędkość, przeciągnij/WASD = przesuń, kółko/szczypnięcie = zoom,
klik w postać = inspektor, dwuklik = śledzenie, `?` = pomoc.

**Parametry URL:** `?seed=7` (powtarzalny świat), `?hour=21` (przewiń do godziny), `?agents=4`, `?paused`.

**Dialogi AI (opcjonalnie):** `cp .env.example .env`, wpisz `ANTHROPIC_API_KEY`, zrestartuj `npm run dev`
i kliknij przełącznik w lewym górnym rogu. Klucz zostaje na serwerze Vite. Bez klucza dialogi są proceduralne.

**Testy:** `npm test` (logika + 7-dniowy soak), `npm run test:e2e` (Playwright, zrzuty w `test-results/shots/`).

Architektura, decyzje i stan prac: `plan/`.
