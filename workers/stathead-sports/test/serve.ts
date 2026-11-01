// Serve the router locally over a directory of dry-run bundles, so the
// health check (and a partner's client) can be exercised without Cloudflare.
//
//   tsx test/serve.ts --dir ./out [--port 8787]
//   API_TOKENS=drip:0123456789abcdef0123  ADMIN_TOKEN=adminadminadminadmin1 (defaults when unset)

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { handle } from '../src/router.js';
import { MemoryStore } from '../src/store.js';

const argv = process.argv.slice(2);
const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : 'out';
const port = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 8787;

/** A FileStore writes `key` as `key.replace(/[^a-z0-9_.-]+/gi, '_')`; undo that from the file's own contents. */
async function load(): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    const text = await readFile(join(dir, f), 'utf8');
    const name = f.slice(0, -5);
    // Recover the colon-separated key from the file name: prefix, sport, season, month.
    const m = /^(meta|dir|sl|cal|adp|xw|tenure|boxidx|box)_([a-z]+)(?:_(\d{4}))?(?:_(\d{4}-\d{2}))?$/.exec(name);
    if (!m) continue;
    const key = [m[1], m[2], m[3], m[4]].filter(Boolean).join(':');
    store.data.set(key, text);
  }
  return store;
}

const env = { API_TOKENS: process.env.API_TOKENS ?? 'drip:0123456789abcdef0123', ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? 'adminadminadminadmin1' };

load().then((store) => {
  console.error(`loaded ${store.data.size} keys from ${dir}`);
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: body && req.method !== 'GET' ? body : undefined });
    const response = await handle(request, env, { store });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(port, () => console.error(`stathead-sports local server on http://localhost:${port}`));
});
