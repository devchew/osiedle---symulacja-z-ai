import type { DialogueProvider, World } from '../types';
import { createLlmProvider, fetchLlmStatus, isFreeModel, modelShortName, type LlmStatus } from '../social/llmProvider';
import './llmToggle.css';

// Small pill (top-left) switching world.dialogue between the procedural and the
// LLM provider (OpenRouter via the local proxy). Hidden-ish when the proxy reports no API key.

const STORAGE_KEY = 'sim.llmDialogue';

function readPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writePref(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable: choice just isn't remembered */
  }
}

export interface LlmToggle {
  readonly enabled: boolean;
  readonly status: LlmStatus;
  setEnabled(on: boolean): void;
}

/** mounts the toggle into `parent`; resolves once the proxy status is known */
export async function createLlmToggle(parent: HTMLElement, world: World): Promise<LlmToggle> {
  const procedural: DialogueProvider = world.dialogue;
  const llm = createLlmProvider();
  const status = await fetchLlmStatus();
  let enabled = false;

  const root = document.createElement('div');
  root.className = 'llm-toggle';
  root.dataset.testid = 'llm-toggle';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'llm-pill';
  const dot = document.createElement('span');
  dot.className = 'llm-dot';
  const label = document.createElement('span');
  button.append(dot, label);
  root.append(button);

  const allFree = status.models.length > 0 && status.models.every(isFreeModel);
  const aiLabel = allFree || !status.models.length ? 'Dialogi: AI (free)' : `Dialogi: AI (${modelShortName(status.models[0])})`;
  const modelList = status.models.length ? `\nModele (OpenRouter, kolejno): ${status.models.join(', ')}` : '';

  const render = (): void => {
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('on', enabled);
    label.textContent = enabled ? aiLabel : 'Dialogi: proceduralne';
    button.title =
      (enabled
        ? 'Kwestie generuje AI przez OpenRouter. Kliknij, by wrócić do proceduralnych.'
        : 'Kliknij, by kwestie generowało AI (OpenRouter).') + modelList;
  };

  const setEnabled = (on: boolean): void => {
    enabled = on && status.available;
    world.dialogue = enabled ? llm : procedural;
    render();
  };

  if (status.available) {
    button.addEventListener('click', () => {
      setEnabled(!enabled);
      writePref(enabled);
    });
    setEnabled(readPref());
  } else {
    button.disabled = true;
    button.classList.add('off');
    label.textContent = 'AI: brak klucza';
    // disabled buttons swallow hover in some browsers: put the tooltip on the wrapper too
    button.title = root.title = 'Dialogi AI wyłączone — ustaw OPENROUTER_API_KEY w .env i uruchom serwer ponownie';
  }
  parent.append(root);

  return {
    get enabled() {
      return enabled;
    },
    status,
    setEnabled,
  };
}
