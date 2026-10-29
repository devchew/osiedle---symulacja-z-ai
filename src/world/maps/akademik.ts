import type { Vec2 } from '../../types';
import { createBuilder, rect, type MapData } from './build';

export const AKADEMIK_WIDTH = 46;
export const AKADEMIK_HEIGHT = 31;

/*
 "Akademik" (46x31), generated dump. A student dorm: one long corridor; north side: four double
 rooms (washbasin in each), the shared bathroom (3 showers, 2 toilets) in the middle and a reading
 room; south side: shared kitchen with a long table, common room (TV, piano, books) and a gym
 with its own shower. A small yard with a grill, benches and flowerbeds; street on the north.
 Legend: # wall, D door, ' ' wood floor, . tile floor, , grass, : path, ~ water, @ spawn
 B bed, F fridge, S stove, T dining_table, = counter, H shower, U bathtub, W toilet, K sink,
 V tv, O sofa, R bookshelf, P piano, C computer, E exercise_bike, M treadmill, L bench,
 G grill, * flowerbed, f fishing_spot, Z wardrobe, p plant, l lamp, r rug, Y tree, b bush
 (regenerate: DUMP_MAPS=1 npx vitest run tests/maps.test.ts -> test-results/maps.txt)

 ,,,,,,,,Y,,,,,,,,,,,Y,,,,,,,,,,,Y,,,,,,,,Y,,,,
 ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
 ::::::::::::::::::::::::::::::::::::::::::::::
 ,:,########################################,:,
 ,:,#Bl CC#Bl RR#HHH.WW.#Bl CC#Bl RR#CClRR #,:,
 ,:,#B    #B    #.......#B    #B    #      #,:,
 Y:,# rrr # rrr #.......# rrr # rrr # rrr  #,:,
 ,:,#BrrrK#BrrrK#......K#BrrrK#BrrrK# rrr  #,:,
 ,:,#B   p#B   p#p.....K#B   p#B   p#     p#,:,
 ,:,###D#####D######D######D#####D#####D####,:,
 ,:,# p @       p        @  p       p     pD::,
 ,::D     l   @      l         @  l     @  #,:,
 ,:,#######D###########D##D###########D#####,:,
 ,:,#FFSS==.SS=.p# VVV  RR  PPRR#MMEE   HZZ#,:,
 ,:b#............# rrr          #MM        #,:Y
 ,:,#........@...# rrr          #          #,:,
 ,:,#..TTTTTT....#lOOO   rrr    #          #b:,
 ,:,#..TTTTTT....#       rrr    # r@r      #,:,
 Y:,#............#     @ OOO    # rrr      #,:,
 ,:,#l..........p#p            p#         p#,:,
 ,:,###########D########D############D######,:,
 ,:,,,,,,,,,,,,:,,,,,,,,:,,,,,,,,,,,,,,,,,,,,:,
 ,:,b,,,,,,,GG,:,LL,,,b,:,,b,LL,,,,,,,,LL,,b,:Y
 ,:,,,,,,,,,,,,:,,,,,,,,@,,,,,,,,,,,,,,,,,,,,:,
 ,:,,,,,,,,,,,,:,,,,,,,,:,,,,,,,,,,,,,,,,,,,,:,
 ,::::::::::::::::::::::::::::::::@:::::::::::,
 ,,,,,,,,LL,,,,,,,,,,,,,:,,,,,,,,,,,,,,,,,,,,,,
 ,,,,,,,,,,,,,,,,,,***,,:,,,,,,***,,,,,,,,,,,,,
 ,,,,Y,,,,,,,,,,,,,,,,,,:,,,,,,,,,,,,,,,,,,Y,,,
 ,,,,,,b,,,,,Y,,,,,,,,,,:,,,Y,,,,,,,Y,,,b,,,,,,
 ,,,,,,,,,,,,,,,,,,,,,,,:,,,,,,,,,,,,,,,,,,,,,,
*/

export function createAkademikMap(): MapData {
  const b = createBuilder(AKADEMIK_WIDTH, AKADEMIK_HEIGHT, 'grass');
  const { grid: g, objects, fill, hLine, vLine, door, put, room } = b;

  // ---------------------------------------------------------------- ground
  hLine(2, 0, 45, 'path'); // street-side pavement
  vLine(23, 21, 30, 'path'); // main entrance -> yard
  hLine(25, 6, 40, 'path'); // yard walk
  vLine(1, 2, 25, 'path'); // around the west side
  hLine(11, 1, 2, 'path'); // west corridor door
  vLine(44, 2, 25, 'path'); // around the east side
  hLine(10, 43, 43, 'path'); // east corridor door
  hLine(25, 1, 5, 'path');
  hLine(25, 41, 44, 'path');
  vLine(14, 21, 24, 'path'); // kitchen back door

  // ---------------------------------------------------------------- building shell x3..42, y3..20
  fill(rect(3, 3, 40, 18), 'wall');
  // north row: four double rooms, a bathroom and a reading room (y4..8)
  // the bathroom sits in the middle of the corridor, between the rooms
  const dorms: [string, number][] = [['Pokój 1', 4], ['Pokój 2', 10], ['Pokój 3', 24], ['Pokój 4', 30]];
  const BX = 16;
  dorms.forEach(([name, x], i) => room(`room${i + 1}`, name, rect(x, 4, 5, 5)));
  room('bathroom', 'Łazienka', rect(BX, 4, 7, 5), 'tile');
  room('reading', 'Czytelnia', rect(36, 4, 6, 5));
  room('corridor', 'Korytarz', rect(4, 10, 38, 2));
  // south row (y13..19)
  room('kitchen', 'Kuchnia', rect(4, 13, 12, 7), 'tile');
  room('common', 'Świetlica', rect(17, 13, 14, 7));
  room('gym', 'Siłownia', rect(32, 13, 10, 7));

  for (const [, x] of dorms) door(x + 2, 9);
  door(BX + 3, 9); // bathroom
  door(38, 9); // reading room
  door(10, 12); // kitchen
  door(22, 12); door(25, 12); // common room (double)
  door(37, 12); // gym
  door(3, 11); // west end of the corridor
  door(42, 10); // east end
  door(23, 20); // main entrance (common room)
  door(14, 20); // kitchen -> yard
  door(36, 20); // gym -> yard

  g.rooms.push(
    { id: 'yard', name: 'Podwórko', rect: rect(3, 21, 40, 10) },
    { id: 'street', name: 'Ulica', rect: rect(0, 0, 46, 3) },
  );

  // ---------------------------------------------------------------- dorm rooms
  // two beds against the west wall (one above the other), a desk by the north wall;
  // beds are assigned in this order, so housemates share rooms pairwise
  dorms.forEach(([, x], i) => {
    put('bed', x, 4);
    put('bed', x, 7);
    put('lamp', x + 1, 4);
    put(i % 2 === 0 ? 'computer' : 'bookshelf', x + 3, 4);
    put('rug', x + 1, 6);
    put('sink', x + 4, 7); // every room has its own washbasin
    put('plant', x + 4, 8);
  });

  // bathroom: three showers, two toilets, two sinks
  put('shower', BX, 4);
  put('shower', BX + 1, 4);
  put('shower', BX + 2, 4);
  put('toilet', BX + 4, 4);
  put('toilet', BX + 5, 4);
  put('sink', BX + 6, 7);
  put('sink', BX + 6, 8);
  put('plant', BX, 8);

  // reading room
  put('computer', 36, 4);
  put('lamp', 38, 4);
  put('bookshelf', 39, 4);
  put('plant', 41, 8);
  put('rug', 37, 6);

  // corridor
  for (const x of [5, 15, 27, 35, 41]) put('plant', x, 10);
  for (const x of [9, 20, 33]) put('lamp', x, 11);

  // kitchen: two fridges, two stoves, one long table (two tables end to end)
  put('fridge', 4, 13);
  put('fridge', 5, 13);
  put('stove', 6, 13);
  put('counter', 8, 13);
  put('counter', 9, 13);
  put('stove', 11, 13);
  put('counter', 13, 13);
  put('plant', 15, 13);
  put('dining_table', 6, 16);
  put('dining_table', 9, 16);
  put('lamp', 4, 19);
  put('plant', 15, 19);

  // common room: TV corner, piano, bookshelf
  put('tv', 18, 13);
  put('rug', 18, 14);
  put('sofa', 18, 16);
  put('lamp', 17, 16);
  put('bookshelf', 23, 13);
  put('piano', 27, 13);
  put('bookshelf', 29, 13);
  put('rug', 24, 16);
  put('sofa', 24, 18);
  put('plant', 17, 19);
  put('plant', 30, 19);

  // gym
  put('treadmill', 32, 13);
  put('treadmill', 33, 13);
  put('rug', 33, 17);
  put('exercise_bike', 34, 13);
  put('exercise_bike', 35, 13);
  put('shower', 39, 13); // changing room shower
  put('wardrobe', 40, 13);
  put('plant', 41, 19);

  // ---------------------------------------------------------------- yard
  put('grill', 11, 22);
  put('bench', 8, 26);
  put('bench', 16, 22);
  put('bench', 28, 22);
  put('flowerbed', 30, 27);
  put('flowerbed', 18, 27);
  put('bench', 38, 22);
  const trees: [number, number][] = [
    [4, 28], [12, 29], [27, 29], [35, 29], [42, 28], [0, 6], [0, 18], [45, 14], [45, 22], [8, 0], [20, 0], [32, 0], [41, 0],
  ];
  for (const [x, y] of trees) put('tree', x, y);
  const bushes: [number, number][] = [[3, 22], [42, 22], [21, 22], [26, 22], [6, 29], [39, 29], [2, 14], [43, 16]];
  for (const [x, y] of bushes) put('bush', x, y);

  // games in the common room (joint activities): console under the south wall, a card table
  put('console', 19, 19);
  put('board_game_table', 28, 16);

  const spawnPoints: Vec2[] = [
    { x: 7, y: 10 }, { x: 13, y: 11 }, { x: 24, y: 10 }, { x: 30, y: 11 }, { x: 39, y: 11 },
    { x: 22, y: 18 }, { x: 12, y: 15 }, { x: 34, y: 17 }, { x: 23, y: 23 }, { x: 33, y: 25 },
  ];
  return { grid: g, objects, spawnPoints };
}
