/**
 * Build step: generates the short "at a glance" summaries shown at the top of
 * NPC, Location, and Organisation pages, with the full dossier collapsed below.
 *
 * Runs before Eleventy (see the "build:summaries" script in package.json).
 * Summaries are produced by the Anthropic API, but only for notes whose
 * content hash has changed since the previous build; unchanged notes reuse
 * the cache in .cache/summaries.json (persisted between Netlify deploys via
 * netlify-plugin-cache). Output is written to src/site/_data/summaries.json,
 * which Eleventy exposes to templates as the `summaries` global.
 *
 * This step is always fail-soft: a missing ANTHROPIC_API_KEY or API failure
 * degrades to cached (or no) summaries — it must never break the site build.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const matter = require("gray-matter");
const { matterOptions } = require("./matterOptions");

const REPO_ROOT = path.join(__dirname, "..", "..");
const NOTES_DIR = path.join(REPO_ROOT, "src", "site", "notes");
const CACHE_FILE = path.join(REPO_ROOT, ".cache", "summaries.json");
const OUTPUT_FILE = path.join(REPO_ROOT, "src", "site", "_data", "summaries.json");

const SUMMARY_FOLDERS = ["NPCs", "Locations", "Organisations"];
// Notes with less body text than this are left uncollapsed — a summary card
// would be longer than the page itself.
const MIN_BODY_LENGTH = 600;
// Very large notes are truncated before being sent for summarisation.
const MAX_BODY_LENGTH = 60000;
const MODEL = "claude-sonnet-4-5";
const CONCURRENCY = 4;
const MAX_RETRIES = 3;
const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You write short "at a glance" summary cards for a D&D 5E campaign wiki ("Riders of the Storm").
Given the full wiki entry for an NPC, location, or organisation, write a 2-3 sentence summary (at most 60 words) covering who or what this is and their current status and relevance to the campaign right now.
Accuracy rules - these override everything else:
- Use ONLY facts stated explicitly in the entry. Never infer, extrapolate, combine facts into new claims, or add anything from outside the entry.
- Do not state that a character performed an action unless the entry explicitly says they did. A label such as "assassin" or "the Black Knight" is not evidence that they assassinated or killed anyone.
- If the entry marks something as uncertain, suspected, rumoured, or unknown, preserve that uncertainty with the same hedging.
- When in doubt, leave it out. A shorter, plainer summary is better than a confident wrong one.
Style rules:
- British English.
- Plain text only: no markdown, no headings, no bullet points, no [[wikilinks]].
- Lead with the most important fact; prefer the most recent status over older history.
- Do not begin with "This page", "This entry", or similar.`;

function hashContent(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

// The cache key folds in the model and the prompt as well as the note body, so
// changing either (to improve summary quality) invalidates every cached
// summary and forces a one-time regeneration on the next build.
function noteHash(body) {
  return hashContent(`${MODEL} ${SYSTEM_PROMPT} ${body}`);
}

/**
 * Finds all notes eligible for a summary card. Returns
 * [{ key, title, body, hash }] where key matches Eleventy's page.filePathStem
 * (e.g. "/notes/NPCs/Elincia Flowers").
 */
function discoverNotes(notesDir = NOTES_DIR, folders = SUMMARY_FOLDERS) {
  const notes = [];
  for (const folder of folders) {
    const dir = path.join(notesDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.toLowerCase().endsWith(".md")) continue;
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      let body;
      try {
        body = matter(raw, matterOptions).content.trim();
      } catch {
        continue;
      }
      if (body.length < MIN_BODY_LENGTH) continue;
      const title = file.replace(/\.md$/i, "");
      notes.push({
        key: `/notes/${folder}/${title}`,
        title,
        body,
        hash: noteHash(body),
      });
    }
  }
  return notes;
}

function loadJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/**
 * Splits discovered notes into those whose cached summary is still valid and
 * those needing (re)generation.
 */
function planGeneration(notes, cache) {
  const reusable = {};
  const toGenerate = [];
  for (const note of notes) {
    const cached = cache[note.key];
    if (cached && cached.hash === note.hash && cached.summary) {
      reusable[note.key] = cached;
    } else {
      toGenerate.push(note);
    }
  }
  return { reusable, toGenerate };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateSummary(note, apiKey, fetchImpl = fetch) {
  const body = note.body.slice(0, MAX_BODY_LENGTH);
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Wiki entry: ${note.title}\n\n${body}`,
          },
        ],
      }),
    }).catch((err) => ({ ok: false, status: 0, statusText: String(err) }));

    if (response.ok) {
      const data = await response.json();
      const text = (data.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!text) throw new Error("Empty summary returned");
      return text;
    }

    const retryable = response.status === 429 || response.status >= 500 || response.status === 0;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`API error ${response.status} ${response.statusText || ""}`.trim());
    }
    const retryAfter = response.headers && response.headers.get && response.headers.get("retry-after");
    const delay = retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
    await sleep(delay);
  }
}

/** Runs `worker` over `items` with limited concurrency. */
async function runPool(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function run({
  notesDir = NOTES_DIR,
  cacheFile = CACHE_FILE,
  outputFile = OUTPUT_FILE,
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const notes = discoverNotes(notesDir);
  const cache = loadJsonFile(cacheFile);
  const { reusable, toGenerate } = planGeneration(notes, cache);
  const results = { ...reusable };
  let generated = 0;
  let failed = 0;

  if (!apiKey) {
    log("[summaries] ANTHROPIC_API_KEY not set - using cached summaries only.");
    // Fall back to stale cache entries for changed notes rather than dropping them.
    for (const note of toGenerate) {
      const cached = cache[note.key];
      if (cached && cached.summary) results[note.key] = cached;
    }
  } else if (toGenerate.length > 0) {
    log(`[summaries] Generating ${toGenerate.length} summaries (${Object.keys(reusable).length} unchanged, cached).`);
    await runPool(toGenerate, CONCURRENCY, async (note) => {
      try {
        const summary = await generateSummary(note, apiKey, fetchImpl);
        results[note.key] = { hash: note.hash, summary };
        generated++;
      } catch (err) {
        failed++;
        const cached = cache[note.key];
        if (cached && cached.summary) {
          results[note.key] = cached;
          log(`[summaries] FAILED for "${note.key}" (${err.message}) - reusing stale summary.`);
        } else {
          log(`[summaries] FAILED for "${note.key}" (${err.message}) - page will render without a summary card.`);
        }
      }
    });
  } else {
    log(`[summaries] All ${notes.length} summaries up to date - no API calls needed.`);
  }

  writeJsonFile(cacheFile, results);
  const output = {};
  for (const [key, entry] of Object.entries(results)) {
    output[key] = { summary: entry.summary };
  }
  writeJsonFile(outputFile, output);
  log(`[summaries] Done: ${Object.keys(output).length} summaries written (${generated} generated, ${failed} failed).`);
  return { generated, failed, total: Object.keys(output).length };
}

module.exports = {
  discoverNotes,
  planGeneration,
  generateSummary,
  hashContent,
  noteHash,
  run,
  MIN_BODY_LENGTH,
  SUMMARY_FOLDERS,
};

if (require.main === module) {
  run().catch((err) => {
    // Fail-soft: never break the site build because summaries failed.
    console.error(`[summaries] Unexpected error, continuing build without new summaries: ${err.stack || err}`);
    if (!fs.existsSync(OUTPUT_FILE)) writeJsonFile(OUTPUT_FILE, {});
    process.exitCode = 0;
  });
}
