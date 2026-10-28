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
T = statystyki (sieć relacji, nastroje), Z = zapis/wczytanie, N = nowy świat, L = pobierz log aktywności, `?` = pomoc.

**Domy:** w oknie „Nowy świat” (klawisz N) do wyboru Dom z ogrodem, Kamienica, Domek nad jeziorem i Akademik.

**Telewizja:** gdy ktoś ogląda TV, nad telewizorem leci pasek wiadomości: prawdziwe nagłówki z polskich serwisów (RSS przez serwer Vite, ustawienie `NEWS_FEEDS`, `off` wyłącza), a bez sieci „Wiadomości z osiedla”. Mieszkańcy potem o nich rozmawiają.

**Tryb na żywo:** `?mode=real` albo zaznaczenie w oknie „Nowy świat”: zegar gry = Twój zegar, pogoda z Open-Meteo dla Twojej lokalizacji (domyślnie Warszawa, `?lat=&lon=`). Bez przyspieszania i zapisów.

**Parametry URL:** `?seed=7` (powtarzalny świat), `?hour=21` lub `?tick=2000` (przewiń), `?agents=4` (1–8), `?map=akademik`, `?mode=real`, `?news=off`, `?paused`.

**Dialogi AI (opcjonalnie, OpenRouter):** `cp .env.example .env`, wpisz `OPENROUTER_API_KEY`, zrestartuj
`npm run dev` i kliknij przełącznik w lewym górnym rogu. Domyślnie używane są wyłącznie darmowe modele
(`:free`); listę można zmienić w `OPENROUTER_MODELS`. Klucz zostaje na serwerze Vite. Bez klucza
dialogi są proceduralne.

**Analiza zachowań:** `node scripts/observe.mjs "http://localhost:5173/?seed=42" 15 test-results/observe` (15 min w Chromium) i `node scripts/analyze-trace.mjs test-results/observe/trace.txt`.

**Testy:** `npm test` (logika + 7-dniowy soak), `npm run test:e2e` (Playwright, zrzuty w `test-results/shots/`).

Architektura, decyzje i stan prac: `plan/`.
