/** Format version defined by spec/permalock-v1.md */
export const FORMAT_VERSION = 1;

export interface PageEntry {
  type: 'page';
  /** Stable identity of what produced the page (file path or `id:<value>`). */
  source?: string;
  /** First 16 hex chars of SHA-256 of the normalised main text. */
  hash?: string;
  /** 64-bit SimHash of the normalised main text, 16 hex chars. */
  sim?: string;
  /** Where the URL was learned when not from a build. */
  origin?: string;
  [extra: string]: unknown;
}

export interface RedirectEntry {
  type: 'redirect';
  to: string;
  reason?: string;
  [extra: string]: unknown;
}

export interface GoneEntry {
  type: 'gone';
  reason?: string;
  [extra: string]: unknown;
}

export type Entry = PageEntry | RedirectEntry | GoneEntry;

export interface Lockfile {
  permalock: number;
  site?: string;
  urls: Record<string, Entry>;
  /** Unknown top-level fields, preserved verbatim. */
  extra?: Record<string, unknown>;
}

/** A page produced by a build. */
export interface BuiltPage {
  url: string;
  source?: string;
  hash?: string;
  sim?: string;
  /** Number of words of the normalised main text. */
  words?: number;
  /** Absolute path of the HTML file, when scanned from disk. */
  file?: string;
}

export interface ScanResult {
  pages: BuiltPage[];
  /** HTML redirect pages (meta refresh) found in the build: url -> target */
  htmlRedirects: Map<string, string>;
}

export interface Suggestion {
  to: string;
  score: number;
  basis: 'content' | 'path' | 'redirect';
}

export interface Orphan {
  url: string;
  suggestion?: Suggestion;
  origin?: string;
}

export interface ResolvedRedirect {
  from: string;
  to: string;
  reason: string;
}

export interface ResolutionError {
  url: string;
  kind: 'cycle' | 'broken-redirect' | 'redirect-to-gone';
  message: string;
}

export interface Resolution {
  lock: Lockfile;
  added: string[];
  revived: { url: string; was: 'redirect' | 'gone' }[];
  redirected: ResolvedRedirect[];
  collapsed: { from: string; was: string; now: string }[];
  orphans: Orphan[];
  errors: ResolutionError[];
  /** true when the resolved lockfile differs from the input one */
  changed: boolean;
}

export interface ResolveOptions {
  /** Minimum similarity for automatic redirects; false disables rule 2.3. Default 0.94 */
  autoThreshold?: number | false;
  /** Minimum content similarity for a suggestion. Default 0.80 */
  suggestThreshold?: number;
  /** Minimum path similarity for a suggestion. Default 0.6 */
  pathThreshold?: number;
  /** Minimum margin between best and second best for automatic similarity. Default 0.05 */
  margin?: number;
}

export const MIN_WORDS = 40;
