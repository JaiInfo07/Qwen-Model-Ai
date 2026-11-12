"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// This test uses mock Ollama/Qdrant HTTP responses: it never contacts services
// and never writes to your real Qdrant collection.
process.env.QDRANT_COLLECTION = "jarvis_ai_knowledge_prod";
process.env.RAG_MIN_SCORE = "0.55";
process.env.RAG_MIN_CONFIDENCE_SCORE = "0.58";
process.env.RAG_MAX_CONTEXT_CHUNKS = "3";

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "dotenv") return { config: () => ({ parsed: {} }) };
  return originalLoad.call(this, request, parent, isMain);
};
const { retrieveKnowledge } = require(path.join(__dirname, "..", "rag-service.js"));
Module._load = originalLoad;

function point(score, section, trustLevel="approved", text="Test policy") {
  return {
    id: section + score,
    score,
    payload: {
      text,
      topic: section,
      section,
      title: "IANE",
      fileName: "IANE.txt",
      trustLevel,
    },
  };
}

let queryHistory = [];
let resultsForQuestion = {};
let currentQuestion = "";

global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  if (url.endsWith("/api/embed")) {
    currentQuestion = body.input;
    return { ok: true, text: async () => JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }) };
  }
  if (url.includes("/points/query")) {
    queryHistory.push(currentQuestion);
    return { ok: true, text: async () => JSON.stringify({ result: { points: resultsForQuestion[currentQuestion] || [] } }) };
  }
  throw Error("Unexpected request: " + url);
};

async function run(question, results) {
  queryHistory = [];
  resultsForQuestion = results;
  return retrieveKnowledge(question);
}

(async () => {
  const officeQuestion = "What are our exact office start and end times?";
  const altQuestion = "How many working hours should employees maintain daily?";
  const workPolicy = point(0.7276, "Working Hours", "approved", "You must maintain an effective total of 9.5 working hours daily (Monday to Friday).");
  const offTopic = point(0.5232, "Mobile phone usage", "approved", "No personal calls during office hours.");

  let r = await run(officeQuestion, {
    [officeQuestion]: [offTopic],
    [altQuestion]: [workPolicy],
  });
  assert.equal(r.selectionReason, "related_working_hours_policy_fallback");
  assert.equal(r.relatedPolicyOnly, true);
  assert.equal(r.chunks.length, 1);
  assert.equal(r.chunks[0].section, "Working Hours");
  assert.match(r.context, /NOT proof of the exact clock times/);
  assert.match(r.context, /9\.5 working hours/);
  assert.equal(queryHistory.length, 2);
  console.log("PASS: time question retrieves related approved policy without lowering threshold");

  r = await run("What is Selvam's monthly salary?", {
    "What is Selvam's monthly salary?": [point(0.4021, "Payments")],
  });
  assert.equal(r.chunks.length, 0);
  assert.equal(queryHistory.length, 1);
  console.log("PASS: salary question never triggers alternate retrieval");

  const leaveQuestion = "How many casual leaves do employees get?";
  r = await run(leaveQuestion, {
    [leaveQuestion]: [point(0.6596, "Leaves")],
  });
  assert.equal(r.chunks.length, 1);
  assert.equal(r.relatedPolicyOnly, false);
  assert.equal(queryHistory.length, 1);
  console.log("PASS: known company policy still uses normal retrieval");

  r = await run(officeQuestion, {
    [officeQuestion]: [offTopic],
    [altQuestion]: [point(0.7276, "Working Hours", "unverified")],
  });
  assert.equal(r.chunks.length, 0);
  console.log("PASS: unapproved related policy is rejected");

  r = await run(officeQuestion, {
    [officeQuestion]: [offTopic],
    [altQuestion]: [point(0.57, "Working Hours", "approved")],
  });
  assert.equal(r.chunks.length, 0);
  console.log("PASS: score below existing 0.58 confidence gate is rejected");

  const generalQuestion = "What is an illusion?";
  r = await run(generalQuestion, {
    [generalQuestion]: [offTopic],
  });
  assert.equal(r.chunks.length, 0);
  assert.equal(queryHistory.length, 1);
  console.log("PASS: general question cannot trigger related-policy fallback");

  console.log("All 6 offline RAG fallback tests passed.");
})().catch(e => { console.error(e); process.exitCode = 1; });
