"use strict";

const OLLAMA_URL = normalizeBaseUrl(process.env.OLLAMA_URL || "http://localhost:11434");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:4b";
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:3b";
const OLLAMA_THINK = normalizeBoolean(process.env.OLLAMA_THINK, false);
const OLLAMA_NUM_CTX = clampInteger(process.env.OLLAMA_NUM_CTX, 512, 32768, 2048);
const OLLAMA_KEEP_ALIVE = String(process.env.OLLAMA_KEEP_ALIVE || "10m").trim() || "10m";

const AI_PROVIDER = normalizeProvider(process.env.AI_PROVIDER || "ollama");
const AIRLLM_URL = normalizeBaseUrl(process.env.AIRLLM_URL || "http://localhost:8001");
const AIRLLM_API_KEY = String(process.env.AIRLLM_API_KEY || "").trim();
const AIRLLM_MODEL_LABEL = process.env.AIRLLM_MODEL_LABEL || "Devstral-Small-2505-AirLLM";
const AIRLLM_MAX_NEW_TOKENS = clampInteger(process.env.AIRLLM_MAX_NEW_TOKENS, 1, 32, 1);
const AIRLLM_TEMPERATURE = clampNumber(process.env.AIRLLM_TEMPERATURE, 0, 2, 0);
const AIRLLM_VISION_FALLBACK = normalizeVisionFallback(
  process.env.AIRLLM_VISION_FALLBACK || "ollama"
);

class AIProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AIProviderError";
    this.status = Number(options.status || 500);
    this.publicMessage = options.publicMessage || message;
    this.provider = options.provider || AI_PROVIDER;
    this.detail = options.detail || "";
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "ollama" || normalized === "airllm") return normalized;
  throw new Error(`Unsupported AI_PROVIDER "${value}". Use "ollama" or "airllm".`);
}

function normalizeVisionFallback(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "ollama" || normalized === "reject") return normalized;
  throw new Error(
    `Unsupported AIRLLM_VISION_FALLBACK "${value}". Use "ollama" or "reject".`
  );
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function toAirLLMMessages(messages) {
  return messages
    .filter((message) => message && typeof message.content === "string")
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

async function readErrorResponse(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return "";

  try {
    const parsed = JSON.parse(raw);
    return String(parsed.detail || parsed.error || parsed.message || raw);
  } catch {
    return raw;
  }
}

function connectionFailure(error, provider) {
  if (error?.name === "AbortError") return error;

  if (provider === "airllm") {
    return new AIProviderError(error?.message || "AirLLM request failed.", {
      provider,
      publicMessage:
        "The Devstral AirLLM service is not responding. Start the WSL Uvicorn API on port 8001 and try again.",
    });
  }

  return new AIProviderError(error?.message || "Ollama request failed.", {
    provider,
    publicMessage: "The Ollama service is not responding. Check that Ollama is running on this PC.",
  });
}

async function generateWithOllama({ messages, needsVision, signal, onReady, onText }) {
  const selectedModel = needsVision ? OLLAMA_VISION_MODEL : OLLAMA_MODEL;
  let response;

  const requestBody = {
    model: selectedModel,
    messages,
    stream: true,
    keep_alive: OLLAMA_KEEP_ALIVE,
  };

  if (!needsVision) {
    requestBody.think = OLLAMA_THINK;
    requestBody.options = {
      num_ctx: OLLAMA_NUM_CTX,
    };
  }

  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    throw connectionFailure(error, "ollama");
  }

  if (!response.ok || !response.body) {
    const detail = await readErrorResponse(response);
    let publicMessage = detail || `Ollama returned status ${response.status}.`;

    if (needsVision && /not found|pull model/i.test(detail)) {
      publicMessage = `Image support requires the ${OLLAMA_VISION_MODEL} model. Run: ollama pull ${OLLAMA_VISION_MODEL}`;
    }

    throw new AIProviderError(detail || publicMessage, {
      provider: "ollama",
      status: response.status >= 400 && response.status < 500 ? response.status : 500,
      publicMessage,
      detail,
    });
  }

  onReady?.({ provider: "ollama", model: selectedModel, mode: "stream" });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullReply = "";

  while (true) {
    const result = await reader.read();
    if (result.done) break;

    buffer += decoder.decode(result.value, { stream: true });
    let newlineIndex;

    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.error) {
        throw new AIProviderError(String(parsed.error), {
          provider: "ollama",
          publicMessage: String(parsed.error),
        });
      }

      const piece = parsed.message?.content || "";
      if (!piece) continue;

      fullReply += piece;
      onText?.(piece);
    }
  }

  return {
    provider: "ollama",
    model: selectedModel,
    mode: "stream",
    response: fullReply,
  };
}

async function generateWithAirLLM({ messages, signal, onReady, onText }) {
  let response;
  const headers = { "Content-Type": "application/json" };
  if (AIRLLM_API_KEY) headers["X-API-Key"] = AIRLLM_API_KEY;

  try {
    response = await fetch(`${AIRLLM_URL}/v1/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: toAirLLMMessages(messages),
        max_new_tokens: AIRLLM_MAX_NEW_TOKENS,
        temperature: AIRLLM_TEMPERATURE,
      }),
      signal,
    });
  } catch (error) {
    throw connectionFailure(error, "airllm");
  }

  if (!response.ok) {
    const detail = await readErrorResponse(response);
    let publicMessage = detail || `AirLLM returned status ${response.status}.`;

    if (response.status === 401) {
      publicMessage =
        "The AirLLM API key does not match. Set the same AIRLLM_API_KEY in both the Node project and .env.airllm.";
    } else if (response.status === 503) {
      publicMessage = detail || "The Devstral model is not ready in the AirLLM service.";
    }

    throw new AIProviderError(detail || publicMessage, {
      provider: "airllm",
      status: response.status >= 400 && response.status < 500 ? response.status : 500,
      publicMessage,
      detail,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new AIProviderError("AirLLM returned invalid JSON.", {
      provider: "airllm",
      publicMessage: "The AirLLM service returned an invalid response.",
      detail: error.message,
    });
  }

  const reply = String(data.response || "");
  onReady?.({
    provider: "airllm",
    model: data.model || AIRLLM_MODEL_LABEL,
    mode: "buffered",
    durationSeconds: data.duration_seconds,
    generatedTokens: data.generated_tokens,
    promptTokens: data.prompt_tokens,
  });

  if (reply) onText?.(reply);

  return {
    provider: "airllm",
    model: data.model || AIRLLM_MODEL_LABEL,
    mode: "buffered",
    response: reply,
    durationSeconds: data.duration_seconds,
    generatedTokens: data.generated_tokens,
    promptTokens: data.prompt_tokens,
    queuedSeconds: data.queued_seconds,
  };
}

async function generateChat(options) {
  const { needsVision } = options;

  if (AI_PROVIDER === "airllm") {
    if (needsVision) {
      if (AIRLLM_VISION_FALLBACK === "ollama") {
        return generateWithOllama(options);
      }

      throw new AIProviderError("Devstral is text-only.", {
        provider: "airllm",
        status: 400,
        publicMessage:
          "The current Devstral AirLLM model cannot inspect images. Remove the image or set AIRLLM_VISION_FALLBACK=ollama.",
      });
    }

    return generateWithAirLLM(options);
  }

  return generateWithOllama(options);
}

async function fetchHealth(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);

  try {
    return await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function checkAIHealth() {
  const result = {
    provider: AI_PROVIDER,
    textModel: AI_PROVIDER === "airllm" ? AIRLLM_MODEL_LABEL : OLLAMA_MODEL,
    visionModel: OLLAMA_VISION_MODEL,
    visionFallback: AI_PROVIDER === "airllm" ? AIRLLM_VISION_FALLBACK : "ollama",
    generation: "unreachable",
    vision: "not-checked",
  };

  if (AI_PROVIDER === "airllm") {
    try {
      const response = await fetchHealth(`${AIRLLM_URL}/health`);
      const data = await response.json().catch(() => ({}));
      result.generation = response.ok && data.status === "ready" ? "connected" : "unreachable";
      result.airllm = data;
    } catch (error) {
      result.airllm = { status: "unreachable", error: error.message };
    }

    if (AIRLLM_VISION_FALLBACK !== "ollama") {
      result.vision = "disabled";
      return result;
    }
  }

  try {
    const response = await fetchHealth(`${OLLAMA_URL}/api/tags`);
    const status = response.ok ? "connected" : "unreachable";

    if (AI_PROVIDER === "ollama") result.generation = status;
    result.vision = status;
  } catch {
    if (AI_PROVIDER === "ollama") result.generation = "unreachable";
    result.vision = "unreachable";
  }

  return result;
}

function getAIConfig() {
  return {
    provider: AI_PROVIDER,
    ollamaUrl: OLLAMA_URL,
    ollamaModel: OLLAMA_MODEL,
    ollamaVisionModel: OLLAMA_VISION_MODEL,
    ollamaThink: OLLAMA_THINK,
    ollamaNumCtx: OLLAMA_NUM_CTX,
    ollamaKeepAlive: OLLAMA_KEEP_ALIVE,
    airllmUrl: AIRLLM_URL,
    airllmModelLabel: AIRLLM_MODEL_LABEL,
    airllmMaxNewTokens: AIRLLM_MAX_NEW_TOKENS,
    airllmTemperature: AIRLLM_TEMPERATURE,
    airllmVisionFallback: AIRLLM_VISION_FALLBACK,
  };
}

module.exports = {
  AIProviderError,
  checkAIHealth,
  generateChat,
  getAIConfig,
};
