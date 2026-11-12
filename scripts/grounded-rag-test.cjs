require('dotenv').config();

const qdrantUrl = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '');
const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const collectionName = process.env.QDRANT_COLLECTION || 'jarvis_ai_knowledge';
const embeddingModel = process.env.EMBEDDING_MODEL || 'qwen3-embedding:0.6b';
const textModel = process.env.OLLAMA_MODEL || 'qwen3.5:4b';

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
    throw new Error(`Server returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

function errorMessage(data, response) {
  return data?.status?.error || data?.error || data?.message || `HTTP ${response.status} ${response.statusText}`;
}

async function createEmbedding(input) {
  const response = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: embeddingModel,
      input,
    }),
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

function buildContext(matches) {
  return matches
    .map((match, index) => {
      const payload = match.payload || {};
      return [
        `[CONTEXT ${index + 1}]`,
        `Source: ${payload.fileName || 'Unknown'}`,
        `Topic: ${payload.topic || 'Unknown'}`,
        `Similarity score: ${Number(match.score || 0).toFixed(4)}`,
        `Text:`,
        String(payload.text || '').trim(),
      ].join('\n');
    })
    .join('\n\n');
}

async function evaluateGroundedAnswer(question, matches) {
  const context = buildContext(matches);

  const systemPrompt = `
You are the grounding gate for an internal company RAG assistant.

Your job is NOT to answer from general knowledge.
Use ONLY the supplied retrieved context.

Rules:
1. A context being semantically related is NOT enough.
2. Mark answerable=true only when the specific fact requested by the user is explicitly supported by the supplied context.
3. Never infer missing company-specific facts from working duration, common practice, names, job roles, salary policies, dates, or other indirect clues.
4. Never invent employee details, salary amounts, leave balances, attendance records, office start/end times, managers, dates, or company policies.
5. If the question asks for a specific person/value and that person/value is absent from the context, mark answerable=false.
6. If the context contains only a related policy but not the requested fact, mark answerable=false.
7. When answerable=false, the answer must state that the available company knowledge does not contain the requested information.
8. When answerable=true, answer concisely and only with facts supported by context.
9. Return VALID JSON ONLY. No Markdown and no text outside JSON.

Return exactly this shape:
{
  "answerable": true or false,
  "answer": "final grounded answer",
  "reason": "short explanation of why the context does or does not support the requested fact"
}
`.trim();

  const userPrompt = `
QUESTION:
${question}

RETRIEVED CONTEXT:
${context}
`.trim();

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: textModel,
      stream: false,
      format: 'json',
      options: {
        temperature: 0,
      },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const data = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Ollama grounding check failed: ${errorMessage(data, response)}`);
  }

  const raw = String(data?.message?.content || '').trim();
  if (!raw) {
    throw new Error('Qwen returned an empty grounding response.');
  }

  let decision;
  try {
    decision = JSON.parse(raw);
  } catch {
    throw new Error(`Qwen did not return valid JSON: ${raw.slice(0, 500)}`);
  }

  return {
    answerable: decision?.answerable === true,
    answer: String(decision?.answer || '').trim(),
    reason: String(decision?.reason || '').trim(),
    raw: decision,
  };
}

async function main() {
  const question = process.argv.slice(2).join(' ').trim();

  if (!question) {
    throw new Error('Usage: node scripts/grounded-rag-test.cjs "your question"');
  }

  console.log('Grounded RAG test\n');
  console.log(`Text model: ${textModel}`);
  console.log(`Embedding model: ${embeddingModel}`);
  console.log(`Collection: ${collectionName}`);
  console.log(`Minimum retrieval score: ${minScore}`);
  console.log(`Question: ${question}`);

  const matches = await searchKnowledge(question);

  if (matches.length === 0) {
    console.log('\nRETRIEVAL: REJECTED');
    console.log('No chunk met the minimum similarity score.');
    console.log('\nGROUNDING: NOT NEEDED');
    console.log('\nFINAL ANSWER:');
    console.log('The available company knowledge does not contain enough information to answer that.');
    return;
  }

  console.log(`\nRETRIEVAL: ${matches.length} chunk(s) accepted`);
  matches.forEach((match, index) => {
    console.log(
      `${index + 1}. ${Number(match.score || 0).toFixed(4)} | ` +
      `${match.payload?.topic || 'Unknown'} | ${match.payload?.fileName || 'Unknown'}`
    );
  });

  const decision = await evaluateGroundedAnswer(question, matches);

  console.log(`\nGROUNDING: ${decision.answerable ? 'ANSWERABLE' : 'NOT ANSWERABLE'}`);
  console.log(`Reason: ${decision.reason || '(no reason returned)'}`);

  console.log('\nFINAL ANSWER:');
  if (decision.answerable && decision.answer) {
    console.log(decision.answer);
  } else {
    console.log(
      decision.answer ||
      'The available company knowledge does not contain the requested information.'
    );
  }
}

main().catch((error) => {
  console.error('\n❌ Grounded RAG test failed');
  console.error(error.message);
  process.exit(1);
});
