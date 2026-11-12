require('dotenv').config();

const qdrantUrl = (
  process.env.QDRANT_URL || 'http://127.0.0.1:6333'
).replace(/\/+$/, '');

const ollamaUrl = (
  process.env.OLLAMA_URL || 'http://localhost:11434'
).replace(/\/+$/, '');

const collectionName =
  process.env.QDRANT_COLLECTION || 'jarvis_ai_knowledge';

const embeddingModel =
  process.env.EMBEDDING_MODEL || 'qwen3-embedding:0.6b';

const configuredTopK = Number.parseInt(
  process.env.RAG_TOP_K || '3',
  10,
);

const topK = Number.isInteger(configuredTopK)
  ? Math.min(Math.max(configuredTopK, 1), 10)
  : 3;

/*
 * These sentences act like small document chunks.
 * Later, these will come from uploaded PDF, DOCX and TXT files.
 */
const sampleChunks = [
  {
    id: 1,
    text: 'Employees receive 12 casual leave days annually.',
    topic: 'leave',
  },
  {
    id: 2,
    text: 'An employee without a valid punch-in record must be marked Absent.',
    topic: 'attendance',
  },
  {
    id: 3,
    text: 'Users can reset their password using the Forgot Password option on the login page.',
    topic: 'authentication',
  },
  {
    id: 4,
    text: 'Normal office working hours are from 9:30 AM to 6:30 PM.',
    topic: 'working-hours',
  },
];

async function readJsonResponse(response) {
  const responseText = await response.text();

  if (!responseText) {
    return {};
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(
      `Server returned invalid JSON: ${responseText.slice(0, 300)}`,
    );
  }
}

function getErrorMessage(data, response) {
  return (
    data?.status?.error
    || data?.error
    || data?.message
    || `HTTP ${response.status} ${response.statusText}`
  );
}

/**
 * Generate one or more embeddings using Ollama.
 *
 * @param {string|string[]} input
 * @returns {Promise<number[][]>}
 */
async function createEmbeddings(input) {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: embeddingModel,
      input,
    }),
  });

  const data = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `Ollama embedding failed: ${getErrorMessage(data, response)}`,
    );
  }

  if (
    !Array.isArray(data.embeddings)
    || data.embeddings.length === 0
  ) {
    throw new Error('Ollama returned no embedding vectors.');
  }

  return data.embeddings;
}

/**
 * Create the Qdrant collection when it does not already exist.
 *
 * @param {number} vectorSize
 */
async function ensureCollection(vectorSize) {
  const collectionUrl =
    `${qdrantUrl}/collections/${encodeURIComponent(collectionName)}`;

  const checkResponse = await fetch(collectionUrl);

  if (checkResponse.ok) {
    const collectionData = await readJsonResponse(checkResponse);

    /*
     * Check whether the existing collection uses the same
     * embedding dimension.
     */
    const configuredVectors =
      collectionData?.result?.config?.params?.vectors;

    const existingVectorSize =
      configuredVectors?.size
      ?? configuredVectors?.default?.size
      ?? null;

    if (
      existingVectorSize !== null
      && existingVectorSize !== vectorSize
    ) {
      throw new Error(
        [
          `Collection "${collectionName}" already exists`,
          `with vector size ${existingVectorSize},`,
          `but "${embeddingModel}" returned ${vectorSize}.`,
          'Delete or rename the collection before continuing.',
        ].join(' '),
      );
    }

    console.log(`✅ Collection already exists: ${collectionName}`);
    return;
  }

  if (checkResponse.status !== 404) {
    const errorData = await readJsonResponse(checkResponse);

    throw new Error(
      `Could not check collection: ${
        getErrorMessage(errorData, checkResponse)
      }`,
    );
  }

  const createResponse = await fetch(collectionUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
      },
      metadata: {
        application: 'Jarvis AI Chat',
        embeddingModel,
      },
    }),
  });

  const createData = await readJsonResponse(createResponse);

  if (!createResponse.ok) {
    throw new Error(
      `Collection creation failed: ${
        getErrorMessage(createData, createResponse)
      }`,
    );
  }

  console.log(`✅ Collection created: ${collectionName}`);
  console.log(`   Vector size: ${vectorSize}`);
  console.log('   Distance method: Cosine');
}

/**
 * Insert sample chunks and their embeddings into Qdrant.
 *
 * @param {number[][]} embeddings
 */
async function storeSampleChunks(embeddings) {
  if (embeddings.length !== sampleChunks.length) {
    throw new Error(
      'The number of embeddings does not match the number of chunks.',
    );
  }

  const points = sampleChunks.map((chunk, index) => ({
    id: chunk.id,
    vector: embeddings[index],
    payload: {
      text: chunk.text,
      topic: chunk.topic,

      /*
       * Demo metadata.
       * Later, these values will come from actual uploaded files.
       */
      documentId: 'demo-document-001',
      fileName: 'jarvis-ai-demo-knowledge.txt',
      chunkIndex: index,
      ownerId: 'demo-user',
    },
  }));

  const response = await fetch(
    `${qdrantUrl}/collections/${
      encodeURIComponent(collectionName)
    }/points?wait=true`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ points }),
    },
  );

  const data = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `Qdrant insert failed: ${getErrorMessage(data, response)}`,
    );
  }

  console.log(`✅ Stored ${points.length} sample knowledge chunks`);
}

/**
 * Search Qdrant using the user's question embedding.
 *
 * @param {string} question
 */
async function searchKnowledge(question) {
  const [questionVector] = await createEmbeddings(question);

  const response = await fetch(
    `${qdrantUrl}/collections/${
      encodeURIComponent(collectionName)
    }/points/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: questionVector,
        limit: topK,
        with_payload: true,
        with_vector: false,
      }),
    },
  );

  const data = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `Qdrant search failed: ${getErrorMessage(data, response)}`,
    );
  }

  const matches = data?.result?.points || [];

  console.log('\n🔎 Semantic search');
  console.log(`Question: ${question}`);

  if (matches.length === 0) {
    console.log('\nNo matching knowledge was found.');
    return;
  }

  console.log(`\nTop ${matches.length} results:`);

  matches.forEach((match, index) => {
    const score = Number(match.score || 0).toFixed(4);

    console.log(`\n${index + 1}. Score: ${score}`);
    console.log(`   Topic: ${match.payload?.topic || 'Unknown'}`);
    console.log(`   Text: ${match.payload?.text || 'No text'}`);
    console.log(
      `   Source: ${match.payload?.fileName || 'Unknown file'}`,
    );
  });

  const bestMatch = matches[0];

  console.log('\n✅ Best matching knowledge:');
  console.log(bestMatch.payload?.text || 'No text available');
}

async function main() {
  console.log('Stage 2: Vector storage and semantic search\n');

  console.log(`Embedding model: ${embeddingModel}`);
  console.log(`Collection: ${collectionName}`);

  /*
   * Ollama accepts an array of text inputs and returns
   * one embedding for each input.
   */
  console.log('\nCreating embeddings for sample knowledge...');

  const embeddings = await createEmbeddings(
    sampleChunks.map((chunk) => chunk.text),
  );

  const vectorSize = embeddings[0]?.length;

  if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
    throw new Error('Could not determine embedding vector size.');
  }

  console.log(`✅ Created ${embeddings.length} embeddings`);
  console.log(`   Vector size: ${vectorSize}`);

  await ensureCollection(vectorSize);
  await storeSampleChunks(embeddings);

  /*
   * You can provide another question as a command-line argument.
   */
  const commandLineQuestion = process.argv
    .slice(2)
    .join(' ')
    .trim();

  const question =
    commandLineQuestion
    || 'What status applies when an employee never signs in for attendance?';

  await searchKnowledge(question);

  console.log('\n🎉 Stage 2 completed successfully');
  console.log(
    'Qdrant stored the knowledge and retrieved it by meaning.',
  );
}

main().catch((error) => {
  console.error('\n❌ Stage 2 failed');
  console.error(error.message);
  process.exit(1);
});