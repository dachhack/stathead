/**
 * LLM sentiment pass for the Buzz Tracker.
 *
 * Reads public/data/player-buzz.json (lexicon-scored by fetch-player-buzz.ts)
 * and re-scores the top-N busiest players' blurbs with Claude for real nuance
 * the keyword lexicon misses — "limited in practice" vs "first-team reps",
 * "carted off" (calm phrasing, very negative). Re-scored items + players are
 * tagged method:'llm'; everyone past the top-N keeps their lexicon score, so
 * the data contract is unchanged (see src/lib/buzz.ts).
 *
 * No-op without ANTHROPIC_API_KEY, so the pipeline still produces a lexicon
 * snapshot when no key is configured. Decoupled from the fetch on purpose:
 * re-run it any time to upgrade an existing snapshot without re-crawling.
 *
 * Run:  ANTHROPIC_API_KEY=... npx tsx scripts/score-buzz-llm.ts [--top=60] [--model=claude-opus-4-8]
 */
import { readFileSync, writeFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { sentimentLabel } from '../src/lib/buzzSentiment';

const PATH = 'public/data/player-buzz.json';
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'] as [string, string];
  }),
);
const TOP_N = Number(args.get('top') ?? 60);
// Default to Claude Opus 4.8; override with --model or BUZZ_LLM_MODEL.
const MODEL = args.get('model') ?? process.env.BUZZ_LLM_MODEL ?? 'claude-opus-4-8';

interface Item {
  source: string; headline: string; summary?: string;
  score: number; method: string; rationale?: string;
}
interface Player {
  name: string; position: string; items: Item[];
  sentiment: number; sentimentLabel: string; method: string; volume: number;
}
interface Snapshot { players: Player[]; [k: string]: unknown }

const SYSTEM = `You score NFL news blurbs by their impact on a player's FANTASY FOOTBALL value, for fantasy managers tracking OTA / training-camp buzz.

Score each blurb from -1.0 to 1.0:
  +1.0  clearly great for fantasy value — first-team / every-down reps, expanded or featured role, breakout praise, returns fully healthy, strong beat-writer hype
   0.0  neutral / factual — a routine note with no real value signal
  -1.0  clearly bad — injury / surgery / PUP, limited or DNP, demotion, buried on the depth chart, holdout, suspension

Judge the fantasy implication, not the tone: "carted off the field" is very negative even if phrased calmly; "turning heads in 7-on-7" is positive. Be decisive — reserve near-zero only for genuinely no-signal notes.`;

const TOOL = {
  name: 'record_sentiment',
  description: 'Record the fantasy-value sentiment for each blurb and for the player overall.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per blurb, by its 0-based index.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: '0-based index of the blurb' },
            score: { type: 'number', description: 'Fantasy sentiment, -1.0 to 1.0' },
            rationale: { type: 'string', description: 'Brief reason, <= 8 words' },
          },
          required: ['index', 'score'],
        },
      },
      overall: { type: 'number', description: "Overall sentiment for the player's recent buzz, -1.0 to 1.0" },
    },
    required: ['items', 'overall'],
  },
};

const clamp = (n: number) => Math.max(-1, Math.min(1, Math.round(n * 100) / 100));

async function scorePlayer(client: Anthropic, p: Player): Promise<boolean> {
  const lines = p.items
    .map((it, i) => `${i}. ${it.headline}${it.summary ? ` — ${it.summary}` : ''}`)
    .join('\n');
  const prompt = `Player: ${p.name} (${p.position})\n\nBlurbs:\n${lines}`;

  let input: { items?: { index: number; score: number; rationale?: string }[]; overall?: number } | undefined;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: [TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: 'tool', name: 'record_sentiment' },
      messages: [{ role: 'user', content: prompt }],
    });
    const block = resp.content.find((b) => b.type === 'tool_use') as { input?: typeof input } | undefined;
    input = block?.input;
  } catch (e) {
    console.log(`  ${p.name}: LLM error (${(e as Error).message}) — keeping lexicon score`);
    return false;
  }
  if (!input || !Array.isArray(input.items)) return false;

  for (const r of input.items) {
    const it = p.items[r.index];
    if (!it || typeof r.score !== 'number') continue;
    it.score = clamp(r.score);
    it.method = 'llm';
    if (typeof r.rationale === 'string' && r.rationale.trim()) it.rationale = r.rationale.trim().slice(0, 60);
  }
  const overall = typeof input.overall === 'number'
    ? clamp(input.overall)
    : clamp(p.items.reduce((s, it) => s + it.score, 0) / Math.max(1, p.items.length));
  p.sentiment = overall;
  p.sentimentLabel = sentimentLabel(overall);
  p.method = 'llm';
  return true;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not set — skipping LLM sentiment pass (snapshot stays lexicon-scored).');
    return;
  }
  let snap: Snapshot;
  try {
    snap = JSON.parse(readFileSync(PATH, 'utf-8')) as Snapshot;
  } catch {
    console.log(`No ${PATH} to score — run fetch-player-buzz.ts first.`);
    return;
  }

  const client = new Anthropic();
  // Sort a shallow copy by volume; objects are shared with snap.players, so
  // mutations below flow straight back into the snapshot we write out.
  const targets = [...snap.players].sort((a, b) => b.volume - a.volume).slice(0, TOP_N);
  console.log(`LLM sentiment pass: ${targets.length} top players with ${MODEL}…`);

  let scored = 0;
  for (const p of targets) {
    if (await scorePlayer(client, p)) scored++;
    if (scored % 20 === 0 && scored) console.log(`  …${scored}/${targets.length}`);
  }

  snap.method = scored > 0 ? 'lexicon+llm' : 'lexicon';
  snap.llmModel = MODEL;
  snap.llmScoredPlayers = scored;
  writeFileSync(PATH, JSON.stringify(snap));
  console.log(`LLM-scored ${scored}/${targets.length} players. Wrote ${PATH}.`);
}

main().catch((e) => {
  console.error('LLM sentiment pass failed:', (e as Error).message || e);
  process.exit(0); // never fail the build
});
