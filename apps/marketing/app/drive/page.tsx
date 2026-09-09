/**
 * The driver's entry point.
 *
 * Separate from `/dashboard` on purpose. The console is a place to sit down and decide
 * things across many jobs; this is a place to stand at a door holding a parcel. They want
 * opposite layouts, opposite information density, and opposite default actions, and a
 * single page carrying both in conditionals gets worse every time either side changes.
 *
 * `/drive` is "my work", not a permission level. Any member sees their OWN assigned jobs
 * here — an ops user who also drives on a Friday needs this surface too, and asking them
 * to hold a different role to get it would be a product answering to its own schema.
 */
import { redirect } from "next/navigation";
import { createDbClient } from "@porterdirect/db";
import { SiteHeader } from "../_components/site-header";
import { signOutAction } from "../actions";
import { listConsoleTenants, requireUserId } from "../../lib/console";

export const metadata = { title: "Drive — PorterDirect" };
export const dynamic = "force-dynamic";

export default async function DriveIndex() {
  const userId = await requireUserId();
  const db = createDbClient(process.env.DATABASE_URL);
  const tenants = await listConsoleTenants(db, userId);

  // A chooser with one option is a tap that teaches nothing — and on a phone, in the
  // rain, it is a tap that costs something.
  if (tenants.length === 1) redirect(`/drive/${tenants[0]!.id}`);

  return (
    <>
      <SiteHeader>
        <form action={signOutAction}>
          <button className="btn btn-quiet" type="submit">
            Sign out
          </button>
        </form>
      </SiteHeader>

      <main className="drive">
        <h1 className="drive-title">Who are you driving for?</h1>
        {tenants.length === 0 ? (
          <p className="sub">You are not a member of any operator account yet.</p>
        ) : (
          <ul className="drive-list">
            {tenants.map((t) => (
              <li key={t.id}>
                <a href={`/drive/${t.id}`} className="drive-card">
                  <span className="drive-card-main">{t.name}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
