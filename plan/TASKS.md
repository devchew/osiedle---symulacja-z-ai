# Taski

Legenda: `[ ]` do zrobienia · `[~]` w toku · `[x]` zrobione. Aktualizuje orkiestrator po weryfikacji fali.
Każdy task posiada wyłącznie wymienione pliki. Kontrakty: `src/types.ts`.

## Fala 0 — fundament (orkiestrator)
- [x] Scaffold: Vite + TS + Vitest + Playwright (`package.json`, `tsconfig.json`, `vite.config.ts`, `playwright.config.ts`)
- [x] Kontrakty `src/types.ts`
- [x] `src/core/rng.ts`, `src/core/time.ts`, `src/core/loop.ts` + `tests/core.test.ts`
- [x] `plan/`, `CLAUDE.md`, branch `feat/simulation`

## Fala 1 — moduły równolegle (4 agentów)

### [x] A „world” — `src/world/grid.ts`, `src/world/objects.ts`, `src/world/map.ts`, `tests/world.test.ts`
API:
- `grid.ts`: `createGrid(w, h, fill: TileKind): Grid`, `inBounds(g, x, y)`, `isWalkable(g, x, y)`, `setTile(g, x, y, kind)` (aktualizuje `solid`), `markSolid(g, x, y, solid)`, `roomAt(g, x, y): Room | null`, `randomWalkableTile(g, rng, area?: RectArea): Vec2`
- `objects.ts`: `OBJECT_DEFS: Record<string, ObjectDef>` (~14 aktywności + dekoracje bez slotów), `slotStandTile(obj, def, i): Vec2`, `slotUsePos(obj, def, i): Vec2`, `objectCenter(obj, def): Vec2`
- `map.ts`: `createDefaultMap(): { grid: Grid; objects: ObjectInstance[]; spawnPoints: Vec2[] }` — deterministyczna; dom (kuchnia, salon, ≥3 sypialnie, łazienka) + ogród; łóżek ≥ 6
- Done: testy — każdy slot `stand` jest walkable i osiągalny (BFS) ze spawnów; brak nakładania footprintów; `solid` zgodne z kaflami i obiektami

### [x] B „agents” — `src/agents/agent.ts`, `src/agents/needs.ts`, `src/agents/pathfinding.ts`, `src/agents/movement.ts`, `tests/agents.test.ts`
API:
- `agent.ts`: `AGENT_NAMES`, `createAgent(id, name, pos, rng): Agent`, `createAgents(count, spawnPoints, rng): Agent[]`
- `needs.ts`: `decayNeeds(agent, ctx: { sleeping: boolean; hour: number }): void` (zależne od cech), `applyEffects(agent, effects, scale = 1)`, `computeMood(needs, traits): number`, `urgency(value): number` (0..1, wypukła), `lowestNeed(needs): NeedKey`
- `pathfinding.ts`: `findPath(grid, from, to, opts?: { extraBlocked?: (x, y) => boolean; maxNodes?: number }): Vec2[] | null` (A*, 8 kierunków bez ścinania rogów, binary heap; wynik bez startu, z celem; `[]` gdy start = cel), `nearestWalkable(grid, p): Vec2 | null`
- `movement.ts`: `WALK_SPEED`, `stepAgent(agent, speed = WALK_SPEED): 'moving' | 'arrived' | 'idle'` (nie rusza `prevPos` — robi to world tick)
- Done: testy A* (ściany, brak ścieżki, rogi), potrzeby, ruch

### [x] C „render” — `src/render/*`, `render-demo.html`
API: `createRenderer(canvas, world): Renderer` z `render(alpha)`, `resize()`, `pickAgent(clientX, clientY): Agent | null`, `setSelected(id | null)`, `follow(id | null)`; kamera: drag = pan, kółko = zoom, start = dopasowanie do mapy
- Rysuje: kafle, ściany, nazwy pokoi, obiekty (proceduralnie per typ + fallback), postacie (interpolacja `prevPos→pos`, chód, imię), dymki mowy/myśli, ikonę akcji, zaznaczenie, oświetlenie dzień/noc
- Done: `render-demo.html` z mock-światem; zrzut z Playwright obejrzany

### [x] D „social + ui” — `src/social/*`, `src/ui/*`, `tests/social.test.ts`
API:
- `relationships.ts`: `createRelationships(): Relationships`, `relationshipLabel(v): string`
- `conversation.ts`: `TOPICS`, `startConversation(id, a, b, tick, rng): Conversation`, `willAcceptChat(target, initiator, relationship, rng): boolean`, `conversationDelta(a, b, lines): number`, `describeConversation(a, b, conv, delta): string`
- `dialogueProvider.ts`: `createProceduralProvider(): DialogueProvider` (PL, zależnie od tematu, nastroju, cech, relacji, tury; synchronicznie)
- `ui/hud.ts`: `createHud(root, controls, world): { update() }` — zegar, dzień, pora, pauza, prędkości 1/2/4/8, skróty klawiszowe
- `ui/inspector.ts`: `createInspector(root, world, opts: { onClose(): void }): { show(id | null); update() }`
- `ui/eventLog.ts`: `createEventLog(root, world): { update() }`; `ui/ui.css`
- Done: testy social; UI kompiluje się (`tsc`)

## Fala 2 — integracja (orkiestrator)
- [x] `src/agents/brain.ts` — utility AI (obiekty + rozmowy + wander/idle), top-3 ważone
- [x] `src/agents/actions.ts` — maszyna stanów, rezerwacje slotów, rozmowy (zaproszenie + „przy okazji” przy obiektach social), dymki, rytm snu (noc do rana, w dzień drzemki)
- [x] `src/world/world.ts` — `createWorld(seed, opts)`, `tickWorld(world)`; `src/world/events.ts`
- [x] `src/main.ts` — pętla (5 ticków/s), renderer, UI, `window.__sim`; parametry URL `?seed=`, `?hour=`, `?agents=`, `?paused`
- [x] `e2e/sim.spec.ts` — 5 testów; zrzuty w `test-results/shots/`
- [x] `tests/sim.test.ts` — determinizm, brak podwójnych rezerwacji, 2 doby bez zer
- Narzędzie: `DAYS=7 SEED=1 npx vitest run tests/tools/diag.test.ts` → `test-results/diag.txt` (potrzeby, czas na aktywnościach, sen)

Notatki z integracji: pierwsza wersja wpadała w spiralę (przerywanie aktywności przy kilku krytycznych potrzebach → wieczne chodzenie). Naprawione progiem przerwania + strojeniem tempa (patrz DECISIONS).

## Fala 3 — dopracowanie (3 agentów) — [x]
- [x] E „balans/soak”: `tests/soak.test.ts` (7 dni × 6 seedów; `SOAK_SEEDS=1,…,30` przechodzi), własne łóżka (`agents/home.ts`), pory posiłków, wpływ osobowości, omijanie się postaci, narracja zdarzeń (`agents/narration.ts`), metryki `tests/tools/metrics.ts`
- [x] F „polish wizualny”: pozy (siedzenie, wanna, prysznic, rowerek), fryzury/karnacje, dymki bez nachodzenia, światło bez przenikania przez ściany, zmierzch/świt, chmury/staw/świetliki, pinch/WASD/dwuklik-follow, pomoc `?`, kompaktowy log, `e2e/visual.spec.ts`
- [x] G „LLM”: `server/llmProxy.ts` (plugin Vite, dev + preview), `src/social/llmProvider.ts`, przełącznik `src/ui/llmToggle.ts`, `.env.example`, `tests/llm.test.ts`
- [x] Orkiestrator: drzwi pokój hobby → ogród, limit postaci w URL = liczba łóżek

## Fala 4 — świat i pamięć (3 agentów) — [x]
Przygotowanie (orkiestrator) [x]: kontrakt `Gossip` w `types.ts` (`SimEvent.gossip?`, `ConversationContext.gossip?`), `pushEvent(…, gossip?)`, stub `src/social/memory.ts` (`updateMemories`, `recallFor`, `onConversationEnd`) podpięty w `world.ts` i `actions.ts`.

### [x] H „mapa” — `src/world/map.ts`, `src/world/grid.ts`, `tests/world.test.ts`
- Zwarty dom z krótszymi drogami (cel: chodzenie ≤ ~3,5 h/dobę gry vs 5,7 h), 4. sypialnia → 8 łóżek, ogród bliżej, zachowane wszystkie typy aktywności
- Done: testy world + soak zielone, zrzut obejrzany
- Wynik: dom z centralnym salonem/kuchnią, 4 sypialnie (8 łóżek) z drzwiami do ogrodu, 2 łazienki; chodzenie 6,0 → 4,8 h/dobę (cel 3,5 h nieosiągnięty — krótsze trasy = więcej aktywności i spacerów)

### [x] I „pamięć i plotki” — `src/social/**`, `src/agents/narration.ts`, `tests/social.test.ts`, `tests/memory.test.ts`
- Wspomnienia per postać (z `world.events` z `gossip`), zanikanie, plotki rozchodzą się w rozmowach, wpływają na opinie o osobach trzecich
- Dialog proceduralny wplata plotki („Słyszałeś? Ola przypala obiad!”), narracja wypełnia `gossip`
- Done: testy pamięci; w soak ≥ X rozmów z plotką/tydzień
- Wynik: ~16–29 linii z plotką/tydzień (co druga rozmowa), 11–21 przypadków rozejścia się plotki, zmiany opinii o osobach trzecich

### [x] J „cele dnia” — `src/agents/brain.ts`, `actions.ts`, `goals.ts` (nowy), `home.ts`, `needs.ts`, `src/ui/inspector.ts`, `tests/soak.test.ts`, `tests/sim.test.ts`, `tests/agents.test.ts`
- Rano każdy losuje cel/nastrój dnia (zależny od osobowości), który przesuwa wybory; cel widoczny w inspektorze; zdarzenie w logu przy realizacji
- Done: metryka w soak (cele realizowane w ≥ 60% dni)
- Wynik: 13 rodzajów celów, 82% dni z wykonanym celem, wybór zależny od osobowości
- Orkiestrator: drzemki tylko przy energii < 28 (57 → 20 drzemek / 72 dni postaci), id rozmów per świat (determinizm), brak zaczepiania w łazience

## Fala 5 — dynamika społeczna (3 agentów) — [x]
Przygotowanie [x]: stub `src/world/incidents.ts` (`tickIncidents`, `availability`) podpięty w `world.ts` i `brain.ts`.
### [x] L „relacje i grupy” — `src/agents/**` (bez `narration.ts`), `src/social/relationships.ts`, `conversation.ts`, `tests/agents|sim|soak|social.test.ts`
- Typy relacji z historią (przyjaźń, zauroczenie, rywalizacja), aktywności grupowe (wspólny obiad, grill 3–4 os., wieczór filmowy)
- Wynik: para w ~28% światów/tydzień, rywale w ~28%; 15–26 spotkań grupowych/tydzień; `relationOf`, `gatheringLog`; hooki relacji/spotkań w `world.ts`
### [x] M „zdarzenia świata” — `src/world/incidents.ts`, `src/world/world.ts`, `src/render/**`, `tests/incidents.test.ts`
- Pogoda (deszcz → ogród pustoszeje, render deszczu), awarie obiektów + naprawa, goście z zewnątrz
- Wynik: pogoda z planem dnia (osobny RNG z seeda), ~11 awarii/tydzień naprawianych przez mieszkańców (typ `repair_*`), deszcz/burza w renderze; goście pominięci (kolidują z niezmiennikami mieszkańców)
### [x] N „UI: zapis, statystyki” — `src/ui/**` (bez `llmToggle.*`), `src/main.ts`, `index.html`, `e2e/**`
- Zapis/odczyt (seed + tick, replay), wybór seeda, panel statystyk (sieć relacji, wykres nastroju), sekcja „Wspomnienia” w inspektorze
- Wynik: 💾/Z zapis (3 sloty + autozapis), N nowy świat, 📊/T statystyki, link `?seed&agents&tick&check`, `e2e/ui.spec.ts`

## Fala 6 — AI przez OpenRouter (wykonana przed 5, bo użytkownik dodał klucz) — [x]
- [x] K: proxy `server/llmProxy.ts` → OpenRouter (fetch, `models` fallback, JSON mode + tolerancyjny parser), tylko modele `:free`: `nvidia/nemotron-3.5-super-vl:free` → `google/gemma-4-31b-it:free` → `google/gemma-4-26b-a4b-it:free`; limity 15/min, 3 równolegle, budżet dzienny 180 (sync z `/api/v1/key`); plotki w promptach (indeks historii); usunięty `@anthropic-ai/sdk`
- Smoke test: 10 prawdziwych wywołań, 100% 200, 0,7–1,4 s, koszt $0
- [ ] Do poprawy: model czasem używa form z rodzajem („Słyszałeś?”), czasem zły ton dla wstydliwej historii

## Poprawka „chaos” (orkiestrator, po uwagach użytkownika) — [x]
- [x] Log aktywności `src/world/trace.ts` (decyzje z kandydatami, start/koniec akcji z powodem, zaproszenia, rozmowy); klawisz L = pobierz .txt, `window.__sim.trace()`
- [x] Narzędzia: `scripts/observe.mjs` (N minut w Chromium: zrzuty, FPS, log), `scripts/analyze-trace.mjs`, `tests/tools/trace.test.ts` (analiza headless)
- [x] Poprawki: min. 20 min użycia przed „zaspokojone”, cooldown powrotu do obiektu (45 min), rozmowa przy stole przedłuża pobyt i kończy się pożegnaniem, brak rozmów „przy okazji” tuż przed wyjściem, zajęci odmawiają z powodem, rozmowa na miejscu przy obiektach social, `canChat` uwzględnia rozmowy poboczne
- Wynik (15 min w przeglądarce, seed 42): urwane rozmowy 16/24 → 0/14, wstawanie zaraz po usiądnięciu 47 → 0, zmiany zdania 23 → 0; przeglądarka = headless (deterministycznie)
- [x] `tests/behaviour.test.ts` — regresja tych wzorców

## Fala 7 — świat zewnętrzny i domy (3 agentów) — [~] w toku
Przygotowanie [x]: rejestr domów `src/world/maps/index.ts` (`MAPS`, `getMap`, `bedCount`, `mapIdOf`), `WorldOptions.mapId`, `?map=`; stub `src/world/news.ts` (`tickNews`, `currentHeadline`, `newsFor`) + `ConversationContext.news?`; stub `src/realtime/realtime.ts` (`startRealtime`) + `?mode=real`.
### [ ] O „telewizja i wiadomości” — `server/newsProxy.ts`, `vite.config.ts`, `src/world/news.ts`, `src/render/**`, `src/social/dialogueProvider.ts`, `src/social/llmProvider.ts`, `server/llmProxy.ts`, `tests/news.test.ts`
- Prawdziwe nagłówki RSS przez proxy (cache, fallback), wiadomości z osiedla gdy brak sieci; ekran TV pokazuje nagłówek; oglądający rozmawiają o newsach
### [ ] P „tryb rzeczywisty” — `src/realtime/**`, `src/world/incidents.ts` (źródło pogody), `src/ui/hud.ts`, `tests/realtime.test.ts`
- Zegar = czas lokalny (1 min gry = 1 min), pogoda z Open-Meteo (lokalizacja z przeglądarki lub domyślna), blokada prędkości/replay
### [ ] Q „domy” — `src/world/maps/**`, `src/world/map.ts`, `src/world/world.ts`, `src/ui/newWorld.ts`, `src/ui/saves.ts`, `src/ui/savePanel.ts`, `tests/world.test.ts`, `tests/maps.test.ts`, `e2e/**`
- 2–3 nowe domy (np. kamienica, domek nad jeziorem, akademik), wybór domu i trybu rzeczywistego w oknie „Nowy świat”, `map`/`mode` w zapisach i linkach

## Pomysły na kolejne fale (backlog)
- [ ] Mniej bezcelowych spacerów (wander w `brain.ts`), testy `sim.test.ts` z koordynatami z mapy zamiast na sztywno
- [ ] Goście z zewnątrz (wymaga rozróżnienia mieszkaniec/gość w kontraktach)
- [ ] Narracja kłótni o pilota → bezpośrednio `recordQuarrel` zamiast wykrywania po tekście
- [ ] Wieczory filmowe rzadkie (wczesne zasypianie) — ewentualnie późniejsze pory snu w weekendy
- [ ] Prompt AI: unikać form z rodzajem („Słyszałeś?”), ton zgodny z walencją plotki
- [ ] Zapis/odczyt stanu (localStorage), wybór seeda w UI
- [ ] Ostrzeżenie Vite o imporcie `server/llmProxy` bez rozszerzenia (nieszkodliwe)
