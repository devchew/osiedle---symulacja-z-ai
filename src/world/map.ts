import type { Grid, ObjectInstance, RectArea, TileKind, Vec2 } from '../types';
import { createGrid, markSolid, setTile } from './grid';
import { OBJECT_DEFS, footprint } from './objects';

export const MAP_WIDTH = 44;
export const MAP_HEIGHT = 30;

/*
 Default map (44x30), generated dump. House x1..30 y1..20, garden around it.
 Legend: # wall, D door, ' ' wood floor, . tile floor, , grass, : path, ~ water, @ spawn
 B bed, F fridge, S stove, T dining_table, = counter, H shower, U bathtub, W toilet, K sink,
 V tv, O sofa, R bookshelf, P piano, C computer, E exercise_bike, M treadmill, L bench,
 G grill, * flowerbed, f fishing_spot, Z wardrobe, p plant, l lamp, r rug, Y tree, b bush

 Y,,,,,,,,,,,,,,,,,,,,,,,,,Y,,,,,,,,,,,,,,,,,
 ,##############################,Y,,,,,,,,,,,
 ,#B l B  #B l B p#HUUW#B l B p#,,,,,,,,,,Y,,
 ,#B   B  #B   B  #....#B   B  #b,,,,***,,,,,
 ,# rrr   # rrr   #....# rrr   #,,,,,,,,,,,,,
 ,# rrr   # rrr   #...K# rrr   #,,,,,,,,,,,,,
 ,#       #     CC#....#RR     #b,,,,,,,,,,,,
 ,#p    ZZ#ZZ     #p...#     ZZ#,,,,,,,,,,,Y,
 ,####D#######D#####D######D####,,,,,,,,,,,,,
 ,#p @     l   @       l   @   D:::,,,,,,,,,,
 ,#      @           @        pD:::,,LL,,,,,,
 ,#####D#########DD#########D###,,:,,,,,,,,,,
 ,#F=SS.==F.#RRPP   VVV p#W...H#,,:,,~~~~,,,b
 ,#.........#       rrr  #.....#,,:,~~~~~~,,,
 ,#.........#       rrr  #....K#b,:f~~~~~~,,,
 ,#..TTT....#    @  OOOl #######,,:,~~~~~~f,,
 ,#..TTT....D            #E MCC#,,:,~~~~~~,,,
 ,#.........#  rrr @     #  M  #b,:,,~~~~,,,,
 ,#.........#  rrr       D     #,,:,,,,f,,,,b
 ,#l.......p#p          p#    p#,,:,,,,,,,,,,
 ,###D############DD############,,:,,,,LL,,,,
 ,,,,:,b,,,b,,,,,,::,,b,,,,,,b,,,,:,,,,,,,,,,
 ,,,,:,,,LL,,***b,::,,,,,GG,,,,,,,:@,,,,,,,Y,
 ,,,,:,,,,,,,,,,,,::,@,,,,,,,,,,,,:,,,,,,,,,,
 ,,,,:::::::::::::::::::::::::::::::::::::,,,
 ,,,,,,,,,@,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
 ,,,,,,,,,,,Y,,,,,,,,,,,,,,,,Y,,,,,,,,,Y,,,,,
 ,,Y,,,,,,,,,,,,,,,,,,,Y,,,,,,,,,,,,,,,,,,,,,
 ,,,,,,,Y,,,,,,,,,,,,,,,,,,,,,,,,Y,,,,,,,,,,,
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
  // paths: front door south, back door, east corridor door, loop along the bottom
  vLine(17, 21, 24, 'path');
  vLine(18, 21, 24, 'path');
  vLine(4, 21, 24, 'path');
  hLine(24, 4, 40, 'path');
  hLine(9, 31, 33, 'path');
  hLine(10, 31, 33, 'path');
  vLine(33, 9, 24, 'path');
  // pond with rounded corners
  fill(rect(35, 12, 6, 6), 'water');
  for (const [x, y] of [[35, 12], [40, 12], [35, 17], [40, 17]]) setTile(g, x, y, 'grass');

  // ---------------------------------------------------------------- house shell
  fill(rect(1, 1, 30, 20), 'wall');
  const rooms: { id: string; name: string; r: RectArea; floor: TileKind }[] = [
    { id: 'bedroom1', name: 'Sypialnia 1', r: rect(2, 2, 7, 6), floor: 'floor' },
    { id: 'bedroom2', name: 'Sypialnia 2', r: rect(10, 2, 7, 6), floor: 'floor' },
    { id: 'bathroom', name: 'Łazienka', r: rect(18, 2, 4, 6), floor: 'tile' },
    { id: 'bedroom3', name: 'Sypialnia 3', r: rect(23, 2, 7, 6), floor: 'floor' },
    { id: 'hall', name: 'Korytarz', r: rect(2, 9, 28, 2), floor: 'floor' },
    { id: 'kitchen', name: 'Kuchnia', r: rect(2, 12, 9, 8), floor: 'tile' },
    { id: 'living', name: 'Salon', r: rect(12, 12, 12, 8), floor: 'floor' },
    { id: 'bathroom2', name: 'Mała łazienka', r: rect(25, 12, 5, 3), floor: 'tile' },
    { id: 'hobby', name: 'Pokój hobby', r: rect(25, 16, 5, 4), floor: 'floor' },
  ];
  for (const room of rooms) fill(room.r, room.floor);
  // doors
  [[5, 8], [13, 8], [19, 8], [26, 8]].forEach(([x, y]) => door(x, y)); // bedrooms/bathroom -> hall
  [[6, 11], [16, 11], [17, 11], [27, 11]].forEach(([x, y]) => door(x, y)); // hall -> kitchen/living/bathroom2
  door(11, 16); // kitchen <-> living
  door(24, 18); // living <-> hobby
  door(17, 20); door(18, 20); // front door
  door(4, 20); // kitchen back door
  door(30, 9); door(30, 10); // hall -> east garden
  door(30, 18); // hobby room -> garden (shortcut to the pond)

  g.rooms = [
    ...rooms.map(({ id, name, r }) => ({ id, name, rect: r })),
    { id: 'garden', name: 'Ogród', rect: rect(31, 0, 13, 30) },
    { id: 'yard', name: 'Przed domem', rect: rect(0, 21, 31, 9) },
  ];

  // ---------------------------------------------------------------- objects
  const objects: ObjectInstance[] = [];
  const put = (type: string, x: number, y: number) => {
    const def = OBJECT_DEFS[type];
    const obj: ObjectInstance = { uid: objects.length + 1, type, pos: { x, y }, reservedBy: def.slots.map(() => null) };
    objects.push(obj);
    if (def.blocking) for (const p of footprint(obj, def)) markSolid(g, p.x, p.y, true);
  };

  // bedrooms: two single beds each, wardrobe, lamp
  for (const bx of [2, 10, 23]) {
    put('bed', bx, 2);
    put('bed', bx + 4, 2);
    put('lamp', bx + 2, 2);
  }
  put('rug', 3, 4);
  put('wardrobe', 7, 7);
  put('plant', 2, 7);
  put('wardrobe', 10, 7);
  put('rug', 11, 4);
  put('computer', 15, 6);
  put('plant', 16, 2);
  put('rug', 24, 4);
  put('wardrobe', 28, 7);
  put('plant', 29, 2);
  put('bookshelf', 23, 6);

  // bathroom
  put('shower', 18, 2);
  put('bathtub', 19, 2);
  put('toilet', 21, 2);
  put('sink', 21, 5);
  put('plant', 18, 7);

  // hall
  put('plant', 2, 9);
  put('plant', 29, 10);
  put('lamp', 10, 9);
  put('lamp', 22, 9);

  // kitchen
  put('fridge', 2, 12);
  put('counter', 3, 12);
  put('stove', 4, 12);
  put('counter', 7, 12);
  put('counter', 8, 12);
  put('fridge', 9, 12);
  put('dining_table', 4, 15);
  put('plant', 10, 19);
  put('lamp', 2, 19);

  // living room
  put('bookshelf', 12, 12);
  put('piano', 14, 12);
  put('tv', 19, 12);
  put('rug', 19, 13);
  put('sofa', 19, 15);
  put('lamp', 22, 15);
  put('plant', 23, 12);
  put('plant', 12, 19);
  put('plant', 23, 19);
  put('rug', 14, 17);

  // small bathroom
  put('toilet', 25, 12);
  put('shower', 29, 12);
  put('sink', 29, 14);

  // hobby room
  put('exercise_bike', 25, 16);
  put('treadmill', 27, 16);
  put('computer', 28, 16);
  put('plant', 29, 19);

  // garden
  put('grill', 24, 22);
  put('bench', 8, 22);
  put('flowerbed', 12, 22);
  put('bench', 36, 10);
  put('bench', 38, 20);
  put('flowerbed', 36, 3);
  put('fishing_spot', 34, 14);
  put('fishing_spot', 38, 18);
  put('fishing_spot', 41, 15);
  const trees: [number, number][] = [
    [2, 27], [7, 28], [11, 26], [22, 27], [28, 26], [32, 28], [38, 26], [42, 22], [42, 7], [41, 2], [32, 1], [0, 0], [26, 0],
  ];
  for (const [x, y] of trees) put('tree', x, y);
  const bushes: [number, number][] = [
    [31, 3], [31, 6], [31, 14], [31, 17], [6, 21], [10, 21], [21, 21], [28, 21], [15, 22], [43, 12], [43, 18],
  ];
  for (const [x, y] of bushes) put('bush', x, y);

  const spawnPoints: Vec2[] = [
    { x: 4, y: 9 }, { x: 8, y: 10 }, { x: 14, y: 9 }, { x: 20, y: 10 }, { x: 26, y: 9 },
    { x: 16, y: 15 }, { x: 18, y: 17 }, { x: 20, y: 23 }, { x: 34, y: 22 }, { x: 9, y: 25 },
  ];
  return { grid: g, objects, spawnPoints };
}
