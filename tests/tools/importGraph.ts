// Static import graph of the TypeScript sources, used to keep the simulation free of import cycles
// (issue #1). Only imports that survive compilation count: `import type`, `export type` and imports
// whose every specifier is `type X` are erased, dynamic `import()` does not run at module load.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const STATIC_FROM = /^\s*(import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^\s*import\s+['"]([^'"]+)['"]/gm;

function isTypeOnly(clause: string): boolean {
  const c = clause.trim();
  if (c.startsWith('type ')) return true;
  const named = /^\{([\s\S]*)\}$/.exec(c);
  if (!named) return false;
  const specs = named[1].split(',').map((s) => s.trim()).filter(Boolean);
  return specs.length > 0 && specs.every((s) => s.startsWith('type '));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** runtime import edges between the .ts files under `root`, keyed by path relative to `root` */
export function importGraph(root: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of listTs(root)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const deps = new Set<string>();
    for (const m of src.matchAll(STATIC_FROM)) {
      if (isTypeOnly(m[2])) continue;
      const to = resolveSpecifier(file, m[3]);
      if (to) deps.add(relative(root, to));
    }
    for (const m of src.matchAll(SIDE_EFFECT)) {
      const to = resolveSpecifier(file, m[1]);
      if (to) deps.add(relative(root, to));
    }
    graph.set(relative(root, file), [...deps].sort());
  }
  return graph;
}

/** strongly connected components with more than one module (or a self-import) — i.e. import cycles */
export function importCycles(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (graph.get(v) ?? []).includes(v)) out.push(scc.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) visit(v);
  return out;
}
