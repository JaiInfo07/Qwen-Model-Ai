require("dotenv").config();

const {
  createEmbedding,
  searchKnowledge,
} = require("../rag-service");


const OLLAMA_URL = (
  process.env.OLLAMA_URL ||
  "http://localhost:11434"
).replace(/\/+$/, "");

const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ||
  "qwen3-embedding:0.6b";


function cosineSimilarity(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== b.length
  ) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot /
    (Math.sqrt(normA) * Math.sqrt(normB));
}


async function embedMany(texts) {
  const response = await fetch(
    `${OLLAMA_URL}/api/embed`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error ||
      `Embedding HTTP ${response.status}`
    );
  }

  if (
    !Array.isArray(data.embeddings) ||
    data.embeddings.length !== texts.length
  ) {
    throw new Error(
      "Unexpected embedding result."
    );
  }

  return data.embeddings;
}


async function main() {
  const question =
    process.argv
      .slice(2)
      .join(" ")
      .trim();

  if (!question) {
    console.error(
      'Usage: node scripts/rag-section-rerank-preview.cjs "your question"'
    );

    process.exit(1);
  }


  console.log(
    "============================================================"
  );

  console.log(
    "STAGE D4 — SECTION RERANK PREVIEW"
  );

  console.log(
    "============================================================"
  );

  console.log(`Question: ${question}`);


  /*
   * Same query embedding already used by RAG.
   */
  const questionVector =
    await createEmbedding(question);


  /*
   * Get raw Qdrant candidates.
   */
  const candidates =
    await searchKnowledge(
      questionVector
    );


  if (!candidates.length) {
    console.log(
      "No Qdrant candidates."
    );

    return;
  }


  /*
   * Embed only the concise section/topic names.
   *
   * Examples:
   *
   * "Leaves encashment"
   * "Payments"
   * "Leaves"
   */
  const sectionTexts =
    candidates.map(
      (candidate) =>
        candidate.section ||
        candidate.topic ||
        candidate.title ||
        "unknown"
    );


  const sectionVectors =
    await embedMany(
      sectionTexts
    );


  const results =
    candidates.map(
      (candidate, index) => {
        const sectionScore =
          cosineSimilarity(
            questionVector,
            sectionVectors[index]
          );

        return {
          ...candidate,

          sectionName:
            sectionTexts[index],

          sectionScore,
        };
      }
    );


  console.log();
  console.log(
    "========== RAW VS SECTION RELEVANCE =========="
  );


  results.forEach(
    (item, index) => {
      console.log();

      console.log(
        `${index + 1}. ${item.sectionName}`
      );

      console.log(
        `   Qdrant content score : ${item.score.toFixed(4)}`
      );

      console.log(
        `   Section-title score  : ${item.sectionScore.toFixed(4)}`
      );
    }
  );


  console.log();
  console.log(
    "========== SECTION-SCORE RANKING =========="
  );


  [...results]
    .sort(
      (a, b) =>
        b.sectionScore -
        a.sectionScore
    )
    .forEach(
      (item, index) => {
        console.log(
          `${index + 1}. ` +
          `${item.sectionName} | ` +
          `section=${item.sectionScore.toFixed(4)} | ` +
          `content=${item.score.toFixed(4)}`
        );
      }
    );


  console.log();
  console.log(
    "============================================================"
  );

  console.log(
    "PREVIEW COMPLETE — RAG/QDRANT WAS NOT MODIFIED"
  );

  console.log(
    "============================================================"
  );
}


main().catch(
  (error) => {
    console.error();
    console.error(
      "❌ Section rerank preview failed"
    );

    console.error(
      error.message
    );

    process.exit(1);
  }
);