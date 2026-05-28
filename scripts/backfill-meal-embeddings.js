#!/usr/bin/env node

/**
 * Backfill pgvector embeddings for legacy `public.meals` rows.
 *
 * Usage:
 *   node scripts/backfill-meal-embeddings.js
 *   node scripts/backfill-meal-embeddings.js --all
 *
 * Default mode processes only rows missing `embedding`.
 * `--all` forces re-embedding every meal.
 */

const { pool } = require("../src/config/postgres");
const { embedMealAndStore } = require("../src/services/mealEmbeddings");

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  const reembedAll = hasFlag("--all");
  const where = reembedAll ? "" : "WHERE embedding IS NULL";

  const { rows } = await pool.query(
    `SELECT id
       FROM public.meals
       ${where}
      ORDER BY id ASC`,
  );

  if (!rows.length) {
    console.log("[meal-embeddings] nothing to process");
    return;
  }

  console.log(
    `[meal-embeddings] starting ${rows.length} meal(s) (${reembedAll ? "all rows" : "missing only"})`,
  );

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const mealId = Number(rows[i].id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const success = await embedMealAndStore(client, mealId);
      if (success) {
        await client.query("COMMIT");
        ok += 1;
        console.log(`[meal-embeddings] ${i + 1}/${rows.length} ✓ meal ${mealId}`);
      } else {
        await client.query("ROLLBACK");
        failed += 1;
        console.log(`[meal-embeddings] ${i + 1}/${rows.length} ✗ meal ${mealId}`);
      }
    } catch (err) {
      await client.query("ROLLBACK");
      failed += 1;
      console.error(
        `[meal-embeddings] ${i + 1}/${rows.length} ✗ meal ${mealId}:`,
        err.message || err,
      );
    } finally {
      client.release();
    }
  }

  console.log(`[meal-embeddings] done ✓=${ok} ✗=${failed}`);
}

main()
  .catch((err) => {
    console.error("[meal-embeddings] fatal:", err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      // ignore
    }
  });

