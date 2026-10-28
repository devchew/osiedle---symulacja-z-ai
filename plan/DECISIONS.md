# Decyzje

| Data | Decyzja | Powód |
|---|---|---|
| 2026-10-28 | Top-down 2D, Vite + TS + Canvas, bez silnika gier | wybór użytkownika; prostota, testowalność |
| 2026-10-28 | Rozmowy proceduralne, LLM opcjonalnie przez lokalny proxy (fala 3) | wybór użytkownika; działa offline, klucz poza bundlem |
| 2026-10-28 | 1 tick = 1 minuta gry, 10 ticków/s przy x1 (doba ≈ 2,4 min) | płynne tempo obserwacji |
| 2026-10-28 | Współrzędne w kaflach, liczby całkowite = środki kafli | jedna konwencja dla A*, renderu i logiki |
| 2026-10-28 | `DialogueProvider.nextLine` zwraca linię synchronicznie albo Promise | headless soak test nie może czekać na mikrotaski; LLM jest async |
| 2026-10-28 | `Grid.solid` liczony przez moduł world (ściany + blokujące obiekty) | pathfinding nie zależy od katalogu obiektów |
| 2026-10-28 | Playwright 1.64 + Chromium rev. 1248 pobrany lokalnie | testy renderingu i zrzuty ekranu oglądane przez Claude |
