"use strict";

const assert = require("assert");
const http = require("http");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function main() {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ready", model: "Devstral-Small-2505" }));
      return;
    }

    if (req.url === "/v1/chat") {
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.max_new_tokens, 2);
      assert.strictEqual(parsed.temperature, 0);
      assert.strictEqual(req.headers["x-api-key"], "test-key");
      assert.ok(parsed.messages.every((message) => !Object.hasOwn(message, "images")));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "Devstral-Small-2505-AirLLM",
          response: "Mock Devstral response",
          generated_tokens: 2,
          prompt_tokens: 12,
          duration_seconds: 1.25,
          queued_seconds: 0,
        })
      );
      return;
    }

    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }

    if (req.url === "/api/chat") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { content: "Vision " } }) + "\n");
      res.end(JSON.stringify({ message: { content: "fallback" }, done: true }) + "\n");
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  process.env.AI_PROVIDER = "airllm";
  process.env.AIRLLM_URL = baseUrl;
  process.env.AIRLLM_API_KEY = "test-key";
  process.env.AIRLLM_MAX_NEW_TOKENS = "2";
  process.env.AIRLLM_TEMPERATURE = "0";
  process.env.AIRLLM_VISION_FALLBACK = "ollama";
  process.env.OLLAMA_URL = baseUrl;
  process.env.OLLAMA_MODEL = "qwen2.5:3b";
  process.env.OLLAMA_VISION_MODEL = "qwen2.5vl:3b";

  const { checkAIHealth, generateChat, getAIConfig } = require("../ai-provider");

  const textPieces = [];
  let textReady;
  const textResult = await generateChat({
    messages: [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hello", images: ["ignored-for-airllm"] },
    ],
    needsVision: false,
    onReady: (metadata) => {
      textReady = metadata;
    },
    onText: (piece) => textPieces.push(piece),
  });

  assert.strictEqual(textResult.provider, "airllm");
  assert.strictEqual(textResult.response, "Mock Devstral response");
  assert.strictEqual(textPieces.join(""), "Mock Devstral response");
  assert.strictEqual(textReady.mode, "buffered");

  const visionPieces = [];
  const visionResult = await generateChat({
    messages: [{ role: "user", content: "Inspect this", images: ["base64"] }],
    needsVision: true,
    onText: (piece) => visionPieces.push(piece),
  });

  assert.strictEqual(visionResult.provider, "ollama");
  assert.strictEqual(visionResult.model, "qwen2.5vl:3b");
  assert.strictEqual(visionPieces.join(""), "Vision fallback");

  const health = await checkAIHealth();
  assert.strictEqual(health.provider, "airllm");
  assert.strictEqual(health.generation, "connected");
  assert.strictEqual(health.vision, "connected");

  const config = getAIConfig();
  assert.strictEqual(config.provider, "airllm");
  assert.strictEqual(config.airllmMaxNewTokens, 2);

  assert.ok(requests.some((request) => request.url === "/v1/chat"));
  assert.ok(requests.some((request) => request.url === "/api/chat"));

  await new Promise((resolve) => server.close(resolve));
  console.log("AI provider integration tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
