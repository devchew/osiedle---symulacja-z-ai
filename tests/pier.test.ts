import { describe, expect, it } from 'vitest';
import { MAPS } from '../src/world/maps';
import { pierTiles } from '../src/render/pier';

describe('pierTiles', () => {
  const picture = (id: string): string[] => {
    const { grid: g } = MAPS.find((m) => m.id === id)!.create();
    const pier = pierTiles(g);
    const rows: string[] = [];
    for (let y = 0; y < g.height; y++) {
      let row = '';
      for (let x = 0; x < g.width; x++) row += pier.has(y * g.width + x) ? 'P' : g.tiles[y * g.width + x] === 'path' ? ':' : '.';
      rows.push(row);
    }
    return rows;
  };

  it('marks the boardwalk over the lake, including the wider head, and no land path', () => {
    const rows = picture('jezioro');
    const pier = rows.flatMap((r, y) => [...r].map((c, x) => (c === 'P' ? `${x},${y}` : '')).filter(Boolean));
    expect(pier.sort()).toEqual(['29,15', '30,15', '31,15', '32,15', '31,14', '32,14'].sort());
  });

  it('finds no pier on maps without a pier', () => {
    for (const id of ['dom', 'kamienica', 'akademik']) expect(picture(id).join('')).not.toContain('P');
  });
});
