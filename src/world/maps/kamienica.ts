import type { Vec2 } from '../../types';
import { createBuilder, rect, type MapData } from './build';

export const KAMIENICA_WIDTH = 50;
export const KAMIENICA_HEIGHT = 34;

/*
 "Kamienica" (50x34), generated dump. A city tenement around a green courtyard: three flats in the
 north wing (bed-sitting room with a kitchenette, own bathroom), a fourth flat in the south-east corner,
 a gym and a small library in the west wing, a computer studio and a music room in the east wing,
 the residents' club (TV, big table, piano) next to the gateway to the street. The courtyard has
 the grill, benches and flowerbeds; no pond, so no fishing here.
 Legend: # wall, D door, ' ' wood floor, . tile floor, , grass, : path, ~ water, @ spawn
 B bed, F fridge, S stove, T dining_table, = counter, H shower, U bathtub, W toilet, K sink,
 V tv, O sofa, R bookshelf, P piano, C computer, E exercise_bike, M treadmill, L bench,
 G grill, * flowerbed, f fishing_spot, Z wardrobe, p plant, l lamp, r rug, Y tree, b bush,
 m pet_bowl, c pet_cushion, y pet_toy, w dog_walk
 (regenerate: DUMP_MAPS=1 npx vitest run tests/maps.test.ts -> test-results/maps.txt)

 ::::::::::::::::::::::::::::::::::::::::::::::::::
 ::::::::::::::::::::::::::::::::::::::::::::::::::
 ,,##############################################,,
 ,,#BlB  FSS=#H.W.#BlB  FSS=#H.W.#BlB  FSS=#H.W.#,,
 ,,#B B      #....#B B      #....#B B      #....#,,
 ,,#         #...K#         #...K#         #...K#,,
 ,,#         ##D###         ##D###         ##D###,,
 ,,#VVV ZZ        #RR  ZZ        #CC  ZZ        #,,
 ,,#     rrr      #     rrr      #     rrr      #,,
 ,,#    @rrr      #rrr @rrr      #rrr @rrr      #,,
 ,,#OOO p    l   p#rrr p    l   p#rrr p    l   p#,,
 ,,###########D###########D##########D###########,,
 ,,#M EEZZ#b,,,,,,,,,,,:,,,,,,,,,,,,,,,,b#CClCC #,,
 ,,#M     #:,***,,,,,,,:,,,,,,,,Y,,***,,:#      #,,
 ,,#   @  D:,,,,,,,LL,,:,,,GG,,,,,,,,,,,:D rrr  #,,
 ,,#      #:,,,,,,,,,,,:,,,,,,,,,,,,,,,,:# r@r  #,,
 ,,#     p#:,,,,,,,,,,,:,,,,,@,,,,,,,,,,:#     p#,,
 ,,########:::::@::::::::::::::::::::::::########,,
 ,,#RR RR #:,,,,,,,,,,,:,,,,,,,,,,,@,,,,:#PPl   #,,
 ,,#      #:,,,,,Y,,,,,:,,,LL,,LL,,,,,,,:#      #,,
 ,,# rrr  D:,,***,,,,,,:,,,,,,,,,,,,,Y,,:D rrr  #,,
 ,,# rrr  #:,,,,,,,,,,,:,,,,,,,,,,,,,,,,:# rrr  #,,
 ,,#p    l#b,,,,,,,,,,,:,,,,,,,,,,,,,,,,b#     p#,,
 ,,##########D###D####:::#########D##############,,
 ,,# VVV  PP      RR #:::#FSS= RR            ZZp#,,
 ,,# rrr             #:::#                      #,,
 ,,# rrr      TTT    #:::#   VVV    ##D###      #,,
 ,,# OOO     yTTT    #:::#     @    #H.W.# BlB  #,,
 ,,#       @       g #:::#      rrr #....# B B  #,,
 ,,#              c  #:::#   OOOrrr #...K#      #,,
 ,,#lm XX   l       p#:::#p         #....#      #,,
 ,,###################:::########################,,
 ::::::::::::::::::::::::::::::::::::::::::::::::::
 ::::Y:::::::::Y:::::::::::::::Y:::::::::Y::::::Y::
*/

export function createKamienicaMap(): MapData {
  const b = createBuilder(KAMIENICA_WIDTH, KAMIENICA_HEIGHT, 'grass');
  const { grid: g, objects, fill, hLine, vLine, door, put, room } = b;

  // ---------------------------------------------------------------- ground
  fill(rect(0, 0, 50, 2), 'path'); // pavement behind the block
  fill(rect(0, 32, 50, 2), 'path'); // street-side pavement

  // ---------------------------------------------------------------- building ring x2..47, y2..31
  fill(rect(2, 2, 46, 30), 'wall');
  // courtyard (open air) in the middle
  fill(rect(10, 12, 30, 11), 'grass');

  // north wing: three flats (y3..10), each a bed-sitting room with a kitchenette and a bathroom
  const flats = [3, 18, 33];
  const flatDoors = [13, 25, 36];
  flats.forEach((x, i) => {
    room(`bath${i + 1}`, `Łazienka ${i + 1}`, rect(x + 10, 3, 4, 3), 'tile');
    room(`flat${i + 1}`, `Mieszkanie ${i + 1}`, rect(x, 3, 9, 8));
    fill(rect(x + 9, 7, 5, 4), 'floor'); // the room wraps around the bathroom
    door(x + 11, 6); // bathroom door
    door(flatDoors[i], 11); // to the courtyard
  });
  // west wing: gym; east wing: workshop with computers and a piano
  room('gym', 'Siłownia', rect(3, 12, 6, 5));
  door(9, 14);
  room('library', 'Biblioteczka', rect(3, 18, 6, 5));
  door(9, 20);
  room('studio', 'Pracownia', rect(41, 12, 6, 5));
  door(40, 14);
  room('music', 'Pokój muzyczny', rect(41, 18, 6, 5));
  door(40, 20);
  // south wing (y24..30): residents' club, gateway, fourth flat
  room('club', 'Klub mieszkańców', rect(3, 24, 17, 7));
  door(12, 23);
  door(16, 23);
  fill(rect(21, 23, 3, 9), 'path'); // gateway to the street
  room('bath4', 'Łazienka 4', rect(36, 27, 4, 4), 'tile');
  room('flat4', 'Mieszkanie 4', rect(25, 24, 22, 7));
  // flat 4 spans the south-east corner; its bathroom is a closed corner
  fill(rect(36, 27, 4, 4), 'tile');
  vLine(35, 26, 30);
  hLine(26, 35, 40);
  vLine(40, 27, 30);
  door(37, 26);
  door(33, 23);

  g.rooms.push(
    { id: 'courtyard', name: 'Podwórko', rect: rect(10, 12, 30, 11) },
    { id: 'gate', name: 'Brama', rect: rect(21, 23, 3, 9) },
    { id: 'street', name: 'Ulica', rect: rect(0, 32, 50, 2) },
  );

  // ---------------------------------------------------------------- flats 1–3 (beds first: pairs share a flat)
  flats.forEach((x, i) => {
    put('bed', x, 3);
    put('bed', x + 2, 3);
    put('lamp', x + 1, 3);
    // kitchenette on the north wall
    put('fridge', x + 5, 3);
    put('stove', x + 6, 3);
    put('counter', x + 8, 3);
    // bathroom
    put('shower', x + 10, 3);
    put('toilet', x + 12, 3);
    put('sink', x + 13, 5);
    // living corner: each flat has its own hobby
    if (i === 0) {
      put('tv', x, 7);
      put('sofa', x, 10);
    } else if (i === 1) {
      put('bookshelf', x, 7);
      put('rug', x, 9);
    } else {
      put('computer', x, 7);
      put('rug', x, 9);
    }
    put('wardrobe', x + 4, 7);
    put('rug', x + 5, 8);
    put('plant', x + 4, 10);
    put('plant', x + 13, 10);
    put('lamp', x + 9, 10);
  });

  // ---------------------------------------------------------------- flat 4 (south-east)
  put('bed', 42, 27);
  put('bed', 44, 27);
  put('lamp', 43, 27);
  put('fridge', 25, 24);
  put('stove', 26, 24);
  put('counter', 28, 24);
  put('bookshelf', 30, 24);
  put('tv', 28, 26);
  put('sofa', 28, 29);
  put('rug', 31, 28);
  put('wardrobe', 44, 24);
  put('plant', 46, 24);
  put('plant', 25, 30);
  put('shower', 36, 27);
  put('toilet', 38, 27);
  put('sink', 39, 29);

  // ---------------------------------------------------------------- club, gym, studio
  put('tv', 4, 24);
  put('rug', 4, 25);
  put('sofa', 4, 27);
  put('dining_table', 13, 26);
  put('piano', 9, 24);
  put('bookshelf', 17, 24);
  put('lamp', 3, 30);
  put('plant', 19, 30);
  put('lamp', 11, 30);

  put('treadmill', 3, 12);
  put('exercise_bike', 5, 12);
  put('exercise_bike', 6, 12);
  put('wardrobe', 7, 12);
  put('plant', 8, 16);
  put('bookshelf', 3, 18);
  put('bookshelf', 6, 18);
  put('rug', 4, 20);
  put('lamp', 8, 22);
  put('plant', 3, 22);

  put('computer', 41, 12);
  put('computer', 44, 12);
  put('lamp', 43, 12);
  put('rug', 42, 14);
  put('plant', 46, 16);
  put('piano', 41, 18);
  put('lamp', 43, 18);
  put('rug', 42, 20);
  put('plant', 46, 22);

  // ---------------------------------------------------------------- courtyard
  hLine(17, 10, 39, 'path');
  vLine(22, 12, 22, 'path');
  vLine(10, 13, 21, 'path'); // along the wings: gym, library, studio, music room
  vLine(39, 13, 21, 'path');
  put('grill', 26, 14);
  put('bench', 26, 19);
  put('bench', 18, 14);
  put('bench', 30, 19);
  put('flowerbed', 12, 13);
  put('flowerbed', 34, 13);
  put('flowerbed', 13, 20);
  put('tree', 16, 19);
  put('tree', 36, 20);
  put('tree', 31, 13);
  put('bush', 10, 12);
  put('bush', 39, 12);
  put('bush', 10, 22);
  put('bush', 39, 22);
  // street trees
  for (const x of [4, 14, 30, 40, 47]) put('tree', x, 33);

  // games in the residents' club (joint activities): a console by the south wall, a card table
  put('console', 6, 30);
  put('board_game_table', 18, 28);

  const spawnPoints: Vec2[] = [
    { x: 7, y: 9 }, { x: 22, y: 9 }, { x: 37, y: 9 }, { x: 15, y: 17 }, { x: 28, y: 16 },
    { x: 34, y: 18 }, { x: 10, y: 28 }, { x: 30, y: 27 }, { x: 6, y: 14 }, { x: 43, y: 15 },
  ];
  // house pet (cat of the residents' club: bowl, cushion and toy corner there, never goes out); placed last so the uids of older objects stay the same
  put('pet_bowl', 4, 30);
  put('pet_cushion', 17, 29);
  put('pet_toy', 12, 27);

  return { grid: g, objects, spawnPoints, pet: { species: 'cat', name: 'Popiołek' } };
}
