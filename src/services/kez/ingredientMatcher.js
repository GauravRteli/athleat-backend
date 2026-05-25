// =============================================================================
// ingredientMatcher — Prompt-4 ingredient pipeline (database-first, AI last).
//
// Flow:
//   1. extractIngredients(title, description)  — Claude (JSON) + deterministic
//      fallback. Returns [{ ingredient, qty, unit }].
//   2. matchIngredient(name)                   — 4-tier DB cascade then AI:
//        Tier 1: public.items WHERE is_locked=true (verified)
//        Tier 2: public.items WHERE is_locked=false (unverified library)
//        Tier 3: public.generic_foods WHERE source='AFCD'
//        Tier 4: public.generic_foods WHERE source='AUSNUT2023'
//        Tier 5: Claude Prompt-5 macro estimate (per-100g)
//   3. scaleIngredient(matched, qty, unit)     — qty/unit → grams, then macros.
//
// Each ingredient row stored in `meal_analysis.resolved_items` includes the
// match `source` so the coach UI can show "where did this come from".
// =============================================================================

const { query } = require("../../config/postgres");
const { callLlmText, extractJsonObject } = require("./llm");
const { shapeItem } = require("../foodsService");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// "441.0kJ" / "3.1g" / "81.0mg" → 441 / 3.1 / 81
function parseNumeric(val) {
  if (val === null || val === undefined) return null;
  const m = String(val).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function safeJsonObject(raw) {
  try {
    const s = extractJsonObject(raw) || String(raw || "");
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. extractIngredients — Claude first, deterministic fallback second
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACT_PROMPT_TEMPLATE = (title, description) =>
  [
    "Extract every distinct food ingredient from the meal title + description below.",
    "- Use the ingredient name EXACTLY as written in the title/description — no extra words, no rewording.",
    '- Return qty + unit if explicitly written (e.g. "30g", "2 biscuits", "200ml"); otherwise leave qty="" and unit="".',
    "- Output 1–12 ingredients. Skip cooking method words (grilled, fried…) unless they are the food itself.",
    "Return JSON only — no markdown, no preamble:",
    '{ "ingredients": [ { "ingredient": "...", "qty": "...", "unit": "..." } ] }',
    "",
    `TITLE: ${title || ""}`,
    `DESCRIPTION: ${description || ""}`,
  ].join("\n");

// Known mass/volume/count units the fallback parser will recognise as a
// leading unit. Anything else is treated as part of the food name.
const FALLBACK_UNIT_WORDS = new Set([
  "g", "kg", "mg", "ml", "l",
  "oz", "lb",
  "tbsp", "tsp",
  "cup", "cups",
  "piece", "pieces",
  "biscuit", "biscuits",
  "slice", "slices",
  "serve", "serves", "serving", "servings",
  "scoop", "scoops",
  "egg", "eggs",
]);

// Parse one fragment like "30g Weet-Bix", "200ml milk", "1 banana", "Weet-Bix"
// → { ingredient, qty, unit }.
function parseFallbackFragment(rawFrag) {
  const frag = String(rawFrag || "").trim();
  if (!frag) return null;

  // Match leading number (with optional decimal) then optional whitespace.
  const numMatch = frag.match(/^(\d+(?:\.\d+)?)(.*)$/);
  let qty = "";
  let unit = "";
  let name = frag;
  if (numMatch) {
    qty = numMatch[1];
    let rest = numMatch[2].replace(/^\s*(?:of\s+)?/i, "");

    // Try to peel off a known unit — either glued to the number ("30g") or
    // separated by whitespace ("2 biscuits"). Only consume it if it's in the
    // FALLBACK_UNIT_WORDS set; otherwise it's the food name.
    const unitMatch = rest.match(/^([a-zA-Z]+)(?=\s+|$)/);
    if (unitMatch && FALLBACK_UNIT_WORDS.has(unitMatch[1].toLowerCase())) {
      unit = unitMatch[1];
      rest = rest.slice(unitMatch[1].length).replace(/^\s+/, "");
    }
    name = rest || frag;
  }

  // Strip trailing/leading punctuation.
  name = name.replace(/^[\s.\-–—:]+|[\s.\-–—:]+$/g, "");
  if (!name) return null;
  return { ingredient: name, qty, unit };
}

// Deterministic fallback parser. Splits text on commas, semicolons, line
// breaks and the word " and "; pulls the leading numeric qty + unit out of
// each fragment with a known-unit aware regex. Description is processed
// before title so quantified rows win the dedup.
function fallbackExtractIngredients(title, description) {
  const text = [description, title].filter(Boolean).join(", ");
  if (!text) return [];

  const fragments = text
    .split(/\r?\n|,|;| and | with | & |\+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !/^(meal|breakfast|lunch|dinner|snack)$/i.test(s));

  const out = [];
  const seen = new Set();
  for (const frag of fragments) {
    const parsed = parseFallbackFragment(frag);
    if (!parsed) continue;
    const key = parsed.ingredient.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
    if (out.length >= 12) break;
  }
  return out;
}

async function extractIngredients({ title, description }) {
  const safeTitle = String(title || "").trim();
  const safeDesc = String(description || "").trim();
  console.log("\n[ingredientMatcher] ▶ extractIngredients", {
    title: safeTitle,
    description: safeDesc,
  });
  if (!safeTitle && !safeDesc) {
    console.log("[ingredientMatcher]   ⤷ empty title + description, returning []");
    return [];
  }

  // 1) Claude pass.
  try {
    console.log("[ingredientMatcher]   ⤷ calling Claude (extract prompt)…");
    const raw = await callLlmText(EXTRACT_PROMPT_TEMPLATE(safeTitle, safeDesc), {
      system:
        "You parse meal descriptions into a structured ingredient list. JSON only. No preamble. No code fences.",
      json: true,
    });
    const parsed = safeJsonObject(raw);
    const list = Array.isArray(parsed?.ingredients) ? parsed.ingredients : [];
    const cleaned = list
      .map((r) => ({
        ingredient: String(r?.ingredient || "").trim(),
        qty: String(r?.qty ?? "").trim(),
        unit: String(r?.unit ?? "").trim(),
      }))
      .filter((r) => r.ingredient)
      .slice(0, 12);
    if (cleaned.length > 0) {
      console.log("[ingredientMatcher]   ✓ Claude returned", cleaned.length, "ingredient(s):");
      cleaned.forEach((r, i) =>
        console.log(`     ${i + 1}. "${r.ingredient}" qty="${r.qty}" unit="${r.unit}"`),
      );
      return cleaned;
    }
    console.warn("[ingredientMatcher]   ⚠ Claude returned 0 ingredients — falling back");
  } catch (e) {
    console.warn("[ingredientMatcher]   ⚠ LLM extract failed, falling back:", e.message || e);
  }

  // 2) Deterministic fallback.
  const fb = fallbackExtractIngredients(safeTitle, safeDesc);
  console.log("[ingredientMatcher]   ⤷ fallback parser returned", fb.length, "ingredient(s):");
  fb.forEach((r, i) =>
    console.log(`     ${i + 1}. "${r.ingredient}" qty="${r.qty}" unit="${r.unit}"`),
  );
  return fb;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. matchIngredient — 4-tier DB cascade, then Claude Prompt 5
// ─────────────────────────────────────────────────────────────────────────────

// Convert a `public.items` row (per-serve macros, numeric `serving_size`) into
// per-100g macros + the row's default serving size in grams (for unit scaling).
function itemRowToPer100g(row) {
  const shaped = shapeItem(row);
  const servingG =
    num(shaped.weight_g) ||
    num(row.serving_size) ||
    100;
  const factor = servingG > 0 ? 100 / servingG : 1;
  return {
    per_100g: {
      protein_g: round1((shaped.protein_g || 0) * factor),
      carb_g: round1((shaped.carb_g || 0) * factor),
      fat_g: round1((shaped.fat_g || 0) * factor),
      energy_kj: round1((shaped.energy_kj || 0) * factor),
      fibre_g: round1((shaped.fibre_g || 0) * factor),
      sodium_mg: round1((parseNumeric(shaped.sodium) || 0) * factor),
    },
    serving_g: servingG,
    serving_label: shaped.serving_label || null,
    serving_size_unit: shaped.serving_size_unit || "g",
    food_id: shaped.id,
    matched_name: shaped.food_name,
    image: shaped.image || null,
  };
}

function genericRowToPer100g(row) {
  // generic_foods is already per-100g (per_quantity_g defaults to 100).
  const per = num(row.per_quantity_g) || 100;
  const factor = per > 0 ? 100 / per : 1;
  return {
    per_100g: {
      protein_g: round1((num(row.protein_g) || 0) * factor),
      carb_g: round1((num(row.carb_g) || 0) * factor),
      fat_g: round1((num(row.fat_g) || 0) * factor),
      energy_kj: round1((num(row.energy_kj) || 0) * factor),
      fibre_g: round1((num(row.dietary_fibre_g) || 0) * factor),
      sodium_mg: round1((num(row.sodium_mg) || 0) * factor),
    },
    serving_g: 100,
    serving_label: "100 g",
    serving_size_unit: "g",
    food_id: null,
    matched_name: row.food_name,
    image: null,
  };
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10) / 10;
}

// Tier 1 + 2: public.items by exact `LOWER(title) = LOWER($1)`, then ILIKE
// fallback ordered by length(title) ASC (closest = shortest containing match).
async function lookupItem(name, { verified }) {
  const exact = await query(
    `SELECT * FROM public.items
     WHERE COALESCE(is_locked, false) = $1
       AND LOWER(title) = LOWER($2)
     LIMIT 1`,
    [!!verified, name],
  );
  if (exact.rows[0]) return exact.rows[0];

  const like = await query(
    `SELECT * FROM public.items
     WHERE COALESCE(is_locked, false) = $1
       AND title ILIKE $2
     ORDER BY length(title) ASC
     LIMIT 1`,
    [!!verified, `%${name}%`],
  );
  return like.rows[0] || null;
}

// Tier 3 + 4: public.generic_foods filtered by source. Exact match first then
// ILIKE fallback by shortest matching food_name.
async function lookupGeneric(name, source) {
  const exact = await query(
    `SELECT * FROM public.generic_foods
     WHERE COALESCE(is_active, true) = true
       AND source = $1
       AND LOWER(food_name) = LOWER($2)
     LIMIT 1`,
    [source, name],
  );
  if (exact.rows[0]) return exact.rows[0];

  const like = await query(
    `SELECT * FROM public.generic_foods
     WHERE COALESCE(is_active, true) = true
       AND source = $1
       AND food_name ILIKE $2
     ORDER BY length(food_name) ASC
     LIMIT 1`,
    [source, `%${name}%`],
  );
  return like.rows[0] || null;
}

// Tier 5: Prompt 5 — Claude estimates per-100g macros. Last resort only.
const PROMPT_5_TEMPLATE = (foodName) =>
  [
    `Estimate the nutritional values per 100g for: ${foodName}.`,
    "Base your estimate on standard Australian food composition data (FSANZ / AFCD).",
    "Return JSON only - no other text:",
    "{",
    '  "food_name": "[standardised food name]",',
    '  "energy_kj": [number],',
    '  "protein_g": [number],',
    '  "carb_g": [number],',
    '  "fat_g": [number],',
    '  "dietary_fibre_g": [number],',
    '  "sodium_mg": [number],',
    '  "per_quantity_g": 100,',
    '  "confidence": "[high / medium / low]",',
    "  \"needs_verification\": true",
    "}",
    "Round all values to 1 decimal place.",
  ].join("\n");

async function estimateMacrosWithAI(name) {
  try {
    const raw = await callLlmText(PROMPT_5_TEMPLATE(name), {
      system:
        "You estimate per-100g macros for Australian foods using FSANZ / AFCD references. JSON only.",
      json: true,
    });
    const parsed = safeJsonObject(raw);
    if (!parsed) return null;
    return {
      per_100g: {
        protein_g: round1(num(parsed.protein_g) || 0),
        carb_g: round1(num(parsed.carb_g) || 0),
        fat_g: round1(num(parsed.fat_g) || 0),
        energy_kj: round1(num(parsed.energy_kj) || 0),
        fibre_g: round1(num(parsed.dietary_fibre_g) || 0),
        sodium_mg: round1(num(parsed.sodium_mg) || 0),
      },
      serving_g: num(parsed.per_quantity_g) || 100,
      serving_label: "100 g",
      serving_size_unit: "g",
      food_id: null,
      matched_name: parsed.food_name || name,
      image: null,
      confidence: parsed.confidence || "low",
      needs_verification: parsed.needs_verification !== false,
    };
  } catch (e) {
    console.warn("[ingredientMatcher] AI estimate failed:", e.message || e);
    return null;
  }
}

// Run the 4-tier DB cascade then AI for one ingredient name.
async function matchIngredient(name) {
  const clean = String(name || "").trim();
  if (!clean) {
    console.log("[ingredientMatcher] ✗ empty ingredient name → unresolved");
    return { source: "unresolved", source_label: "unresolved", matched: null };
  }

  console.log(`\n[ingredientMatcher] 🔍 matching "${clean}"`);

  // Tier 1 — verified items (food_items table)
  let row = await lookupItem(clean, { verified: true });
  if (row) {
    console.log(`  ✅ TIER 1 hit (items_verified) → id=${row.id} title="${row.title}"`);
    return {
      source: "items_verified",
      source_label: "Verified DB",
      matched: itemRowToPer100g(row),
    };
  }
  console.log("  ✗ tier 1 (items verified)  — no match");

  // Tier 2 — unverified items (food_items table, not yet locked)
  row = await lookupItem(clean, { verified: false });
  if (row) {
    console.log(`  ✅ TIER 2 hit (items_unverified) → id=${row.id} title="${row.title}"`);
    return {
      source: "items_unverified",
      source_label: "Verified DB",
      matched: itemRowToPer100g(row),
    };
  }
  console.log("  ✗ tier 2 (items unverified) — no match");

  // Tier 3 — generic_foods AFCD
  row = await lookupGeneric(clean, "AFCD");
  if (row) {
    console.log(`  ✅ TIER 3 hit (generic_afcd) → id=${row.id} food_name="${row.food_name}"`);
    return {
      source: "generic_afcd",
      source_label: "Unverified DB",
      matched: genericRowToPer100g(row),
    };
  }
  console.log("  ✗ tier 3 (AFCD)             — no match");

  // Tier 4 — generic_foods AUSNUT2023
  row = await lookupGeneric(clean, "AUSNUT2023");
  if (row) {
    console.log(`  ✅ TIER 4 hit (generic_ausnut) → id=${row.id} food_name="${row.food_name}"`);
    return {
      source: "generic_ausnut",
      source_label: "Unverified DB",
      matched: genericRowToPer100g(row),
    };
  }
  console.log("  ✗ tier 4 (AUSNUT2023)       — no match");

  // Tier 5 — AI estimate (last resort)
  console.log("  ⚠ ALL 4 DB TIERS MISSED — calling Claude (Prompt 5) for estimate…");
  const est = await estimateMacrosWithAI(clean);
  if (est) {
    console.log(
      `  ✅ TIER 5 (ai_estimate) → ${est.matched_name} | confidence=${est.confidence}`,
    );
    return {
      source: "ai_estimate",
      source_label: "AI estimate",
      matched: est,
    };
  }

  console.log("  ✗ TIER 5 (AI) returned nothing → unresolved");
  return { source: "unresolved", source_label: "unresolved", matched: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. scaleIngredient — convert qty/unit → grams, then per-100g → ingredient macros
// ─────────────────────────────────────────────────────────────────────────────

// Mass / volume → grams. Volume converts approximate (assumes water density).
const UNIT_TO_GRAMS = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  mg: 0.001,
  ml: 1,
  l: 1000,
  oz: 28.3495,
  lb: 453.592,
  tbsp: 15,
  tsp: 5,
};

// Returns { grams, unit_note? } for the requested qty + unit, using the
// matched food's serving_g when the unit is "cup", "piece", "biscuit", etc.
function qtyUnitToGrams(qty, unit, matched) {
  const q = num(qty);
  const u = String(unit || "").trim().toLowerCase();
  const servingG = num(matched?.serving_g) || 100;

  // No qty written → default to one serving
  if (q == null || q <= 0) {
    return { grams: servingG, note: "default_serving" };
  }

  // No unit written → if qty looks like grams (≥ 5), treat as grams; else
  // treat as "serves" and multiply by serving_g.
  if (!u) {
    if (q >= 5 && q <= 2000) return { grams: q, note: "assumed_grams" };
    return { grams: q * servingG, note: "assumed_serves" };
  }

  if (UNIT_TO_GRAMS[u] != null) {
    return { grams: q * UNIT_TO_GRAMS[u], note: null };
  }

  // Unknown unit (cup, biscuit, piece, slice, scoop, serve…) → use the
  // matched food's default serving size as the per-unit weight.
  return { grams: q * servingG, note: "unit_unverified" };
}

function scaleIngredient(matched, qty, unit) {
  if (!matched) {
    return {
      grams: 0,
      macros: { protein_g: 0, carb_g: 0, fat_g: 0, energy_kj: 0, energy_kcal: 0 },
      note: "unresolved",
    };
  }
  const { grams, note } = qtyUnitToGrams(qty, unit, matched);
  const factor = grams / 100;
  const energyKj = (matched.per_100g.energy_kj || 0) * factor;
  return {
    grams: Math.round(grams * 10) / 10,
    macros: {
      protein_g: round1((matched.per_100g.protein_g || 0) * factor),
      carb_g: round1((matched.per_100g.carb_g || 0) * factor),
      fat_g: round1((matched.per_100g.fat_g || 0) * factor),
      energy_kj: round1(energyKj),
      energy_kcal: Math.round(energyKj / 4.184),
      fibre_g: round1((matched.per_100g.fibre_g || 0) * factor),
      sodium_mg: round1((matched.per_100g.sodium_mg || 0) * factor),
    },
    note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator — resolve a full list of {ingredient, qty, unit} rows.
// Returns the per-ingredient shape that gets persisted into
// `meal_analysis.resolved_items` AND fed verbatim into Prompt 4.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveIngredients(parsedList) {
  console.log(
    `\n[ingredientMatcher] 🧮 resolveIngredients × ${parsedList.length} ingredient(s)`,
  );
  const out = [];
  for (const row of parsedList) {
    const ingredient = String(row.ingredient || "").trim();
    if (!ingredient) continue;
    const qty = String(row.qty ?? "").trim();
    const unit = String(row.unit ?? "").trim();

    const { source, source_label, matched } = await matchIngredient(ingredient);
    const scaled = scaleIngredient(matched, qty, unit);

    const resolvedRow = {
      ingredient,
      qty,
      unit,
      // Always carry a `measurements` array so the ingredient management UI
      // can edit single OR multi-measure ingredients uniformly. Single entry
      // for the freshly-resolved row; the manager UI may add more.
      measurements: [
        {
          qty,
          unit,
          grams: scaled.grams,
          note: scaled.note || null,
        },
      ],
      grams: scaled.grams,
      matched_name: matched?.matched_name || null,
      source,
      source_label,
      food_id: matched?.food_id || null,
      per_100g: matched?.per_100g || null,
      macros: scaled.macros,
      image: matched?.image || null,
      serving_label: matched?.serving_label || null,
      confidence: matched?.confidence || null,
      needs_verification: matched?.needs_verification || false,
      unit_note: scaled.note,
    };

    console.log(
      `  → "${ingredient}" qty=${qty || "(none)"}${unit || ""} | ` +
        `source=${source} | grams=${scaled.grams} | ` +
        `P:${scaled.macros.protein_g}g C:${scaled.macros.carb_g}g F:${scaled.macros.fat_g}g | ` +
        `${scaled.macros.energy_kj}kJ` +
        (scaled.note ? ` | note=${scaled.note}` : ""),
    );

    out.push(resolvedRow);
  }
  console.log(`[ingredientMatcher] ✓ resolved ${out.length}/${parsedList.length}\n`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-measurement helpers (Kerry Dashboard ingredient management UI).
//
// A "measurement" is one { qty, unit } pair the coach types in. We sum the
// resulting grams across measurements so an ingredient like "Oats — 40g or
// 1/2 cup" can be expressed in BOTH ways at once if Kerry wants to show
// athlete-facing equivalents. Grams = sum(qtyUnitToGrams across each).
// ─────────────────────────────────────────────────────────────────────────────

// Normalise an arbitrary client payload into [{ qty, unit }]. Always returns
// at least one entry — empty input falls back to a single { qty: "", unit: "" }
// row so the resolver still computes a sensible "default serving" grams value.
function normalizeMeasurements(input, fallback) {
  let arr = [];
  if (Array.isArray(input) && input.length > 0) {
    arr = input;
  } else if (
    fallback &&
    (fallback.qty !== "" || fallback.unit !== "")
  ) {
    arr = [{ qty: fallback.qty || "", unit: fallback.unit || "" }];
  }
  const cleaned = arr
    .map((m) => ({
      qty: String(m?.qty ?? "").trim(),
      unit: String(m?.unit ?? "").trim(),
    }))
    .filter((m) => m.qty !== "" || m.unit !== "");
  if (cleaned.length === 0) cleaned.push({ qty: "", unit: "" });
  return cleaned;
}

// Take a matched food (the per_100g + serving shape returned by matchIngredient)
// plus the coach-edited measurement list and rebuild a `resolved_items` row
// with summed grams + per-100g-scaled macros. Mirrors `scaleIngredient` but
// supports multi-measurement aggregation.
function rescaleResolvedRow({
  matched,
  source,
  sourceLabel,
  measurements,
  ingredient,
}) {
  const safeName = String(ingredient || matched?.matched_name || "").trim();
  const list = normalizeMeasurements(measurements, {
    qty: "",
    unit: "",
  });

  let totalGrams = 0;
  const perMeasurement = [];
  for (const m of list) {
    const { grams, note } = qtyUnitToGrams(m.qty, m.unit, matched);
    totalGrams += grams || 0;
    perMeasurement.push({
      qty: m.qty,
      unit: m.unit,
      grams: Math.round((grams || 0) * 10) / 10,
      note: note || null,
    });
  }

  const per100g = matched?.per_100g || {
    protein_g: 0,
    carb_g: 0,
    fat_g: 0,
    energy_kj: 0,
    fibre_g: 0,
    sodium_mg: 0,
  };
  const factor = totalGrams / 100;
  const energyKj = (per100g.energy_kj || 0) * factor;
  const macros = {
    protein_g: round1((per100g.protein_g || 0) * factor),
    carb_g: round1((per100g.carb_g || 0) * factor),
    fat_g: round1((per100g.fat_g || 0) * factor),
    energy_kj: round1(energyKj),
    energy_kcal: Math.round(energyKj / 4.184),
    fibre_g: round1((per100g.fibre_g || 0) * factor),
    sodium_mg: round1((per100g.sodium_mg || 0) * factor),
  };

  // Primary qty/unit = the first measurement (back-compat with single-measure
  // consumers like Prompt 4 and the legacy carousel UI).
  const primary = perMeasurement[0] || { qty: "", unit: "" };

  return {
    ingredient: safeName,
    qty: primary.qty,
    unit: primary.unit,
    measurements: perMeasurement,
    grams: Math.round(totalGrams * 10) / 10,
    matched_name: matched?.matched_name || safeName,
    source,
    source_label: sourceLabel,
    food_id: matched?.food_id || null,
    per_100g: per100g,
    macros,
    image: matched?.image || null,
    serving_label: matched?.serving_label || null,
    confidence: matched?.confidence ?? null,
    needs_verification: !!matched?.needs_verification,
    unit_note: primary.note,
  };
}

// Load a `public.items` row by id and reshape into the per-100g + serving
// payload the rescaler expects. Returns null if not found.
async function loadItemForRescale(itemId) {
  const id = Number(itemId);
  if (!Number.isFinite(id)) return null;
  const { rows } = await query(`SELECT * FROM public.items WHERE id = $1 LIMIT 1`, [id]);
  if (!rows[0]) return null;
  return itemRowToPer100g(rows[0]);
}

// Load a `public.generic_foods` row by id + source. Returns null if not found.
async function loadGenericForRescale(id, source) {
  const numId = Number(id);
  if (!Number.isFinite(numId)) return null;
  const { rows } = await query(
    `SELECT * FROM public.generic_foods WHERE id = $1 AND source = $2 LIMIT 1`,
    [numId, source],
  );
  if (!rows[0]) return null;
  return genericRowToPer100g(rows[0]);
}

module.exports = {
  extractIngredients,
  matchIngredient,
  scaleIngredient,
  resolveIngredients,
  rescaleResolvedRow,
  loadItemForRescale,
  loadGenericForRescale,
  itemRowToPer100g,
  genericRowToPer100g,
  // Exported for tests / reuse:
  fallbackExtractIngredients,
};
