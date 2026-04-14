const app = require("./app");
const env = require("./config/env");
const { pool } = require("./config/postgres");

async function bootstrap() {
  try {
    await pool.query("select 1");
    console.log("Connected to Supabase PostgreSQL");
  } catch (error) {
    console.error("Initial DB connection failed:", error.message);
  }

  app.listen(env.port, () => {
    console.log(`Backend listening on http://localhost:${env.port}`);
  });
}

bootstrap();
