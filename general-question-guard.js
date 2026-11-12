"use strict";

/**
 * Safety net around the existing question-router.js.
 *
 * - Converts clearly GENERAL definitions that the primary router incorrectly
 *   classified as COMPANY_KNOWLEDGE back to GENERAL.
 * - Converts explicit "our/my office/company" questions that the primary
 *   router incorrectly classified as GENERAL to COMPANY_KNOWLEDGE.
 * - Never changes MICROSOFT_DOCS requests.
 *
 * This is deliberately narrow. Do not use it as a substitute for evaluating
 * the full question-router.js against real production questions.
 */
function normalizeQuestion(question) {
  return String(question || "")
    .trim()
    .replace(/^(?:(?:hi|hey|hello)\s+)?jarvis\s*[,!:;\-]?\s*/i, "")
    .replace(/^(?:hi|hey|hello)\s*[,!:;\-]?\s*/i, "")
    .trim();
}

function stripExplicitGeneralDisclaimer(text) {
  return text.replace(
    /\b(?:this\s+is\s+)?not\s+(?:a\s+question\s+)?(?:about|related\s+to)\s+(?:my|our|the)\s+(?:company|organisation|organization|office|workplace)\b/gi,
    ""
  );
}

function isClearlyCompanyQuestion(question) {
  const text = normalizeQuestion(question);
  if (!text) return false;

  // Respect explicit user scope: “This is not about my company.”
  const scopedText = stripExplicitGeneralDisclaimer(text);

  // Strong reference to THIS user's specific organization/office, including
  // intervening qualifiers such as “our EXACT office”, “my official shift”.
  const explicitOrganizationScope =
    /\b(?:our|my|this)\s+(?:(?:exact|official|normal|regular|usual|standard|current|specific)\s+){0,2}(?:company|organisation|organization|office|workplace|employer|team|department|employees|staff|infrastructure|internal\s+(?:process(?:es)?|polic(?:y|ies)|procedures?))\b/i.test(scopedText) ||
    /\b(?:at|in|for)\s+(?:our|my|this)\s+(?:company|office|workplace|organisation|organization|job)\b/i.test(scopedText);

  // Questions about employee-specific HR facts must not fall back to the
  // general LLM even if the original router does not recognize their intent.
  const explicitPersonalHRScope =
    /\b(?:my|our)\s+(?:(?:exact|official|current|remaining|available|monthly|annual|net|gross|paid)\s+){0,2}(?:salary|payslip|paycheck|payroll|leave\s+balance|attendance|shift\s+timings?|office\s+hours|working\s+hours|leave\s+entitlement)\b/i.test(scopedText);

  return explicitOrganizationScope || explicitPersonalHRScope;
}

function isClearlyGeneralQuestion(question) {
  const text = normalizeQuestion(question);
  if (!text) return false;

  // Company scope always takes priority over an unqualified definition request.
  if (isClearlyCompanyQuestion(text)) return false;

  const withoutNegatedScope = stripExplicitGeneralDisclaimer(text);

  const companyScope =
    /\b(?:my|our|your|the)\s+(?:company(?:'s)?|organisation(?:'s)?|organization(?:'s)?|office(?:'s)?|workplace(?:'s)?|team(?:'s)?|employees'?|infrastructure|systems?|network|servers?|process(?:es)?|procedures?|workflows?|operations?|departments?|IT)\b/i.test(withoutNegatedScope) ||
    /\b(?:internally|internal\s+(?:policy|procedure|process)|employee\s+handbook|according\s+to\s+(?:our|the)\s+policy|at\s+(?:my|our)\s+(?:work|company|office)|IANE)\b/i.test(withoutNegatedScope);

  if (companyScope) return false;

  const explicitlyGeneral =
    /\b(?:in\s+general|generally\s+speaking|in\s+general\s+terms|as\s+a\s+general\s+concept|conceptually|not\s+(?:a\s+question\s+)?(?:about|related\s+to)\s+(?:my|our|the)\s+(?:company|organisation|organization|office|workplace))\b/i.test(text);

  if (explicitlyGeneral) return true;

  const startsWithDefinitionRequest =
    /^(?:what\s+(?:is|are)\s+|(?:please\s+)?(?:explain|define|describe)\s+|(?:can|could)\s+you\s+(?:explain|define|describe)\s+|tell\s+me\s+(?:(?:a\s+little|more)\s+)?about\s+|give\s+me\s+(?:an?\s+)?overview\s+of\s+)/i.test(text);

  if (!startsWithDefinitionRequest) return false;

  const couldBeCompanyPolicy =
    /\b(?:leave|leaves|encashment|salary|payroll|attendance|punch[ -]?in|punch[ -]?out|sign[ -]?in|sign[ -]?out|working\s+hours|office\s+hours|shift\s+timings?|employee\s+benefits|overtime|reimbursements?|polic(?:y|ies)|hrms|holidays?)\b/i.test(text);

  if (couldBeCompanyPolicy) return false;

  // A bare follow-up pronoun may depend on company-specific chat history.
  if (/^(?:what\s+(?:is|are)\s+(?:it|that|those|they)\b|tell\s+me\s+(?:more\s+)?about\s+(?:it|that|them)\b)/i.test(text)) {
    return false;
  }

  return true;
}

function applyGeneralQuestionGuard(question, originalRoute, routes) {
  if (!originalRoute || !routes) return originalRoute;

  if (originalRoute.route === routes.MICROSOFT_DOCS) return originalRoute;

  if (
    originalRoute.route === routes.GENERAL &&
    isClearlyCompanyQuestion(question)
  ) {
    return {
      ...originalRoute,
      route: routes.COMPANY_KNOWLEDGE,
      reason: "explicit_company_scope_guard",
    };
  }

  if (
    originalRoute.route === routes.COMPANY_KNOWLEDGE &&
    isClearlyGeneralQuestion(question)
  ) {
    return {
      ...originalRoute,
      route: routes.GENERAL,
      reason: "general_definition_guard",
    };
  }

  return originalRoute;
}

module.exports = {
  isClearlyGeneralQuestion,
  isClearlyCompanyQuestion,
  applyGeneralQuestionGuard,
};
