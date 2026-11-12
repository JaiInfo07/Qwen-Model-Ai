require('dotenv').config();

const qdrantUrl = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const collectionName = process.env.QDRANT_COLLECTION || 'jarvis_ai_knowledge';
const embeddingModel = process.env.EMBEDDING_MODEL || 'qwen3-embedding:0.6b';

const parsedTopK = Number.parseInt(process.env.RAG_TOP_K || '5', 10);
const topK = Number.isInteger(parsedTopK) ? Math.min(Math.max(parsedTopK, 1), 10) : 5;

const parsedMinScore = Number.parseFloat(process.env.RAG_MIN_SCORE || '0.55');
const minScore = Number.isFinite(parsedMinScore) ? Math.min(Math.max(parsedMinScore, 0), 1) : 0.55;

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Server returned invalid JSON: ${text.slice(0, 300)}`);
  }
}

function errorMessage(data, response) {
  return data?.status?.error || data?.error || data?.message || `HTTP ${response.status} ${response.statusText}`;
}

async function createEmbedding(input) {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embeddingModel, input }),
  });

  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${errorMessage(data, response)}`);
  }

  const vector = data?.embeddings?.[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Ollama returned no embedding vector.');
  }
  return vector;
}

async function searchKnowledge(question) {
  const vector = await createEmbedding(question);

  const response = await fetch(
    `${qdrantUrl}/collections/${encodeURIComponent(collectionName)}/points/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: vector,
        limit: topK,
        score_threshold: minScore,
        with_payload: true,
        with_vector: false,
      }),
    },
  );

  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Qdrant search failed: ${errorMessage(data, response)}`);
  }

  return data?.result?.points || [];
}

async function main() {
  const question = process.argv.slice(2).join(' ').trim();

  if (!question) {
    throw new Error('Usage: node scripts/rag-query-test.cjs "your question"');
  }

  console.log('RAG read-only retrieval test\n');
  console.log(`Collection: ${collectionName}`);
  console.log(`Embedding model: ${embeddingModel}`);
  console.log(`Minimum score: ${minScore}`);
  console.log(`Question: ${question}`);

  const matches = await searchKnowledge(question);

  if (matches.length === 0) {
    console.log('\n⚠️ No sufficiently relevant knowledge found.');
    console.log('Jarvis should answer: The available company knowledge does not contain enough information to answer that.');
    return;
  }

  console.log(`\nTop ${matches.length} accepted result(s):`);

  matches.forEach((match, index) => {
    console.log(`\n${index + 1}. Score: ${Number(match.score || 0).toFixed(4)}`);
    console.log(`   Topic: ${match.payload?.topic || 'Unknown'}`);
    console.log(`   Source: ${match.payload?.fileName || 'Unknown file'}`);
    console.log(`   Text: ${match.payload?.text || 'No text'}`);
  });

  console.log('\nImportant: semantic relevance does not guarantee that the requested fact is explicitly present.');
  console.log('The next RAG stage must apply an answerability/grounding check before Qwen generates the final answer.');
}

main().catch((error) => {
  console.error('\n❌ RAG query test failed');
  console.error(error.message);
  process.exit(1);
});
