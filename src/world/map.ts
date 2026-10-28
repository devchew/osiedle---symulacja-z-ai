import type { Grid, ObjectInstance, RectArea, TileKind, Vec2 } from '../types';
import { createGrid, markSolid, setTile } from './grid';
import { OBJECT_DEFS, footprint } from './objects';

export const MAP_WIDTH = 44;
export const MAP_HEIGHT = 29;

/*
 Default map (44x29), generated dump. Compact house x13..28 y5..22 with a hobby wing (x7..13 y10..17):
 bedrooms + bathrooms (north y6..9, south y18..21) open straight onto the living/kitchen hub (y11..16);
 every bedroom also has a garden door, the kitchen opens onto the terrace, grill and pond (east),
 the hobby room onto the orchard (west). Walking per resident went from ~6 h to ~4.8 h per game day.
 Legend: # wall, D door, ' ' wood floor, . tile floor, , grass, : path, ~ water, @ spawn
 B bed, F fridge, S stove, T dining_table, = counter, H shower, U bathtub, W toilet, K sink,
 V tv, O sofa, R bookshelf, P piano, C computer, E exercise_bike, M treadmill, L bench,
 G grill, * flowerbed, f fishing_spot, Z wardrobe, p plant, l lamp, r rug, Y tree, b bush

 ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
 ,,,,,,,,,,,,,,,,,,,,,,Y,,,,,,,,,,,,,,,,,,,,,
 ,,,,,Y,,,,Y,,,,,Y,,,,,,,,,,,,,,,,,,,,,,,,,,,
 ,Y,,,,,,,,,,,,,,,,,,,,,,,,,Y,,,,,,,,,,,,,Y,,
 ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,Y,,,,,,,,,
 ,,,,,,,,,,,,,################,,,,,,,,,,,,,,,
 ,,,,,,,,,,,,b#BlBp#HUUW#BlBp#b,,,,,,,,,,,,,,
 ,,,,,,b,,LL,,#B B #....#B B #,,,,,,b,,,,,,,,
 ,,,,,,,,,,,,,Drrr #...K# rrrD,,,,,,,,,,,,,,,
 ,,Y,,,,,,,,,,#rrr #...p# rrr#,,,,,,,,,,,,,,,
 ,,,,,,,##########D#D####D####GG,,LL,,,,,,,Y,
 ,,,,,,,#ME CC#VVV l FSSF.RRp#,,,,,,,,,,,,,,,
 ,,,,,GG#M    #r@r   ........#::,,~~~,,,,,,,,
 ,,,,,,,# r@r Drrr @ .....@..D:@,~~~~~,,b,,,,
 ,,,,@::D rrr #OOO   TTT@....D::f~~~~~f,,,,,,
 ,,,,:,,#PP RR#    @ TTT...@.#::,~~~~~,,,,,,,
 ,,,,:,,#     #p   l .......l#,:,,~~~,,,,,,,,
 ,***:,,##########D#D####D####LL,,,f,,,,,,,,,
 ,,,,:,,,,,,,,#rrr #.HUU# rrr#,:,,,,,,,,,Y,,,
 ,,,,:,,,,,,,,Drrrp#....#prrrD,:,,,,@,,,,,,,,
 ,,,,:,b,Y,,,,#BlB #W..K#BlB #,:***,,,,,,,,,,
 ,,,,:,,,,,,,b#B B #...p#B B #b:,,,,,,,,,,,,,
 ,Y,,:,,,,,,,,################,:,,,,,,,,,,,,,
 ,,,,:,,,,,,,,,,,b,,,,,,,,b,,,,:,,,,,,,,,,,,Y
 ,,,,:::::::::::::::::::::::::::,,,,,,,,,,,,,
 ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
 ,,,,,,,,,,,,,,,,,Y,,,,,,,,,,,,,,,,,,,Y,,,,,,
 ,,,Y,,,,,,Y,,,,,,,,,,,,,Y,,,,,,Y,,,,,,,,,,,,
 ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
*/

const rect = (x: number, y: number, w: number, h: number): RectArea => ({ x, y, w, h });

export function createDefaultMap(): { grid: Grid; objects: ObjectInstance[]; spawnPoints: Vec2[] } {
  const g = createGrid(MAP_WIDTH, MAP_HEIGHT, 'grass');
  const fill = (r: RectArea, kind: TileKind) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setTile(g, x, y, kind);
  };
  const hLine = (y: number, x0: number, x1: number, kind: TileKind = 'wall') => fill(rect(x0, y, x1 - x0 + 1, 1), kind);
  const vLine = (x: number, y0: number, y1: number, kind: TileKind = 'wall') => fill(rect(x, y0, 1, y1 - y0 + 1), kind);
  const door = (x: number, y: number) => setTile(g, x, y, 'door');

  // ---------------------------------------------------------------- garden ground
  fill(rect(29, 12, 2, 4), 'path'); // terrace in front of the kitchen doors
  vLine(30, 16, 24, 'path'); // around the house
  hLine(24, 4, 30, 'path');
  vLine(4, 15, 23, 'path');
  hLine(14, 4, 6, 'path'); // hobby room door
  // pond with rounded corners
  fill(rect(32, 12, 5, 5), 'water');
  for (const [x, y] of [[32, 12], [36, 12], [32, 16], [36, 16]]) setTile(g, x, y, 'grass');

  // ---------------------------------------------------------------- house shell
  // Compact house: bedrooms and bathrooms (north y6..9, south y18..21) open straight
  // onto the living/kitchen hub (y11..16); the hobby room is a west wing. Every bedroom
  // also has a door to the garden, the kitchen opens onto the terrace and the pond.
  fill(rect(13, 5, 16, 18), 'wall');
  fill(rect(7, 10, 7, 8), 'wall');
  const rooms: { id: string; name: string; r: RectArea; floor: TileKind }[] = [
    { id: 'bedroom1', name: 'Sypialnia 1', r: rect(14, 6, 4, 4), floor: 'floor' },
    { id: 'bathroom', name: 'Łazienka', r: rect(19, 6, 4, 4), floor: 'tile' },
    { id: 'bedroom2', name: 'Sypialnia 2', r: rect(24, 6, 4, 4), floor: 'floor' },
    { id: 'hobby', name: 'Pokój hobby', r: rect(8, 11, 5, 6), floor: 'floor' },
    { id: 'living', name: 'Salon', r: rect(14, 11, 6, 6), floor: 'floor' },
    { id: 'kitchen', name: 'Kuchnia', r: rect(20, 11, 8, 6), floor: 'tile' },
    { id: 'bedroom3', name: 'Sypialnia 3', r: rect(14, 18, 4, 4), floor: 'floor' },
    { id: 'bathroom2', name: 'Mała łazienka', r: rect(19, 18, 4, 4), floor: 'tile' },
    { id: 'bedroom4', name: 'Sypialnia 4', r: rect(24, 18, 4, 4), floor: 'floor' },
  ];
  for (const room of rooms) fill(room.r, room.floor);
  // the hub is one open space: no wall between the living room and the kitchen
  [[17, 10], [19, 10], [24, 10]].forEach(([x, y]) => door(x, y)); // north rooms -> hub
  [[17, 17], [19, 17], [24, 17]].forEach(([x, y]) => door(x, y)); // south rooms -> hub
  door(13, 13); // hub -> hobby room
  door(28, 13); door(28, 14); // kitchen -> terrace
  door(7, 14); // hobby room -> orchard
  [[13, 8], [28, 8], [13, 19], [28, 19]].forEach(([x, y]) => door(x, y)); // bedroom garden doors

  g.rooms = [
    ...rooms.map(({ id, name, r }) => ({ id, name, rect: r })),
    { id: 'orchard', name: 'Sad', rect: rect(0, 0, 7, 29) },
    { id: 'garden', name: 'Ogród', rect: rect(29, 0, 15, 29) },
    { id: 'yard', name: 'Przed domem', rect: rect(7, 23, 22, 6) },
  ];

  // ---------------------------------------------------------------- objects
  const objects: ObjectInstance[] = [];
  const put = (type: string, x: number, y: number) => {
    const def = OBJECT_DEFS[type];
    const obj: ObjectInstance = { uid: objects.length + 1, type, pos: { x, y }, reservedBy: def.slots.map(() => null) };
    objects.push(obj);
    if (def.blocking) for (const p of footprint(obj, def)) markSolid(g, p.x, p.y, true);
  };

  // bedrooms: two single beds each (beds are assigned in this order, pairs share a room);
  // north ones along the north wall, south ones along the south wall
  for (const [x, y] of [[14, 6], [24, 6], [14, 20], [24, 20]]) {
    put('bed', x, y);
    put('bed', x + 2, y);
    put('lamp', x + 1, y);
  }
  put('rug', 14, 8);
  put('plant', 17, 6);
  put('rug', 25, 8);
  put('plant', 27, 6);
  put('rug', 14, 18);
  put('plant', 17, 19);
  put('rug', 25, 18);
  put('plant', 24, 19);

  // bathroom
  put('shower', 19, 6);
  put('bathtub', 20, 6);
  put('toilet', 22, 6);
  put('sink', 22, 8);
  put('plant', 22, 9);
  // small bathroom
  put('shower', 20, 18);
  put('bathtub', 21, 18);
  put('toilet', 19, 20);
  put('sink', 22, 20);
  put('plant', 22, 21);

  // hobby room
  put('treadmill', 8, 11);
  put('exercise_bike', 9, 11);
  put('computer', 11, 11);
  put('piano', 8, 15);
  put('bookshelf', 11, 15);
  put('rug', 9, 13);

  // living room
  put('tv', 14, 11);
  put('rug', 14, 12);
  put('sofa', 14, 14);
  put('lamp', 18, 11);
  put('plant', 14, 16);
  put('lamp', 18, 16);

  // kitchen
  put('fridge', 20, 11);
  put('stove', 21, 11);
  put('fridge', 23, 11);
  put('dining_table', 20, 14);
  put('bookshelf', 25, 11);
  put('plant', 27, 11);
  put('lamp', 27, 16);

  // gardens: everything within a few steps of the doors
  put('grill', 29, 10);
  put('bench', 29, 17);
  put('bench', 33, 10);
  put('fishing_spot', 31, 14);
  put('fishing_spot', 34, 17);
  put('fishing_spot', 37, 14);
  put('flowerbed', 31, 20);
  put('bench', 9, 7);
  put('grill', 5, 12);
  put('flowerbed', 1, 17);
  const trees: [number, number][] = [
    [1, 3], [5, 2], [2, 9], [1, 22], [3, 27], [10, 2], [16, 2], [22, 1], [27, 3], [34, 4], [41, 3], [42, 10],
    [40, 18], [43, 23], [37, 26], [31, 27], [24, 27], [17, 26], [10, 27], [8, 20],
  ];
  for (const [x, y] of trees) put('tree', x, y);
  const bushes: [number, number][] = [
    [12, 6], [12, 21], [29, 6], [29, 21], [16, 23], [25, 23], [6, 7], [6, 20], [39, 13], [35, 7],
  ];
  for (const [x, y] of bushes) put('bush', x, y);

  const spawnPoints: Vec2[] = [
    { x: 15, y: 12 }, { x: 18, y: 13 }, { x: 23, y: 14 }, { x: 26, y: 15 }, { x: 18, y: 15 },
    { x: 10, y: 13 }, { x: 30, y: 13 }, { x: 35, y: 19 }, { x: 4, y: 14 }, { x: 25, y: 13 },
  ];
  return { grid: g, objects, spawnPoints };
}
