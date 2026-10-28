# Osiedle — autonomiczna symulacja życia

Przeglądarkowa symulacja w stylu The Sims, w której nie sterujesz postaciami. Do ośmiorga mieszkańców
ma potrzeby, osobowość i codzienny cel. Sami wybierają, co robić: gotują, śpią we własnych łóżkach,
łowią ryby, grillują, naprawiają zepsute sprzęty i chowają się przed deszczem. Rozmawiają,
plotkują o tym, co widzieli, zaprzyjaźniają się, zakochują albo zostają rywalami. Ty tylko obserwujesz.

```bash
npm install
npm run dev          # http://localhost:5173
```

**Sterowanie widokiem:** Spacja = pauza, 1–4 = prędkość, przeciągnij/WASD = przesuń, kółko/szczypnięcie = zoom,
klik w postać = inspektor (potrzeby, cel dnia, relacje, wspomnienia), dwuklik = śledzenie,
T = statystyki (sieć relacji, nastroje), Z = zapis/wczytanie, N = nowy świat, `?` = pomoc.

**Parametry URL:** `?seed=7` (powtarzalny świat), `?hour=21` lub `?tick=2000` (przewiń), `?agents=4` (1–8), `?paused`.

**Dialogi AI (opcjonalnie, OpenRouter):** `cp .env.example .env`, wpisz `OPENROUTER_API_KEY`, zrestartuj
`npm run dev` i kliknij przełącznik w lewym górnym rogu. Domyślnie używane są wyłącznie darmowe modele
(`:free`); listę można zmienić w `OPENROUTER_MODELS`. Klucz zostaje na serwerze Vite. Bez klucza
dialogi są proceduralne.

**Testy:** `npm test` (logika + 7-dniowy soak), `npm run test:e2e` (Playwright, zrzuty w `test-results/shots/`).

Architektura, decyzje i stan prac: `plan/`.
