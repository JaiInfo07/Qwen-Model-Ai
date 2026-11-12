require("dotenv").config();

const {
  createEmbedding,
  searchKnowledge,
} = require("../rag-service");


const MAX_SELECTED = 3;

/*
 * Minimum difference that we consider meaningful
 * when separating one relevance cluster from another.
 *
 * This is only for preview/testing right now.
 */
const MIN_MEANINGFUL_GAP = 0.07;


function analyzeScoreGaps(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return {
      candidates: [],
      gaps: [],
      selected: [],
      cutIndex: null,
    };
  }

  const ordered = [...candidates]
    .sort((a, b) => b.score - a.score);

  const limited = ordered.slice(0, MAX_SELECTED + 2);

  const gaps = [];

  for (let i = 0; i < limited.length - 1; i++) {
    const current = limited[i];
    const next = limited[i + 1];

    gaps.push({
      afterIndex: i,
      fromScore: current.score,
      toScore: next.score,
      gap: current.score - next.score,
    });
  }


  /*
   * Find the largest meaningful gap within the portion
   * of the ranking that could affect our context selection.
   */
  const usableGaps =
    gaps.filter(
      (item) =>
        item.afterIndex < MAX_SELECTED &&
        item.gap >= MIN_MEANINGFUL_GAP
    );


  let cutIndex = null;

  if (usableGaps.length) {
    const largest =
      [...usableGaps]
        .sort(
          (a, b) =>
            b.gap - a.gap
        )[0];

    cutIndex =
      largest.afterIndex;
  }


  /*
   * If a meaningful gap exists:
   *
   * keep everything ABOVE that gap.
   *
   * Otherwise fall back to max 3.
   */
  const selected =
    cutIndex !== null
      ? limited.slice(
          0,
          Math.min(
            cutIndex + 1,
            MAX_SELECTED
          )
        )
      : limited.slice(
          0,
          MAX_SELECTED
        );


  return {
    candidates: limited,
    gaps,
    selected,
    cutIndex,
  };
}


async function main() {
  const question =
    process.argv
      .slice(2)
      .join(" ")
      .trim();

  if (!question) {
    console.error(
      'Usage: node scripts/rag-gap-preview.cjs "your question"'
    );

    process.exit(1);
  }


  console.log(
    "============================================================"
  );

  console.log(
    "STAGE D4.1 — ADAPTIVE SCORE-GAP PREVIEW"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `Question: ${question}`
  );


  const vector =
    await createEmbedding(
      question
    );


  const candidates =
    await searchKnowledge(
      vector
    );


  const result =
    analyzeScoreGaps(
      candidates
    );


  console.log();
  console.log(
    "========== CANDIDATES =========="
  );


  result.candidates.forEach(
    (item, index) => {
      console.log(
        `${index + 1}. ` +
        `${item.topic} | ` +
        `${item.score.toFixed(4)}`
      );
    }
  );


  console.log();
  console.log(
    "========== SCORE GAPS =========="
  );


  if (!result.gaps.length) {
    console.log(
      "Not enough candidates."
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
    "========== ADAPTIVE SELECTION =========="
  );


  result.selected.forEach(
    (item, index) => {
      console.log(
        `${index + 1}. ` +
        `${item.topic} | ` +
        `${item.score.toFixed(4)}`
      );
    }
  );


  console.log();
  console.log(
    "============================================================"
  );

  console.log(
    "PREVIEW COMPLETE — RAG WAS NOT MODIFIED"
  );

  console.log(
    "============================================================"
  );
}


main().catch(
  (error) => {
    console.error();
    console.error(
      "❌ Gap preview failed"
    );
    console.error(
      error.message
    );

    process.exit(1);
  }
);