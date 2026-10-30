import type { Vec2 } from '../../types';
import { setTile, tileAt } from '../grid';
import { createBuilder, rect, type MapData } from './build';

export const JEZIORO_WIDTH = 54;
export const JEZIORO_HEIGHT = 32;

/*
 "Domek nad jeziorem" (54x32), generated dump. A compact wooden cabin (two bedrooms, 4 beds, one
 bathroom, a big main room with the kitchen, table, TV and books) in a forest clearing, a porch with
 a pier into a big lake, fishing spots all around the shore, a campfire (grill) ringed by benches
 on the meadow and a vegetable patch behind the cabin. Few indoor toys, lots to do outside.
 Legend: # wall, D door, ' ' wood floor, . tile floor, , grass, : path, ~ water, @ spawn
 B bed, F fridge, S stove, T dining_table, = counter, H shower, U bathtub, W toilet, K sink,
 V tv, O sofa, R bookshelf, P piano, C computer, E exercise_bike, M treadmill, L bench,
 G grill, * flowerbed, f fishing_spot, Z wardrobe, p plant, l lamp, r rug, Y tree, b bush,
 m pet_bowl, c pet_cushion, y pet_toy, w dog_walk
 (regenerate: DUMP_MAPS=1 npx vitest run tests/maps.test.ts -> test-results/maps.txt)

 ,,,,,,,,Y,,,,,,,,Y,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
 ,Y,,Y,,,,,,,Y,,,,,,,,,,,,Y,,,,,,,Y,,,,,,,,,,,,,,,,,,,,
 ,,,,,,,,,,,,,,,,,,,,,Y,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
 ,,,,,,,,***,,***,,,,,,,,,,,,,,,,,,,,,,,~~~~,f,,,,,,,,Y
 ,,,Y,,,,,,,,,,,,,,,b,,,,,,Y,,,,,,,,,,~~~~~~~~,,,,,,,,,
 ,,,,,,,,,,,,,,@,,,,,,,,,,,,,,,,,,,f~~~~~~~~~~~,,,,,,,,
 ,,,,,,#################,,,,,,,,,,f~~~~~~~~~~~~~~,,,,,,
 ,,,b,,#BlBZZ#H.W#BlBZZ#,Y,,,,,,,,~~~~~~~~~~~~~~~~,,,,,
 Y,,,,Y#B B  #...#B B  #,,,,,,,,,~~~~~~~~~~~~~~~~~,,,,,
 ,,,,,,#rrr  #..K# rrr #,,,,,,,,,~~~~~~~~~~~~~~~~~~,,,,
 ,,,,,,#rrr  #...# rrr #,,,,,,,,,~~~~~~~~~~~~~~~~~~~,,,
 ,,Y,,,####D###D####D###,LL,,,,,~~~~~~~~~~~~~~~~~~~~f,,
 ,,,,,,#FSS =   VVV  RR#:::,,,,~~~~~~~~~~~~~~~~~~~~~~,,
 ,,,,,,#  m     rrr    #:::,,,,~~~~~~~~~~~~~~~~~~~~~~~,
 ,,,,Y,#     @  rrr    D:::,,,~~:f~~~~~~~~~~~~~~~~~~~~,
 ,,,,,,#  TTT   OOO    D:::::::@:f~~~~~~~~~~~~~~~~~~~~~
 ,,::::D  TTT y     g  #:@:,,,~~~~~~~~~~~~~~~~~~~~~~~~~
 ,Y,,,,#      @    @ c #:::,,,~~~~~~~~~~~~~~~~~~~~~~~~~
 ,,,,,,#l        XXp  l#,:,,,,~~~~~~~~~~~~~~~~~~~~~~~~,
 ,,,,,b########D########,:,b,,,~~~~~~~~~~~~~~~~~~~~~~~,
 ,,,Y,,,,,,,,,,:,,,,,,,,,:,,,,,~~~~~~~~~~~~~~~~~~~~~~,Y
 ,,,,,,,,,b,,,,:,,,,,,,,,:,,,,,,~~~~~~~~~~~~~~~~~~~~,,,
 ,,,,,,,,,,,,,,::::::::@::,,,,,,,~~~~~~~~~~~~~~~~~~,,,,
 Y,,,,,,,,,,Y,,,,,LL,,,,,Y,,,,,,,f~~~~~~~~~~~~~~~~,,,,,
 ,,,,,Y,,,,,,,,,,,,,,,,,,,,,,,,,,f~~~~~~~~~~~~~~~,,,,,,
 ,,,,,,,,,,,,,LL,,GG,@LL,,,,,,,,,,,~~~~~~~~~~~~~,,,,,,,
 ,,,,,,,,,,@,,,,,,,,,,,,,,,,,,,,,,,,,~~~~~~~~~~,,,,,,,,
 ,,Y,,,,,,,b,,,,@,,,,,,,,,,,,,,,,,,,,,~~~~~~~~,,,,,,,,,
 ,,,,,,,,,,,,,,,,,LL,,,,,,,,Y,,,,,,,,,,f~~~~,,,,,,,,,,,
 ,,,,,,,,Y,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,w,,,,,,,,,,,Y,
 ,Y,,,Y,,,,,,,Y,,,,,,Y,,,,,,,,Y,,,,,,,,,,,,,,,Y,,,,,,,,
 ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,Y,,,,
*/

/** lake outline: a wobbly ellipse (deterministic, no RNG) */
function inLake(x: number, y: number): boolean {
  const cx = 40.5;
  const cy = 15.5;
  const wobble = 1.2 * Math.sin(y * 0.45 + 0.5) + 0.8 * Math.cos(x * 0.35 + 1);
  const dx = (x - cx) / (11 + wobble);
  const dy = (y - cy) / (12.5 + 0.6 * Math.sin(x * 0.5));
  return dx * dx + dy * dy <= 1;
}

export function createJezioroMap(): MapData {
  const b = createBuilder(JEZIORO_WIDTH, JEZIORO_HEIGHT, 'grass');
  const { grid: g, objects, fill, hLine, vLine, door, put, room } = b;

  // ---------------------------------------------------------------- lake and shore
  for (let y = 0; y < JEZIORO_HEIGHT; y++) for (let x = 0; x < JEZIORO_WIDTH; x++) if (inLake(x, y)) setTile(g, x, y, 'water');
  // pier: a boardwalk from the porch path four tiles into the lake
  let shoreX = 26;
  while (tileAt(g, shoreX, 15) !== 'water') shoreX++;
  const pierEnd = shoreX + 3;
  hLine(15, 26, pierEnd, 'path');
  // a wider pier head, so two or three can fish side by side
  hLine(14, pierEnd - 1, pierEnd, 'path');
  // paths: cabin porch -> pier, -> campfire, -> forest
  fill(rect(23, 12, 3, 6), 'path'); // porch
  vLine(14, 20, 22, 'path'); // front door -> campfire
  vLine(24, 18, 22, 'path'); // porch -> campfire
  hLine(22, 15, 23, 'path');
  hLine(16, 2, 5, 'path'); // back door -> forest

  // ---------------------------------------------------------------- cabin x6..22, y6..19
  fill(rect(6, 6, 17, 14), 'wall');
  room('bedroom1', 'Sypialnia', rect(7, 7, 5, 4));
  room('bathroom', 'Łazienka', rect(13, 7, 3, 4), 'tile');
  room('bedroom2', 'Pokój z antresolą', rect(17, 7, 5, 4));
  room('main', 'Izba', rect(7, 12, 15, 7));
  door(10, 11);
  door(14, 11);
  door(19, 11);
  door(22, 14); door(22, 15); // to the porch
  door(14, 19); // front door
  door(6, 16); // back door to the forest

  g.rooms.push(
    { id: 'porch', name: 'Weranda', rect: rect(23, 12, 3, 6) },
    { id: 'lake', name: 'Jezioro', rect: rect(28, 2, 26, 28) },
    { id: 'forest', name: 'Las', rect: rect(0, 0, 6, 32) },
    { id: 'meadow', name: 'Polana', rect: rect(6, 20, 22, 12) },
  );

  // ---------------------------------------------------------------- bedrooms (beds first: pairs share a room)
  for (const x of [7, 17]) {
    put('bed', x, 7);
    put('bed', x + 2, 7);
    put('lamp', x + 1, 7);
    put('wardrobe', x + 3, 7);
  }
  put('rug', 7, 9);
  put('rug', 18, 9);

  // bathroom
  put('shower', 13, 7);
  put('toilet', 15, 7);
  put('sink', 15, 9);

  // main room: kitchen corner, table, TV and books by the fire
  put('fridge', 7, 12);
  put('stove', 8, 12);
  put('counter', 11, 12);
  put('dining_table', 9, 15);
  put('tv', 15, 12);
  put('rug', 15, 13);
  put('sofa', 15, 15);
  put('bookshelf', 20, 12);
  put('lamp', 7, 18);
  put('lamp', 21, 18);
  put('plant', 18, 18);

  // ---------------------------------------------------------------- outdoors
  // fishing spots along the shore and at the end of the pier
  const shore = shoreSpots(g, [[pierEnd, 15], [31, 6], [30, 24], [38, 29], [44, 2], [51, 12]]);
  for (const [x, y] of shore) put('fishing_spot', x, y);
  // campfire with benches around it
  put('grill', 17, 25);
  put('bench', 17, 23);
  put('bench', 13, 25);
  put('bench', 21, 25);
  put('bench', 17, 28);
  // porch bench overlooking the lake
  put('bench', 24, 11);
  // vegetable / flower patch behind the cabin
  put('flowerbed', 8, 3);
  put('flowerbed', 13, 3);
  // forest
  const trees: [number, number][] = [
    [1, 1], [3, 4], [0, 8], [2, 11], [4, 14], [1, 17], [3, 20], [0, 23], [2, 27], [5, 30], [4, 1], [8, 0], [12, 1], [17, 0],
    [21, 2], [25, 1], [24, 7], [26, 4], [8, 29], [11, 23], [24, 23], [27, 28], [20, 30], [13, 30], [5, 24], [5, 8], [1, 30],
    // far shore
    [52, 29], [49, 31], [53, 3], [33, 1], [29, 30], [53, 20], [45, 30],
  ];
  for (const [x, y] of trees) if (tileAt(g, x, y) === 'grass') put('tree', x, y);
  const bushes: [number, number][] = [[5, 19], [26, 19], [9, 21], [19, 4], [3, 7], [10, 27]];
  for (const [x, y] of bushes) put('bush', x, y);

  // games (joint activities): a console by the south wall of the main room, a card table,
  // and fishing spots next to the pier end and two shore spots (fishing side by side)
  put('console', 16, 18);
  put('board_game_table', 19, 16);
  const taken = new Set(shore.map(([x, y]) => `${x},${y}`));
  put('fishing_spot', pierEnd, 14);
  taken.add(`${pierEnd},14`);
  for (const [x, y] of [shore[1], shore[2]]) {
    const n = besideSpot(g, x, y, taken);
    if (n) {
      put('fishing_spot', n[0], n[1]);
      taken.add(`${n[0]},${n[1]}`);
    }
  }

  const spawnPoints: Vec2[] = [
    { x: 12, y: 14 }, { x: 18, y: 17 }, { x: 13, y: 17 }, { x: 24, y: 16 }, { x: 30, y: 15 },
    { x: 15, y: 27 }, { x: 22, y: 22 }, { x: 10, y: 26 }, { x: 14, y: 5 }, { x: 20, y: 25 },
  ];
  // house pet (dog: bowl by the kitchen, cushion and toys in the main room, walks across the meadow to the south shore); placed last so the uids of older objects stay the same
  put('pet_bowl', 9, 13);
  put('pet_cushion', 20, 17);
  put('pet_toy', 13, 16);
  put('dog_walk', 40, 29);

  return { grid: g, objects, spawnPoints, pet: { species: 'dog', name: 'Azor' } };
}

/** a free shore tile (grass / path next to water) 1–2 tiles from (x, y), not one of `taken` */
function besideSpot(g: ReturnType<typeof createBuilder>['grid'], x: number, y: number, taken: Set<string>): [number, number] | null {
  for (const r of [1, 2])
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        const k = tileAt(g, nx, ny);
        if ((k !== 'grass' && k !== 'path') || taken.has(`${nx},${ny}`) || g.solid[ny * g.width + nx]) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, ay]) => tileAt(g, nx + ax, ny + ay) === 'water')) return [nx, ny];
      }
  return null;
}

/** for each wish, the nearest grass/path tile next to water (keeps spots on the real shore) */
function shoreSpots(g: ReturnType<typeof createBuilder>['grid'], wishes: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [wx, wy] of wishes) {
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++) {
        const k = tileAt(g, x, y);
        if (k !== 'grass' && k !== 'path') continue;
        const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tileAt(g, x + dx, y + dy) === 'water');
        if (!wet) continue;
        const d = Math.abs(x - wx) + Math.abs(y - wy);
        if (!best || d < best.d) best = { x, y, d };
      }
    if (best) out.push([best.x, best.y]);
  }
  return out;
}
