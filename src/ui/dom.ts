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
