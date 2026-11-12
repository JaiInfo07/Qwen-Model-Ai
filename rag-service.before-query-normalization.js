require("dotenv").config();

const QDRANT_URL = (
  process.env.QDRANT_URL ||
  "http://127.0.0.1:6333"
).replace(/\/+$/, "");

const OLLAMA_URL = (
  process.env.OLLAMA_URL ||
  "http://localhost:11434"
).replace(/\/+$/, "");

const COLLECTION_NAME =
  process.env.QDRANT_COLLECTION ||
  "jarvis_ai_knowledge_prod";

const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ||
  "qwen3-embedding:0.6b";


function parseInteger(value, fallback) {
  const parsed =
    Number.parseInt(value, 10);

  return Number.isInteger(parsed)
    ? parsed
    : fallback;
}


function parseNumber(value, fallback) {
  const parsed =
    Number.parseFloat(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}


/*
 * ============================================================
 * RAG CONFIGURATION
 * ============================================================
 */

const TOP_K = Math.min(
  Math.max(
    parseInteger(
      process.env.RAG_TOP_K,
      5
    ),
    1
  ),
  20
);


/*
 * Absolute safety floor.
 *
 * Even adaptive selection must not accept extremely weak
 * semantic matches.
 */
const MIN_SCORE = Math.min(
  Math.max(
    parseNumber(
      process.env.RAG_MIN_SCORE,
      0.30
    ),
    -1
  ),
  1
);


/*
 * Maximum amount of knowledge we allow into Qwen context.
 */
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


/*
 * Adaptive gap threshold.
 *
 * If adjacent semantic results have a gap >= this value,
 * we treat that as a possible boundary between:
 *
 * relevant knowledge
 *
 * and
 *
 * weaker/background knowledge.
 */
const MIN_MEANINGFUL_GAP = Math.min(
  Math.max(
    parseNumber(
      process.env.RAG_MIN_SCORE_GAP,
      0.07
    ),
    0
  ),
  1
);


/*
 * ============================================================
 * HTTP HELPERS
 * ============================================================
 */

async function readJsonResponse(response) {
  const text =
    await response.text();

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


function getErrorMessage(
  data,
  response
) {
  return (
    data?.status?.error ||
    data?.error ||
    data?.message ||
    `HTTP ${response.status} ${response.statusText}`
  );
}


/*
 * ============================================================
 * EMBEDDINGS
 * ============================================================
 */

async function createEmbedding(text) {
  const cleanText =
    String(text || "").trim();

  if (!cleanText) {
    throw new Error(
      "Cannot create an embedding for empty text."
    );
  }


  const response =
    await fetch(
      `${OLLAMA_URL}/api/embed`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            EMBEDDING_MODEL,

          input:
            cleanText,
        }),
      }
    );


  const data =
    await readJsonResponse(
      response
    );


  if (!response.ok) {
    throw new Error(
      `Embedding failed: ${getErrorMessage(
        data,
        response
      )}`
    );
  }


  const vector =
    data?.embeddings?.[0];


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


/*
 * ============================================================
 * QDRANT SEARCH
 * ============================================================
 */

async function searchKnowledge(
  questionVector
) {
  const response =
    await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(
        COLLECTION_NAME
      )}/points/query`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          query:
            questionVector,

          limit:
            TOP_K,

          with_payload:
            true,

          with_vector:
            false,
        }),
      }
    );


  const data =
    await readJsonResponse(
      response
    );


  if (!response.ok) {
    throw new Error(
      `Qdrant search failed: ${getErrorMessage(
        data,
        response
      )}`
    );
  }


  const points =
    data?.result?.points || [];


  return points
    .map(
      (point) => ({
        id:
          point.id,

        score:
          Number(
            point.score || 0
          ),

        text:
          point.payload?.text ||
          "",

        topic:
          point.payload?.topic ||
          point.payload?.section ||
          "unknown",

        section:
          point.payload?.section ||
          point.payload?.topic ||
          "unknown",

        title:
          point.payload?.title ||
          "unknown",

        fileName:
          point.payload?.fileName ||
          "unknown",

        sourcePath:
          point.payload?.sourcePath ||
          null,

        sourceType:
          point.payload?.sourceType ||
          null,

        trustLevel:
          point.payload?.trustLevel ||
          null,

        documentId:
          point.payload?.documentId ||
          null,

        chunkIndex:
          point.payload?.chunkIndex ??
          null,

        chunkCount:
          point.payload?.chunkCount ??
          null,

        sectionChunkIndex:
          point.payload?.sectionChunkIndex ??
          null,

        sectionChunkCount:
          point.payload?.sectionChunkCount ??
          null,
      })
    )
    .filter(
      (point) =>
        point.text &&
        Number.isFinite(
          point.score
        )
    )
    .sort(
      (a, b) =>
        b.score - a.score
    );
}


/*
 * ============================================================
 * ADAPTIVE RELEVANCE SELECTION
 * ============================================================
 *
 * Previous logic used:
 *
 * bestScore * fixed ratio
 *
 * That worked for some queries but could keep unnecessary
 * chunks such as Payments for a leave-encashment question.
 *
 * New logic:
 *
 * 1. Apply absolute MIN_SCORE.
 *
 * 2. Inspect score differences between adjacent candidates.
 *
 * 3. Find the largest meaningful gap within the portion that
 *    could enter our Qwen context.
 *
 * 4. Keep everything above that gap.
 *
 * 5. Never exceed MAX_CONTEXT_CHUNKS.
 *
 *
 * Example — single intent:
 *
 * Leaves encashment  0.6426
 *                    ↓ gap 0.0796
 * Payments           0.5630
 *
 * Selected:
 * Leaves encashment only
 *
 *
 * Example — multi intent:
 *
 * Leaves encashment  0.6009
 * Leaves             0.5609
 *                    ↓ gap 0.1270
 * Holiday payout     0.4339
 *
 * Selected:
 * Leaves encashment + Leaves
 */

function selectRelevantChunks(
  candidates
) {
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0
  ) {
    return {
      chunks: [],
      gaps: [],
      cutAfterIndex: null,
      selectionReason:
        "no_candidates",
    };
  }


  const ordered =
    [...candidates]
      .filter(
        (candidate) =>
          candidate?.text &&
          Number.isFinite(
            candidate.score
          )
      )
      .sort(
        (a, b) =>
          b.score - a.score
      );


  if (!ordered.length) {
    return {
      chunks: [],
      gaps: [],
      cutAfterIndex: null,
      selectionReason:
        "no_valid_candidates",
    };
  }


  /*
   * Strongest result must satisfy the absolute floor.
   */
  if (
    ordered[0].score <
    MIN_SCORE
  ) {
    return {
      chunks: [],
      gaps: [],
      cutAfterIndex: null,
      selectionReason:
        "best_score_below_minimum",
    };
  }


  /*
   * Ignore candidates below the absolute floor completely.
   */
  const eligible =
    ordered.filter(
      (candidate) =>
        candidate.score >=
        MIN_SCORE
    );


  if (!eligible.length) {
    return {
      chunks: [],
      gaps: [],
      cutAfterIndex: null,
      selectionReason:
        "no_candidate_above_minimum",
    };
  }


  /*
   * We only need enough candidates to decide what may enter
   * the maximum context window, plus a small look-ahead.
   */
  const analysisLimit =
    Math.min(
      eligible.length,
      MAX_CONTEXT_CHUNKS + 2
    );


  const analysisPool =
    eligible.slice(
      0,
      analysisLimit
    );


  const gaps = [];


  for (
    let index = 0;
    index <
      analysisPool.length - 1;
    index++
  ) {
    const current =
      analysisPool[index];

    const next =
      analysisPool[index + 1];

    gaps.push({
      afterIndex:
        index,

      fromScore:
        current.score,

      toScore:
        next.score,

      gap:
        current.score -
        next.score,
    });
  }


  /*
   * Only gaps occurring before/at our maximum selected region
   * can affect context selection.
   */
  const meaningfulGaps =
    gaps.filter(
      (item) =>
        item.afterIndex <
          MAX_CONTEXT_CHUNKS &&
        item.gap >=
          MIN_MEANINGFUL_GAP
    );


  let cutAfterIndex =
    null;


  if (
    meaningfulGaps.length
  ) {
    /*
     * Choose the strongest cluster boundary.
     */
    const largestGap =
      [...meaningfulGaps]
        .sort(
          (a, b) =>
            b.gap - a.gap
        )[0];


    cutAfterIndex =
      largestGap.afterIndex;
  }


  let chunks;


  if (
    cutAfterIndex !== null
  ) {
    chunks =
      analysisPool.slice(
        0,
        Math.min(
          cutAfterIndex + 1,
          MAX_CONTEXT_CHUNKS
        )
      );
  } else {
    /*
     * No obvious boundary.
     *
     * Fall back to top N instead of throwing away potentially
     * useful multi-intent information.
     */
    chunks =
      analysisPool.slice(
        0,
        MAX_CONTEXT_CHUNKS
      );
  }


  return {
    chunks,

    gaps,

    cutAfterIndex,

    selectionReason:
      cutAfterIndex !== null
        ? "adaptive_score_gap"
        : "top_chunks_fallback",
  };
}


/*
 * ============================================================
 * BUILD QWEN CONTEXT
 * ============================================================
 */

function buildContext(chunks) {
  if (
    !Array.isArray(chunks) ||
    chunks.length === 0
  ) {
    return "";
  }


  return chunks
    .filter(
      (chunk) =>
        chunk?.text
    )
    .map(
      (chunk, index) => {
        const lines = [
          `[Knowledge ${index + 1}]`,

          `Document: ${
            chunk.title ||
            chunk.fileName ||
            "unknown"
          }`,

          `Section: ${
            chunk.section ||
            chunk.topic ||
            "unknown"
          }`,

          `Source: ${
            chunk.fileName ||
            "unknown"
          }`,

          `Trust: ${
            chunk.trustLevel ||
            "unknown"
          }`,

          `Content: ${chunk.text}`,
        ];


        return lines.join(
          "\n"
        );
      }
    )
    .join(
      "\n\n"
    );
}


/*
 * ============================================================
 * COMPLETE RETRIEVAL PIPELINE
 * ============================================================
 */

async function retrieveKnowledge(
  question
) {
  const cleanQuestion =
    String(
      question || ""
    ).trim();


  if (!cleanQuestion) {
    return {
      question: "",
      candidates: [],
      chunks: [],
      context: "",
      gaps: [],
      selectionReason:
        "empty_question",
    };
  }


  const questionVector =
    await createEmbedding(
      cleanQuestion
    );


  const candidates =
    await searchKnowledge(
      questionVector
    );


  const selection =
    selectRelevantChunks(
      candidates
    );


  const chunks =
    selection.chunks;


  const context =
    buildContext(
      chunks
    );


  return {
    question:
      cleanQuestion,

    candidates,

    chunks,

    context,

    gaps:
      selection.gaps,

    cutAfterIndex:
      selection.cutAfterIndex,

    selectionReason:
      selection.selectionReason,

    bestScore:
      candidates.length
        ? candidates[0].score
        : null,
  };
}


/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  createEmbedding,
  searchKnowledge,
  selectRelevantChunks,
  buildContext,
  retrieveKnowledge,
};


/*
 * ============================================================
 * CLI DIAGNOSTIC MODE
 * ============================================================
 */

if (
  require.main === module
) {
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
    "STAGE D4.2 — ADAPTIVE PRODUCTION RAG"
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
    `Minimum score gap  : ${MIN_MEANINGFUL_GAP}`
  );

  console.log(
    `Max context chunks : ${MAX_CONTEXT_CHUNKS}`
  );


  retrieveKnowledge(
    question
  )
    .then(
      (result) => {
        console.log();

        console.log(
          "========== ALL QDRANT CANDIDATES =========="
        );


        if (
          !result.candidates.length
        ) {
          console.log(
            "No knowledge candidates returned."
          );
        }


        result.candidates.forEach(
          (
            candidate,
            index
          ) => {
            console.log();

            console.log(
              `${index + 1}. ` +
              `Score=${candidate.score.toFixed(4)} | ` +
              `Section=${candidate.section}`
            );

            console.log(
              `   ${candidate.text}`
            );
          }
        );


        console.log();

        console.log(
          "========== SCORE GAPS =========="
        );


        if (!result.gaps.length) {
          console.log(
            "No score gaps available."
          );
        }


        result.gaps.forEach(
          (item) => {
            console.log(
              `After #${item.afterIndex + 1}: ` +
              `${item.fromScore.toFixed(4)} -> ` +
              `${item.toScore.toFixed(4)} | ` +
              `gap=${item.gap.toFixed(4)}`
            );
          }
        );


        console.log();

        console.log(
          "========== RELEVANCE DECISION =========="
        );


        console.log(
          `Selection strategy : ${result.selectionReason}`
        );


        console.log();

        console.log(
          "========== SELECTED RAG CHUNKS =========="
        );


        if (
          !result.chunks.length
        ) {
          console.log(
            "No sufficiently relevant knowledge selected."
          );
        }


        result.chunks.forEach(
          (
            chunk,
            index
          ) => {
            console.log();

            console.log(
              `${index + 1}. ` +
              `Score=${chunk.score.toFixed(4)} | ` +
              `Section=${chunk.section}`
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
          "STAGE D4.2 COMPLETED"
        );

        console.log(
          "============================================================"
        );
      }
    )
    .catch(
      (error) => {
        console.error();

        console.error(
          "❌ Adaptive RAG failed"
        );

        console.error(
          error.message
        );

        process.exit(1);
      }
    );
}