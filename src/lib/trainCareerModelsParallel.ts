/**
 * Parallel career model training using worker threads.
 * Trains each position on a separate thread, merging results.
 * Falls back to sequential if workers fail.
 */
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { trainRookieCareerModels } from './rookieCareerModel';
import type { RookieCareerModelResult } from './rookieCareerModel';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function trainPositionInWorker(
  rows: any[],
  position: string,
  postDraft: boolean,
): Promise<Record<string, RookieCareerModelResult>> {
  return new Promise((resolve, reject) => {
    const workerPath = join(__dirname, 'careerModelWorker.ts');
    // Pass the tsx loader flags from our parent process so the worker
    // can resolve TypeScript imports the same way the main thread does.
    // Filter out --eval and its arg (only present when tsx runs with -e).
    const filteredArgv = process.execArgv.filter((arg, i, arr) =>
      arg !== '--eval' && arg !== '-e' && !(i > 0 && (arr[i - 1] === '--eval' || arr[i - 1] === '-e'))
    );
    const worker = new Worker(workerPath, {
      workerData: { rows, position, postDraft },
      execArgv: filteredArgv,
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

/**
 * Train career models for all positions in parallel using worker threads.
 * Each position runs on its own thread. Returns merged results.
 */
export async function trainCareerModelsParallel(
  rows: any[],
  options?: { postDraft?: boolean },
): Promise<Record<string, RookieCareerModelResult>> {
  const positions = ['QB', 'RB', 'WR', 'TE'];
  const postDraft = options?.postDraft ?? false;
  const label = postDraft ? 'post-draft' : 'pre-draft';

  try {
    console.log(`    Training ${label} career models in parallel (${positions.length} workers)...`);
    const start = Date.now();

    const results = await Promise.all(
      positions.map(pos => trainPositionInWorker(rows, pos, postDraft))
    );

    // Merge per-position results
    const merged: Record<string, RookieCareerModelResult> = {};
    for (const r of results) {
      Object.assign(merged, r);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`    Parallel ${label} training done in ${elapsed}s`);
    return merged;
  } catch (err) {
    console.warn(`    Parallel training failed, falling back to sequential: ${err}`);
    return trainRookieCareerModels(rows, { postDraft });
  }
}
