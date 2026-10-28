import { defineConfig } from 'vitest/config';
import { llmProxy } from './server/llmProxy';
import { newsProxy } from './server/newsProxy';

export default defineConfig({
  // optional LLM dialogue proxy (/api/llm/*); the API key stays server-side
  // + real news headlines for the TV (/api/news), fetched from public RSS feeds server-side
  plugins: [llmProxy(), newsProxy()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
