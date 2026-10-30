# Osiedle — symulacja życia na żywo

Cztery miejsca — **Dom z ogrodem** (Józefów), **Kamienica** (Kraków), **Domek nad jeziorem** (Giżycko)
i **Akademik** (Wrocław) — w każdym mieszka kilka osób, które żyją własnym życiem: jedzą, śpią we
własnych łóżkach, łowią ryby, grają razem na konsoli, budują altanę, plotkują, zakochują się,
kłócą i co wieczór piszą pamiętnik. Nikt nimi nie steruje.

Światy działają **24/7 na serwerze w czasie rzeczywistym**: zegar to czas polski, pogoda jest
prawdziwa (Open-Meteo dla miasta danego miejsca), w telewizorze lecą prawdziwe nagłówki, a dialogi
i pamiętniki może pisać AI (OpenRouter, darmowe modele). Odwiedzający oglądają i przełączają miejsca.

Produkcja: https://osiedle.devchew.com

## Obsługa

Klik w mieszkańca — szczegóły (potrzeby, cel dnia, relacje, wspomnienia, 📔 pamiętnik); dwuklik —
śledzenie kamerą; przeciągnij/WASD — przesuwanie; kółko — zoom; **T** statystyki, **P** pamiętniki,
**B** projekty, **?** pomoc. Link do mieszkańca: `/kamienica#ola`.

## Uruchomienie lokalne

```bash
npm install
npm run dev                  # http://localhost:5173
LIVE_SPEED=60 npm run dev    # świat przyspieszony (1 min gry / s)
```

Opcjonalnie `.env` (zobacz `.env.example`): `OPENROUTER_API_KEY` (AI), `NEWS_FEEDS`, `LIVE_*`, `DATA_DIR`.

## Docker / wdrożenie

```bash
docker build -t osiedle .                     # build → (test) → runtime
docker build --target test .                  # build + testy jednostkowe
docker run -d -p 8080:8080 -v osiedle-data:/app/data --env-file .env osiedle
```

Światy zapisują stan w `/app/data` (co 5 min i przy zatrzymaniu) — **podłącz trwały wolumen**, inaczej
każdy restart zaczyna osiedla od nowa. `compose.yaml` jest przygotowany pod Coolify.

## Współpraca

Zadania: **GitHub Issues**. Zasady pracy (gałęzie, testy, determinizm, język, AI, wdrożenie):
**`CONTRIBUTING.md`**. Decyzje projektowe: `plan/DECISIONS.md`.
