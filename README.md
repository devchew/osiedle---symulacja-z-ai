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
T = statystyki (sieć relacji, nastroje), Z = zapis/wczytanie, N = nowy świat, P = pamiętniki mieszkańców, L = pobierz log aktywności, `?` = pomoc.

**Pamiętniki:** każdy mieszkaniec wieczorem zapisuje kilka zdań o swoim dniu (📔 w inspektorze lub klawisz P) — na podstawie tego, co naprawdę się wydarzyło; z włączonym AI wpisy mogą być przepisane przez model.

**Domy:** w oknie „Nowy świat” (klawisz N) do wyboru Dom z ogrodem, Kamienica, Domek nad jeziorem i Akademik.

**Telewizja:** gdy ktoś ogląda TV, nad telewizorem leci pasek wiadomości: prawdziwe nagłówki z polskich serwisów (RSS przez serwer Vite, ustawienie `NEWS_FEEDS`, `off` wyłącza), a bez sieci „Wiadomości z osiedla”. Mieszkańcy potem o nich rozmawiają.

**Tryb na żywo:** `?mode=real` albo zaznaczenie w oknie „Nowy świat”: zegar gry = Twój zegar, pogoda z Open-Meteo dla Twojej lokalizacji (domyślnie Warszawa, `?lat=&lon=`). Bez przyspieszania i zapisów.

**Parametry URL:** `?seed=7` (powtarzalny świat), `?hour=21` lub `?tick=2000` (przewiń), `?agents=4` (1–8), `?map=akademik`, `?mode=real`, `?news=off`, `?paused`.

**Dialogi AI (opcjonalnie, OpenRouter):** `cp .env.example .env`, wpisz `OPENROUTER_API_KEY`, zrestartuj
`npm run dev` i kliknij przełącznik w lewym górnym rogu. Domyślnie używane są wyłącznie darmowe modele
(`:free`); listę można zmienić w `OPENROUTER_MODELS`. Klucz zostaje na serwerze Vite. Bez klucza
dialogi są proceduralne.

## Docker / serwer

Obraz wieloetapowy (`Dockerfile`): etap `build` instaluje zależności, sprawdza typy i buduje aplikację
oraz serwer produkcyjny (`server/prod.ts` → jeden plik `dist-server/prod.js`), opcjonalny etap `test`
uruchamia testy, a etap `runtime` to lekki Node Alpine z samym buildem (bez `node_modules`, źródeł
i sekretów), działający jako użytkownik `node`, z healthcheckiem `/healthz`.

```bash
docker build -t osiedle .                       # obraz produkcyjny
docker build --target test .                    # build + testy jednostkowe
docker run -d -p 8080:8080 --env-file .env osiedle   # albo: docker compose up -d --build
```

Konfiguracja wyłącznie przez zmienne środowiskowe przy uruchomieniu: `PORT` (8080), `OPENROUTER_API_KEY`
(dialogi AI, opcjonalnie), `OPENROUTER_MODELS`, `OPENROUTER_DAILY_LIMIT`, `NEWS_FEEDS` (`off` wyłącza
prawdziwe nagłówki). Klucz nigdy nie trafia do obrazu (`.env` jest w `.dockerignore`). Za reverse proxy
(nginx, Traefik) działa bez zmian — proxy AI akceptuje `X-Forwarded-Host`.

**Analiza zachowań:** `node scripts/observe.mjs "http://localhost:5173/?seed=42" 15 test-results/observe` (15 min w Chromium) i `node scripts/analyze-trace.mjs test-results/observe/trace.txt`.

**Testy:** `npm test` (logika + 7-dniowy soak), `npm run test:e2e` (Playwright, zrzuty w `test-results/shots/`).

Architektura, decyzje i stan prac: `plan/`.

## Współpraca

Zadania: GitHub Issues. Zasady pracy (gałęzie, testy, determinizm, język, AI, wdrożenie): `CONTRIBUTING.md`.
