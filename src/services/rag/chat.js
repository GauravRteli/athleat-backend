// RAG chat turn.
//
// Given a conversation (`messages: [{role, content}, …]`) plus an optional
// `topK`, this:
//   1. trims to last N turns (env.rag.maxHistoryTurns)
//   2. embeds the latest user message
//   3. queries Supabase pgvector (match_knowledge_chunks RPC) for the top-K
//      matching chunks
//   4. builds a system prompt that injects those chunks as CONTEXT
//   5. calls OpenAI chat completions
//   6. returns { answer, sources }
//
// No data is persisted — chat memory lives only on the client.

const OpenAI = require("openai");
const env = require("../../config/env");
const { embedQuery } = require("./embeddings");
const vectorStore = require("./vectorStore");
const log = require("./log").tag("chat");

let _client = null;
function getClient() {
  if (!env.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is not set — chatbot is disabled.");
  }
  if (!_client) _client = new OpenAI({ apiKey: env.openai.apiKey });
  return _client;
}

const SYSTEM_PERSONA = [
  "You are Virtual Kez — a knowledgeable, no-nonsense performance dietitian assistant.",
  "Answer the user's question using ONLY the CONTEXT excerpts below.",
  "If the answer cannot be found in the context, say plainly that the knowledge base doesn't cover it — do not invent facts.",
  "When you cite a fact, you may reference its source as [#1], [#2], etc., matching the numbered context blocks.",
  "Be concise, practical, and use plain English.",
].join(" ");

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

async function chatTurn({ messages, topK }) {
  if (!env.openai.apiKey) {
    throw Object.assign(new Error("OpenAI API key not configured"), { status: 503 });
  }

  const trimmed = trimHistory(messages, env.rag.maxHistoryTurns);
  const userQ = lastUser(trimmed);
  if (!userQ.trim()) {
    throw Object.assign(new Error("No user message in conversation"), { status: 400 });
  }

  const stop = log.timer();
  const k = Math.max(1, Math.min(20, topK || env.rag.topK));
  log.info("turn start", { q: userQ, history: trimmed.length, topK: k });

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
  const systemPrompt = `${SYSTEM_PERSONA}\n\n=== CONTEXT (top ${matches.length} matches) ===\n${contextBlock}\n=== END CONTEXT ===`;

  const tChat = log.timer();
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: env.openai.chatModel,
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      ...trimmed.map((m) => ({ role: m.role, content: m.content })),
    ],
  });
  const answer = completion.choices?.[0]?.message?.content || "";
  log.info("completion done", { chars: answer.length, took_ms: tChat() });
  log.info("turn done", { total_ms: stop() });

  return {
    answer,
    sources: shapeSources(matches),
  };
}

module.exports = { chatTurn };
