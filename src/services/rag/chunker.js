// Recursive character text splitter with token-aware sizing.
//
// Strategy (LangChain-style RecursiveCharacterTextSplitter):
//   1. Pick the largest natural separator that keeps every block under
//      `chunkSize` tokens (paragraph → newline → sentence → comma → space).
//   2. If a block is still too big, recurse with the next finer separator.
//   3. Pack adjacent small blocks together up to chunkSize, and bleed a
//      `chunkOverlap`-token tail of the previous chunk into the next one to
//      preserve cross-boundary context for retrieval.
//
// Token counts use tiktoken `cl100k_base` (the encoding used by all current
// OpenAI text-embedding-3-* models).

const { get_encoding } = require("tiktoken");
const env = require("../../config/env");

let _enc = null;
function enc() {
  if (!_enc) _enc = get_encoding("cl100k_base");
  return _enc;
}

function tokenLen(text) {
  if (!text) return 0;
  return enc().encode(text).length;
}

const SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""];

function splitWith(text, separator) {
  if (separator === "") return text.split("");
  const parts = [];
  let idx = 0;
  while (idx < text.length) {
    const next = text.indexOf(separator, idx);
    if (next === -1) {
      parts.push(text.slice(idx));
      break;
    }
    // Keep the separator attached to the preceding piece so re-joining the
    // chunks doesn't lose punctuation/spacing.
    parts.push(text.slice(idx, next + separator.length));
    idx = next + separator.length;
  }
  return parts.filter((p) => p.length > 0);
}

function recursiveSplit(text, chunkSize, sepIndex = 0) {
  if (tokenLen(text) <= chunkSize) return [text];
  if (sepIndex >= SEPARATORS.length) return [text];
  const sep = SEPARATORS[sepIndex];
  const pieces = splitWith(text, sep);
  // If the chosen separator didn't actually split (single piece), drop a level.
  if (pieces.length <= 1) return recursiveSplit(text, chunkSize, sepIndex + 1);
  const out = [];
  for (const piece of pieces) {
    if (tokenLen(piece) <= chunkSize) {
      out.push(piece);
    } else {
      out.push(...recursiveSplit(piece, chunkSize, sepIndex + 1));
    }
  }
  return out;
}

function takeOverlapTail(text, overlapTokens) {
  if (overlapTokens <= 0 || !text) return "";
  const e = enc();
  const tokens = e.encode(text);
  if (tokens.length <= overlapTokens) return text;
  const tail = tokens.slice(tokens.length - overlapTokens);
  // tiktoken decode returns Uint8Array of utf-8 bytes; convert back to string.
  const bytes = e.decode(tail);
  return Buffer.from(bytes).toString("utf-8");
}

function packChunks(pieces, chunkSize, overlap) {
  const chunks = [];
  let buf = "";
  let bufTokens = 0;
  for (const piece of pieces) {
    const t = tokenLen(piece);
    if (bufTokens + t <= chunkSize || !buf) {
      buf += piece;
      bufTokens += t;
    } else {
      chunks.push(buf);
      const tail = takeOverlapTail(buf, overlap);
      buf = tail + piece;
      bufTokens = tokenLen(buf);
    }
  }
  if (buf.trim().length) chunks.push(buf);
  return chunks;
}

function chunkText(rawText, opts = {}) {
  const text = (rawText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const chunkSize = opts.chunkSize || env.rag.chunkSize;
  const overlap = opts.chunkOverlap ?? env.rag.chunkOverlap;
  const pieces = recursiveSplit(text, chunkSize);
  const packed = packChunks(pieces, chunkSize, overlap);
  return packed.map((c) => c.trim()).filter((c) => c.length > 0);
}

module.exports = { chunkText, tokenLen };
