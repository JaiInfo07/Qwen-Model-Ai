# AirLLM + Devstral integration

This project can now switch between the original Ollama text model and the
Devstral Small 2505 model served by the AirLLM FastAPI service in WSL.

## Architecture

```text
Browser UI
   -> POST /api/chat
Node.js provider router
   -> AirLLM FastAPI /v1/chat for normal text conversations
   -> Ollama qwen2.5vl:3b only when an image is attached and fallback is enabled
AirLLM
   -> Devstral-Small-2505 split model on CPU
```

The UI, authentication, conversations, attachments, Markdown rendering, and
message storage still use the existing project flow.

## 1. Start the AirLLM API in WSL

Use the AirLLM environment that already passed the one-token test:

```bash
cd ~/airLLM
source .venv/bin/activate
export HF_HOME="$HOME/airLLM/storage/hf-cache"

uvicorn airllm_api:app \
  --host 0.0.0.0 \
  --port 8001 \
  --workers 1
```

Verify from WSL:

```bash
curl -s http://127.0.0.1:8001/health | python -m json.tool
```

Verify from Windows PowerShell:

```powershell
Invoke-RestMethod -Uri "http://localhost:8001/health" -Method Get
```

The health response must show `status: ready`.

## 2. Provider configuration

The supplied `.env` is set to Devstral:

```text
AI_PROVIDER=airllm
AIRLLM_URL=http://localhost:8001
AIRLLM_API_KEY=devstral-local-secret
AIRLLM_MODEL_LABEL=Devstral-Small-2505-AirLLM
AIRLLM_MAX_NEW_TOKENS=1
AIRLLM_TEMPERATURE=0
AIRLLM_VISION_FALLBACK=ollama
```

`AIRLLM_API_KEY` must exactly match the value in `~/airLLM/.env.airllm`.

The first verification uses one output token because the measured CPU-only
speed was roughly seven minutes for one token. Increase the value gradually,
up to the Python API's configured maximum, after confirming the full project
flow.

## 3. Start the Node project

From the project directory:

```bash
npm install
npm run check
npm run test:ai
npm start
```

Open `http://localhost:3500`, log in, create a new chat, and first send:

```text
Reply with only the word OK.
```

The typing indicator remains visible while Devstral is running. The current
AirLLM endpoint is buffered, so the browser receives the generated content only
when the Python API completes the request.

## 4. Check provider status

Open:

```text
http://localhost:3500/api/health
```

Expected key values:

```json
{
  "server": "ok",
  "aiProvider": "airllm",
  "generation": "connected",
  "textModel": "Devstral-Small-2505-AirLLM"
}
```

When `AIRLLM_VISION_FALLBACK=ollama`, the health output also reports whether
Ollama is available for image attachments.

## 5. Roll back to the old model

Change only this value in `.env`:

```text
AI_PROVIDER=ollama
```

Restart Node.js. Normal text chats will immediately use `OLLAMA_MODEL` again.
No frontend or database changes are required.

## Current limitations

- Devstral Small 2505 is text-only. Image attachments use the old Ollama vision
  model when fallback is enabled.
- The AirLLM API returns a complete JSON response rather than token streaming.
  The Node route converts it into the same plain-text response expected by the
  current browser UI.
- Aborting the browser request stops the browser and Node connection, but the
  synchronous Python generation may continue on the CPU. Stop/restart Uvicorn
  to terminate that computation immediately.
- The Python API currently limits input and output tokens according to
  `~/airLLM/.env.airllm`. Large histories or extracted attachments may exceed
  that input limit.
- Ollama remains required for the current embedding scripts and optional vision
  fallback even while Devstral is the text-generation provider.
