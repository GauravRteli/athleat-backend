// RAG chat turn.
//
// Given a conversation (`messages: [{role, content}, …]`) plus optional
// `topK` and `studentFirstName` (dashboard student's first token for
// `[FirstName]` substitutions in the master prompt), this:
//   1. trims to last N turns (env.rag.maxHistoryTurns)
//   2. embeds the latest user message
//   3. queries Supabase pgvector (match_knowledge_chunks RPC) for the top-K
//      matching chunks
//   4. builds a system prompt that injects those chunks as CONTEXT
//   5. calls Anthropic Messages API (reply text only; embeddings stay OpenAI)
//   6. returns { answer, sources }
//
// No data is persisted — chat memory lives only on the client.

const Anthropic = require("@anthropic-ai/sdk");
const env = require("../../config/env");
const { MASTER_SYSTEM_PROMPT } = require("../kez/masterPrompt");
const { embedQuery } = require("./embeddings");
const vectorStore = require("./vectorStore");
const log = require("./log").tag("chat");

let _anthropic = null;
function getAnthropicClient() {
  if (!env.anthropic.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — knowledge-base chat is disabled.");
  }
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: env.anthropic.apiKey });
  return _anthropic;
}

function textFromAnthropicMessage(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// Full Virtual Kez persona + guardrails (voice, macros, hard stops, etc.)
// live in masterPrompt.js — same source as meal analysis / feedback drafts.
// Below we add RAG-only task rules so answers stay grounded in retrieved chunks.

const KNOWLEDGE_BASE_TASK_RULES = [
  "Current task: KNOWLEDGE_BASE_QA — Brain tab chat with retrieval.",
  "",
  "Apply EVERY rule in the MASTER SYSTEM PROMPT above (voice for Kerry / Brain tab, hard stops, anti-doping, uncertainty flagging where relevant, etc.).",
  "",
  "The === STUDENT CONTEXT === block (between the master prompt and this section) defines how to replace `[FirstName]` in greetings and athlete-facing wording. Never emit the literal characters [FirstName] in your reply — use the resolved name given there.",
  "",
  "Retrieval grounding (non-negotiable):",
  "- Ground factual claims in the CONTEXT block below. Prefer information that appears there.",
  "- If CONTEXT is empty or does not support a confident answer, say plainly that the indexed knowledge base does not cover it — do not invent studies, statistics, clinical guidelines, product names, or athlete-specific data.",
  "- When you use a fact from CONTEXT, cite it as [#1], [#2], … matching the numbered blocks.",
  "- If CONTEXT conflicts with NEVER / CORRECTION entries inside it, those override generic advice.",
  "- Keep answers concise unless the user explicitly asks for depth; Kerry Brain mode allows technical/clinical wording per the master prompt.",
].join("\n");

function trimHistory(messages, maxTurns) {
  if (!Array.isArray(messages)) return [];
  const cleaned = messages
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .filter((m) => m.role === "user" || m.role === "assistant");
  // Keep last N user turns plus their assistant replies.
  const keep = Math.max(2, maxTurns * 2);
  return cleaned.slice(-keep);
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

/** First token only; strips control chars / digits / injection fodder from API input. */
function sanitizeStudentFirstName(raw) {
  if (raw == null) return "";
  const head = String(raw).trim().split(/\r?\n/)[0];
  if (!head) return "";
  const token = head.split(/\s+/)[0] || "";
  const cleaned = token.normalize("NFC").replace(/[^\p{L}'-]+/gu, "");
  if (!cleaned || cleaned.length > 48) return "";
  return cleaned;
}

function formatStudentContextBlock(studentFirstName) {
  const fn = sanitizeStudentFirstName(studentFirstName);
  const body = fn
    ? [
        `athlete_first_name: ${fn}`,
        "",
        `When the master prompt tells you to open with Hey [FirstName]., you MUST open with Hey ${fn}.`,
        `Use this exact spelling. Do not wrap the name in brackets. Never output the substring [FirstName].`,
        "When you address the athlete in-frame as 'you', assume you are speaking about / to this athlete.",
      ].join("\n")
    : [
        "No athlete/student is selected in the Kerry dashboard for this request.",
        "",
        "When the master prompt tells you to open with Hey [FirstName]., open with Hey Kerry. instead (coach asking Virtual Kez in Brain-tab mode).",
      ].join("\n");
  return ["=== STUDENT CONTEXT ===", body, "=== END STUDENT CONTEXT ==="].join("\n");
}

function formatContext(matches) {
  if (!matches.length) {
    return "(No relevant entries were retrieved from the knowledge base.)";
  }
  return matches
    .map((m, i) => {
      const md = m.metadata || {};
      const label = md.file_name
        ? `${md.file_name} (chunk ${md.chunk_index ?? "?"})`
        : md.entry_type === "correction"
          ? `Correction note (${md.category || "general"})`
          : md.entry_type === "never"
            ? `Hard stop (${md.category || "general"})`
            : `Knowledge note (${md.category || "general"})`;
      return `[#${i + 1}] ${label}\n${md.text || ""}`.trim();
    })
    .join("\n\n---\n\n");
}

function shapeSources(matches) {
  return matches.map((m, i) => {
    const md = m.metadata || {};
    return {
      ref: i + 1,
      score: typeof m.score === "number" ? Number(m.score.toFixed(4)) : null,
      entry_id: md.entry_id || null,
      entry_type: md.entry_type || null,
      file_name: md.file_name || null,
      file_url: md.file_url || null,
      chunk_index: md.chunk_index ?? null,
      category: md.category || null,
      preview: md.text ? String(md.text).slice(0, 240) : "",
    };
  });
}

async function chatTurn({ messages, topK, studentFirstName }) {
  if (!env.openai.apiKey) {
    throw Object.assign(new Error("OPENAI_API_KEY not configured (required for RAG embeddings)"), { status: 503 });
  }
  if (!env.anthropic.apiKey) {
    throw Object.assign(new Error("ANTHROPIC_API_KEY not configured"), { status: 503 });
  }

  const trimmed = trimHistory(messages, env.rag.maxHistoryTurns);
  const userQ = lastUser(trimmed);
  if (!userQ.trim()) {
    throw Object.assign(new Error("No user message in conversation"), { status: 400 });
  }

  const stop = log.timer();
  const k = Math.max(1, Math.min(20, topK || env.rag.topK));
  log.info("turn start", {
    q: userQ,
    history: trimmed.length,
    topK: k,
    athlete_ctx: sanitizeStudentFirstName(studentFirstName) ? "named" : "none",
  });

  const tEmbed = log.timer();
  const queryVector = await embedQuery(userQ);
  log.info("query embedded", { dim: queryVector.length, took_ms: tEmbed() });

  const tQ = log.timer();
  const matches = await vectorStore.query({ vector: queryVector, topK: k });
  const top = matches[0]?.score ?? null;
  const bot = matches[matches.length - 1]?.score ?? null;
  log.info("retrieved", {
    count: matches.length,
    top_score: top != null ? Number(top.toFixed(4)) : null,
    min_score: bot != null ? Number(bot.toFixed(4)) : null,
    took_ms: tQ(),
  });

  const contextBlock = formatContext(matches);
  const studentCtx = formatStudentContextBlock(studentFirstName);
  const systemPrompt = [
    MASTER_SYSTEM_PROMPT,
    "",
    studentCtx,
    "",
    KNOWLEDGE_BASE_TASK_RULES,
    "",
    `=== CONTEXT (top ${matches.length} matches) ===`,
    contextBlock,
    "=== END CONTEXT ===",
  ].join("\n");
  const tChat = log.timer();
  const client = getAnthropicClient();
  const anthropicMessages = trimmed.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const completion = await client.messages.create({
    model: env.anthropic.ragChatModel,
    max_tokens: Math.max(256, Math.min(8192, env.anthropic.ragMaxOutputTokens || 4096)),
    temperature: 0.3,
    system: systemPrompt,
    messages: anthropicMessages,
  });
  const answer = textFromAnthropicMessage(completion);
  log.info("completion done", { chars: answer.length, took_ms: tChat() });
  log.info("turn done", { total_ms: stop() });

  return {
    answer,
    sources: shapeSources(matches),
  };
}

module.exports = { chatTurn };
