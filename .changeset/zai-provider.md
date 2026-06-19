---
"agent-do": minor
---

Add Z.ai (Zhipu AI / GLM) as a first-class CLI provider via its OpenAI-compatible endpoint. `npx agent-do --provider zai --model glm-4.6` works out of the box — it reuses the bundled `@ai-sdk/openai` against `https://api.z.ai/api/paas/v4`, so no new dependency. Set `ZAI_API_KEY`; override the endpoint with `ZAI_BASE_URL` (e.g. for the GLM Coding Plan endpoint at `/api/coding/paas/v4`). Library example added at `examples/19-zai.ts`.
