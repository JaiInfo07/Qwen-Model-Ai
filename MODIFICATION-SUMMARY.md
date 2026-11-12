# Devstral AirLLM integration summary

## Added

- `ai-provider.js`
  - Switches normal text generation between Ollama and AirLLM.
  - Sends Devstral requests to `POST /v1/chat`.
  - Preserves Ollama token streaming.
  - Supports optional Ollama vision fallback for image attachments.
  - Provides provider-aware health checks and clear errors.
- `scripts/test-ai-provider.cjs`
  - Tests AirLLM text calls, API-key forwarding, buffered responses,
    Ollama image fallback, and provider health checks using local mocks.
- `AIRLLM-INTEGRATION.md`
  - Contains the exact WSL/Node startup and verification flow.

## Changed

- `server.js`
  - Routes `/api/chat` through the provider module.
  - Keeps the existing browser response format and database persistence.
  - Adds provider/model response headers.
  - Reports AirLLM and fallback status through `/api/health`.
- `.env` and `.env.example`
  - Add the provider switch and Devstral API settings.
- `package.json` and `package-lock.json`
  - Version updated to 6.4.0.
  - Adds `npm run test:ai`.
- `README.md`
  - Adds startup, rollback, and provider configuration notes.

## Initial active configuration

```text
AI_PROVIDER=airllm
AIRLLM_URL=http://localhost:8001
AIRLLM_MAX_NEW_TOKENS=1
AIRLLM_VISION_FALLBACK=ollama
```

Change `AI_PROVIDER=ollama` and restart Node.js for immediate rollback.
