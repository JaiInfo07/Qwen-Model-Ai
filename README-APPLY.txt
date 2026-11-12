JARVIS GENERAL + RAG ROUTING FIX
================================
Created from your uploaded current server.js, ai-system-prompt.js, rag-service.js.

WHAT CHANGES
------------
1. server.js (replace existing): keeps your current auth, chat, uploads,
   Qdrant retrieval and Microsoft docs integration. Adds a conservative
   general-question safety net and passes the selected knowledge mode
   into the system prompt.
2. ai-system-prompt.js (replace existing): explicitly permits ordinary
   general-knowledge answers while retaining strict grounding for
   actual company-policy questions. Prevents unrelated instruction
   examples from influencing general answers.
3. general-question-guard.js (NEW): prevents clear general definitions
   such as 'What is illusion?' and 'Tell me about infrastructure
   management?' being forced through company RAG. Company- and HR-
   specific requests remain under your original router.
4. tests/test-general-question-guard.cjs (NEW): runs local routing and
   prompt unit tests; needs neither Docker nor Ollama.

UNCHANGED
---------
rag-service.js, question-router.js, microsoft-docs-service.js,
AI provider settings, .env, Qdrant data, chat history, login/OTP.

INSTALL (PowerShell)
--------------------
1. Stop Jarvis (Ctrl+C in its npm start terminal).
2. Open PowerShell in your real JarvisAI project directory.
3. Back up both original files:

   Copy-Item .\server.js .\server.js.before-general-fix.bak
   Copy-Item .\ai-system-prompt.js .\ai-system-prompt.js.before-general-fix.bak

4. Extract this ZIP in a separate temporary folder.
5. Copy the extracted server.js, ai-system-prompt.js and
   general-question-guard.js into your JarvisAI project ROOT (beside
   server.js). Copy the included test file to JarvisAI\tests\.
   Do NOT overwrite or delete your existing rag-service.js or
   question-router.js.

6. Verify syntax and tests:

   node --check server.js
   node --check ai-system-prompt.js
   node --check general-question-guard.js
   node tests/test-general-question-guard.cjs

7. Start Jarvis again:

   npm start

LIVE ACCEPTANCE TESTS (use NEW conversations for each case)
-----------------------------------------------------------
A. 'What is illusion?'
   -> GENERAL; should define illusion, NOT request company sources.

B. 'Tell me about infrastructure management?'
   -> GENERAL; should describe infrastructure management.

C. 'How many casual leaves are employees entitled to?'
   -> COMPANY_KNOWLEDGE; should use real IANE.txt company chunks.

D. 'What is our office start and finish time?'
   -> COMPANY_KNOWLEDGE; cannot invent times not in IANE.txt.

E. 'What is Selvam's monthly salary?'
   -> COMPANY_KNOWLEDGE; must not invent salary.

Check the server terminal for [ROUTER] and possibly [ROUTER-GUARD].
If your original router already picks GENERAL, no guard log is necessary.

NOTE
----
Actual question-router.js was not uploaded, so this patch is a
conservative guard around your existing classifier, not a rewrite of
its rules. Offline unit tests passed; end-to-end test on your local
machine is still needed. The previous RAG relevance threshold is
not a full answerability guarantee; we can add that as the next stage.

ROLLBACK
--------
Stop Jarvis; restore the two .bak files to their original names;
remove general-question-guard.js; restart.
