const app = require("./app");
const env = require("./config/env");
const { pool } = require("./config/postgres");
const vectorStore = require("./services/rag/vectorStore");
const { runBackfillAsync } = require("./services/rag/backfill");

async function bootstrap() {
  try {
    await pool.query("select 1");
    console.log("Connected to Supabase PostgreSQL");
  } catch (error) {
    console.error("Initial DB connection failed:", error.message);
  }
  // 

  // Verify pgvector + knowledge_chunks table are present.  This is cheap
  // (two metadata queries) so we always run it; missing extension/table
  // means the operator forgot to apply the migration and we should warn
  // loudly rather than fail later on the first upsert.
  let storeReady = false;
  try {
    storeReady = await vectorStore.ensureIndex();
  } catch (error) {
    console.error("Initial pgvector init failed:", error.message);
  }

  // Start the HTTP listener first so health checks succeed immediately, then
  // kick the backfill in the background. The backfill itself logs each entry
  // as it's processed via the [rag][indexer …] tag.
  app.listen(env.port, () => {
    console.log(`Backend listening on http://localhost:${env.port}`);
  });

  if (storeReady && env.openai.apiKey) {
    runBackfillAsync();
  }
}

bootstrap();
