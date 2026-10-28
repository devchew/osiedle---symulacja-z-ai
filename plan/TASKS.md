# Taski

Legenda: `[ ]` do zrobienia · `[~]` w toku · `[x]` zrobione. Aktualizuje orkiestrator po weryfikacji fali.
Każdy task posiada wyłącznie wymienione pliki. Kontrakty: `src/types.ts`.

## Fala 0 — fundament (orkiestrator)
- [x] Scaffold: Vite + TS + Vitest + Playwright (`package.json`, `tsconfig.json`, `vite.config.ts`, `playwright.config.ts`)
- [x] Kontrakty `src/types.ts`
- [x] `src/core/rng.ts`, `src/core/time.ts`, `src/core/loop.ts` + `tests/core.test.ts`
- [x] `plan/`, `CLAUDE.md`, branch `feat/simulation`

## Fala 1 — moduły równolegle (4 agentów)

### [ ] A „world” — `src/world/grid.ts`, `src/world/objects.ts`, `src/world/map.ts`, `tests/world.test.ts`
API:
- `grid.ts`: `createGrid(w, h, fill: TileKind): Grid`, `inBounds(g, x, y)`, `isWalkable(g, x, y)`, `setTile(g, x, y, kind)` (aktualizuje `solid`), `markSolid(g, x, y, solid)`, `roomAt(g, x, y): Room | null`, `randomWalkableTile(g, rng, area?: RectArea): Vec2`
- `objects.ts`: `OBJECT_DEFS: Record<string, ObjectDef>` (~14 aktywności + dekoracje bez slotów), `slotStandTile(obj, def, i): Vec2`, `slotUsePos(obj, def, i): Vec2`, `objectCenter(obj, def): Vec2`
- `map.ts`: `createDefaultMap(): { grid: Grid; objects: ObjectInstance[]; spawnPoints: Vec2[] }` — deterministyczna; dom (kuchnia, salon, ≥3 sypialnie, łazienka) + ogród; łóżek ≥ 6
- Done: testy — każdy slot `stand` jest walkable i osiągalny (BFS) ze spawnów; brak nakładania footprintów; `solid` zgodne z kaflami i obiektami

### [ ] B „agents” — `src/agents/agent.ts`, `src/agents/needs.ts`, `src/agents/pathfinding.ts`, `src/agents/movement.ts`, `tests/agents.test.ts`
API:
- `agent.ts`: `AGENT_NAMES`, `createAgent(id, name, pos, rng): Agent`, `createAgents(count, spawnPoints, rng): Agent[]`
- `needs.ts`: `decayNeeds(agent, ctx: { sleeping: boolean; hour: number }): void` (zależne od cech), `applyEffects(agent, effects, scale = 1)`, `computeMood(needs, traits): number`, `urgency(value): number` (0..1, wypukła), `lowestNeed(needs): NeedKey`
- `pathfinding.ts`: `findPath(grid, from, to, opts?: { extraBlocked?: (x, y) => boolean; maxNodes?: number }): Vec2[] | null` (A*, 8 kierunków bez ścinania rogów, binary heap; wynik bez startu, z celem; `[]` gdy start = cel), `nearestWalkable(grid, p): Vec2 | null`
- `movement.ts`: `WALK_SPEED`, `stepAgent(agent, speed = WALK_SPEED): 'moving' | 'arrived' | 'idle'` (nie rusza `prevPos` — robi to world tick)
- Done: testy A* (ściany, brak ścieżki, rogi), potrzeby, ruch

### [ ] C „render” — `src/render/*`, `render-demo.html`
API: `createRenderer(canvas, world): Renderer` z `render(alpha)`, `resize()`, `pickAgent(clientX, clientY): Agent | null`, `setSelected(id | null)`, `follow(id | null)`; kamera: drag = pan, kółko = zoom, start = dopasowanie do mapy
- Rysuje: kafle, ściany, nazwy pokoi, obiekty (proceduralnie per typ + fallback), postacie (interpolacja `prevPos→pos`, chód, imię), dymki mowy/myśli, ikonę akcji, zaznaczenie, oświetlenie dzień/noc
- Done: `render-demo.html` z mock-światem; zrzut z Playwright obejrzany

### [ ] D „social + ui” — `src/social/*`, `src/ui/*`, `tests/social.test.ts`
API:
- `relationships.ts`: `createRelationships(): Relationships`, `relationshipLabel(v): string`
- `conversation.ts`: `TOPICS`, `startConversation(id, a, b, tick, rng): Conversation`, `willAcceptChat(target, initiator, relationship, rng): boolean`, `conversationDelta(a, b, lines): number`, `describeConversation(a, b, conv, delta): string`
- `dialogueProvider.ts`: `createProceduralProvider(): DialogueProvider` (PL, zależnie od tematu, nastroju, cech, relacji, tury; synchronicznie)
- `ui/hud.ts`: `createHud(root, controls, world): { update() }` — zegar, dzień, pora, pauza, prędkości 1/2/4/8, skróty klawiszowe
- `ui/inspector.ts`: `createInspector(root, world, opts: { onClose(): void }): { show(id | null); update() }`
- `ui/eventLog.ts`: `createEventLog(root, world): { update() }`; `ui/ui.css`
- Done: testy social; UI kompiluje się (`tsc`)

## Fala 2 — integracja (orkiestrator)
- [ ] `src/agents/brain.ts` — utility AI (obiekty + rozmowy + wander/idle), top-3 ważone
- [ ] `src/agents/actions.ts` — maszyna stanów, rezerwacje slotów, rozmowy, dymki
- [ ] `src/world/world.ts` — `createWorld(seed, opts)`, `tickWorld(world)`
- [ ] `src/main.ts` — pętla, renderer, UI, `window.__sim` (debug/testy)
- [ ] `e2e/sim.spec.ts` — canvas niepusty, ruch postaci, inspektor, pauza/prędkość, zrzuty dzień/noc

## Fala 3 — dopracowanie (3 agentów)
- [ ] E „balans/soak”: `tests/soak.test.ts` 7 dni × 6 postaci, strojenie
- [ ] F „polish wizualny”: animacje, czytelność, responsywność
- [ ] G „LLM”: `LlmProvider` + proxy Vite middleware (`.env`, `claude-haiku-5-5`, timeout, fallback), przełącznik w UI
