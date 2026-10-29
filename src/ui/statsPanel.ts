import './ui.css';
import { formatClock, MINUTES_PER_DAY, START_MINUTE, timeFromTick } from '../core/time';
import type { Agent, World } from '../types';
import { relationshipLabel } from '../social/relationships';
import { agentMemories, memoryStats } from '../social/memory';
import { goalHistory } from '../agents/goals';
import { el, fitCanvas, isTypingTarget, moodEmoji, setText, valueColor } from './dom';
import type { MoodHistory } from './history';
import type { RelationOfFn } from './extras';

export interface StatsPanelOptions {
  history: MoodHistory;
  /** relationship kind (couple, rivals…), when the simulation provides it */
  relationOf?: RelationOfFn;
  onSelectAgent?(id: number): void;
  onToggle?(open: boolean): void;
}

export interface StatsPanel {
  readonly isOpen: boolean;
  setOpen(open: boolean): void;
  /** redraws when open; call a few times per second */
  update(): void;
  /** shows another world (live view) */
  setWorld(world: World): void;
}

const GOOD = [79, 209, 139];
const BAD = [255, 107, 107];
const NODE_R = 15;

type Hover = { kind: 'node'; id: number } | { kind: 'edge'; a: number; b: number } | null;

function signed(v: number): string {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0';
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** statistics overlay: relationship network, mood history, per-resident table */
export function createStatsPanel(initialWorld: World, opts: StatsPanelOptions): StatsPanel {
  let world = initialWorld;
  const root = el('section', 'ui-panel ui-stats');
  root.id = 'stats-panel';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Statystyki');

  const closeBtn = el('button', 'ui-icon-btn', ['✕']);
  closeBtn.type = 'button';
  closeBtn.title = 'Zamknij (Esc)';
  closeBtn.addEventListener('click', () => setOpen(false));
  const subtitle = el('span', 'panel-sub');

  // relationship network
  const net = el('canvas', 'stats-net');
  net.setAttribute('role', 'img');
  net.setAttribute('aria-label', 'Sieć relacji między mieszkańcami');
  const netInfo = el('p', 'stats-info');
  const netCard = el('section', 'stats-card stats-card--net', [
    el('h3', 'stats-h', ['Sieć relacji']),
    net,
    el('div', 'stats-legend-inline', [
      el('span', 'leg leg--good', ['sympatia']),
      el('span', 'leg leg--bad', ['niechęć']),
      el('span', 'leg-note', ['grubość = siła']),
    ]),
    netInfo,
  ]);

  // table
  const tbody = el('tbody');
  const table = el('table', 'stats-table', [
    el('thead', '', [
      el('tr', '', [
        el('th', '', ['Mieszkaniec']),
        Object.assign(el('th', 'num', ['😊']), { title: 'Nastrój' }),
        Object.assign(el('th', 'num', ['💬']), { title: 'Rozmowy' }),
        Object.assign(el('th', 'num', ['🔧']), { title: 'Użyte przedmioty' }),
        Object.assign(el('th', 'num', ['🎯']), { title: 'Cele dnia wykonane / wszystkie' }),
        Object.assign(el('th', 'num', ['🧠']), { title: 'Wspomnienia' }),
      ]),
    ]),
    tbody,
  ]);
  const tableFoot = el('p', 'stats-foot');
  const pairs = el('ul', 'stats-pairs');
  const tableCard = el('section', 'stats-card stats-card--table', [
    el('h3', 'stats-h', ['Mieszkańcy']),
    el('div', 'stats-table-wrap', [table]),
    tableFoot,
    el('h3', 'stats-h stats-h--gap', ['Najsilniejsze więzi i napięcia']),
    pairs,
  ]);

  // mood chart
  const chart = el('canvas', 'stats-chart');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', 'Nastrój mieszkańców w ostatnich dniach');
  const legend = el('div', 'stats-legend');
  const chartEmpty = el('p', 'stats-empty', ['Historia nastroju zbiera się co godzinę gry.']);
  const chartCard = el('section', 'stats-card stats-card--chart', [
    el('h3', 'stats-h', ['Nastrój — ostatnie 3 dni']),
    el('div', 'stats-chart-wrap', [chart, chartEmpty]),
    legend,
  ]);

  root.append(
    el('header', 'panel-header', [el('h2', 'panel-title', ['📊 Statystyki']), subtitle, closeBtn]),
    el('div', 'stats-grid', [netCard, tableCard, chartCard]),
  );
  document.body.append(root);

  let open = false;
  let hover: Hover = null;
  let pinned: Hover = null;
  /** agent highlighted from the legend or table */
  let focusId: number | null = null;
  let chartHoverX: number | null = null;
  let rowsKey = '';
  const rowCells = new Map<number, HTMLTableCellElement[]>();
  const legendChips = new Map<number, HTMLElement>();
  let nodePos = new Map<number, { x: number; y: number }>();

  const agentById = (id: number): Agent | undefined => world.agents.find((a) => a.id === id);

  // ------------------------------------------------------------ network

  function edgeStyle(v: number, emphasis: number): { color: string; width: number } {
    const s = Math.min(1, Math.abs(v) / 100);
    const [r, g, b] = v >= 0 ? GOOD : BAD;
    const alpha = (0.18 + 0.72 * s) * emphasis;
    return { color: `rgba(${r},${g},${b},${alpha.toFixed(3)})`, width: 1 + s * 6 };
  }

  function drawNetwork(): void {
    const fit = fitCanvas(net);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const agents = world.agents;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.max(30, Math.min(w, h) / 2 - 40);
    nodePos = new Map(
      agents.map((a, i) => {
        const ang = -Math.PI / 2 + (i / Math.max(1, agents.length)) * Math.PI * 2;
        return [a.id, { x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R }];
      }),
    );
    const active = hover ?? pinned;
    const focusNode = active?.kind === 'node' ? active.id : focusId;

    // faint guide circle
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineCap = 'round';
    const icons: { x: number; y: number; icon: string }[] = [];
    for (let i = 0; i < agents.length; i++)
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const v = world.relationships.get(a.id, b.id);
        const pa = nodePos.get(a.id)!;
        const pb = nodePos.get(b.id)!;
        const isActive = active?.kind === 'edge' && ((active.a === a.id && active.b === b.id) || (active.a === b.id && active.b === a.id));
        const touches = focusNode === null || focusNode === a.id || focusNode === b.id;
        const emphasis = isActive ? 1.25 : active?.kind === 'edge' ? 0.35 : touches ? 1 : 0.18;
        const st = edgeStyle(v, emphasis);
        if (isActive) {
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = st.width + 4;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
        ctx.strokeStyle = st.color;
        ctx.lineWidth = st.width;
        ctx.setLineDash(Math.abs(v) < 5 ? [3, 4] : []);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        const kind = opts.relationOf?.(world, a.id, b.id);
        if (kind?.icon && touches) icons.push({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, icon: kind.icon });
      }
    ctx.setLineDash([]);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '13px system-ui, sans-serif';
    for (const ic of icons) ctx.fillText(ic.icon, ic.x, ic.y);

    for (const a of agents) {
      const p = nodePos.get(a.id)!;
      const inEdge = active?.kind === 'edge' && (active.a === a.id || active.b === a.id);
      const isFocus = focusNode === a.id || inEdge;
      const dim = active?.kind === 'edge' && !inEdge ? 0.5 : 1;
      ctx.globalAlpha = dim;
      // mood ring
      ctx.strokeStyle = valueColor(a.mood);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, NODE_R + 3, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * a.mood) / 100);
      ctx.stroke();
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, NODE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isFocus ? '#fff' : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = isFocus ? 2.5 : 1.5;
      ctx.stroke();
      ctx.fillStyle = 'rgba(10,14,24,0.85)';
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillText(a.name.slice(0, 1), p.x, p.y + 0.5);
      // name outside the circle
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const lx = p.x + (dx / d) * (NODE_R + 16);
      const ly = p.y + (dy / d) * (NODE_R + 13);
      ctx.font = `${isFocus ? 700 : 600} 12px system-ui, sans-serif`;
      ctx.textAlign = Math.abs(dx / d) < 0.3 ? 'center' : dx > 0 ? 'left' : 'right';
      const tx = Math.abs(dx / d) < 0.3 ? p.x : lx - (dx > 0 ? 8 : -8);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(a.name, tx + 1, ly + 1);
      ctx.fillStyle = '#f1f4fb';
      ctx.fillText(a.name, tx, ly);
      ctx.textAlign = 'center';
      ctx.globalAlpha = 1;
    }
    renderNetInfo(active);
  }

  function pairText(aId: number, bId: number): string {
    const a = agentById(aId);
    const b = agentById(bId);
    if (!a || !b) return '';
    const v = world.relationships.get(aId, bId);
    const kind = opts.relationOf?.(world, aId, bId);
    const label = kind ? `${kind.icon ? `${kind.icon} ` : ''}${kind.label}` : relationshipLabel(v);
    return `${a.name} ↔ ${b.name}: ${signed(v)} · ${label}${kind?.detail ? ` · ${kind.detail}` : ''}`;
  }

  function renderNetInfo(active: Hover): void {
    if (!active) {
      setText(netInfo, world.agents.length > 1 ? 'Najedź na osobę lub linię, by zobaczyć szczegóły. Klik w osobę otwiera jej panel.' : 'Potrzeba co najmniej dwóch mieszkańców.');
      netInfo.classList.remove('is-active');
      return;
    }
    netInfo.classList.add('is-active');
    if (active.kind === 'edge') {
      setText(netInfo, pairText(active.a, active.b));
      return;
    }
    const a = agentById(active.id);
    if (!a) return;
    const others = world.agents
      .filter((o) => o.id !== a.id)
      .map((o) => ({ o, v: world.relationships.get(a.id, o.id) }))
      .sort((x, y) => y.v - x.v);
    if (!others.length) {
      setText(netInfo, a.name);
      return;
    }
    const best = others[0];
    const worst = others[others.length - 1];
    const avg = others.reduce((s, x) => s + x.v, 0) / others.length;
    let text = `${a.name} · najbliżej: ${best.o.name} (${signed(best.v)})`;
    if (others.length > 1) text += ` · najdalej: ${worst.o.name} (${signed(worst.v)})`;
    text += ` · średnio ${signed(avg)}`;
    setText(netInfo, text);
  }

  function hitNetwork(e: PointerEvent): Hover {
    const r = net.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    for (const a of world.agents) {
      const p = nodePos.get(a.id);
      if (p && Math.hypot(p.x - x, p.y - y) <= NODE_R + 5) return { kind: 'node', id: a.id };
    }
    let best: Hover = null;
    let bestD = 7;
    const agents = world.agents;
    for (let i = 0; i < agents.length; i++)
      for (let j = i + 1; j < agents.length; j++) {
        const pa = nodePos.get(agents[i].id);
        const pb = nodePos.get(agents[j].id);
        if (!pa || !pb) continue;
        const d = distToSegment(x, y, pa.x, pa.y, pb.x, pb.y);
        if (d < bestD) {
          bestD = d;
          best = { kind: 'edge', a: agents[i].id, b: agents[j].id };
        }
      }
    return best;
  }

  net.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const h = hitNetwork(e);
    if (JSON.stringify(h) !== JSON.stringify(hover)) {
      hover = h;
      net.style.cursor = h ? 'pointer' : '';
      drawNetwork();
    }
  });
  net.addEventListener('pointerleave', () => {
    hover = null;
    drawNetwork();
  });
  net.addEventListener('click', (e) => {
    const h = hitNetwork(e as PointerEvent);
    if (h?.kind === 'node') {
      pinned = h;
      opts.onSelectAgent?.(h.id);
    } else pinned = h;
    drawNetwork();
  });

  // ------------------------------------------------------------ mood chart

  function drawChart(): void {
    const samples = opts.history.samples();
    const points = [...samples];
    const last = points[points.length - 1];
    if (!last || last.tick < world.tick) points.push({ tick: world.tick, moods: new Map(world.agents.map((a) => [a.id, a.mood])) });
    chartEmpty.hidden = points.length >= 2;
    const fit = fitCanvas(chart);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const padL = 30;
    const padR = 10;
    const padT = 8;
    const padB = 20;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const t1 = world.tick;
    const t0 = Math.min(points[0].tick, t1 - 60);
    const span = Math.max(60, t1 - t0);
    const X = (t: number): number => padL + ((t - t0) / span) * pw;
    const Y = (v: number): number => padT + (1 - v / 100) * ph;

    // night bands 22:00–06:00
    ctx.fillStyle = 'rgba(120,140,255,0.07)';
    const firstDayStart = Math.floor((t0 + START_MINUTE) / MINUTES_PER_DAY) * MINUTES_PER_DAY - START_MINUTE;
    for (let d = firstDayStart - MINUTES_PER_DAY; d <= t1; d += MINUTES_PER_DAY) {
      const n0 = Math.max(t0, d + 22 * 60);
      const n1 = Math.min(t1, d + 30 * 60);
      if (n1 > n0) ctx.fillRect(X(n0), padT, X(n1) - X(n0), ph);
    }
    // grid
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [0, 25, 50, 75, 100]) {
      ctx.strokeStyle = v === 50 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(Y(v)) + 0.5);
      ctx.lineTo(w - padR, Math.round(Y(v)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(169,178,199,0.85)';
      ctx.fillText(String(v), padL - 6, Y(v));
    }
    // midnights + day labels
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let d = firstDayStart; d <= t1; d += MINUTES_PER_DAY) {
      if (d > t0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(X(d)) + 0.5, padT);
        ctx.lineTo(Math.round(X(d)) + 0.5, padT + ph);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const labelX = Math.max(padL, X(d)) + 4;
      if (labelX < w - padR - 40) {
        ctx.fillStyle = 'rgba(169,178,199,0.9)';
        ctx.fillText(`Dzień ${timeFromTick(Math.max(d, t0)).day}`, labelX, padT + ph + 5);
      }
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(241,244,251,0.9)';
    ctx.fillText(formatClock(timeFromTick(t1)), w - padR, padT + ph + 5);

    // lines
    const hasFocus = focusId !== null && world.agents.some((a) => a.id === focusId);
    const order = [...world.agents].sort((a, b) => (a.id === focusId ? 1 : 0) - (b.id === focusId ? 1 : 0));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const a of order) {
      const focused = a.id === focusId;
      ctx.globalAlpha = hasFocus && !focused ? 0.22 : 0.95;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = focused ? 3 : 1.8;
      ctx.beginPath();
      let started = false;
      for (const p of points) {
        const v = p.moods.get(a.id);
        if (v === undefined) {
          started = false;
          continue;
        }
        if (started) ctx.lineTo(X(p.tick), Y(v));
        else ctx.moveTo(X(p.tick), Y(v));
        started = true;
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // hover crosshair + tooltip
    if (chartHoverX !== null && points.length >= 2) {
      const tAt = t0 + ((chartHoverX - padL) / pw) * span;
      let near = points[0];
      for (const p of points) if (Math.abs(p.tick - tAt) < Math.abs(near.tick - tAt)) near = p;
      const x = X(near.tick);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padT);
      ctx.lineTo(Math.round(x) + 0.5, padT + ph);
      ctx.stroke();
      const rows = world.agents
        .map((a) => ({ a, v: near.moods.get(a.id) }))
        .filter((r): r is { a: Agent; v: number } => r.v !== undefined)
        .sort((p, q) => q.v - p.v);
      for (const r of rows) {
        ctx.fillStyle = r.a.color;
        ctx.beginPath();
        ctx.arc(x, Y(r.v), r.a.id === focusId ? 4 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const t = timeFromTick(near.tick);
      const lines = [`Dzień ${t.day}, ${formatClock(t)}`, ...rows.map((r) => `${r.a.name}  ${Math.round(r.v)}`)];
      ctx.font = '11.5px system-ui, sans-serif';
      const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 30;
      const lh = 14;
      const bh = lines.length * lh + 8;
      let bx = x + 10;
      if (bx + bw > w - 4) bx = x - 10 - bw;
      const by = Math.max(2, Math.min(h - bh - 2, padT));
      ctx.fillStyle = 'rgba(12,16,26,0.92)';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 7);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      lines.forEach((l, i) => {
        const ly = by + 4 + lh * i + lh / 2;
        if (i === 0) {
          ctx.fillStyle = 'rgba(169,178,199,1)';
          ctx.fillText(l, bx + 8, ly);
          return;
        }
        ctx.fillStyle = rows[i - 1].a.color;
        ctx.beginPath();
        ctx.arc(bx + 12, ly, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rows[i - 1].a.id === focusId ? '#fff' : 'rgba(241,244,251,0.9)';
        ctx.fillText(l, bx + 21, ly);
      });
    }
  }

  chart.addEventListener('pointermove', (e) => {
    const r = chart.getBoundingClientRect();
    chartHoverX = e.clientX - r.left;
    drawChart();
  });
  chart.addEventListener('pointerleave', () => {
    chartHoverX = null;
    drawChart();
  });

  function setFocus(id: number | null): void {
    if (focusId === id) return;
    focusId = id;
    for (const [aid, chip] of legendChips) chip.classList.toggle('is-focus', aid === id);
    for (const [aid, cells] of rowCells) cells[0].parentElement!.classList.toggle('is-focus', aid === id);
    drawChart();
    drawNetwork();
  }

  // ------------------------------------------------------------ table + legend

  function buildRows(): void {
    const key = world.agents.map((a) => `${a.id}:${a.name}`).join('|');
    if (key === rowsKey) return;
    rowsKey = key;
    rowCells.clear();
    legendChips.clear();
    tbody.replaceChildren();
    legend.replaceChildren();
    for (const a of world.agents) {
      const dot = el('span', 'insp-dot insp-dot--small');
      dot.style.background = a.color;
      const nameBtn = el('button', 'stats-name', [dot, a.name]);
      nameBtn.type = 'button';
      nameBtn.title = `Pokaż: ${a.name}`;
      nameBtn.addEventListener('click', () => opts.onSelectAgent?.(a.id));
      const cells = [el('td', '', [nameBtn]), el('td', 'num'), el('td', 'num'), el('td', 'num'), el('td', 'num'), el('td', 'num')];
      const tr = el('tr', '', cells);
      tr.addEventListener('pointerenter', () => setFocus(a.id));
      tr.addEventListener('pointerleave', () => setFocus(null));
      tbody.append(tr);
      rowCells.set(a.id, cells);

      const chipDot = el('span', 'insp-dot insp-dot--small');
      chipDot.style.background = a.color;
      const chip = el('button', 'stats-chip', [chipDot, a.name]);
      chip.type = 'button';
      chip.addEventListener('pointerenter', () => setFocus(a.id));
      chip.addEventListener('pointerleave', () => setFocus(null));
      chip.addEventListener('click', () => setFocus(focusId === a.id ? null : a.id));
      legend.append(chip);
      legendChips.set(a.id, chip);
    }
  }

  function renderTable(): void {
    buildRows();
    let goalsDone = 0;
    for (const a of world.agents) {
      const c = rowCells.get(a.id);
      if (!c) continue;
      const goals = goalHistory(a);
      const done = goals.filter((g) => g.done).length;
      const closed = goals.filter((g) => g.done || !g.open).length;
      goalsDone += done;
      setText(c[1], `${moodEmoji(a.mood)} ${Math.round(a.mood)}`);
      setText(c[2], String(a.stats.conversations));
      setText(c[3], String(a.stats.objectsUsed));
      setText(c[4], goals.length ? `${done}/${Math.max(closed, done)}` : '—');
      c[4].title = goals.length ? `Wykonane ${done} z ${goals.length} (w tym dzisiejszy, jeśli trwa)` : 'Jeszcze bez celów';
      setText(c[5], String(agentMemories(world, a.id).length));
    }
    const ms = memoryStats(world);
    const conv = world.agents.reduce((s, a) => s + a.stats.conversations, 0) / 2;
    setText(tableFoot, `Razem: ${Math.round(conv)} rozmów · ${goalsDone} celów · ${ms.stories} historii · plotka przeszła ${ms.spreads}×`);
    const t = timeFromTick(world.tick);
    setText(subtitle, `dzień ${t.day}, ${formatClock(t)} · 👥 ${world.agents.length}`);
  }

  let pairsKey = '';
  function renderPairs(): void {
    const ids = new Set(world.agents.map((a) => a.id));
    const all = world.relationships.all().filter((r) => ids.has(r.a) && ids.has(r.b));
    const best = [...all].sort((x, y) => y.value - x.value).slice(0, 3);
    const worst = all
      .filter((r) => r.value < 0 && !best.includes(r))
      .sort((x, y) => x.value - y.value)
      .slice(0, 2);
    const list = [...best, ...worst];
    const key = list.map((r) => `${r.a}-${r.b}:${Math.round(r.value)}:${opts.relationOf?.(world, r.a, r.b)?.label ?? ''}`).join('|');
    if (key === pairsKey) return;
    pairsKey = key;
    pairs.replaceChildren(
      ...list.map((r) => {
        const a = agentById(r.a)!;
        const b = agentById(r.b)!;
        const kind = opts.relationOf?.(world, r.a, r.b);
        const dotA = el('span', 'insp-dot insp-dot--small');
        dotA.style.background = a.color;
        const dotB = el('span', 'insp-dot insp-dot--small');
        dotB.style.background = b.color;
        const val = el('span', `stats-pair-val ${r.value >= 0 ? 'is-good' : 'is-bad'}`, [signed(r.value)]);
        const label = el('span', 'stats-pair-label', [kind ? `${kind.icon ?? ''} ${kind.label}`.trim() : relationshipLabel(r.value)]);
        const btn = el('button', 'stats-pair', [dotA, a.name, ' ↔ ', dotB, b.name, label, val]);
        btn.type = 'button';
        btn.title = 'Pokaż w sieci relacji';
        btn.addEventListener('click', () => {
          pinned = { kind: 'edge', a: r.a, b: r.b };
          drawNetwork();
        });
        btn.addEventListener('pointerenter', () => {
          hover = { kind: 'edge', a: r.a, b: r.b };
          drawNetwork();
        });
        btn.addEventListener('pointerleave', () => {
          hover = null;
          drawNetwork();
        });
        return el('li', '', [btn]);
      }),
    );
  }

  function update(): void {
    if (!open) return;
    renderTable();
    renderPairs();
    drawNetwork();
    drawChart();
  }

  function setOpen(o: boolean): void {
    if (o === open) return;
    open = o;
    root.hidden = !o;
    if (!o) {
      hover = pinned = null;
      setFocus(null);
    }
    opts.onToggle?.(o);
    if (o) requestAnimationFrame(update);
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (isTypingTarget(e)) return;
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        setOpen(false);
      } else if (e.code === 'KeyT' && !e.repeat) setOpen(!open);
    },
    true,
  );
  window.addEventListener('resize', () => open && update());

  return {
    get isOpen() {
      return open;
    },
    setOpen,
    update,
    setWorld(w) {
      if (w === world) return;
      const ids = (x: World) => x.agents.map((a) => `${a.id}:${a.name}`).join('|');
      const sameCast = ids(w) === ids(world);
      world = w;
      if (!sameCast) {
        hover = pinned = null;
        rowsKey = '';
        pairsKey = '';
        nodePos = new Map();
        setFocus(null);
      }
      update();
    },
  };
}
