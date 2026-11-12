/*
 * ============================================================
 * JARVIS QUESTION ROUTER
 * ============================================================
 *
 * Purpose:
 *
 * Decide whether a user's question is asking about:
 *
 * 1. Internal/company knowledge
 * 2. General knowledge
 *
 * IMPORTANT:
 *
 * This router does NOT answer the question.
 * It only decides whether Jarvis should query the internal
 * company RAG knowledge base.
 */


const ROUTES = Object.freeze({
  COMPANY_KNOWLEDGE: "company_knowledge",
  MICROSOFT_DOCS: "from_official_docs",
  GENERAL: "general",
});


function normalizeQuestion(question) {
  return String(question || "")
    .replace(/\s+/g, " ")
    .trim();
}


/*
 * ------------------------------------------------------------
 * STRONG INTERNAL COMPANY SIGNALS
 * ------------------------------------------------------------
 *
 * These phrases are specifically related to employment /
 * internal-office policy rather than normal technical questions.
 */
const STRONG_COMPANY_PATTERNS = [
  /\bleave encashment\b/i,
  /\bbalance leaves?\b/i,
  /\bpaid leaves?\b/i,
  /\bcasual leaves?\b/i,
  /\bsick leaves?\b/i,
  /\bleave application\b/i,

  /\bactive payroll\b/i,
  /\bgross salary\b/i,
  /\bpayroll\b/i,

  /\bwork from home\b/i,
  /\bworking from home\b/i,
  /\bwfh\b/i,

  /\bworking hours?\b/i,
  /\boffice hours?\b/i,

  /\bholiday payout\b/i,
  /\bcomp[\s-]?off\b/i,

  /\bbreak notification\b/i,

  /\bmanager(?:'s)? approval\b/i,

  /\bhuman resources\b/i,
  /\bemployee handbook\b/i,

  /\bcompany policy\b/i,
  /\bcompany policies\b/i,
  /\boffice policy\b/i,
  /\boffice policies\b/i,
];


/*
 * ------------------------------------------------------------
 * EMPLOYMENT CONTEXT SIGNALS
 * ------------------------------------------------------------
 */
const EMPLOYMENT_CONTEXT_PATTERNS = [
  /\bemployees?\b/i,
  /\bemployment\b/i,
  /\bpayroll\b/i,
  /\bsalary\b/i,
  /\bhr\b/i,
  /\bmanager\b/i,
  /\borganisation\b/i,
  /\borganization\b/i,
  /\bcompany\b/i,
];


/*
 * ------------------------------------------------------------
 * PERSONAL POLICY QUESTIONS
 * ------------------------------------------------------------
 *
 * Example:
 *
 * "How many leaves do I get?"
 * "Can I take permission today?"
 * "What are my office hours?"
 *
 * These may not explicitly contain the word "company".
 */
const PERSONAL_POLICY_PATTERN =
  /\b(?:can i|am i|do i|how many|how much|what are my|when can i|will i|get i|eligible)\b[\s\S]{0,100}\b(?:leave|leaves|salary|permission|attendance|working hours|office hours|work from home|wfh|holiday|payroll|break)\b/i;


/*
 * Generic leave-related phrases that are clearly HR-oriented.
 *
 * We intentionally do NOT classify every occurrence of the word
 * "leave" as company knowledge because a technical question such
 * as "How do I leave a Teams meeting?" should remain general.
 */
const HR_LEAVE_PATTERNS = [
  /\btake (?:a )?leave\b/i,
  /\btake leaves?\b/i,
  /\bleave balance\b/i,
  /\bleave days?\b/i,
  /\bleave policy\b/i,
  /\bleave calendar\b/i,
  /\bleave approval\b/i,
  /\bannual leaves?\b/i,
];

/*
 * ------------------------------------------------------------
 * GENERAL EXIT / LEAVE ACTIONS
 * ------------------------------------------------------------
 *
 * Prevent the word "leave" from being mistaken for HR leave
 * when the user means exiting a meeting, call, chat, group,
 * channel, or application session.
 */

const GENERAL_EXIT_ACTION_PATTERNS = [
  /*
   * Handles:
   *
   * leave a meeting
   * leave a Teams meeting
   * leave a Microsoft Teams meeting
   * leave a Zoom meeting
   * leave a Google Meet call
   * exit the Webex meeting
   *
   * Up to 3 words may appear between the article and
   * meeting/call/etc. so we don't need vendor-specific rules.
   */
  /\b(?:leave|exit)\s+(?:(?:a|the|this)\s+)?(?:[\w.-]+\s+){0,3}(?:meeting|call|conference|chat|group|channel)\b/i,

  /*
   * Same idea for "end".
   */
  /\bend\s+(?:(?:a|the|this)\s+)?(?:[\w.-]+\s+){0,3}(?:meeting|call|conference)\b/i,
];


/*
 * ------------------------------------------------------------
 * MICROSOFT PRODUCT / DOCUMENTATION SIGNALS
 * ------------------------------------------------------------
 *
 * These are questions that should use official Microsoft docs
 * rather than relying only on the base model.
 */
const MICROSOFT_PRODUCT_PATTERNS = [
  /\bmicrosoft excel\b/i,
  /\bexcel\b/i,

  /\bmicrosoft teams\b/i,
  /\bteams\b/i,

  /\bpower automate\b/i,
  /\bpower apps\b/i,
  /\bpower bi\b/i,

  /\bsharepoint\b/i,
  /\bonedrive\b/i,

  /\boutlook\b/i,

  /\bmicrosoft 365\b/i,
  /\boffice 365\b/i,

  /\bazure\b/i,

  /\bmicrosoft graph\b/i,

  /\boffice scripts?\b/i,
];


/*
 * ------------------------------------------------------------
 * CLASSIFICATION
 * ------------------------------------------------------------
 */
function classifyQuestion(question) {
  const normalizedQuestion =
    normalizeQuestion(question);


  if (!normalizedQuestion) {
    return {
      route: ROUTES.GENERAL,
      reason: "empty_question",
      normalizedQuestion,
    };
  }

  /*
   * General application actions must be checked before
   * HR/policy patterns because words such as "leave" are
   * ambiguous.
   */
  
for (
  const pattern of
  GENERAL_EXIT_ACTION_PATTERNS
) {
  if (
    pattern.test(
      normalizedQuestion
    )
  ) {
    const isMicrosoftExitAction =
      MICROSOFT_PRODUCT_PATTERNS.some(
        (microsoftPattern) =>
          microsoftPattern.test(
            normalizedQuestion
          )
      );


    return {
      route:
        isMicrosoftExitAction
          ? ROUTES.MICROSOFT_DOCS
          : ROUTES.GENERAL,

      reason:
        isMicrosoftExitAction
          ? "microsoft_product_exit_action"
          : "general_exit_action",

      normalizedQuestion,
    };
  }
}


  for (const pattern of STRONG_COMPANY_PATTERNS) {
    if (pattern.test(normalizedQuestion)) {
      return {
        route: ROUTES.COMPANY_KNOWLEDGE,
        reason: "strong_company_signal",
        normalizedQuestion,
      };
    }
  }


  if (
    PERSONAL_POLICY_PATTERN.test(
      normalizedQuestion
    )
  ) {
    return {
      route: ROUTES.COMPANY_KNOWLEDGE,
      reason: "personal_policy_question",
      normalizedQuestion,
    };
  }


  for (const pattern of HR_LEAVE_PATTERNS) {
    if (pattern.test(normalizedQuestion)) {
      return {
        route: ROUTES.COMPANY_KNOWLEDGE,
        reason: "hr_leave_signal",
        normalizedQuestion,
      };
    }
  }


  /*
   * Employment-context terms alone are intentionally weaker.
   *
   * Require at least one policy/benefit-related concept as well.
   */
  const hasEmploymentContext =
    EMPLOYMENT_CONTEXT_PATTERNS.some(
      (pattern) =>
        pattern.test(
          normalizedQuestion
        )
    );


  const hasPolicyConcept =
    /\b(?:policy|rule|benefit|leave|salary|attendance|permission|holiday|working hours|office hours|work from home|wfh|break)\b/i
      .test(
        normalizedQuestion
      );


  if (
    hasEmploymentContext &&
    hasPolicyConcept
  ) {
    return {
      route: ROUTES.COMPANY_KNOWLEDGE,
      reason: "employment_policy_context",
      normalizedQuestion,
    };
  }

  /*
 * Microsoft technical/product questions.
 *
 * Company-policy classification has already happened above,
 * so questions such as "What is our leave policy?" cannot
 * accidentally become Microsoft documentation queries.
 */
const isMicrosoftQuestion =
  MICROSOFT_PRODUCT_PATTERNS.some(
    (pattern) =>
      pattern.test(
        normalizedQuestion
      )
  );


if (isMicrosoftQuestion) {
  return {
    route:
      ROUTES.MICROSOFT_DOCS,

    reason:
      "microsoft_product_signal",

    normalizedQuestion,
  };
}


  return {
    route: ROUTES.GENERAL,
    reason: "no_internal_company_signal",
    normalizedQuestion,
  };
}


/*
 * Convenient helper for server.js later.
 */
function getQuestionRoute(question) {
  return classifyQuestion(question).route;
}


module.exports = {
  ROUTES,
  normalizeQuestion,
  classifyQuestion,
  getQuestionRoute,
};


/*
 * ============================================================
 * CLI TEST MODE
 * ============================================================
 */

if (require.main === module) {
  const question =
    process.argv
      .slice(2)
      .join(" ")
      .trim();


  if (!question) {
    console.error(
      'Usage: node question-router.js "your question"'
    );

    process.exit(1);
  }


  const result =
    classifyQuestion(question);


  console.log(
    "============================================================"
  );

  console.log(
    "JARVIS QUESTION ROUTER"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `Question : ${question}`
  );

  console.log(
    `Route    : ${result.route}`
  );

  console.log(
    `Reason   : ${result.reason}`
  );

  console.log(
    "============================================================"
  );
}