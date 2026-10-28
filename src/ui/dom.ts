/** tiny DOM helper: el('div', 'cls', [children]) */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const c of children) node.append(c);
  return node;
}

/** sets textContent only when it changed (avoids layout churn at 5 Hz) */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** colour for a 0..100 value: red → amber → green */
export function valueColor(v: number): string {
  const c = Math.max(0, Math.min(100, v));
  return `hsl(${Math.round(c * 1.25)}, 75%, 50%)`;
}

export function setBar(fill: HTMLElement, value: number, color = valueColor(value)): void {
  const w = `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
  if (fill.style.width !== w) fill.style.width = w;
  if (fill.dataset.color !== color) {
    fill.dataset.color = color;
    fill.style.background = color;
  }
}

export function moodEmoji(mood: number): string {
  if (mood >= 80) return '😄';
  if (mood >= 60) return '🙂';
  if (mood >= 40) return '😐';
  if (mood >= 20) return '🙁';
  return '😫';
}

/** true when a key event should be left to a text field (or a modifier shortcut) */
export function isTypingTarget(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  // a modal dialog (new world) owns the keyboard
  if (document.body.dataset.modal === 'open') return true;
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** best-effort localStorage access (private mode, blocked storage, quota) */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** canvas sized to its CSS box with devicePixelRatio; returns the context in CSS pixels, or null if hidden */
export function fitCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const r = canvas.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(r.width * dpr);
  const ph = Math.round(r.height * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  return { ctx, w: r.width, h: r.height };
}
