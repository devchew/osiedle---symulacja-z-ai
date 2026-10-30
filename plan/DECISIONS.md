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
| 2026-10-28 | TV: prawdziwe nagłówki z publicznych RSS przez proxy Vite `/api/news` (bez kluczy, cache 15 min, tytuły dosłownie ze źródłem, filtr drastycznych), bez sieci „Wiadomości z osiedla” z `world.events` (deterministycznie); feed startuje po replayu, zapis oznaczony jak AI | prawdziwy świat w TV bez psucia determinizmu symulacji |
| 2026-10-28 | Tryb rzeczywisty `?mode=real`: zegar = lokalny czas (DST-safe), `loop.setDriver` dogania zegar, pogoda Open-Meteo przez `setWeatherOverride`, lokalizacja `?lat&lon` > zgoda > Warszawa; zapis/linki wyłączone | „akwarium na żywo” jako alternatywny tryb |
| 2026-10-28 | Domy w `src/world/maps/*.ts` (wspólny `build.ts`), zapis/link niosą `map` (brak = `dom`); każdy dom ma zestaw podstawowy aktywności zamiast wszystkich | różnorodność domów |
| 2026-10-28 | Produkcja: własny serwer Node bez zależności (bundel 32 kB) zamiast `vite preview`; konfiguracja tylko przez env przy uruchomieniu | mały obraz runtime bez node_modules, sekrety poza obrazem |
| 2026-10-28 | Proxy AI akceptuje `X-Forwarded-Host` przy sprawdzaniu Origin | działanie za reverse proxy; przeglądarka nie wyśle tego nagłówka cross-origin bez preflightu |
| 2026-10-29 | Pamiętniki: fakty dnia zbierane przyrostowo z trace i zdarzeń; wpis przy położeniu się na noc (≥19:00, ≥180 min snu) lub o 23:30; dzień pamiętnika od 05:00; 60 dni/postać | wpis zgodny z tym, co naprawdę się wydarzyło |
| 2026-10-29 | Wpisy proceduralne z własnym RNG `diarySeed(seed, agent, day)`, tylko odczyt stanu; replay odtwarza wpisy; detektor form z rodzajem w testach | determinizm, symulacja nietknięta, polszczyzna bez rodzaju |
| 2026-10-29 | AI pamiętników przez ten sam proxy i budżet co dialogi, max 1 próba/postać/dzień, odmowa przy ≤ max(20, 15%) budżetu, ścisła walidacja wyniku | dialogi mają pierwszeństwo, każdy błąd = wpis proceduralny |
| 2026-10-29 | Wspólne zajęcia (`agents/joint.ts`) nad zwykłymi akcjami `use`: wspólny koniec, wyjście tylko przy krytycznej potrzebie/deszczu | długie zajęcia razem zamiast krótkich solo |
| 2026-10-29 | Projekty: etapy jako typy obiektów (przebudowa warstwy statycznej), własny RNG, praca 8–19 bez deszczu, tempo przez mnożnik harmonogramu | budowa altany ~2 tygodnie bez zmian w agentach |
| 2026-10-29 | Wieczory: energia 22 h, łóżko 20–22 ×0,08 przy energii > 40, premia wypoczynku 18–22 | wcześniej wszyscy spali od ~20:30, wieczorów nie było |
| 2026-10-29 | Kierunek produktu: 4 stałe światy na żywo na serwerze (24/7, Europe/Warsaw), sandbox = kopia stanu w sesji, realne tempo ruchu; kronika/„ostatnie 24 h” później | decyzja użytkownika |
| 2026-10-29 | Snapshot świata: `core/state.ts` (rejestr w modułach), czysty JSON, stan kluczowany obiektami zapisywany po id, `SNAPSHOT_VERSION` + zgodność kluczy modułów; haki (pogoda na żywo, feed, AI pamiętnika) podpina właściciel | serwer 24/7 i sandbox z kopii |
| 2026-10-29 | Ruch realny: 82,5 kafla/tick, spacer o połowę wolniej, ślad (trail) tylko do renderu; renderer odtwarza ścieżkę (na żywo 1:1, sandbox ~6 kafli/s z limitem opóźnienia) | na żywo postacie nie mogą „pełzać” godzinami |
| 2026-10-29 | Po realnym ruchu: rozmowy przy okazji 0,02 → 0,008, energia 26 h, romans/irytacja razem 0,04/0,17, rywale zostają do 10, naprawy atrakcyjniejsze (5 + h, max 10) | więcej czasu w czynnościach zmieniło dynamikę |
| 2026-10-29 | Światy na żywo: jeden proces Node, 4 miejsca, zegar Europe/Warsaw przez Intl, tick na granicy minuty, >3 dni przestoju → przesunięcie kotwicy zamiast odtwarzania | serwer 24/7 niezależny od strefy kontenera |
| 2026-10-29 | Trwałość: plik JSON na miejsce w `/app/data` (snapshot + baseDay), zapis atomowy co 5 min i przy SIGTERM, nieczytelny → `.bak` + świeży świat | restart/deploy bez utraty historii |
| 2026-10-29 | Transport SSE: ramka (NETWORK_SNAPSHOT) serializowana raz na tick, gzip z niezależnie skompresowanych segmentów wspólnych dla widzów; limity 200 strumieni / 8 na IP | tani streaming dla wielu widzów |
| 2026-10-29 | AI na serwerze przez ten sam handler `/api/llm` w procesie; budżet dzienny dzielony na 4 światy, oglądane mogą pożyczać | jeden budżet, AI generowane raz na świat |
| 2026-10-29 | Klient: tryby live (tylko render), sandbox (fork snapshotu, sessionStorage), ukryte `/lab` (dawny tryb do testów); wejścia ładują najpierw `world/world` (cykle importów) | publiczny widok bez tworzenia/modyfikacji światów |
| 2026-10-29 | Rozmowy jako wymiany (#26): kwestia + odpowiedź w tej samej minucie, przerwa 1–2 min, 4–7 kwestii (~5 min zamiast ~55); `Bubble.at` (opcjonalny ułamek tiku) — odpowiedź kilka s po kwestii; dymki pokazywane przez renderer w czasie rzeczywistym (czas czytania 3,5–9 s, min. 1,5 s przy szybkim tempie, zegar staje przy pauzie); balans: rozmowa „na podejście” 5 social/min, rozmowy przy okazji 0,008 → 0,004, wydłużanie siedzenia 60/20 → 20/8, wspólne zajęcia domykają rozmowy 6 min przed końcem | na żywo dymek jednej osoby wisiał kilkanaście minut; liczba rozmów, relacje i potrzeby jak przed zmianą (diag/soak) |
| 2026-10-30 | Kronika miejsca (#4): serwer po każdym ticku klasyfikuje zdarzenia (`src/social/chronicle.ts`) i trzyma ważne przez 14 dni (≤60/dzień) w osobnym `DATA_DIR/<miejsce>.chronicle.json` (zapis atomowy razem ze snapshotem, uszkodzony → `.bak`, dociąganie z `world.events` po crashu); odczyt `GET /api/live/:place/chronicle` (`ChronicleResponse`, ETag, gzip, 503 `starting`) pobierany przez UI przy otwarciu panelu (klawisz K) i co 5 min — ramka SSE bez zmian; podsumowanie dnia proceduralne, opcjonalnie AI (`/api/llm/chronicle`, 1 próba na dzień i świat, wspólny budżet z rezerwą jak pamiętniki) | `world.events` ma cap 200 (kilka godzin) — nie widać, co działo się wczoraj; osobny plik nie podbija `SNAPSHOT_VERSION` ani nie obciąża ramek |
