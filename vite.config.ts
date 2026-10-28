import { defineConfig } from 'vitest/config';
import { llmProxy } from './server/llmProxy';

export default defineConfig({
  // optional LLM dialogue proxy (/api/llm/*); the API key stays server-side
  plugins: [llmProxy()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
