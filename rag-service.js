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
 * Minimum confidence required before Jarvis is allowed to
 * treat retrieved company knowledge as an actual answer.
 *
 * Calibrated against the current approved IANE knowledge:
 *
 * lowest known-answer top score  = 0.6184
 * highest unknown-answer score   = 0.5361
 *
 * 0.58 sits safely between them.
 */
const MIN_CONFIDENCE_SCORE = Math.min(
  Math.max(
    parseNumber(
      process.env.RAG_MIN_CONFIDENCE_SCORE,
      0.58
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
 * Example â€” single intent:
 *
 * Leaves encashment  0.6426
 *                    â†“ gap 0.0796
 * Payments           0.5630
 *
 * Selected:
 * Leaves encashment only
 *
 *
 * Example â€” multi intent:
 *
 * Leaves encashment  0.6009
 * Leaves             0.5609
 *                    â†“ gap 0.1270
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
 * ----------------------------------------------------------
 * ANSWER-CONFIDENCE GATE
 * ----------------------------------------------------------
 *
 * Semantic search can return office-related chunks even when
 * the approved knowledge does not actually contain an answer.
 *
 * Example:
 * "How many WFH days do I get?"
 *
 * Working Hours may still score around 0.53 simply because
 * both concepts are workplace related.
 *
 * Do not allow such weak matches to become company policy.
 */
if (
  ordered[0].score <
  MIN_CONFIDENCE_SCORE
) {
  return {
    chunks: [],
    gaps: [],
    cutAfterIndex: null,
    selectionReason:
      "insufficient_answer_confidence",
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


/*
 * ============================================================
 * RETRIEVAL QUERY NORMALIZATION
 * ============================================================
 *
 * Remove conversational addressing that should not influence
 * semantic retrieval.
 *
 * IMPORTANT:
 * This changes only the embedding/search query.
 * The original user message is still sent to Qwen unchanged.
 *
 * Examples:
 *
 * "Hey Jarvis, Can I encash my leaves?"
 *      ->
 * "Can I encash my leaves?"
 *
 * "Jarvis: How many paid leaves do I get?"
 *      ->
 * "How many paid leaves do I get?"
 */
function normalizeRetrievalQuery(question) {
  const original =
    String(question || "").trim();

  if (!original) {
    return "";
  }

  let normalized =
    original;


  /*
   * Assistant-name addressing.
   *
   * Handles:
   * Hey Jarvis,
   * Hi Jarvis
   * Hello Jarvis!
   * Jarvis:
   * Jarvis,
   */
  normalized =
    normalized.replace(
      /^(?:(?:hey|hi|hello)\s+)?jarvis\s*[,!:;-]?\s*/i,
      ""
    );


  /*
   * Plain conversational greeting.
   *
   * Handles:
   * Hey, can I...
   * Hi! How many...
   * Hello - what is...
   */
  normalized =
    normalized.replace(
      /^(?:hey|hi|hello)\s*[,!:;-]?\s*/i,
      ""
    );


  normalized =
    normalized.trim();


  /*
   * Never accidentally produce an empty retrieval query.
   */
  return normalized || original;
}

/**
 * Narrow, read-only fallback for company office start/end-time questions.
 * This does NOT relax score thresholds or assert a clock-in/clock-out time.
 * It merely permits a separately retrieved, APPROVED working-hours policy
 * to be shown as partial context when the exact-time query has no match.
 *
 * Future: replace this narrow heuristic with a general multi-query
 * retrieval + evidence-level answerability verifier.
 */
function asksExactOfficeClockTimes(question) {
  const text = String(question || "").toLowerCase();
  const companyScope = /\b(?:our|office|company|organisation|organization|employee|employees|workplace)\b/.test(text);
  const start = /\b(?:start|starting|begin|begins|opening|open|clock[ -]?in|sign[ -]?in)\b/.test(text);
  const end = /\b(?:end|ending|finish|finishing|closing|close|clock[ -]?out|sign[ -]?out)\b/.test(text);
  const clock = /\b(?:time|times|timings|schedule|hours|shift)\b/.test(text);
  return companyScope && start && end && clock;
}

const RELATED_HOURS_QUERY =
  "How many working hours should employees maintain daily?";

function isApprovedWorkingHoursPolicy(chunk) {
  if (!chunk || String(chunk.trustLevel || "").toLowerCase() !== "approved") {
    return false;
  }
  const section = `${chunk.section || ""} ${chunk.topic || ""} ${chunk.title || ""}`;
  return /\b(?:working hours|office hours|work schedule|shift hours)\b/i.test(section);
}

async function retrieveRelatedHoursPolicy(question) {
  if (!asksExactOfficeClockTimes(question)) return null;

  // A second query is allowed only for this limited, explicit use case.
  // All normal confidence and relevance gates remain in force.
  const alternateVector = await createEmbedding(RELATED_HOURS_QUERY);
  const alternateCandidates = await searchKnowledge(alternateVector);
  const selection = selectRelevantChunks(alternateCandidates);

  // Only a single positively-identified approved policy may be supplied.
  const policy = selection.chunks.find(isApprovedWorkingHoursPolicy);
  if (!policy) return null;

  return {
    policy,
    alternateBestScore: alternateCandidates[0]?.score ?? null,
  };
}

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


  /*
 * Normalize only the semantic-search query.
 * The original user message remains unchanged for Qwen.
 */
const retrievalQuestion =
  normalizeRetrievalQuery(
    cleanQuestion
  );


const questionVector =
  await createEmbedding(
    retrievalQuestion
  );


  const candidates =
    await searchKnowledge(
      questionVector
    );


  const selection =
    selectRelevantChunks(
      candidates
    );

  let chunks = selection.chunks;
  let selectionReason = selection.selectionReason;
  let relatedPolicyOnly = false;
  let supplementalQuery = null;
  let supplementalBestScore = null;

  if (!chunks.length && asksExactOfficeClockTimes(cleanQuestion)) {
    const related = await retrieveRelatedHoursPolicy(cleanQuestion);
    if (related) {
      chunks = [related.policy];
      relatedPolicyOnly = true;
      supplementalQuery = RELATED_HOURS_QUERY;
      supplementalBestScore = related.alternateBestScore;
      selectionReason = "related_working_hours_policy_fallback";
    }
  }

  const context =
    relatedPolicyOnly
      ? `[Related Policy — Partial Evidence Only]
The user asked for exact office start and end clock times.
The approved working-hours policy below is RELATED information, NOT proof of the exact clock times.
State the daily working-hours requirement if it appears in the text, and explicitly say the exact start and end times are not specified in this retrieved policy unless the text actually supplies them.
Never calculate, infer, or invent office start/end times from a shift duration or breaks.

${buildContext(chunks)}`
      : chunks.length
        ? buildContext(chunks)
        : `
  [Retrieval Status]
  No sufficiently relevant approved company knowledge was found for this question.

  For a company-specific question, do not guess or use generic company practice.
  Clearly state that the available approved knowledge does not specify the requested information.
  `.trim();


  return {
    question:
      cleanQuestion,

    retrievalQuestion,
    
    candidates,

    chunks,

    context,

    gaps:
      selection.gaps,

    cutAfterIndex:
      selection.cutAfterIndex,

    selectionReason,

    relatedPolicyOnly,

    supplementalQuery,

    supplementalBestScore,

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
    "STAGE D4.2 â€” ADAPTIVE PRODUCTION RAG"
  );

  console.log(
    "============================================================"
  );


  console.log(
    `Question           : ${question}`
  );

  console.log(
    `Retrieval query    : ${
      normalizeRetrievalQuery(question)
    }`
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
    `Answer confidence  : ${MIN_CONFIDENCE_SCORE}`
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

        if (result.relatedPolicyOnly) {
          console.log(
            `Supplemental query  : ${result.supplementalQuery}`
          );
          console.log(
            `Supplemental score  : ${Number(result.supplementalBestScore).toFixed(4)}`
          );
          console.log(
            "Selected source is RELATED policy only, not evidence of exact office clock times."
          );
        }

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
          "âŒ Adaptive RAG failed"
        );

        console.error(
          error.message
        );

        process.exit(1);
      }
    );
}