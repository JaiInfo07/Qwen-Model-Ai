const fs = require("fs");
const path = require("path");


const MAX_CHARS = 650;
const OVERLAP_CHARS = 60;


/*
 * ============================================================
 * TEXT NORMALIZATION
 * ============================================================
 *
 * Preserve meaningful line boundaries.
 *
 * Do NOT perform sentence-based replacements because that can
 * damage:
 *
 * 9.5
 * email@example.com
 * version numbers
 * URLs
 */

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


/*
 * ============================================================
 * HEADING DETECTION
 * ============================================================
 *
 * Plain-text company documents commonly look like:
 *
 * Working Hours
 *
 * You must maintain...
 *
 *
 * Leaves encashment
 *
 * Employees are eligible...
 *
 *
 * Some labels may instead look like:
 *
 * Break Notification:
 * If you are stepping away...
 *
 * We detect those structures conservatively.
 */

function looksLikeHeading(lines, index) {
  const value =
    String(lines[index] || "").trim();

  if (!value) {
    return false;
  }


  /*
   * ----------------------------------------------------------
   * NEVER treat logical connector words as headings.
   * ----------------------------------------------------------
   *
   * Example:
   *
   * 1. Extra salary
   *
   * OR
   *
   * 2. Comp off
   *
   * "OR" belongs to the surrounding section.
   */

  const nonHeadingWords = new Set([
    "OR",
    "AND",
    "AND/OR",
    "BUT",
    "THEN",
    "ELSE",
  ]);

  if (
    nonHeadingWords.has(
      value.toUpperCase()
    )
  ) {
    return false;
  }


  /*
   * Markdown heading.
   */
  if (/^#{1,6}\s+/.test(value)) {
    return true;
  }


  /*
   * Reject long lines.
   */
  if (value.length > 80) {
    return false;
  }


  /*
   * Don't treat bullets as headings.
   */
  if (/^[-*•]\s+/.test(value)) {
    return false;
  }


  /*
   * Don't treat numbered list items as headings.
   */
  if (/^\d+[.)]\s+/.test(value)) {
    return false;
  }


  const words =
    value
      .split(/\s+/)
      .filter(Boolean);


  /*
   * Company-document headings should normally be short.
   */
  if (words.length > 8) {
    return false;
  }


  const previousBlank =
    index === 0 ||
    !String(
      lines[index - 1] || ""
    ).trim();

  const nextBlank =
    index === lines.length - 1 ||
    !String(
      lines[index + 1] || ""
    ).trim();


  /*
   * Colon-style label:
   *
   * Break Notification:
   * If you are...
   */
  if (
    previousBlank &&
    value.endsWith(":") &&
    words.length <= 6
  ) {
    return true;
  }


  /*
   * Short isolated line surrounded by blank space.
   */
  if (
    previousBlank &&
    nextBlank &&
    words.length <= 5
  ) {
    /*
     * Normal sentences ending with these punctuation
     * marks are not headings.
     *
     * Question mark is deliberately allowed for:
     *
     * Leaving early?
     * Planning leave?
     */
    if (/[.;,]$/.test(value)) {
      return false;
    }

    return true;
  }


  return false;
}

function cleanHeading(value) {
  return String(value || "")
    .replace(/^#{1,6}\s+/, "")
    .trim();
}


/*
 * ============================================================
 * SECTION EXTRACTION
 * ============================================================
 */

function splitIntoSections(
  text,
  fallbackTitle = "Document"
) {
  const lines =
    normalizeText(text).split("\n");

  const sections = [];

  let currentHeading = fallbackTitle;
  let currentLines = [];


  function flushSection() {
    const body =
      currentLines
        .join("\n")
        .trim();

    if (body) {
      sections.push({
        section: currentHeading,
        text: body,
      });
    }

    currentLines = [];
  }


  for (
    let index = 0;
    index < lines.length;
    index++
  ) {
    const line =
      lines[index].trim();

    if (
      looksLikeHeading(
        lines,
        index
      )
    ) {
      flushSection();

      currentHeading =
        cleanHeading(line);

      continue;
    }

    currentLines.push(
      lines[index]
    );
  }


  flushSection();

  return sections;
}


/*
 * ============================================================
 * SAFE LINE UNITS
 * ============================================================
 *
 * Do not split on periods.
 *
 * This prevents:
 *
 * 9.5         -> 9. 5
 * infoane.com -> infoane. com
 */

function getTextUnits(text) {
  return String(text || "")
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+/g, " ")
        .trim()
    )
    .filter(Boolean);
}


/*
 * ============================================================
 * LONG-LINE FALLBACK
 * ============================================================
 *
 * Only used if a single source line itself is extremely long.
 */

function splitLongText(
  text,
  maxChars
) {
  const pieces = [];

  let remaining =
    String(text || "").trim();


  while (
    remaining.length >
    maxChars
  ) {
    let cut =
      remaining.lastIndexOf(
        " ",
        maxChars
      );

    if (
      cut <
      maxChars * 0.6
    ) {
      cut = maxChars;
    }

    const piece =
      remaining
        .slice(0, cut)
        .trim();

    if (piece) {
      pieces.push(piece);
    }

    remaining =
      remaining
        .slice(cut)
        .trim();
  }


  if (remaining) {
    pieces.push(remaining);
  }

  return pieces;
}


/*
 * ============================================================
 * OVERLAP
 * ============================================================
 *
 * Overlap occurs only inside the same section.
 *
 * We NEVER overlap:
 *
 * Leaves encashment
 *
 * into:
 *
 * Payments
 */

function getOverlap(text) {
  const value =
    String(text || "").trim();

  if (
    !value ||
    OVERLAP_CHARS <= 0
  ) {
    return "";
  }


  if (
    value.length <=
    OVERLAP_CHARS
  ) {
    return value;
  }


  const tail =
    value.slice(
      -OVERLAP_CHARS
    );

  const firstSpace =
    tail.indexOf(" ");

  if (
    firstSpace >= 0
  ) {
    return tail
      .slice(
        firstSpace + 1
      )
      .trim();
  }


  return tail.trim();
}


/*
 * ============================================================
 * SECTION CHUNKING
 * ============================================================
 */

function chunkSection(section) {
  const heading =
    String(
      section.section ||
      "Document"
    ).trim();


  const units =
    getTextUnits(
      section.text
    );


  if (!units.length) {
    return [];
  }


  /*
   * Reserve room for heading because heading is included
   * in embedding text.
   */
  const maxBodyChars =
    Math.max(
      150,
      MAX_CHARS -
      heading.length -
      1
    );


  const bodyChunks = [];

  let current = "";


  function pushCurrent() {
    const value =
      current.trim();

    if (value) {
      bodyChunks.push(value);
    }

    current = "";
  }


  for (
    const originalUnit of units
  ) {
    /*
     * A line may itself exceed our target size.
     */
    const pieces =
      originalUnit.length >
      maxBodyChars
        ? splitLongText(
            originalUnit,
            maxBodyChars
          )
        : [originalUnit];


    for (
      const unit of pieces
    ) {
      if (!current) {
        current = unit;
        continue;
      }


      const combined =
        `${current}\n${unit}`;


      if (
        combined.length <=
        maxBodyChars
      ) {
        current =
          combined;

        continue;
      }


      const previous =
        current;

      pushCurrent();


      const overlap =
        getOverlap(
          previous
        );


      current =
        overlap
          ? `${overlap}\n${unit}`
          : unit;
    }
  }


  pushCurrent();


  return bodyChunks.map(
    (body, index) => ({
      section: heading,

      /*
       * Include section heading in vectorized text.
       *
       * Example:
       *
       * Leaves encashment
       * Employees are eligible...
       */
      text:
        `${heading}\n${body}`
          .trim(),

      body,

      sectionChunkIndex:
        index,

      sectionChunkCount:
        bodyChunks.length,
    })
  );
}


/*
 * ============================================================
 * COMPLETE DOCUMENT CHUNKING
 * ============================================================
 */

function chunkDocument(
  text,
  fallbackTitle = "Document"
) {
  const sections =
    splitIntoSections(
      text,
      fallbackTitle
    );


  const chunks = [];


  for (
    const section of sections
  ) {
    const generated =
      chunkSection(
        section
      );

    chunks.push(
      ...generated
    );
  }


  return chunks
    .filter(
      (chunk) =>
        chunk.body &&
        chunk.body.length >= 10
    )
    .map(
      (
        chunk,
        index,
        all
      ) => ({
        ...chunk,

        chunkIndex:
          index,

        chunkCount:
          all.length,
      })
    );
}


/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  normalizeText,
  looksLikeHeading,
  splitIntoSections,
  getTextUnits,
  chunkSection,
  chunkDocument,
};


/*
 * ============================================================
 * CLI PREVIEW
 * ============================================================
 *
 * IMPORTANT:
 *
 * This script ONLY previews chunks.
 *
 * It does NOT:
 *
 * - call Ollama
 * - create embeddings
 * - delete Qdrant points
 * - upload vectors
 * - modify production RAG
 */

if (
  require.main === module
) {
  const input =
    process.argv
      .slice(2)
      .join(" ")
      .trim();


  if (!input) {
    console.error(
      'Usage: node scripts/knowledge-chunker.cjs "knowledge/approved/document.txt"'
    );

    process.exit(1);
  }


  const filePath =
    path.resolve(input);


  if (
    !fs.existsSync(
      filePath
    )
  ) {
    console.error(
      `File not found: ${filePath}`
    );

    process.exit(1);
  }


  const text =
    fs.readFileSync(
      filePath,
      "utf8"
    );


  const fallbackTitle =
    path.basename(
      filePath,
      path.extname(
        filePath
      )
    );


  const sections =
    splitIntoSections(
      text,
      fallbackTitle
    );


  const chunks =
    chunkDocument(
      text,
      fallbackTitle
    );


  console.log(
    "============================================================"
  );

  console.log(
    "STAGE D2.1 — SAFE SECTION-AWARE CHUNK PREVIEW"
  );

  console.log(
    "============================================================"
  );


  console.log(
    `File          : ${path.basename(filePath)}`
  );

  console.log(
    `Sections      : ${sections.length}`
  );

  console.log(
    `Chunks        : ${chunks.length}`
  );

  console.log(
    `Max chars     : ${MAX_CHARS}`
  );

  console.log(
    `Overlap chars : ${OVERLAP_CHARS}`
  );


  console.log();

  console.log(
    "========== DETECTED SECTIONS =========="
  );


  sections.forEach(
    (
      section,
      index
    ) => {
      console.log(
        `${index + 1}. ${section.section}`
      );
    }
  );


  console.log();

  console.log(
    "========== CHUNK PREVIEW =========="
  );


  chunks.forEach(
    (
      chunk,
      index
    ) => {
      console.log();

      console.log(
        "------------------------------------------------------------"
      );

      console.log(
        `Chunk   : ${index + 1}/${chunks.length}`
      );

      console.log(
        `Section : ${chunk.section}`
      );

      console.log(
        `Length  : ${chunk.text.length}`
      );

      console.log(
        "------------------------------------------------------------"
      );

      console.log(
        chunk.text
      );
    }
  );


  console.log();

  console.log(
    "============================================================"
  );

  console.log(
    "PREVIEW COMPLETE — QDRANT WAS NOT MODIFIED"
  );

  console.log(
    "============================================================"
  );
}