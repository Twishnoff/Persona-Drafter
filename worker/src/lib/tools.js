// Tool definitions available to the research agent, plus the implementation
// for the one custom tool (search_jobs). Anthropic's web_search / web_fetch
// tools are executed server-side by Anthropic itself — they never touch this
// Worker's own subrequest count. search_jobs is executed *by this Worker*,
// which is what keeps job-posting data structured and reliable (see the
// build plan's spike-test findings: Indeed/LinkedIn direct fetch is noisy or
// blocked, Adzuna/Jooble are not).

import { FINALIZE_PERSONA_TOOL } from "./schema.js";

// --- Cost-control constants (Layer 2 of the build plan's spend protection) ---
// These are hard ceilings enforced in code, not just requested of the model.
// web_search was raised 12 -> 16 (and MAX_AGENT_TURNS 14 -> 16 to match) so the
// Sample Profiles rule (see prompt.js) has enough budget left to actually run
// several distinct site:linkedin.com/in searches (primary title, each secondary
// title, and industry/company-size-combined queries) on top of everything else
// the methodology already needs web_search for. Dial this back down if runs are
// costing more than expected — see README's "Layer 2" note.
export const MAX_WEB_SEARCH_USES = 16;
export const MAX_WEB_FETCH_USES = 10;
export const MAX_SEARCH_JOBS_CALLS = 6; // each call fans out to Adzuna + Jooble
export const MAX_AGENT_TURNS = 16; // hard cap on Messages API round-trips per run
export const MAX_OUTPUT_TOKENS = 4096;

export const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: MAX_WEB_SEARCH_USES,
};

export const WEB_FETCH_TOOL = {
  type: "web_fetch_20250910",
  name: "web_fetch",
  max_uses: MAX_WEB_FETCH_USES,
  max_content_tokens: 60000,
};

export const SEARCH_JOBS_TOOL = {
  name: "search_jobs",
  description:
    "Search current job postings by title and (optionally) location, pulled from Adzuna and Jooble " +
    "(structured job-board APIs — prefer this over web_search/web_fetch for job postings, since it " +
    "returns clean title/company/description/date fields instead of noisy search results). " +
    "Returns up to 20 combined results per call, most recent first.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Job title or close variant to search for, e.g. 'Senior Data Engineer'." },
      location: { type: "string", description: "Optional location filter, e.g. 'United States'. Omit for broad/no location filter." },
      max_days_old: { type: "integer", description: "Restrict to postings at most this many days old. Defaults to 180 (six months), matching the research methodology." },
    },
  },
};

export function buildToolset() {
  return [WEB_SEARCH_TOOL, WEB_FETCH_TOOL, SEARCH_JOBS_TOOL, FINALIZE_PERSONA_TOOL];
}

// --- search_jobs implementation --------------------------------------------

async function searchAdzuna(env, { query, location, max_days_old }) {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return [];
  try {
    const country = "us"; // adjust if you need non-US postings
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
    url.searchParams.set("app_id", env.ADZUNA_APP_ID);
    url.searchParams.set("app_key", env.ADZUNA_APP_KEY);
    url.searchParams.set("what", query);
    if (location) url.searchParams.set("where", location);
    url.searchParams.set("results_per_page", "15");
    url.searchParams.set("max_days_old", String(max_days_old || 180));
    url.searchParams.set("content-type", "application/json");

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      console.error("Adzuna error:", resp.status, await resp.text().catch(() => ""));
      return [];
    }
    const data = await resp.json();
    return (data.results || []).map((job) => ({
      source: "adzuna",
      title: job.title,
      company: job.company?.display_name || "",
      location: job.location?.display_name || "",
      description: job.description || "",
      url: job.redirect_url || "",
      posted_date: job.created || "",
      salary_min: job.salary_min ?? null,
      salary_max: job.salary_max ?? null,
    }));
  } catch (err) {
    console.error("Adzuna fetch failed:", err);
    return [];
  }
}

async function searchJooble(env, { query, location }) {
  if (!env.JOOBLE_API_KEY) return [];
  try {
    const resp = await fetch(`https://jooble.org/api/${env.JOOBLE_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keywords: query, location: location || "" }),
    });
    if (!resp.ok) {
      console.error("Jooble error:", resp.status, await resp.text().catch(() => ""));
      return [];
    }
    const data = await resp.json();
    return (data.jobs || []).slice(0, 15).map((job) => ({
      source: "jooble",
      title: job.title,
      company: job.company || "",
      location: job.location || "",
      description: job.snippet || "",
      url: job.link || "",
      posted_date: job.updated || "",
      salary_min: null,
      salary_max: null,
    }));
  } catch (err) {
    console.error("Jooble fetch failed:", err);
    return [];
  }
}

/**
 * Executes the search_jobs tool: fans out to Adzuna + Jooble in parallel,
 * merges and lightly dedupes by title+company, caps at 20 combined results.
 */
export async function executeSearchJobs(env, input) {
  const [adzuna, jooble] = await Promise.all([searchAdzuna(env, input), searchJooble(env, input)]);
  const combined = [...adzuna, ...jooble];

  const seen = new Set();
  const deduped = [];
  for (const job of combined) {
    const key = `${(job.title || "").toLowerCase()}::${(job.company || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  if (deduped.length === 0) {
    return {
      note: "No results from Adzuna or Jooble for this query. Try a broader title, drop the location filter, or fall back to web_search for this specific query.",
      results: [],
    };
  }

  return { results: deduped.slice(0, 20) };
}
