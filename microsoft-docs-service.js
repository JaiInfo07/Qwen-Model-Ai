const {
  spawn,
} = require("child_process");


/*
 * ============================================================
 * MICROSOFT OFFICIAL DOCUMENTATION SERVICE
 * ============================================================
 *
 * Testing-stage implementation:
 *
 * 1. Search through @microsoft/learn-cli
 * 2. Parse structured JSON results
 * 3. Prefer official Microsoft Support / Learn URLs
 * 4. Fetch the strongest official page
 * 5. Return compact grounded context
 *
 * No API key.
 * No credit card.
 * No paid search provider.
 */


const MAX_CONTEXT_CHARS = 7000;


function runLearnCli(args) {
  return new Promise(
    (resolve, reject) => {
      /*
       * On Windows, npx is exposed through npx.cmd.
       *
       * Node 24 cannot reliably spawn that .cmd shim directly
       * with shell:false, which causes:
       *
       * spawn EINVAL
       *
       * Instead, launch PowerShell itself and pass the Learn CLI
       * arguments through an environment variable as JSON.
       *
       * This also avoids inserting the user's question directly
       * into a shell command string.
       */
      if (process.platform === "win32") {
        const powershell =
          process.env.SystemRoot
            ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
            : "powershell.exe";


        const script = `
$ErrorActionPreference = "Stop"

$learnArgs =
  ConvertFrom-Json $env:JARVIS_LEARN_CLI_ARGS

& npx --yes "@microsoft/learn-cli" @learnArgs

exit $LASTEXITCODE
`.trim();


        const child =
          spawn(
            powershell,
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              script,
            ],
            {
              shell: false,

              windowsHide: true,

              env: {
                ...process.env,

                JARVIS_LEARN_CLI_ARGS:
                  JSON.stringify(args),
              },
            }
          );


        let stdout = "";
        let stderr = "";


        child.stdout.on(
          "data",
          (chunk) => {
            stdout +=
              chunk.toString();
          }
        );


        child.stderr.on(
          "data",
          (chunk) => {
            stderr +=
              chunk.toString();
          }
        );


        child.on(
          "error",
          (error) => {
            reject(error);
          }
        );


        child.on(
          "close",
          (code) => {
            if (code !== 0) {
              return reject(
                new Error(
                  stderr.trim() ||
                  `Microsoft Learn CLI exited with code ${code}`
                )
              );
            }


            resolve(
              stdout.trim()
            );
          }
        );


        return;
      }


      /*
       * Linux / macOS
       */
      const child =
        spawn(
          "npx",
          [
            "--yes",
            "@microsoft/learn-cli",
            ...args,
          ],
          {
            shell: false,
          }
        );


      let stdout = "";
      let stderr = "";


      child.stdout.on(
        "data",
        (chunk) => {
          stdout +=
            chunk.toString();
        }
      );


      child.stderr.on(
        "data",
        (chunk) => {
          stderr +=
            chunk.toString();
        }
      );


      child.on(
        "error",
        (error) => {
          reject(error);
        }
      );


      child.on(
        "close",
        (code) => {
          if (code !== 0) {
            return reject(
              new Error(
                stderr.trim() ||
                `Microsoft Learn CLI exited with code ${code}`
              )
            );
          }


          resolve(
            stdout.trim()
          );
        }
      );
    }
  );
}


/*
 * Microsoft Learn CLI currently returns URLs in Markdown form:
 *
 * [https://example](https://example)
 *
 * Convert them into plain URLs.
 */
function normalizeUrl(value) {
  const text =
    String(value || "").trim();


  if (!text) {
    return "";
  }


  const markdownMatch =
    text.match(
      /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/
    );


  if (markdownMatch) {
    return markdownMatch[2];
  }


  const plainMatch =
    text.match(
      /https?:\/\/[^\s)]+/i
    );


  return plainMatch
    ? plainMatch[0]
    : "";
}


/*
 * Extract Microsoft URLs appearing inside result content.
 *
 * This is important because Microsoft Q&A results sometimes
 * contain links to the real Microsoft Support article.
 */
function extractMicrosoftUrls(text) {
  const source =
    String(text || "");


  const matches =
    source.match(
      /https?:\/\/(?:support\.microsoft\.com|learn\.microsoft\.com)\/[^\s)\]\\]+/gi
    ) || [];


  return [
    ...new Set(
      matches.map(
        (url) =>
          url
            .replace(/&amp;/g, "&")
            .replace(/[.,;]+$/, "")
      )
    ),
  ];
}


/*
 * Source ranking.
 *
 * For ordinary Microsoft product/help questions:
 *
 * 1. Microsoft Support article
 * 2. Microsoft Learn product documentation
 * 3. Microsoft Learn developer/API documentation
 * 4. Microsoft Q&A
 */
function getSourcePriority(url) {
  const normalized =
    String(url || "")
      .toLowerCase();


  if (
    normalized.startsWith(
      "https://support.microsoft.com/"
    )
  ) {
    return 100;
  }


  if (
    normalized.startsWith(
      "https://learn.microsoft.com/"
    )
  ) {
    if (
      normalized.includes(
        "/answers/"
      )
    ) {
      return 40;
    }


    if (
      normalized.includes(
        "/javascript/api/"
      ) ||
      normalized.includes(
        "/office/dev/"
      ) ||
      normalized.includes(
        "/dotnet/api/"
      )
    ) {
      return 70;
    }


    return 90;
  }


  return 0;
}

function getCanonicalMicrosoftCandidates(question) {
  const text =
    String(question || "")
      .toLowerCase();


  const mentionsTeams =
    /\bmicrosoft teams\b|\bteams\b/i
      .test(text);


  const mentionsPowerAutomate =
    /\bpower automate\b|\bflow\b|\bcloud flow\b/i
      .test(text);


  const asksAboutConnectorBehaviour =
    /\btrigger\b|\baction\b|\bconnector\b|\bmessage\b|\bchannel\b/i
      .test(text);


  const candidates = [];


  /*
   * Canonical Microsoft Teams connector reference.
   *
   * Use this when the question is about Power Automate +
   * Teams triggers/actions/messages/channels.
   */
  if (
    mentionsTeams &&
    mentionsPowerAutomate &&
    asksAboutConnectorBehaviour
  ) {
    candidates.push({
      url:
        "https://learn.microsoft.com/en-us/connectors/teams/",

      title:
        "Microsoft Teams connector reference",

      sourceKind:
        "canonical_official_source",

      searchIndex:
        -1,

      priority:
        120,
    });
  }


  return candidates;
}


function buildCandidateList(results) {
  const candidates = [];
  const seen = new Set();


  function addCandidate(
    url,
    title,
    sourceKind,
    searchIndex
  ) {
    const cleanUrl =
      normalizeUrl(url) ||
      String(url || "").trim();


    if (!cleanUrl) {
      return;
    }


    if (
      !/^https:\/\/(?:support|learn)\.microsoft\.com\//i
        .test(cleanUrl)
    ) {
      return;
    }


    const key =
      cleanUrl.toLowerCase();


    if (seen.has(key)) {
      return;
    }


    seen.add(key);


    candidates.push({
      url:
        cleanUrl,

      title:
        String(
          title ||
          "Microsoft documentation"
        ).trim(),

      sourceKind,

      searchIndex,

      priority:
        getSourcePriority(
          cleanUrl
        ),
    });
  }


  results.forEach(
    (result, index) => {
      const directUrl =
        normalizeUrl(
          result.contentUrl
        );


      addCandidate(
        directUrl,
        result.title,
        "search_result",
        index
      );


      const embeddedUrls =
        extractMicrosoftUrls(
          result.content
        );


      embeddedUrls.forEach(
        (url) => {
          addCandidate(
            url,
            result.title,
            "embedded_official_link",
            index
          );
        }
      );
    }
  );


  return candidates.sort(
    (a, b) => {
      if (
        b.priority !==
        a.priority
      ) {
        return (
          b.priority -
          a.priority
        );
      }


      return (
        a.searchIndex -
        b.searchIndex
      );
    }
  );
}


async function searchMicrosoftDocs(
  question
) {
  const cleanQuestion =
    String(
      question || ""
    ).trim();


  if (!cleanQuestion) {
    throw new Error(
      "Microsoft documentation search requires a question."
    );
  }


  const raw =
    await runLearnCli([
      "search",
      cleanQuestion,
      "--json",
    ]);


  let parsed;


  try {
    parsed =
      JSON.parse(raw);
  } catch {
    throw new Error(
      "Microsoft Learn CLI returned invalid JSON."
    );
  }


  const results =
    Array.isArray(
      parsed.results
    )
      ? parsed.results
      : [];


  const candidates =
  buildCandidateList(
    results
  );


/*
 * Add known canonical Microsoft documentation when the
 * product/question type clearly matches.
 *
 * This complements Learn search instead of replacing it.
 */
const canonicalCandidates =
  getCanonicalMicrosoftCandidates(
    cleanQuestion
  );


for (
  const canonical of
  canonicalCandidates
) {
  const existing =
    candidates.find(
      (candidate) =>
        candidate.url.toLowerCase() ===
        canonical.url.toLowerCase()
    );


  if (existing) {
    existing.priority =
      Math.max(
        existing.priority,
        canonical.priority
      );

    existing.sourceKind =
      canonical.sourceKind;
  } else {
    candidates.push(
      canonical
    );
  }
}


candidates.sort(
  (a, b) => {
    if (
      b.priority !==
      a.priority
    ) {
      return (
        b.priority -
        a.priority
      );
    }


    return (
      a.searchIndex -
      b.searchIndex
    );
  }
);


  return {
    question:
      cleanQuestion,

    results,

    candidates,
  };
}


async function fetchMicrosoftPage(
  url
) {
  const cleanUrl =
    normalizeUrl(url) ||
    String(url || "").trim();


  if (
    !/^https:\/\/(?:support|learn)\.microsoft\.com\//i
      .test(cleanUrl)
  ) {
    throw new Error(
      "Refusing to fetch a non-Microsoft documentation URL."
    );
  }


  const content =
    await runLearnCli([
      "fetch",
      cleanUrl,
    ]);


  return {
    url:
      cleanUrl,

    content:
      content.trim(),
  };
}

function extractDocumentTitle(content, fallback = "Microsoft documentation") {
  const text =
    String(content || "");

  const heading =
    text.match(
      /^\s*#\s+(.+?)\s*$/m
    );

  return heading
    ? heading[1].trim()
    : fallback;
}


async function retrieveMicrosoftKnowledge(
  question
) {
  const search =
    await searchMicrosoftDocs(
      question
    );


  if (
    !search.candidates.length
  ) {
    return {
      question:
        search.question,

      source:
        null,

      context:
        "",

      candidates:
        [],
    };
  }


  /*
   * Start with the strongest official candidate.
   */
  const selected =
    search.candidates[0];


  let fetched;


  try {
    fetched =
      await fetchMicrosoftPage(
        selected.url
      );
  } catch (error) {
    /*
     * If the strongest URL cannot be fetched,
     * try the next official candidates.
     */
    let recovered =
      null;


    for (
      const candidate of
      search.candidates.slice(1, 5)
    ) {
      try {
        recovered =
          await fetchMicrosoftPage(
            candidate.url
          );


        if (recovered.content) {
          fetched =
            recovered;

          selected.url =
            candidate.url;

          selected.title =
            candidate.title;

          selected.priority =
            candidate.priority;

          break;
        }
      } catch {
        // Try next candidate.
      }
    }


    if (!fetched) {
      throw error;
    }
  }

  const fetchedTitle =
    extractDocumentTitle(
      fetched.content,
      selected.title
    );


  const trimmedContent =
    fetched.content.length >
    MAX_CONTEXT_CHARS
      ? `${fetched.content.slice(
          0,
          MAX_CONTEXT_CHARS
        )}\n\n[Content truncated]`
      : fetched.content;


  const context = `
[Microsoft Official Documentation]

Title: ${fetchedTitle}
URL: ${fetched.url}
Trust: official_microsoft

Content:
${trimmedContent}
`.trim();


  return {
    question:
      search.question,

    source: {
      title:
        fetchedTitle,

      url:
        fetched.url,

      trust:
        "official_microsoft",
    },

    context,

    candidates:
      search.candidates,
  };
}


/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
  getCanonicalMicrosoftCandidates,
  extractDocumentTitle,
  normalizeUrl,
  extractMicrosoftUrls,
  getSourcePriority,
  searchMicrosoftDocs,
  fetchMicrosoftPage,
  retrieveMicrosoftKnowledge,
};


/*
 * ============================================================
 * CLI TEST MODE
 * ============================================================
 */

if (
  require.main === module
) {
  const question =
    process.argv
      .slice(2)
      .join(" ")
      .trim();


  if (!question) {
    console.error(
      'Usage: node microsoft-docs-service.js "your question"'
    );

    process.exit(1);
  }


  console.log(
    "============================================================"
  );

  console.log(
    "D6.1 — MICROSOFT OFFICIAL DOCS RETRIEVAL"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `Question: ${question}`
  );


  retrieveMicrosoftKnowledge(
    question
  )
    .then(
      (result) => {
        console.log();

        console.log(
          "========== RANKED SOURCES =========="
        );


        result.candidates
          .slice(0, 8)
          .forEach(
            (candidate, index) => {
              console.log(
                `${index + 1}. ` +
                `[${candidate.priority}] ` +
                `${candidate.url}`
              );
            }
          );


        console.log();

        console.log(
          "========== SELECTED SOURCE =========="
        );


        if (!result.source) {
          console.log(
            "No official Microsoft source found."
          );

          return;
        }


        console.log(
          `Title : ${result.source.title}`
        );

        console.log(
          `URL   : ${result.source.url}`
        );

        console.log(
          `Trust : ${result.source.trust}`
        );


        console.log();

        console.log(
          "========== CONTEXT FOR QWEN =========="
        );

        console.log();

        console.log(
          result.context
        );


        console.log();

        console.log(
          "============================================================"
        );

        console.log(
          "D6.1 TEST COMPLETE"
        );

        console.log(
          "============================================================"
        );
      }
    )
    .catch(
      (error) => {
        console.error();

        console.error(
          "❌ Microsoft docs retrieval failed"
        );

        console.error(
          error.message
        );

        process.exit(1);
      }
    );
}