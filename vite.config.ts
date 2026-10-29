import { defineConfig } from 'vitest/config';
import { llmProxy } from './server/llmProxy';
import { newsProxy } from './server/newsProxy';
import { worldsProxy } from './server/worldsProxy';

export default defineConfig({
  // optional LLM dialogue proxy (/api/llm/*); the API key stays server-side
  // + real news headlines for the TV (/api/news), fetched from public RSS feeds server-side
  // + the four shared live worlds (/api/live/*, server/worlds.ts) on the dev and preview servers
  plugins: [llmProxy(), newsProxy(), worldsProxy()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
