import { serializeEntry } from './lockfile.js';
import type { Entry, Lockfile } from './types.js';

export interface MergeResult {
  lock: Lockfile;
  conflicts: { url: string; ours?: Entry; theirs?: Entry }[];
}

const same = (a?: Entry, b?: Entry) => (a ? serializeEntry(a) : '') === (b ? serializeEntry(b) : '');

/** Three-way merge of lockfiles (spec 2.7). */
export function mergeLockfiles(base: Lockfile, ours: Lockfile, theirs: Lockfile): MergeResult {
  const out: Lockfile = {
    permalock: Math.max(ours.permalock, theirs.permalock),
    ...(ours.site ?? theirs.site ? { site: ours.site ?? theirs.site } : {}),
    urls: {},
    ...(ours.extra || theirs.extra ? { extra: { ...theirs.extra, ...ours.extra } } : {}),
  };
  const conflicts: MergeResult['conflicts'] = [];
  const keys = new Set([...Object.keys(base.urls), ...Object.keys(ours.urls), ...Object.keys(theirs.urls)]);
  for (const k of keys) {
    const b = base.urls[k], o = ours.urls[k], t = theirs.urls[k];
    let pick: Entry | undefined;
    if (same(o, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (same(b, t)) pick = o;
    else if (o && t && o.type === t.type && o.to === t.to) pick = o;
    else {
      conflicts.push({ url: k, ours: o, theirs: t });
      pick = o ?? t; // keep something sensible; the conflict is reported
    }
    if (pick) out.urls[k] = pick;
  }
  return { lock: out, conflicts };
}
