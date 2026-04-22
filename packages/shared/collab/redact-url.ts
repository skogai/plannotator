/**
 * Scrub room credentials (`key` / `admin`) from any URL before it is handed to
 * telemetry, error reporting, referrer headers, or logs.
 *
 * Threat model: the URL fragment `#key=<roomSecret>` is the product's access
 * token. We intentionally keep the fragment in the visible URL bar so
 * refresh + copy-address-bar keep working. That means any code path that
 * captures `window.location.href` or `document.referrer` for reporting must
 * route through this helper first. Missing one capture site would ship room
 * secrets to third-party systems.
 *
 * Rules:
 * - Remove `key` and `admin` params wherever they appear in the URL — query
 *   and fragment, before or after any other keys. Preserve other params.
 * - Values are replaced with the empty string rather than the key being
 *   deleted entirely. That keeps downstream URL parsers from silently
 *   mis-interpreting a missing key as "default roomSecret" (a mistake would
 *   fail loudly instead of silently authing) and leaves the URL shape
 *   identical — so logs that dedupe by URL still dedupe consistently.
 * - If a fragment becomes empty after scrubbing, strip the leading `#` so
 *   the URL doesn't grow a dangling separator.
 * - Idempotent: redact(redact(x)) === redact(x).
 * - Safe on non-URLs and non-string inputs. Never throws.
 *
 * We avoid the URL constructor here because:
 *   1. Fragments containing `key=...&admin=...` are not part of URL's
 *      searchParams API — fragments are opaque strings per WHATWG URL spec.
 *   2. Relative URLs without a base would throw; we must tolerate them.
 *   3. Manual regex-level substitution preserves exact non-secret formatting
 *      (trailing slashes, encoded characters) which matters when the caller
 *      diffs URLs for deduplication.
 */

const SECRET_PARAM_NAMES = ['key', 'admin'] as const;

// Match `<name>=<value>` where value runs to the next `&` or end of string.
// `\b` would miss `&key=...` at position 0 of a fragment; we match by explicit
// boundary instead (start-of-string, `?`, `&`, or `#`). Capture the boundary
// so we can put it back unchanged. Hoisted: the pattern is constant.
const SECRET_REGEX = new RegExp(
  `(^|[?&#])(${SECRET_PARAM_NAMES.join('|')})=[^&#]*`,
  'gi',
);

export function redactRoomSecrets(url: string | null | undefined): string {
  if (typeof url !== 'string' || url.length === 0) return '';

  // String.prototype.replace with a global regex does NOT use lastIndex
  // for iteration — it always starts from index 0. So the hoisted regex
  // is safe to reuse without resetting lastIndex between calls.
  const re = SECRET_REGEX;
  let out = url.replace(re, (_match, boundary: string, name: string) => {
    return `${boundary}${name}=`;
  });

  // If the fragment is now just `#` or `#&` or `#&&`, strip it. A stripped
  // fragment is a cleaner reporting artifact; carrying empty `#` into a log
  // can mask legitimate "same URL, different fragment" signal.
  const hashIdx = out.indexOf('#');
  if (hashIdx !== -1) {
    const fragment = out.slice(hashIdx + 1);
    // Fragment is "empty" if every param's value is blank AND no non-secret
    // content remains. We look for any char that's not `&`, `=`, or a known
    // scrubbed-secret-name token.
    const onlyScrubbedSecrets = fragment
      .split('&')
      .every((part) => {
        if (part === '') return true;
        const eq = part.indexOf('=');
        if (eq === -1) return false;  // non-kv token = real content
        const key = part.slice(0, eq).toLowerCase();
        const value = part.slice(eq + 1);
        return SECRET_PARAM_NAMES.includes(key as (typeof SECRET_PARAM_NAMES)[number]) && value === '';
      });
    if (onlyScrubbedSecrets) {
      out = out.slice(0, hashIdx);
    }
  }

  return out;
}
