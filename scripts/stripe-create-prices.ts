/**
 * Create the Stripe Products + Prices that MIRROR the canonical catalog.
 *
 * Every amount, tier boundary, tax code and env var name is READ from
 * packages/billing/src/plans.ts — nothing is retyped here (DOSI-S). Safe to re-run:
 * Products use deterministic ids and Prices use lookup_keys, so an existing object is
 * reused, never duplicated. That matters because Stripe Prices cannot be deleted (only
 * archived) and `tax_behavior` is immutable once set.
 *
 *   npm run stripe:prices           # DRY RUN — writes nothing
 *   npm run stripe:prices -- --apply
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  ADD_ONS,
  PLANS,
  PLAN_PRICE_TAX_BEHAVIOR,
  SAAS_BUSINESS_TAX_CODE,
} from "../packages/billing/src/plans.js";

const APPLY = process.argv.includes("--apply");
const ENV_FILE = ".env.local";

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);
    else val = val.split(" #")[0]!.trim();
    env[key] = val;
  }
  return env;
}

const env = loadEnv(ENV_FILE);
const SK = env.STRIPE_SECRET_KEY ?? "";
if (!SK) throw new Error("STRIPE_SECRET_KEY missing from .env.local");
// Same mechanical refusal as scripts/guard-stripe-env.sh — this script WRITES to Stripe.
if (!/^(sk|rk)_test_/.test(SK)) {
  throw new Error(`REFUSING: STRIPE_SECRET_KEY is not a test-mode key (${SK.slice(0, 8)}…)`);
}

type StripeRes = { ok: boolean; status: number; json: any };
async function stripe(method: string, path: string, params?: Record<string, string>): Promise<StripeRes> {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(SK + ":").toString("base64"),
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
  return { ok: res.ok, status: res.status, json: await res.json() };
}

async function ensureProduct(id: string, name: string): Promise<string> {
  const found = await stripe("GET", `products/${id}`);
  if (found.ok) {
    console.log(`  product  reuse   ${id}`);
    return found.json.id;
  }
  if (!APPLY) {
    console.log(`  product  CREATE  ${id}  name=${JSON.stringify(name)} tax_code=${SAAS_BUSINESS_TAX_CODE}`);
    return id;
  }
  const made = await stripe("POST", "products", { id, name, tax_code: SAAS_BUSINESS_TAX_CODE });
  if (!made.ok) throw new Error(`product ${id}: ${made.json.error?.message}`);
  console.log(`  product  created ${made.json.id}`);
  return made.json.id;
}

async function ensurePrice(lookupKey: string, params: Record<string, string>, describe: string): Promise<string> {
  const found = await stripe("GET", `prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&limit=1`);
  if (found.ok && found.json.data?.length) {
    console.log(`  price    reuse   ${found.json.data[0].id}  [${lookupKey}]`);
    return found.json.data[0].id;
  }
  if (!APPLY) {
    console.log(`  price    CREATE  [${lookupKey}]  ${describe}`);
    return "(dry-run)";
  }
  const made = await stripe("POST", "prices", { ...params, lookup_key: lookupKey });
  if (!made.ok) throw new Error(`price ${lookupKey}: ${made.json.error?.message}`);
  console.log(`  price    created ${made.json.id}  [${lookupKey}]`);
  return made.json.id;
}

const resolved: Record<string, string> = {};
const skipped: string[] = [];

console.log(APPLY ? "APPLY — writing to Stripe\n" : "DRY RUN — nothing will be written\n");

for (const plan of PLANS) {
  console.log(`${plan.name}`);
  const productId = await ensureProduct(`porterdirect_${plan.id}`, plan.name);

  // Graduated per-seat: flat first tier up to includedSeats, then per-seat above it.
  // This is exactly what computeMonthlyTotalCents models.
  resolved[plan.stripePriceEnv] = await ensurePrice(
    `porterdirect_${plan.id}_monthly_v1`,
    {
      product: productId,
      currency: "usd",
      "recurring[interval]": "month",
      "recurring[usage_type]": "licensed",
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      "tiers[0][up_to]": String(plan.includedSeats),
      "tiers[0][flat_amount]": String(plan.monthlyBasePriceCents),
      "tiers[0][unit_amount]": "0",
      "tiers[1][up_to]": "inf",
      "tiers[1][unit_amount]": String(plan.extraSeatPriceCents),
      tax_behavior: PLAN_PRICE_TAX_BEHAVIOR,
    },
    `graduated: ${plan.monthlyBasePriceCents} flat to ${plan.includedSeats} seats, then ${plan.extraSeatPriceCents}/seat, ${PLAN_PRICE_TAX_BEHAVIOR}`,
  );

  if (plan.setupFeePriceEnv) {
    resolved[plan.setupFeePriceEnv] = await ensurePrice(
      `porterdirect_${plan.id}_setup_v1`,
      {
        product: productId,
        currency: "usd",
        unit_amount: String(plan.oneTimeSetupFeeCents),
        tax_behavior: PLAN_PRICE_TAX_BEHAVIOR,
      },
      `one-time ${plan.oneTimeSetupFeeCents}, ${PLAN_PRICE_TAX_BEHAVIOR}`,
    );
  }
  console.log();
}

for (const addOn of ADD_ONS) {
  console.log(`${addOn.name}`);
  if (addOn.priceCents === null) {
    // Pass-through metered: the catalog deliberately carries no amount, so there is
    // nothing to derive. Creating it with a guessed unit price would invent pricing.
    console.log(`  SKIPPED — ${addOn.stripePriceEnv} has no catalog amount (metered pass-through)`);
    skipped.push(addOn.stripePriceEnv);
    console.log();
    continue;
  }
  const productId = await ensureProduct(`porterdirect_${addOn.id}`, addOn.name);
  resolved[addOn.stripePriceEnv] = await ensurePrice(
    `porterdirect_${addOn.id}_v1`,
    {
      product: productId,
      currency: "usd",
      unit_amount: String(addOn.priceCents),
      tax_behavior: PLAN_PRICE_TAX_BEHAVIOR,
    },
    `one-time ${addOn.priceCents}, ${PLAN_PRICE_TAX_BEHAVIOR}`,
  );
  console.log();
}

if (APPLY) {
  let text = readFileSync(ENV_FILE, "utf8");
  for (const [key, id] of Object.entries(resolved)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (!re.test(text)) throw new Error(`${key} not present in ${ENV_FILE}`);
    text = text.replace(re, `${key}=${id}`);
  }
  writeFileSync(ENV_FILE, text, "utf8");
  console.log(`Wrote ${Object.keys(resolved).length} Price ids into ${ENV_FILE}`);
}
if (skipped.length) console.log(`Still unset (no catalog amount): ${skipped.join(", ")}`);
