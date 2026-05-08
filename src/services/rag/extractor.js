// Text extraction dispatcher.
//
// Given a file URL + filename, return the best-effort plain-text content.
// Supports:
//   • PDF        → pdf-parse, falls back to OpenAI Vision if scan-only
//   • DOCX       → mammoth (extractRawText)
//   • PPTX       → officeparser
//   • XLSX/XLS   → xlsx (sheet→CSV per sheet)
//   • CSV/TSV    → utf-8 read
//   • TXT/MD/JSON→ utf-8 read
//   • Images     → OpenAI Vision (gpt-4o-mini), passing the public URL
//
// All extractors return a plain string. Errors bubble up; callers
// (`indexer.indexEntry`) record them on the row.

const path = require("path");
const mime = require("mime-types");
const env = require("../../config/env");

// Some libraries (pdf-parse, officeparser) require()-import lazily to avoid
// pulling them in when the embedding pipeline isn't even being used.
//
// pdf-parse v2 ships a class-based API:
//   const { PDFParse } = require('pdf-parse');
//   await new PDFParse({ data: buffer }).getText();
// (The v1 callable-default-export `pdf(buffer)` was removed.)
let _PDFParse = null;
function PDFParseCtor() {
  if (!_PDFParse) _PDFParse = require("pdf-parse").PDFParse;
  return _PDFParse;
}

let _mammoth = null;
function mammoth() {
  if (!_mammoth) _mammoth = require("mammoth");
  return _mammoth;
}

let _officeparser = null;
function officeparser() {
  if (!_officeparser) _officeparser = require("officeparser");
  return _officeparser;
}

let _xlsx = null;
function xlsx() {
  if (!_xlsx) _xlsx = require("xlsx");
  return _xlsx;
}

let _OpenAI = null;
function OpenAI() {
  if (!_OpenAI) _OpenAI = require("openai");
  return _OpenAI;
}

let _openaiClient = null;
function openai() {
  if (!_openaiClient) {
    if (!env.openai.apiKey) {
      throw new Error("OPENAI_API_KEY is required for image OCR.");
    }
    const Cls = OpenAI();
    _openaiClient = new Cls({ apiKey: env.openai.apiKey });
  }
  return _openaiClient;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff"]);

function extOf(name = "", url = "") {
  const fromName = path.extname(name || "").toLowerCase().replace(".", "");
  if (fromName) return fromName;
  // Cloudinary often appends extension to the secure_url.
  const fromUrl = path.extname((url || "").split("?")[0]).toLowerCase().replace(".", "");
  return fromUrl;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function extractPdf(buf /* , url */) {
  // pdf-parse v2: instance API. We pass the buffer as `data` and call
  // `destroy()` afterwards so the underlying pdf.js worker shuts down — the
  // backend process can otherwise hold its event loop open after parsing.
  const Ctor = PDFParseCtor();
  const parser = new Ctor({ data: buf });
  try {
    const result = await parser.getText();
    return (result?.text || "").trim();
  } finally {
    try { await parser.destroy?.(); } catch { /* ignore */ }
  }
  // Note: scanned-PDF fallback to OpenAI Vision is not wired here yet — Vision
  // doesn't natively read PDFs, so it would require rasterising pages first
  // (future work).
}

async function extractDocx(buf) {
  const result = await mammoth().extractRawText({ buffer: buf });
  return (result?.value || "").trim();
}

async function extractPptx(buf) {
  // officeparser's parseOfficeAsync accepts a Buffer.
  const text = await officeparser().parseOfficeAsync(buf);
  return (text || "").trim();
}

function extractSpreadsheet(buf) {
  const wb = xlsx().read(buf, { type: "buffer" });
  const out = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const csv = xlsx().utils.sheet_to_csv(sheet);
    if (csv.trim()) out.push(`# Sheet: ${sheetName}\n${csv}`);
  }
  return out.join("\n\n").trim();
}

function extractText(buf) {
  return buf.toString("utf-8").trim();
}

async function extractImage(url) {
  const client = openai();
  const res = await client.chat.completions.create({
    model: env.openai.visionModel,
    messages: [
      {
        role: "system",
        content:
          "You are an OCR engine. Extract every readable piece of text from the image verbatim. Preserve line breaks and ordering. Return plain text only — no commentary, no markdown.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract all text from this image." },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
    temperature: 0,
  });
  return (res.choices?.[0]?.message?.content || "").trim();
}

async function extractFromUrl({ url, filename }) {
  if (!url) throw new Error("extractFromUrl: url is required");
  const ext = extOf(filename, url);

  if (IMAGE_EXTS.has(ext)) {
    return extractImage(url);
  }

  const buf = await fetchBuffer(url);

  switch (ext) {
    case "pdf":
      return extractPdf(buf, url);
    case "docx":
      return extractDocx(buf);
    case "pptx":
    case "ppt":
      return extractPptx(buf);
    case "xlsx":
    case "xls":
      return extractSpreadsheet(buf);
    case "csv":
    case "tsv":
    case "txt":
    case "md":
    case "markdown":
    case "json":
    case "log":
    case "":
      return extractText(buf);
    default: {
      // Fallback: try treating it as text. If the bytes look binary the
      // caller will eventually filter out the unreadable result via the
      // chunker's empty-string check.
      const lookup = mime.lookup(ext) || "";
      if (lookup.startsWith("text/")) return extractText(buf);
      throw new Error(`Unsupported file type: .${ext}`);
    }
  }
}

module.exports = { extractFromUrl };
