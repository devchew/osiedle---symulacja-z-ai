import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { importCycles, importGraph } from './tools/importGraph';

// Issue #1: module-level state (object catalogue, registered world state) must not depend on which
// module happens to be loaded first, so the simulation may not have import cycles.

const SRC = resolve(__dirname, '../src');

describe('import graph', () => {
  const graph = importGraph(SRC);

  it('finds the simulation modules', () => {
    expect(graph.get('world/world.ts')).toContain('world/objects.ts');
    expect(graph.size).toBeGreaterThan(40);
  });

  it('has no import cycles in src', () => {
    expect(importCycles(graph).map((c) => c.join(', '))).toEqual([]);
  });
});
