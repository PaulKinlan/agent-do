/**
 * Example 19: Z.ai (GLM) provider
 *
 * Z.ai (Zhipu AI) exposes an OpenAI-compatible API, so we reuse the
 * bundled @ai-sdk/openai against Z.ai's endpoint — no extra install
 * beyond agent-do and @ai-sdk/openai.
 *
 * Equivalent CLI invocation:
 *
 *   export ZAI_API_KEY=...
 *   npx agent-do --provider zai --model glm-4.6 "Explain CRDTs"
 *
 * Run:
 *
 *   export ZAI_API_KEY=...        # https://z.ai/
 *   npx tsx examples/19-zai.ts
 *
 * Optional:
 *   ZAI_BASE_URL  override the endpoint (e.g. the GLM Coding Plan
 *                endpoint at https://api.z.ai/api/coding/paas/v4).
 */

import { createAgent } from 'agent-do';
import { createOpenAI } from '@ai-sdk/openai';

// Z.ai is OpenAI-compatible: same client, different baseURL + apiKey.
// Setting `name: 'zai'` keeps provider metadata/debug output honest.
const zai = createOpenAI({
  baseURL: process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/paas/v4',
  apiKey: process.env.ZAI_API_KEY,
  name: 'zai',
});

const agent = createAgent({
  id: 'zai-demo',
  name: 'Z.ai Demo',
  model: zai('glm-4.6'),
  systemPrompt: 'You are a concise, helpful assistant.',
});

const prompt = process.argv[2] ?? 'Explain CRDTs in two sentences.';
const result = await agent.run(prompt);
console.log(result);
