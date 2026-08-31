// The research agent loop: drives the Anthropic Messages API through however many
// tool-use turns it takes to fill out finalize_persona, within a hard budget.
//
// Anthropic's own tools (web_search, web_fetch) are executed server-side by
// Anthropic and come back resolved within the same response — we never see a
// tool_use for those that we need to answer ourselves. Only client tools
// (search_jobs, finalize_persona) require us to execute and reply.

import { buildToolset, executeSearchJobs, MAX_AGENT_TURNS, MAX_OUTPUT_TOKENS, MAX_SEARCH_JOBS_CALLS } from "./tools.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import { sanitizePersona } from "./schema.js";

const ANTHROPIC_VERSION = "2023-06-01";
const CLIENT_TOOL_NAMES = new Set(["search_jobs", "finalize_persona"]);

function describeToolCall(block) {
  if (block.name === "search_jobs") return `Searching job postings for "${block.input?.query || ""}"…`;
  if (block.name === "web_search") return `Searching the web: ${block.input?.query || ""}`;
  if (block.name === "web_fetch") return `Reading ${block.input?.url || "a page"}…`;
  return `Running ${block.name}…`;
}

/**
 * Runs the full research loop.
 * @param {object} env - Worker env bindings/secrets.
 * @param {{jobTitle: string, companySize: string, industry: string}} input
 * @param {(event: {type: string, message?: string}) => void} onEvent - progress callback for SSE.
 * @returns {Promise<{persona: object|null, partial: boolean, error?: string}>}
 */
export async function runResearchAgent(env, input, onEvent) {
  const messages = [
    { role: "user", content: buildUserPrompt(input) },
  ];

  emit(onEvent, "status", "Conducting research…");
  let searchJobsCalls = 0;

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const forceFinalize = turn === MAX_AGENT_TURNS - 1;
    let response;
    try {
      response = await callClaudeWithOptionalForce(env, messages, forceFinalize);
    } catch (err) {
      console.error("Agent turn failed:", err);
      return { persona: null, partial: true, error: String(err.message || err) };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    const finalizeBlock = toolUseBlocks.find((b) => b.name === "finalize_persona");

    if (finalizeBlock) {
      emit(onEvent, "status", "Research complete — assembling results…");
      // Code-side backstop on top of the prompt's instructions — strips any
      // sample_profiles entry that isn't a genuine linkedin.com/in/... member
      // profile page (a job posting, company page, etc.) before it can ever
      // reach the frontend. See sanitizePersona in schema.js for why.
      return { persona: sanitizePersona(finalizeBlock.input), partial: turn >= MAX_AGENT_TURNS - 1 };
    }

    const clientToolBlocks = toolUseBlocks.filter((b) => CLIENT_TOOL_NAMES.has(b.name));

    if (clientToolBlocks.length === 0) {
      // Model produced text/server-tool activity but didn't call a client tool this turn.
      // Nudge it forward rather than looping on empty progress.
      if (response.stop_reason === "end_turn") {
        messages.push({
          role: "user",
          content: "Continue your research, or call finalize_persona now if you have enough to report.",
        });
      }
      continue;
    }

    const toolResults = [];
    for (const block of clientToolBlocks) {
      if (block.name === "search_jobs") {
        if (searchJobsCalls >= MAX_SEARCH_JOBS_CALLS) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({
              note: "search_jobs budget exhausted for this run — proceed with what you've already gathered instead of searching further.",
              results: [],
            }),
          });
          continue;
        }
        searchJobsCalls += 1;
        emit(onEvent, "status", describeToolCall(block));
        const result = await executeSearchJobs(env, block.input || {});
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  emit(onEvent, "status", "Ran out of research budget before a clean finish — reporting what was found.");
  return { persona: null, partial: true, error: "Exhausted tool-call budget without a finalize_persona call." };
}

async function callClaudeWithOptionalForce(env, messages, forceFinalize) {
  const model = env.CLAUDE_MODEL || "claude-sonnet-5";
  const body = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: buildSystemPrompt(),
    tools: buildToolset(),
    messages,
  };
  if (forceFinalize) {
    body.tool_choice = { type: "tool", name: "finalize_persona" };
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic API error ${resp.status}: ${errText.slice(0, 500)}`);
  }
  return resp.json();
}

function emit(onEvent, type, message) {
  try {
    onEvent && onEvent({ type, message });
  } catch (err) {
    console.error("onEvent handler threw:", err);
  }
}
