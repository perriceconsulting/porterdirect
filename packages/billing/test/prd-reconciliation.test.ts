/**
 * The PRD's pricing table is a MIRROR of the catalogue, and this is what makes it one.
 *
 * `CLAUDE.prd.md` restates prices and driver counts because a PRD nobody can read the
 * numbers out of is not doing its job. That restatement is a second copy, and the DOSI-S
 * caveat is explicit: an optimistic or local copy is fine only if it reconciles back.
 * Without this test the PRD is a second source of truth that drifts silently, and it is
 * the copy a human quotes in a sales call.
 *
 * Reads the real document, not a fixture — a fixture would drift in exactly the same way
 * and report green while doing it. Same reasoning as the `.env.example` reconciliation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLANS, formatUsdCents } from "../src/index.js";

const PRD = readFileSync(new URL("../../../CLAUDE.prd.md", import.meta.url), "utf8");

interface PrdRow {
  readonly name: string;
  readonly price: string;
  readonly drivers: string;
}

/**
 * Pull the tier rows out of the pricing table.
 *
 * Matched by the bolded tier NAME rather than by position, so reordering the table or
 * adding a column does not silently stop the test from finding anything — a reconciler
 * that quietly matches zero rows is the failure mode that matters here.
 */
function prdRow(planName: string): PrdRow | null {
  const escaped = planName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\|\\s*\\*\\*${escaped}\\*\\*\\s*\\|([^|]*)\\|([^|]*)\\|`, "m").exec(
    PRD,
  );
  if (!match) return null;
  return { name: planName, price: match[1]!.trim(), drivers: match[2]!.trim() };
}

describe("catalog <-> CLAUDE.prd.md reconciliation", () => {
  it("finds a table row for every plan in the catalogue", () => {
    // Guards the guard: if the table is reformatted so nothing matches, every assertion
    // below would pass vacuously.
    for (const plan of PLANS) {
      expect(prdRow(plan.name), `no PRD pricing row for "${plan.name}"`).not.toBeNull();
    }
  });

  it("states each plan's monthly price exactly as the catalogue has it", () => {
    for (const plan of PLANS) {
      const row = prdRow(plan.name)!;
      expect(row.price, `${plan.name} price row: "${row.price}"`).toContain(
        formatUsdCents(plan.monthlyBasePriceCents),
      );
    }
  });

  it("states each plan's setup fee, and states one only where there is one", () => {
    for (const plan of PLANS) {
      const row = prdRow(plan.name)!;
      if (plan.oneTimeSetupFeeCents > 0) {
        expect(row.price, `${plan.name} should show its setup fee`).toContain(
          formatUsdCents(plan.oneTimeSetupFeeCents),
        );
      } else {
        expect(row.price.toLowerCase(), `${plan.name} has no setup fee`).not.toContain("setup");
      }
    }
  });

  it("states the included driver count and the extra-driver price", () => {
    for (const plan of PLANS) {
      const row = prdRow(plan.name)!;
      expect(row.drivers, `${plan.name} included drivers`).toContain(String(plan.includedSeats));
      expect(row.drivers, `${plan.name} extra driver price`).toContain(
        formatUsdCents(plan.extraSeatPriceCents),
      );
    }
  });

  it("does not call the included driver count a limit", () => {
    // The wording is the finding, not a nitpick: "limit" describes a wall that refuses
    // the sixth driver, and what is built is a threshold that bills them. Two different
    // products, and the document is what a person quotes.
    const section = PRD.slice(PRD.indexOf("## 9. Pricing"), PRD.indexOf("## 10."));
    expect(section.toLowerCase()).not.toMatch(/driver limit|limit of \d+ drivers/);
  });

  it("still declares the catalogue canonical", () => {
    expect(PRD).toContain("packages/billing/src/plans.ts");
  });
});
