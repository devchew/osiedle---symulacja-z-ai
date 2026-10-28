import './ui.css';
import { el } from './dom';

let host: HTMLElement | null = null;

/** short notice at the bottom centre, e.g. "Zapisano w slocie 1" */
export function toast(text: string, kind: 'info' | 'warn' = 'info', ms = 3200): void {
  if (!host || !host.isConnected) {
    host = el('div', 'ui-toasts');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const t = el('div', `ui-panel ui-toast ui-toast--${kind}`, [text]);
  host.append(t);
  setTimeout(() => {
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), 300);
  }, ms);
}
