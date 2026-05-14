const path = require("path");
const dotenv = require("dotenv");

// Load `.env` from `backend/` even if the process cwd is the repo root.
dotenv.config({ path: path.join(__dirname, "../../.env") });

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  databaseUrl: process.env.DATABASE_URL,
  directUrl: process.env.DIRECT_URL,
  supabaseDb: {
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: process.env.SUPABASE_DB_NAME || "postgres",
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: process.env.SUPABASE_DB_SSL === "true",
  },
  // Optional REST keys (unused by Virtual Kez — Kez talks to Postgres via `DATABASE_URL`/pool.)
  supabaseApi: {
    url: String(process.env.SUPABASE_URL || "").trim(),
    serviceRoleKey: String(
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "",
    ).trim(),
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET || "",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "30d",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-large",
    chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    visionModel: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    /** Brain / knowledge-base RAG reply model (Messages API). */
    ragChatModel:
      process.env.ANTHROPIC_RAG_CHAT_MODEL || "claude-sonnet-4-20250514",
    ragMaxOutputTokens: Number(process.env.ANTHROPIC_RAG_MAX_TOKENS || 1000),
  },
  rag: {
    chunkSize: Number(process.env.RAG_CHUNK_SIZE || 800),
    chunkOverlap: Number(process.env.RAG_CHUNK_OVERLAP || 100),
    topK: Number(process.env.RAG_TOP_K || 6),
    maxHistoryTurns: Number(process.env.RAG_MAX_HISTORY_TURNS || 10),
    // Width of each embedding written into knowledge_chunks.embedding.
    // Must match the `vector(N)` column dim in the pgvector migration —
    // changing it requires dropping & recreating the table.
    vectorDimension: Number(process.env.RAG_VECTOR_DIMENSION || 1024),
  },
};

module.exports = env;
