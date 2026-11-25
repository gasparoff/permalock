// Scan the sites people try first and store the results in public/results/.
// Runs weekly in GitHub Actions: node apps/scanner/precompute.mjs [domain ...]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { headline, scanDomain } from 'permalock';

const dir = new URL('./public/results/', import.meta.url);
const sites = process.argv.length > 2 ? process.argv.slice(2) : JSON.parse(await readFile(new URL('./sites.json', import.meta.url), 'utf8'));
await mkdir(dir, { recursive: true });
let failed = 0;
for (const domain of sites) {
  const t0 = Date.now();
  try {
    const done = await scanDomain(domain, { max: 400, concurrency: 8, limit: 30000, timeoutMs: 60000 });
    if (done.errors.length) throw new Error(`partial: ${done.errors.join('; ')}`);
    await writeFile(new URL(`${domain}.json`, dir), JSON.stringify({ done, headline: headline(done) }) + '\n');
    console.log(`ok   ${domain} (${((Date.now() - t0) / 1000).toFixed(0)}s): ${headline(done)}`);
  } catch (e) {
    failed++;
    console.log(`skip ${domain}: ${e.message}`);
  }
}
if (failed === sites.length) process.exit(1);
