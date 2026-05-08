const app = require("./app");
const env = require("./config/env");
const { pool } = require("./config/postgres");
const pinecone = require("./services/rag/pinecone");
const { runBackfillAsync } = require("./services/rag/backfill");

async function bootstrap() {
  try {
    await pool.query("select 1");
    console.log("Connected to Supabase PostgreSQL");
  } catch (error) {
    console.error("Initial DB connection failed:", error.message);
  }

  let pineconeReady = false;
  if (env.pinecone.apiKey) {
    try {
      pineconeReady = await pinecone.ensureIndex();
    } catch (error) {
      console.error("Initial Pinecone init failed:", error.message);
    }
  } else {
    console.warn(
      "[startup] PINECONE_API_KEY missing — RAG indexing disabled until set."
    );
  }

  // Start the HTTP listener first so health checks succeed immediately, then
  // kick the backfill in the background. The backfill itself logs each entry
  // as it's processed via the [rag][indexer …] tag.
  app.listen(env.port, () => {
    console.log(`Backend listening on http://localhost:${env.port}`);
  });

  if (pineconeReady && env.openai.apiKey) {
    runBackfillAsync();
  }
}

bootstrap();
