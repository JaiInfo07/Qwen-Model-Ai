'use strict';
require('dotenv').config();

const { retrieveKnowledge } = require('../rag-service');
const { assessAnswerability, suggestedResponse } = require('../answerability-service');

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('Usage: node scripts/stage5-answerability-test.cjs "Your company question"');
  process.exit(1);
}

async function main() {
  console.log('\nSTAGE 5 — COMPANY RAG ANSWERABILITY TEST (READ-ONLY)');
  console.log(`Question: ${question}`);
  const retrieved = await retrieveKnowledge(question);
  console.log(`Retrieval strategy: ${retrieved.selectionReason || 'unknown'}`);
  console.log(`Accepted chunks: ${retrieved.chunks?.length || 0}`);
  if (retrieved.supplementalQuery) {
    console.log(`Supplemental query: ${retrieved.supplementalQuery}`);
  }
  (retrieved.chunks || []).forEach((chunk, i) => {
    console.log(`  ${i + 1}. ${chunk.fileName} / ${chunk.topic || chunk.section} — ${chunk.score.toFixed(4)}`);
  });

  const result = await assessAnswerability({
    question,
    chunks: retrieved.chunks,
    relatedPolicyOnly: retrieved.relatedPolicyOnly,
  });

  console.log(`\nAnswerability: ${result.status}`);
  console.log(`Reason (model judgment): ${result.reason}`);
  console.log(`Evidence check: ${result.guard}`);
  console.log('\nSource-verified quotations:');
  if (result.evidence.length === 0) console.log('  (none)');
  for (const e of result.evidence) console.log(`  ${e.source} / ${e.topic}: “${e.quote}”`);
  console.log('\nConservative suggested response (not a live Jarvis answer):');
  console.log(suggestedResponse(question, result));
  console.log('\nNOTE: Quote verification proves the words exist in the source. It does not by itself guarantee the model\'s FULL/PARTIAL judgment is correct. Review the 4-case results before live integration.');
}

main().catch(error => {
  console.error(`\nStage 5 test failed: ${error.message}`);
  process.exitCode = 1;
});
