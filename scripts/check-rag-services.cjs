require('dotenv').config();

const qdrantUrl =
  process.env.QDRANT_URL || 'http://127.0.0.1:6333';

const ollamaUrl =
  process.env.OLLAMA_URL || 'http://localhost:11434';

const embeddingModel =
  process.env.EMBEDDING_MODEL || 'qwen3-embedding:0.6b';

async function checkQdrant() {
  const response = await fetch(`${qdrantUrl}/collections`);

  if (!response.ok) {
    throw new Error(
      `Qdrant returned HTTP ${response.status}`,
    );
  }

  const data = await response.json();

  console.log('✅ Qdrant connected');
  console.log(
    `   Collections: ${data.result?.collections?.length ?? 0}`,
  );
}

async function checkEmbeddingModel() {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: 'Jarvis AI vector database connection test.',
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || `Ollama returned HTTP ${response.status}`,
    );
  }

  const vector = data.embeddings?.[0];

  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(
      'Ollama returned no embedding vector.',
    );
  }

  console.log('✅ Embedding model connected');
  console.log(`   Model: ${embeddingModel}`);
  console.log(`   Vector size: ${vector.length}`);

  return vector.length;
}

async function main() {
  console.log('Checking RAG services...\n');

  await checkQdrant();
  await checkEmbeddingModel();

  console.log('\n✅ Stage 1 configuration completed');
  console.log(
    'Next: create a Qdrant collection and store one sample text.',
  );
}

main().catch((error) => {
  console.error('\n❌ RAG service check failed');
  console.error(error.message);
  process.exit(1);
});