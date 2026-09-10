"use server";

/**
 * Pricing settings.
 *
 * Kept out of `actions.ts` because that file is billing — what WE charge the operator.
 * This is what the OPERATOR charges their customers, and the two being one file is how
 * a reader ends up unsure which money a function is about.
 *
 * Every export here is async. A synchronous helper exported from a `"use server"` module
 * makes the whole route 500 with "Server Actions must be async functions", which reads
 * like a framework fault and is a stray export — the pure helpers live in
 * `lib/rate-cards.ts`.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isRedirectError } from "@porterdirect/auth";
import { parseUsdToCents } from "@porterdirect/billing";
import { ORDER_TYPES, type OrderType } from "@porterdirect/orders";
import { RateCardError, type RateCard, type TypeRate } from "@porterdirect/pricing";
import { customerSignupMode, tenants } from "@porterdirect/db";
import { eq } from "drizzle-orm";
import { requireConsole } from "../../../lib/console";
import { milesToMetres, saveRateCard } from "../../../lib/rate-cards";

function field(data: FormData, key: string): string {
  const v = data.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Read a dollar amount typed by a person.
 *
 * Through `parseUsdToCents`, never `parseFloat` — which is banned repo-wide, because
 * `Math.round(parseFloat("19.99") * 100)` is 1998. It also refuses an ambiguous comma:
 * "12,34" is decimal notation across most of Europe, and reading it as thousands turns
 * $12.34 into $1,234 on a rate card that then prices every job.
 */
function money(data: FormData, key: string, label: string): number {
  const raw = field(data, key);
  if (!raw) throw new RateCardError(`${label} is required.`);
  const cents = parseUsdToCents(raw);
  if (cents === null) throw new RateCardError(`${label} is not an amount I can read: "${raw}".`);
  return cents;
}

export async function saveRateCardAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  if (!tenantId) redirect("/dashboard");

  // Pricing is a settings decision, not a dispatch one: a dispatcher moves work, they do
  // not set what the firm charges. `tenant:settings` is owner and ops.
  const { db } = await requireConsole(tenantId, "tenant:settings");
  const base = `/dashboard/${tenantId}`;

  try {
    // Built by iterating the DOMAIN list rather than reading whichever fields happened to
    // be posted. A form that stops sending a type would otherwise write a card missing
    // that row — which `loadRateCard` correctly reports as no card at all, so pricing
    // would silently switch off rather than fail.
    const rates = {} as Record<OrderType, TypeRate>;
    for (const type of ORDER_TYPES) {
      rates[type] = {
        baseCents: money(data, `${type}_base`, "Base fare"),
        perMileCents: money(data, `${type}_perMile`, "Per mile"),
        minimumCents: money(data, `${type}_minimum`, "Minimum charge"),
      };
    }

    const percentRaw = field(data, "driverPayPercent");
    const driverPayPercent = Number(percentRaw);
    if (!percentRaw || !Number.isInteger(driverPayPercent)) {
      throw new RateCardError("Driver share must be a whole percent, e.g. 65.");
    }

    // Blank means no ceiling, which is a real choice — not a missing value.
    const ceilingRaw = field(data, "maxQuotableMiles");
    const maxQuotableMeters = ceilingRaw ? milesToMetres(Number(ceilingRaw)) : null;

    // Fuel is opt-in and ALL-OR-NOTHING. A half-filled set is refused rather than
    // patched with defaults: a baseline of zero would surcharge the whole pump price on
    // top of a per-mile rate that already covers fuel, and a guessed mpg misprices every
    // mile. Both are wrong in a way that only shows up on an invoice.
    const basisRaw = field(data, "fuelBasis");
    const baselineRaw = field(data, "fuelBaseline");
    const mpgRaw = field(data, "milesPerGallon");
    const anyFuel = Boolean(basisRaw) || Boolean(baselineRaw) || Boolean(mpgRaw);

    let fuel: RateCard["fuel"] = null;
    if (anyFuel) {
      if (!basisRaw || !baselineRaw || !mpgRaw) {
        throw new RateCardError(
          "A fuel surcharge needs all three: fuel type, the pump price your rate assumes, and miles per gallon.",
        );
      }
      if (basisRaw !== "gasoline" && basisRaw !== "diesel") {
        throw new RateCardError("Choose either gasoline or diesel.");
      }
      const mpg = Number(mpgRaw);
      if (!Number.isFinite(mpg) || mpg <= 0) {
        throw new RateCardError("Miles per gallon must be a number greater than zero.");
      }
      fuel = {
        basis: basisRaw,
        // Through the same money parser as every other amount — never parseFloat, and it
        // refuses an ambiguous comma rather than turning $3,45 into $345 a gallon.
        baselineCentsPerGallon: money(data, "fuelBaseline", "Baseline fuel price"),
        // Tenths, so the stored value is an integer and no float reaches a price.
        milesPerGallonTenths: Math.round(mpg * 10),
      };
    }

    const card: RateCard = { rates, driverPayPercent, maxQuotableMeters, fuel };
    await saveRateCard(db, tenantId, card);
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof RateCardError) {
      // The message names the field, so it travels as copy rather than an opaque code.
      redirect(`${base}?priceError=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  revalidatePath(base);
  redirect(`${base}?priced=1`);
}

/**
 * Turn open customer registration on or off.
 *
 * This control exists because the column would otherwise be a default nobody can change
 * — the `default_country` landmine, where every tenant silently got US phone rules
 * because that was the column default and nothing could decide otherwise.
 */
export async function setCustomerSignupAction(data: FormData): Promise<void> {
  const tenantId = field(data, "tenantId");
  if (!tenantId) redirect("/dashboard");

  const { db } = await requireConsole(tenantId, "tenant:settings");

  const wanted = field(data, "mode");
  // Checked against the enum's own values rather than a list written here. A second list
  // is how the database comes to be sent a mode it has never heard of.
  const allowed: readonly string[] = customerSignupMode.enumValues;
  if (!allowed.includes(wanted)) redirect(`/dashboard/${tenantId}?error=bad-signup-mode`);

  await db
    .update(tenants)
    .set({ customerSignup: wanted as (typeof customerSignupMode.enumValues)[number] })
    .where(eq(tenants.id, tenantId));

  revalidatePath(`/dashboard/${tenantId}`);
  redirect(`/dashboard/${tenantId}?signup=${wanted}`);
}
