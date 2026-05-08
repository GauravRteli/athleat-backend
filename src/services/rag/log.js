// Tiny structured logger for the RAG pipeline.
//
// Output looks like:
//   [rag][indexer 14:32:09.123] claim id=abc-123 file=foo.pdf
//
// Each tag (indexer / chat / pinecone / extract / embed / backfill) gets its
// own bound logger via `tag()` so call-sites stay terse:
//
//   const log = require("./log").tag("indexer");
//   log.info("claim", { id, file: entry.file_name });
//
// Format conventions:
//   • info / warn / error pick the stream + label
//   • a payload object is rendered as `key=value` pairs (truncated strings)
//   • errors are pulled out separately and rendered after the kv pairs

function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
}

function trim(value, max = 80) {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    if (typeof v === "string") parts.push(`${k}="${trim(v)}"`);
    else parts.push(`${k}=${trim(v)}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function emit(stream, tagName, level, msg, payload, err) {
  const line = `[rag][${tagName} ${ts()}] ${level ? `${level} ` : ""}${msg}${fmtPayload(payload)}`;
  if (err) {
    stream(`${line}  err="${err.message || err}"`);
    if (err.stack && process.env.RAG_LOG_STACK === "1") stream(err.stack);
  } else {
    stream(line);
  }
}

function tag(name) {
  return {
    info: (msg, payload) => emit(console.log, name, "", msg, payload),
    warn: (msg, payload, err) => emit(console.warn, name, "WARN", msg, payload, err),
    error: (msg, payload, err) => emit(console.error, name, "ERROR", msg, payload, err),
    // Convenience timer: returns ms since `start()` was called.
    timer: () => {
      const t0 = Date.now();
      return () => Date.now() - t0;
    },
  };
}

module.exports = { tag };
