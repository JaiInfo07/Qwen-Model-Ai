"use strict";

const assert = require("node:assert/strict");
const {
  isClearlyGeneralQuestion,
  isClearlyCompanyQuestion,
  applyGeneralQuestionGuard,
} = require("../general-question-guard");
const { buildSystemPrompt } = require("../ai-system-prompt");

// These are mocks of the route constants; the live server supplies the
// real values to the guard at runtime, so uppercase/lowercase both work.
const ROUTES = {
  GENERAL: "general",
  COMPANY_KNOWLEDGE: "company_knowledge",
  MICROSOFT_DOCS: "microsoft_docs",
};

const expectedGeneral = [
  "What is an illusion?",
  "What is illusion?",
  "Tell me about infrastructure management?",
  "What is infrastructure management?",
  "Explain Kubernetes",
  "What is the capital of France?",
  "Explain infrastructure management in general. This is not a question about my company.",
  "What is our solar system?",
];

// If the primary router already selects GENERAL for an unqualified
// industry/country question, leave that decision unchanged.
const normalGeneral = applyGeneralQuestionGuard(
  "What are typical office hours in India?",
  { route: ROUTES.GENERAL, reason: "no_internal_company_signal" },
  ROUTES,
);
assert.equal(normalGeneral.route, ROUTES.GENERAL);

const expectedCompany = [
  "What are our exact office start and end times?",
  "What is our office start time?",
  "What are our official office hours?",
  "What time does our office open?",
  "Tell me about our infrastructure management",
  "How does our company manage infrastructure?",
  "What is my salary?",
  "What is our leave balance?",
  "What is my monthly payslip?",
  "What is my company's working policy?",
  "At our office, what are the working hours?",
];

for (const question of expectedGeneral) {
  assert.equal(
    isClearlyCompanyQuestion(question),
    false,
    `Unexpected COMPANY scope: ${question}`,
  );
  const result = applyGeneralQuestionGuard(
    question,
    { route: ROUTES.COMPANY_KNOWLEDGE, reason: "mock" },
    ROUTES,
  );
  // General-policy questions are deliberately conservative; all cases here
  // are safe ordinary explanations, not specific HR policy queries.
  assert.equal(result.route, ROUTES.GENERAL, `Expected GENERAL: ${question}`);
}

for (const question of expectedCompany) {
  assert.equal(
    isClearlyCompanyQuestion(question),
    true,
    `Missing COMPANY scope: ${question}`,
  );
  const result = applyGeneralQuestionGuard(
    question,
    { route: ROUTES.GENERAL, reason: "no_internal_company_signal" },
    ROUTES,
  );
  assert.equal(result.route, ROUTES.COMPANY_KNOWLEDGE, `Expected COMPANY: ${question}`);
  assert.equal(result.reason, "explicit_company_scope_guard");
}

const companyByDefault = [
  "How many casual leaves are employees entitled to?",
  "What is Selvam's monthly salary?",
  "What is leave encashment?",
];
for (const question of companyByDefault) {
  const result = applyGeneralQuestionGuard(
    question,
    { route: ROUTES.COMPANY_KNOWLEDGE, reason: "original_company" },
    ROUTES,
  );
  assert.equal(result.route, ROUTES.COMPANY_KNOWLEDGE, `Keep original company: ${question}`);
}

const microsoft = applyGeneralQuestionGuard(
  "What are our Microsoft Teams policies?",
  { route: ROUTES.MICROSOFT_DOCS, reason: "ms" },
  ROUTES,
);
assert.equal(microsoft.route, ROUTES.MICROSOFT_DOCS);

assert.match(buildSystemPrompt({ knowledgeMode: "general" }), /Current Request Mode: GENERAL KNOWLEDGE/);
assert.match(buildSystemPrompt({ knowledgeMode: "company" }), /Current Request Mode: COMPANY_KNOWLEDGE/);

console.log(`PASS: ${expectedGeneral.length} general, ${expectedCompany.length} company, ` +
  `${companyByDefault.length} retained-company cases, Microsoft route + prompt modes.`);
