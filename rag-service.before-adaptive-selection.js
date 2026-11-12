require("dotenv").config();

const QDRANT_URL = (
  process.env.QDRANT_URL || "http://127.0.0.1:6333"
).replace(/\/+$/, "");

const OLLAMA_URL = (
  process.env.OLLAMA_URL || "http://localhost:11434"
).replace(/\/+$/, "");

const COLLECTION_NAME =
  process.env.QDRANT_COLLECTION || "jarvis_ai_knowledge";

const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "qwen3-embedding:0.6b";


function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed)
    ? parsed
    : fallback;
}


function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}


const TOP_K = Math.min(
  Math.max(
    parseInteger(process.env.RAG_TOP_K, 5),
    1
  ),
  20
);

const MIN_SCORE = Math.min(
  Math.max(
    parseNumber(process.env.RAG_MIN_SCORE, 0.30),
    -1
  ),
  1
);

const RELATIVE_SCORE_RATIO = Math.min(
  Math.max(
    parseNumber(
      process.env.RAG_RELATIVE_SCORE_RATIO,
      0.70
    ),
    0
  ),
  1
);

const MAX_CONTEXT_CHUNKS = Math.min(
  Math.max(
    parseInteger(
      process.env.RAG_MAX_CONTEXT_CHUNKS,
      3
    ),
    1
  ),
  10
);


/**
 * Safely read JSON returned by Ollama or Qdrant.
 */
async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid JSON response: ${text.slice(0, 300)}`
    );
  }
}


/**
 * Build useful API error text.
 */
function getErrorMessage(data, response) {
  return (
    data?.status?.error ||
    data?.error ||
    data?.message ||
    `HTTP ${response.status} ${response.statusText}`
  );
}


/**
 * Convert text into a vector using
 * qwen3-embedding through Ollama.
 */
async function createEmbedding(text) {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    throw new Error(
      "Cannot create an embedding for empty text."
    );
  }

  const response = await fetch(
    `${OLLAMA_URL}/api/embed`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: cleanText,
      }),
    }
  );

  const data = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `Embedding failed: ${getErrorMessage(
        data,
        response
      )}`
    );
  }

  const vector = data?.embeddings?.[0];

  if (
    !Array.isArray(vector) ||
    vector.length === 0
  ) {
    throw new Error(
      "Embedding model returned no vector."
    );
  }

  return vector;
}


/**
 * Retrieve several candidate chunks from Qdrant.
 */
async function searchKnowledge(questionVector) {
  const response = await fetch(
    `${QDRANT_URL}/collections/${encodeURIComponent(
      COLLECTION_NAME
    )}/points/query`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        query: questionVector,
        limit: TOP_K,
        with_payload: true,
        with_vector: false,
      }),
    }
  );

  const data = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `Qdrant search failed: ${getErrorMessage(
        data,
        response
      )}`
    );
  }

  const points = data?.result?.points || [];

  return points
    .map((point) => ({
      id: point.id,

      score:
        Number(point.score || 0),

      text:
        point.payload?.text || "",

      topic:
        point.payload?.topic || "unknown",

      fileName:
        point.payload?.fileName || "unknown",

      documentId:
        point.payload?.documentId || null,

      chunkIndex:
        point.payload?.chunkIndex ?? null,
    }))
    .filter((point) => point.text)
    .sort((a, b) => b.score - a.score);
}


/**
 * Decide which Qdrant candidates are strong enough
 * to send to the main language model.
 *
 * Two checks are applied:
 *
 * 1. Absolute relevance:
 *    score >= MIN_SCORE
 *
 * 2. Relative relevance:
 *    score >= bestScore * RELATIVE_SCORE_RATIO
 *
 * This prevents weak search results from being
 * blindly passed to Jarvis.
 */
function selectRelevantChunks(candidates) {
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0
  ) {
    return [];
  }

  const ordered = [...candidates]
    .filter(
      (candidate) =>
        candidate?.text &&
        Number.isFinite(candidate.score)
    )
    .sort((a, b) => b.score - a.score);

  if (!ordered.length) {
    return [];
  }

  const bestScore = ordered[0].score;

  /*
   * If even the strongest result is below our
   * absolute relevance floor, don't supply RAG
   * context at all.
   */
  if (bestScore < MIN_SCORE) {
    return [];
  }

  const relativeFloor =
    bestScore * RELATIVE_SCORE_RATIO;

  const effectiveThreshold =
    Math.max(
      MIN_SCORE,
      relativeFloor
    );

  return ordered
    .filter(
      (candidate) =>
        candidate.score >= effectiveThreshold
    )
    .slice(
      0,
      MAX_CONTEXT_CHUNKS
    );
}


/**
 * Convert selected knowledge chunks into context
 * that can later be supplied to buildSystemPrompt().
 */
function buildContext(chunks) {
  if (
    !Array.isArray(chunks) ||
    chunks.length === 0
  ) {
    return "";
  }

  return chunks
    .filter((chunk) => chunk?.text)
    .map((chunk, index) => {
      return [
        `[Knowledge ${index + 1}]`,
        `Topic: ${chunk.topic || "unknown"}`,
        `Source: ${chunk.fileName || "unknown"}`,
        `Content: ${chunk.text}`,
      ].join("\n");
    })
    .join("\n\n");
}


/**
 * Complete retrieval pipeline.
 */
async function retrieveKnowledge(question) {
  const cleanQuestion =
    String(question || "").trim();

  if (!cleanQuestion) {
    return {
      question: "",
      candidates: [],
      chunks: [],
      context: "",
      bestScore: null,
      threshold: null,
    };
  }

  const questionVector =
    await createEmbedding(cleanQuestion);

  const candidates =
    await searchKnowledge(questionVector);

  const chunks =
    selectRelevantChunks(candidates);

  const context =
    buildContext(chunks);

  const bestScore =
    candidates.length
      ? candidates[0].score
      : null;

  const threshold =
    bestScore !== null &&
    bestScore >= MIN_SCORE
      ? Math.max(
          MIN_SCORE,
          bestScore * RELATIVE_SCORE_RATIO
        )
      : null;

  return {
    question: cleanQuestion,
    candidates,
    chunks,
    context,
    bestScore,
    threshold,
  };
}


module.exports = {
  createEmbedding,
  searchKnowledge,
  selectRelevantChunks,
  buildContext,
  retrieveKnowledge,
};


/*
 * ------------------------------------------------------------
 * COMMAND-LINE DIAGNOSTIC MODE
 * ------------------------------------------------------------
 */

if (require.main === module) {
  const question =
    process.argv
      .slice(2)
      .join(" ")
      .trim();

  if (!question) {
    console.error(
      'Usage: node rag-service.js "your question"'
    );

    process.exit(1);
  }

  console.log(
    "============================================================"
  );

  console.log(
    "STAGE B2 — RELEVANCE-AWARE MULTI-CHUNK RAG"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `Question           : ${question}`
  );

  console.log(
    `Collection         : ${COLLECTION_NAME}`
  );

  console.log(
    `Embedding model    : ${EMBEDDING_MODEL}`
  );

  console.log(
    `Top-K              : ${TOP_K}`
  );

  console.log(
    `Minimum score      : ${MIN_SCORE}`
  );

  console.log(
    `Relative ratio     : ${RELATIVE_SCORE_RATIO}`
  );

  console.log(
    `Max context chunks : ${MAX_CONTEXT_CHUNKS}`
  );


  retrieveKnowledge(question)
    .then((result) => {
      console.log();

      console.log(
        "========== ALL QDRANT CANDIDATES =========="
      );

      if (!result.candidates.length) {
        console.log(
          "No knowledge candidates returned."
        );
      }

      result.candidates.forEach(
        (candidate, index) => {
          console.log();

          console.log(
            `${index + 1}. ` +
            `Score=${candidate.score.toFixed(4)} | ` +
            `Topic=${candidate.topic}`
          );

          console.log(
            `   ${candidate.text}`
          );
        }
      );


      console.log();

      console.log(
        "========== RELEVANCE DECISION =========="
      );

      if (result.bestScore === null) {
        console.log(
          "Best score : none"
        );
      } else {
        console.log(
          `Best score : ${result.bestScore.toFixed(4)}`
        );
      }

      if (result.threshold === null) {
        console.log(
          "Threshold  : no RAG context"
        );
      } else {
        console.log(
          `Threshold  : ${result.threshold.toFixed(4)}`
        );
      }


      console.log();

      console.log(
        "========== SELECTED RAG CHUNKS =========="
      );

      if (!result.chunks.length) {
        console.log(
          "No sufficiently relevant knowledge selected."
        );
      }

      result.chunks.forEach(
        (chunk, index) => {
          console.log();

          console.log(
            `${index + 1}. ` +
            `Score=${chunk.score.toFixed(4)} | ` +
            `Topic=${chunk.topic}`
          );

          console.log(
            `   ${chunk.text}`
          );
        }
      );


      console.log();

      console.log(
        "========== CONTEXT FOR QWEN =========="
      );

      console.log();

      console.log(
        result.context ||
        "[No RAG context]"
      );


      console.log();

      console.log(
        "============================================================"
      );

      console.log(
        "STAGE B2 COMPLETED"
      );

      console.log(
        "============================================================"
      );
    })
    .catch((error) => {
      console.error();

      console.error(
        "❌ Stage B2 failed"
      );

      console.error(
        error.message
      );

      process.exit(1);
    });
}