require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  chunkDocument: chunkApprovedDocument,
} = require("./knowledge-chunker.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const APPROVED_DIR = path.join(
  PROJECT_ROOT,
  "knowledge",
  "approved"
);

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

const CHUNK_MAX_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 180;
const EMBEDDING_BATCH_SIZE = 8;
const QDRANT_BATCH_SIZE = 32;


/*
 * ------------------------------------------------------------
 * GENERAL HELPERS
 * ------------------------------------------------------------
 */

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}


/*
 * Qdrant accepts UUID point IDs.
 *
 * This creates a deterministic UUID-like ID from a hash,
 * allowing the same chunk to receive the same ID when
 * re-ingested.
 */
function hashToUuid(value) {
  const hash = sha256(value).slice(0, 32).split("");

  hash[12] = "4";

  const variant =
    (parseInt(hash[16], 16) & 0x3) | 0x8;

  hash[16] = variant.toString(16);

  const h = hash.join("");

  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20, 32),
  ].join("-");
}


async function readJson(response) {
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


function apiError(data, response) {
  return (
    data?.status?.error ||
    data?.error ||
    data?.message ||
    `HTTP ${response.status} ${response.statusText}`
  );
}


/*
 * ------------------------------------------------------------
 * FILE SECURITY / VALIDATION
 * ------------------------------------------------------------
 */

function ensureApprovedFile(filePath) {
  const absolutePath = path.resolve(filePath);

  const relativeToApproved =
    path.relative(APPROVED_DIR, absolutePath);

  const isOutside =
    relativeToApproved.startsWith("..") ||
    path.isAbsolute(relativeToApproved);

  if (isOutside) {
    throw new Error(
      [
        "Production ingestion refused.",
        "",
        "Only files inside:",
        APPROVED_DIR,
        "",
        "may be added to the production knowledge base.",
      ].join("\n")
    );
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `File does not exist: ${absolutePath}`
    );
  }

  const stat = fs.statSync(absolutePath);

  if (!stat.isFile()) {
    throw new Error(
      `Path is not a file: ${absolutePath}`
    );
  }

  const extension =
    path.extname(absolutePath).toLowerCase();

  const supported = [
    ".txt",
    ".md",
  ];

  if (!supported.includes(extension)) {
    throw new Error(
      [
        `Unsupported file type: ${extension}`,
        "",
        "Stage D1 supports:",
        ".txt",
        ".md",
        "",
        "PDF and DOCX support will be added later.",
      ].join("\n")
    );
  }

  return absolutePath;
}


/*
 * ------------------------------------------------------------
 * DOCUMENT EXTRACTION
 * ------------------------------------------------------------
 */

function extractText(filePath) {
  return normalizeText(
    fs.readFileSync(filePath, "utf8")
  );
}


function extractTitle(text, fileName) {
  const lines =
    String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const markdownHeading =
    lines.find((line) => /^#{1,3}\s+/.test(line));

  if (markdownHeading) {
    return markdownHeading
      .replace(/^#{1,3}\s+/, "")
      .trim();
  }

  return path
    .basename(fileName, path.extname(fileName))
    .replace(/[-_]+/g, " ")
    .trim();
}


/*
 * ------------------------------------------------------------
 * CHUNKING
 * ------------------------------------------------------------
 *
 * We prefer paragraph boundaries instead of blindly cutting
 * every N characters.
 */

function splitIntoParagraphs(text) {
  return normalizeText(text)
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph.replace(/\s+/g, " ").trim()
    )
    .filter(Boolean);
}


function takeOverlap(text, maxChars) {
  if (!text || maxChars <= 0) {
    return "";
  }

  if (text.length <= maxChars) {
    return text;
  }

  const slice =
    text.slice(-maxChars);

  const firstSpace =
    slice.indexOf(" ");

  if (firstSpace >= 0) {
    return slice
      .slice(firstSpace + 1)
      .trim();
  }

  return slice.trim();
}


function splitLongParagraph(paragraph) {
  const chunks = [];

  let remaining = paragraph.trim();

  while (remaining.length > CHUNK_MAX_CHARS) {
    let cut =
      remaining.lastIndexOf(
        ". ",
        CHUNK_MAX_CHARS
      );

    if (cut < CHUNK_MAX_CHARS * 0.5) {
      cut =
        remaining.lastIndexOf(
          " ",
          CHUNK_MAX_CHARS
        );
    }

    if (cut <= 0) {
      cut = CHUNK_MAX_CHARS;
    } else {
      cut += 1;
    }

    const piece =
      remaining.slice(0, cut).trim();

    if (piece) {
      chunks.push(piece);
    }

    const overlap =
      takeOverlap(
        piece,
        CHUNK_OVERLAP_CHARS
      );

    remaining =
      `${overlap} ${remaining.slice(cut)}`
        .trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}


function chunkDocument(text) {
  const paragraphs =
    splitIntoParagraphs(text);

  const chunks = [];

  let current = "";

  function pushCurrent() {
    const value = current.trim();

    if (value) {
      chunks.push(value);
    }

    current = "";
  }

  for (const paragraph of paragraphs) {
    if (
      paragraph.length >
      CHUNK_MAX_CHARS
    ) {
      pushCurrent();

      const pieces =
        splitLongParagraph(paragraph);

      chunks.push(...pieces);

      continue;
    }

    if (!current) {
      current = paragraph;
      continue;
    }

    const combined =
      `${current}\n\n${paragraph}`;

    if (
      combined.length <=
      CHUNK_MAX_CHARS
    ) {
      current = combined;
      continue;
    }

    const previous =
      current;

    pushCurrent();

    const overlap =
      takeOverlap(
        previous,
        CHUNK_OVERLAP_CHARS
      );

    current =
      overlap
        ? `${overlap}\n\n${paragraph}`
        : paragraph;
  }

  pushCurrent();

  return chunks.filter(
    (chunk) => chunk.length >= 20
  );
}


/*
 * ------------------------------------------------------------
 * OLLAMA EMBEDDINGS
 * ------------------------------------------------------------
 */

async function embedTexts(texts) {
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
          model: EMBEDDING_MODEL,
          input: texts,
        }),
      }
    );

  const data =
    await readJson(response);

  if (!response.ok) {
    throw new Error(
      `Embedding failed: ${apiError(
        data,
        response
      )}`
    );
  }

  const embeddings =
    data?.embeddings;

  if (
    !Array.isArray(embeddings) ||
    embeddings.length !== texts.length
  ) {
    throw new Error(
      "Embedding result count does not match chunk count."
    );
  }

  for (const vector of embeddings) {
    if (
      !Array.isArray(vector) ||
      vector.length !== 1024
    ) {
      throw new Error(
        "Expected a 1024-dimension embedding vector."
      );
    }
  }

  return embeddings;
}


async function embedAllChunks(chunks) {
  const vectors = [];

  for (
    let start = 0;
    start < chunks.length;
    start += EMBEDDING_BATCH_SIZE
  ) {
    const batch =
      chunks.slice(
        start,
        start + EMBEDDING_BATCH_SIZE
      );

    console.log(
      `Embedding chunks ` +
      `${start + 1}-${start + batch.length} ` +
      `of ${chunks.length}...`
    );

    const batchVectors =
      await embedTexts(batch);

    vectors.push(...batchVectors);
  }

  return vectors;
}


/*
 * ------------------------------------------------------------
 * QDRANT
 * ------------------------------------------------------------
 */

async function deleteOldDocument(documentId) {
  const response =
    await fetch(
      `${QDRANT_URL}/collections/` +
      `${encodeURIComponent(COLLECTION_NAME)}` +
      `/points/delete?wait=true`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          filter: {
            must: [
              {
                key: "documentId",

                match: {
                  value: documentId,
                },
              },
            ],
          },
        }),
      }
    );

  const data =
    await readJson(response);

  if (!response.ok) {
    throw new Error(
      `Could not remove previous document chunks: ` +
      apiError(data, response)
    );
  }
}


async function upsertPoints(points) {
  for (
    let start = 0;
    start < points.length;
    start += QDRANT_BATCH_SIZE
  ) {
    const batch =
      points.slice(
        start,
        start + QDRANT_BATCH_SIZE
      );

    console.log(
      `Uploading points ` +
      `${start + 1}-${start + batch.length} ` +
      `of ${points.length}...`
    );

    const response =
      await fetch(
        `${QDRANT_URL}/collections/` +
        `${encodeURIComponent(COLLECTION_NAME)}` +
        `/points?wait=true`,
        {
          method: "PUT",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            points: batch,
          }),
        }
      );

    const data =
      await readJson(response);

    if (!response.ok) {
      throw new Error(
        `Qdrant upsert failed: ${apiError(
          data,
          response
        )}`
      );
    }
  }
}


/*
 * ------------------------------------------------------------
 * INGESTION PIPELINE
 * ------------------------------------------------------------
 */

async function ingestDocument(inputPath) {
  const filePath =
    ensureApprovedFile(inputPath);

  const fileName =
    path.basename(filePath);

  const extension =
    path.extname(filePath).toLowerCase();

  const sourcePath =
    path
      .relative(
        PROJECT_ROOT,
        filePath
      )
      .replace(/\\/g, "/");

  const text =
    extractText(filePath);

  if (!text) {
    throw new Error(
      "The document contains no usable text."
    );
  }

  const title =
    extractTitle(text, fileName);


  /*
   * documentId is based on source path.
   *
   * Therefore the same approved document keeps the
   * same identity when its content is updated later.
   */
  const documentId =
    sha256(
      `approved:${sourcePath.toLowerCase()}`
    );


  const contentHash =
    sha256(text);


  /*
   * ----------------------------------------------------------
   * SECTION-AWARE CHUNKING
   * ----------------------------------------------------------
   *
   * knowledge-chunker.cjs now determines:
   *
   * - section boundaries
   * - chunk boundaries
   * - section metadata
   *
   * Example:
   *
   * section = "Leaves encashment"
   * text    = "Leaves encashment\nEmployees are eligible..."
   */
  const chunks =
    chunkApprovedDocument(
      text,
      title
    );


  if (!chunks.length) {
    throw new Error(
      "No usable chunks were generated."
    );
  }


  console.log();
  console.log(`Title          : ${title}`);
  console.log(`Source         : ${sourcePath}`);
  console.log(`Document ID    : ${documentId}`);
  console.log(`Content hash   : ${contentHash}`);
  console.log(`Characters     : ${text.length}`);
  console.log(`Chunks         : ${chunks.length}`);


  /*
   * ----------------------------------------------------------
   * EMBEDDINGS
   * ----------------------------------------------------------
   *
   * Embed only the actual text string of each chunk.
   */
  console.log();
  console.log(
    "Creating embeddings..."
  );


  const embeddingTexts =
    chunks.map(
      (chunk) => chunk.text
    );


  const vectors =
    await embedAllChunks(
      embeddingTexts
    );


  if (
    vectors.length !==
    chunks.length
  ) {
    throw new Error(
      "Embedding count does not match chunk count."
    );
  }


  const ingestedAt =
    new Date().toISOString();


  /*
   * ----------------------------------------------------------
   * BUILD QDRANT POINTS
   * ----------------------------------------------------------
   */
  const points =
    chunks.map(
      (chunk, index) => ({
        id: hashToUuid(
          `${documentId}:${index}:${sha256(chunk.text)}`
        ),

        vector:
          vectors[index],

        payload: {
          /*
           * Actual section-aware knowledge text.
           */
          text:
            chunk.text,


          /*
           * Document-level metadata.
           */
          title,

          documentId,

          fileName,

          fileType:
            extension.slice(1),

          sourcePath,

          sourceType:
            "approved_local_document",

          trustLevel:
            "approved",

          contentHash,

          ingestedAt,


          /*
           * Section-level metadata.
           *
           * topic is kept because rag-service.js already
           * understands this field.
           */
          topic:
            chunk.section || title,

          section:
            chunk.section || title,

          sectionChunkIndex:
            chunk.sectionChunkIndex ?? 0,

          sectionChunkCount:
            chunk.sectionChunkCount ?? 1,


          /*
           * Document-level chunk position.
           */
          chunkIndex:
            chunk.chunkIndex ?? index,

          chunkCount:
            chunk.chunkCount ?? chunks.length,
        },
      })
    );


  /*
   * ----------------------------------------------------------
   * RE-INGESTION
   * ----------------------------------------------------------
   *
   * Remove the previous version of this same source document
   * before writing the newly generated chunks.
   */
  console.log();
  console.log(
    "Removing previous version of this document..."
  );

  await deleteOldDocument(
    documentId
  );


  console.log(
    "Uploading current document..."
  );

  await upsertPoints(
    points
  );


  return {
    title,
    sourcePath,
    documentId,
    contentHash,
    chunkCount:
      chunks.length,
  };
}

/*
 * ------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------
 */

async function main() {
  const input =
    process.argv
      .slice(2)
      .join(" ")
      .trim();

  if (!input) {
    console.error(
      [
        "",
        "Usage:",
        "",
        'node scripts/ingest-knowledge.cjs "knowledge/approved/document.txt"',
        "",
      ].join("\n")
    );

    process.exit(1);
  }

  console.log(
    "============================================================"
  );

  console.log(
    "STAGE D1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â PRODUCTION KNOWLEDGE INGESTION"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `Collection      : ${COLLECTION_NAME}`
  );

  console.log(
    `Embedding model : ${EMBEDDING_MODEL}`
  );

  console.log(
    `Approved folder : ${APPROVED_DIR}`
  );

  const result =
    await ingestDocument(input);

  console.log();
  console.log(
    "============================================================"
  );

  console.log(
    "DOCUMENT INGESTED SUCCESSFULLY"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `Title     : ${result.title}`
  );

  console.log(
    `Source    : ${result.sourcePath}`
  );

  console.log(
    `Chunks    : ${result.chunkCount}`
  );

  console.log(
    `Trust     : approved`
  );
}


if (require.main === module) {
  main().catch((error) => {
    console.error();
    console.error(
      "ÃƒÂ¢Ã‚ÂÃ…â€™ Knowledge ingestion failed"
    );

    console.error(
      error.message
    );

    process.exit(1);
  });
}


module.exports = {
  normalizeText,
  chunkDocument,
  ingestDocument,
};