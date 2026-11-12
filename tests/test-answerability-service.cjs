'use strict';
const assert = require('node:assert/strict');
const {
  STATUS, parseDecision, verifyEvidenceItems, suggestedResponse, assessAnswerability,
} = require('../answerability-service');

const chunks = [
  { text: 'Employees get 12 casual leaves and 6 sick leaves after they are accrued.', topic: 'Leaves', fileName: 'IANE.txt' },
  { text: 'Employees must maintain an effective total of 9.5 working hours daily.', topic: 'Working Hours', fileName: 'IANE.txt' },
];

async function main() {
  const full = parseDecision(JSON.stringify({
    status: 'FULL', reason: '12 days stated', evidence: [{ chunk: 1, quote: '12 casual leaves' }],
  }), chunks);
  assert.equal(full.status, STATUS.FULL);
  assert.equal(full.evidence[0].source, 'IANE.txt');

  const partial = parseDecision(JSON.stringify({
    status: 'PARTIAL', reason: 'Duration is known, clock times are absent',
    evidence: [{ chunk: 2, quote: '9.5 working hours daily' }],
  }), chunks);
  assert.equal(partial.status, STATUS.PARTIAL);
  assert.match(suggestedResponse('Exact office times?', partial), /does not explicitly answer/i);

  const fake = parseDecision(JSON.stringify({
    status: 'FULL', reason: 'Made up office timings', evidence: [{ chunk: 2, quote: '9:30 AM to 6:30 PM' }],
  }), chunks);
  assert.equal(fake.status, STATUS.NONE);
  assert.equal(fake.guard, 'unverifiable_evidence');

  assert.equal(parseDecision('bad json', chunks).status, STATUS.NONE);
  assert.equal(parseDecision('{"status":"FULL","evidence":[]}', chunks).status, STATUS.NONE);
  assert.equal(verifyEvidenceItems([{ chunk: 999, quote: '12 casual leaves' }], chunks).length, 0);

  let calls = 0;
  const noChunks = await assessAnswerability({ question: 'How much salary?', chunks: [], fetchImpl: () => { calls++; } });
  assert.equal(noChunks.status, STATUS.NONE);
  assert.equal(calls, 0, 'No Qwen request should occur with no accepted chunks');

  const mockFetch = async (_url, args) => {
    const body = JSON.parse(args.body);
    assert.equal(body.model.length > 0, true);
    assert.equal(body.format, 'json');
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({
      status: 'FULL', reason: 'Policy states it', evidence: [{ chunk: 1, quote: '12 casual leaves' }],
    }) } }) };
  };
  const mocked = await assessAnswerability({ question: 'How many casual leaves?', chunks, fetchImpl: mockFetch });
  assert.equal(mocked.status, STATUS.FULL);

  console.log('Stage 5 answerability tests passed (offline mocks, no Ollama or Qdrant required).');
}
main().catch(error => { console.error(error); process.exit(1); });
