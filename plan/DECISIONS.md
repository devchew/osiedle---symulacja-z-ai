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
| 2026-10-28 | Postacie nie blokują się nawzajem na ścieżkach | prostota; przy 6–8 postaciach nie razi, ewentualnie fala 3 |
| 2026-10-28 | Strojenie: chód 0,45 kafla/tick, 5 ticków/s, potrzeby wolniej (głód 20 h, zabawa 14 h, towarzystwo 16 h, higiena 26 h, komfort 16 h), kara dystansu /20 | wcześniej postacie więcej chodziły niż robiły i potrzeby spadały do zera |
| 2026-10-28 | Przerwanie aktywności tylko po ≥10 tickach i gdy potrzeby obsługiwane przez obiekt ≥50 | eliminuje „thrashing” między obiektami |
| 2026-10-28 | Sen: długość ustalana z góry — wieczorem/w nocy do 6:00–7:00, w dzień drzemka 60–120 min | wcześniej popołudniowe drzemki do 21:30 i grill o północy |
| 2026-10-28 | Każda postać ma własne łóżko (WeakMap w `agents/home.ts`, kontrakt bez zmian) | koniec chodzenia do losowych łóżek |
| 2026-10-28 | Scoring: wagi potrzeb, koszty liczone poniżej 0, osobowość i dystans słabną przy pilnej potrzebie; okna posiłków 7–9/12–14/17:30–19:30; ogród ×0,12 w nocy; kara za powtarzanie | różnorodność i wiarygodny rytm dnia |
| 2026-10-28 | Postacie się omijają (czekanie, re-path co 3 ticki, przejście po 12) — zastępuje decyzję „nie blokują się” | czytelniejszy ruch, brak zakleszczeń |
| 2026-10-28 | Narracja: ≤4 zdarzenia/h, bez czasu przeszłego z rodzajem („Ola: …”) | czytelny log, poprawna polszczyzna bez odmiany imion |
| 2026-10-28 | LLM przez proxy jako plugin Vite (klucz z `.env`, nigdy w bundlu), `claude-haiku-5-5`, structured output `{text, tone}`, 20 req/min, timeouty 6/8 s, fallback proceduralny, 403 dla cross-origin | koszt i bezpieczeństwo klucza; gra działa bez klucza |
| 2026-10-28 | Z włączonym LLM seed nie gwarantuje powtarzalności | odpowiedzi przychodzą asynchronicznie |
| 2026-10-28 | Limit postaci z URL = liczba łóżek (6) | test E pokazał, że nadmiarowe postacie nie mają gdzie spać |
| 2026-10-28 | Kolejność: fala 4 świat+pamięć, 5 dynamika społeczna, 6 AI | decyzja użytkownika po przeglądzie |
| 2026-10-28 | AI w fali 6 przez OpenRouter (proxy przepięte z `@anthropic-ai/sdk` na API OpenRouter) | decyzja użytkownika |
| 2026-10-28 | Plotki: kontrakt `Gossip` (tekst 3. osoba, czas teraźniejszy, imiona nieodmieniane) w zdarzeniach i kontekście rozmowy; pamięć w `social/memory.ts` | pamięć i dialogi bez zmian w `Agent` |
| 2026-10-28 | Mapa 44×29: centralny salon/kuchnia, 4 sypialnie (8 łóżek) i 2 łazienki przy hubie, drzwi do ogrodu z każdej sypialni | krótsze trasy, do 8 mieszkańców |
| 2026-10-28 | Pamięć: per świat, klucz = tekst historii; świadkowie ≤6 kafli i nieśpiący; połowiczny zanik 2,5 dnia (przeżyte) / 1,5 (zasłyszane); max 12 wspomnień; plotka tylko o osobach trzecich; zmiana opinii ±1..3 × zaufanie; `DialogueLine.gossip?`, `Gossip.shared?` | plotki rozchodzą się i mają skutki |
| 2026-10-28 | Cele dnia: 13 rodzajów, losowane o 6:00 wg osobowości, wygasają o 22:00, premia w scoringu słabnie przy pilnej potrzebie; stan w WeakMap (`agents/goals.ts`) | mniej przypadkowe dni |
| 2026-10-28 | Drzemka w dzień tylko przy energii < 28; brak zaczepiania w łóżku i łazience; id rozmów per świat | realizm i determinizm |
| 2026-10-28 | AI: OpenRouter, wyłącznie modele `:free` (łańcuch w `models`, płatny tylko jawnie w `OPENROUTER_MODELS`); JSON mode; reasoning off | twardy limit $2 na koncie, prośba o darmowe modele |
| 2026-10-28 | Limity AI: 15/min, 3 równolegle, timeout 12/14 s, budżet dzienny 180 (sync z `/api/v1/key`), upstream 429 → pauza wg `Retry-After` | limity free tier OpenRouter |
| 2026-10-28 | Relacje: romans/rywalizacja/historia per para (WeakMap), status z histerezą, romans PG i wyłączny; spotkania grupowe przez zaproszenia (premia w scoringu) | dynamika społeczna bez zmian kontraktu |
| 2026-10-28 | `availability` mnoży wynik po premiach celów i społecznych | deszcz/awaria zawsze wygrywa z premią |
| 2026-10-28 | Zdarzenia świata: własne strumienie RNG z seeda; awaria = zamiana `obj.type` na `repair_<type>`, naprawa z istniejącego utility AI, fachowiec po 8 h | pogoda stabilna przy strojeniu agentów, brak zmian w agentach |
| 2026-10-28 | Zapis = seed + liczba postaci + tick (+ odcisk `check`); odczyt = przeładowanie z parametrami URL i replay; statystyki pod klawiszem T (S przesuwa kamerę) | determinizm zamiast serializacji stanu |
| 2026-10-28 | Log aktywności (trace) w symulacji, ring buffer 30k wpisów per świat, bez wpływu na RNG | diagnoza zachowań („chaos”) na podstawie danych |
| 2026-10-28 | „Zaspokojone” kończy aktywność dopiero po 20 min; cooldown 45 min na ten sam obiekt; rozmowa przy obiekcie social przedłuża pobyt (≤60 min, od 20 min zmierza do pożegnania) | postacie siadały i wstawały co 2 min, rozmowy urywały się w połowie |
| 2026-10-28 | Zaproszenie: zajęty samotną czynnością → ×0,45 szans, odmowa z powodem; przy obiekcie social rozmowa na miejscu | mniej porzucania czynności, czytelniejszy log |
