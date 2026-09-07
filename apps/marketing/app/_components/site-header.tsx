import type { ReactNode } from "react";

/**
 * The site header, in one place.
 *
 * It had been copy-pasted into four pages — past the rule of three, and each copy was a
 * chance for the wordmark or nav to drift.
 *
 * `sticky` is opt-in rather than the default. Next skips its auto-scroll-on-navigation
 * when the element it would focus is `position: sticky`, and logs a warning for each
 * navigation. On the long marketing page a sticky header earns that; on a short auth
 * form it buys nothing and only produces the warning.
 */
export function SiteHeader({
  sticky = false,
  children,
}: {
  sticky?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className={sticky ? "site-header site-header--sticky" : "site-header"}>
      <div className="shell">
        <a className="wordmark" href="/">
          Porter<span>Direct</span>
        </a>
        {children ? (
          <nav className="header-nav" aria-label="Main">
            {children}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
