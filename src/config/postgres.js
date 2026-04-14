const { Pool } = require("pg");
const env = require("./env");

const poolConfig = env.databaseUrl
  ? {
      connectionString: env.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      host: env.supabaseDb.host,
      port: env.supabaseDb.port,
      database: env.supabaseDb.database,
      user: env.supabaseDb.user,
      password: env.supabaseDb.password,
      ssl: env.supabaseDb.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };

const pool = new Pool(poolConfig);

async function query(text, params = []) {
  return pool.query(text, params);
}

async function healthCheck() {
  const { rows } = await query("select now() as now");
  return rows[0];
}

module.exports = {
  pool,
  query,
  healthCheck,
};
