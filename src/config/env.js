const dotenv = require("dotenv");

dotenv.config();

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
  supabaseApi: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
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
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY || "",
    indexName: process.env.PINECONE_INDEX || "athleat-knowledge",
    cloud: process.env.PINECONE_CLOUD || "aws",
    region: process.env.PINECONE_REGION || "us-east-1",
    dimension: Number(process.env.PINECONE_DIMENSION || 3072),
  },
  rag: {
    chunkSize: Number(process.env.RAG_CHUNK_SIZE || 800),
    chunkOverlap: Number(process.env.RAG_CHUNK_OVERLAP || 100),
    topK: Number(process.env.RAG_TOP_K || 6),
    maxHistoryTurns: Number(process.env.RAG_MAX_HISTORY_TURNS || 10),
  },
};

module.exports = env;
