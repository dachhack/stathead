// Reddit sentiment data fetcher for fantasy football players.
// Fetches posts/comments from r/fantasyfootball and computes
// per-player mention counts and sentiment scores.
//
// Run: npx tsx scripts/fetch-reddit-sentiment.ts
// Output: public/data/reddit_sentiment.json

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';

const SUBREDDIT = 'fantasyfootball';
const USER_AGENT = 'stathead-sentiment/1.0 (by /u/stathead-bot)';
const OUTPUT_PATH = 'public/data/reddit_sentiment.json';
const RATE_LIMIT_MS = 1200; // Reddit asks for 1 req/sec for unauthenticated

// NFL season weeks mapped to approximate dates (regular season)
// Week 1 typically starts first Thursday of September
function getSeasonWeekDates(season: number): Array<{ week: number; start: Date; end: Date }> {
  // Approximate: Week 1 starts first Thursday of September
  const sept1 = new Date(season, 8, 1); // September 1
  const dayOfWeek = sept1.getDay();
  // Find first Thursday (day 4)
  const firstThurs = new Date(sept1);
  firstThurs.setDate(sept1.getDate() + ((4 - dayOfWeek + 7) % 7));
  // If that's before Sept 4, push to next week
  if (firstThurs.getDate() < 4) firstThurs.setDate(firstThurs.getDate() + 7);

  const weeks: Array<{ week: number; start: Date; end: Date }> = [];
  for (let w = 1; w <= 18; w++) {
    const start = new Date(firstThurs);
    start.setDate(firstThurs.getDate() + (w - 1) * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    weeks.push({ week: w, start, end });
  }
  return weeks;
}

// Sentiment keywords
const POSITIVE_WORDS = new Set([
  'sleeper', 'breakout', 'league winner', 'league-winner', 'steal', 'undervalued',
  'must draft', 'must-draft', 'love', 'smash', 'elite', 'wr1', 'rb1', 'qb1', 'te1',
  'upside', 'rocket', 'beast', 'stud', 'target', 'buy low', 'buy-low',
  'excited', 'value', 'bargain', 'gem', 'sneaky', 'ascending',
]);

const NEGATIVE_WORDS = new Set([
  'bust', 'avoid', 'overvalued', 'overhyped', 'overrated', 'fade',
  'sell high', 'sell-high', 'drop', 'droppable', 'washed', 'declining',
  'injury prone', 'injury-prone', 'risky', 'concern', 'worried', 'red flag',
  'td dependent', 'td-dependent', 'trap', 'landmine', 'regression',
]);

interface RedditPost {
  title: string;
  selftext: string;
  score: number;
  num_comments: number;
  created_utc: number;
  author: string;
  permalink: string;
}

interface PlayerMention {
  player: string;
  week: number;
  season: number;
  mentions: number;
  upvotes: number;
  positiveHits: number;
  negativeHits: number;
  commentMentions: number;
}

// Fetch with rate limiting and retry
async function fetchReddit(url: string): Promise<unknown> {
  await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (resp.status === 429) {
        console.log('    Rate limited, waiting 10s...');
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      if (!resp.ok) {
        console.log(`    HTTP ${resp.status} for ${url}`);
        return null;
      }
      return await resp.json();
    } catch (e) {
      console.log(`    Fetch error (attempt ${attempt + 1}): ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return null;
}

// Fetch posts from a subreddit search within a time window
async function fetchPostsForWindow(
  query: string,
  afterUtc: number,
  beforeUtc: number,
): Promise<RedditPost[]> {
  // Reddit search API with time bounds using CloudSearch syntax
  const url = `https://www.reddit.com/r/${SUBREDDIT}/search.json` +
    `?q=${encodeURIComponent(query)}` +
    `&restrict_sr=on&sort=relevance&t=all&limit=100` +
    `&after=${afterUtc}&before=${beforeUtc}`;

  const data = await fetchReddit(url) as any;
  if (!data?.data?.children) return [];

  return data.data.children
    .filter((c: any) => c.kind === 't3')
    .map((c: any) => ({
      title: c.data.title || '',
      selftext: c.data.selftext || '',
      score: c.data.score || 0,
      num_comments: c.data.num_comments || 0,
      created_utc: c.data.created_utc || 0,
      author: c.data.author || '',
      permalink: c.data.permalink || '',
    }));
}

// Count sentiment words in text
function analyzeSentiment(text: string): { positive: number; negative: number } {
  const lower = text.toLowerCase();
  let positive = 0;
  let negative = 0;
  for (const word of POSITIVE_WORDS) {
    if (lower.includes(word)) positive++;
  }
  for (const word of NEGATIVE_WORDS) {
    if (lower.includes(word)) negative++;
  }
  return { positive, negative };
}

// Load player names from roster data
function loadPlayerNames(season: number): Map<string, string> {
  const rosterPath = `public/data/roster_${season}.csv`;
  if (!existsSync(rosterPath)) return new Map();

  const csv = readFileSync(rosterPath, 'utf-8');
  const lines = csv.split('\n');
  const header = lines[0].split(',');
  const nameIdx = header.indexOf('full_name');
  const posIdx = header.indexOf('position');
  const statusIdx = header.indexOf('status');

  const names = new Map<string, string>(); // name -> position
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const name = cols[nameIdx]?.replace(/"/g, '').trim();
    const pos = cols[posIdx]?.replace(/"/g, '').trim();
    const status = cols[statusIdx]?.replace(/"/g, '').trim();
    if (name && ['QB', 'RB', 'WR', 'TE'].includes(pos) && status !== 'Inactive') {
      names.set(name, pos);
    }
  }
  return names;
}

// Build search-friendly name patterns
function buildPlayerPatterns(names: Map<string, string>): Array<{ name: string; pos: string; patterns: string[] }> {
  const results: Array<{ name: string; pos: string; patterns: string[] }> = [];
  for (const [name, pos] of names) {
    const parts = name.split(' ');
    if (parts.length < 2) continue;
    const lastName = parts[parts.length - 1];
    const firstName = parts[0];
    // Match full name or last name (for common discussion patterns)
    results.push({
      name,
      pos,
      patterns: [
        name.toLowerCase(),
        `${firstName.toLowerCase()} ${lastName.toLowerCase()}`,
      ],
    });
  }
  return results;
}

// Check if text mentions a player
function findPlayerMentions(
  text: string,
  players: Array<{ name: string; pos: string; patterns: string[] }>,
): string[] {
  const lower = text.toLowerCase();
  const mentioned: string[] = [];
  for (const p of players) {
    for (const pattern of p.patterns) {
      if (lower.includes(pattern)) {
        mentioned.push(p.name);
        break;
      }
    }
  }
  return mentioned;
}

// Main: fetch and aggregate Reddit sentiment data
async function main() {
  const seasons = [2021, 2022, 2023, 2024, 2025];

  console.log('Fetching Reddit sentiment data from r/fantasyfootball...');

  // Accumulate all mentions across seasons
  const allMentions: PlayerMention[] = [];

  for (const season of seasons) {
    console.log(`\n=== Season ${season} ===`);

    // Load player names for this season
    const playerNames = loadPlayerNames(season);
    if (playerNames.size === 0) {
      console.log(`  No roster data for ${season}, skipping`);
      continue;
    }
    const playerPatterns = buildPlayerPatterns(playerNames);
    console.log(`  ${playerNames.size} players loaded from roster`);

    const weekDates = getSeasonWeekDates(season);

    // Fetch top fantasy-relevant posts for each week window
    for (const { week, start, end } of weekDates) {
      const afterUtc = Math.floor(start.getTime() / 1000);
      const beforeUtc = Math.floor(end.getTime() / 1000);

      // Skip future weeks
      if (start.getTime() > Date.now()) break;

      process.stdout.write(`  Week ${week} (${start.toISOString().slice(5, 10)})...`);

      // Search for top fantasy football discussion posts in this window
      const posts = await fetchPostsForWindow(
        'fantasy football',
        afterUtc,
        beforeUtc,
      );

      if (posts.length === 0) {
        console.log(' 0 posts');
        continue;
      }

      // Aggregate player mentions across posts
      const weekMentions = new Map<string, PlayerMention>();

      for (const post of posts) {
        const fullText = `${post.title} ${post.selftext}`;
        const mentioned = findPlayerMentions(fullText, playerPatterns);
        const sentiment = analyzeSentiment(fullText);

        for (const playerName of mentioned) {
          const existing = weekMentions.get(playerName) || {
            player: playerName,
            week,
            season,
            mentions: 0,
            upvotes: 0,
            positiveHits: 0,
            negativeHits: 0,
            commentMentions: 0,
          };
          existing.mentions += 1;
          existing.upvotes += post.score;
          existing.positiveHits += sentiment.positive;
          existing.negativeHits += sentiment.negative;
          existing.commentMentions += post.num_comments;
          weekMentions.set(playerName, existing);
        }
      }

      console.log(` ${posts.length} posts, ${weekMentions.size} players mentioned`);

      for (const mention of weekMentions.values()) {
        allMentions.push(mention);
      }
    }
  }

  console.log(`\nTotal: ${allMentions.length} player-week mention records`);

  // Compute windowed aggregations (1-week, 2-week, 4-week)
  console.log('Computing windowed sentiment features...');

  interface WindowedSentiment {
    player: string;
    season: number;
    week: number;
    // 1-week window
    mentions_1w: number;
    upvotes_1w: number;
    sentiment_1w: number; // (positive - negative) / mentions
    hype_1w: number; // upvotes * mentions (buzz intensity)
    // 2-week window
    mentions_2w: number;
    upvotes_2w: number;
    sentiment_2w: number;
    hype_2w: number;
    // 4-week window
    mentions_4w: number;
    upvotes_4w: number;
    sentiment_4w: number;
    hype_4w: number;
    // Velocity (1w vs 4w average)
    mention_velocity: number;
    sentiment_velocity: number;
  }

  const windowedData: WindowedSentiment[] = [];

  // Group mentions by player+season
  const byPlayerSeason = new Map<string, PlayerMention[]>();
  for (const m of allMentions) {
    const key = `${m.player}:${m.season}`;
    if (!byPlayerSeason.has(key)) byPlayerSeason.set(key, []);
    byPlayerSeason.get(key)!.push(m);
  }

  for (const [key, mentions] of byPlayerSeason) {
    const [player, seasonStr] = key.split(':');
    const season = Number(seasonStr);

    // Build week-indexed data
    const byWeek = new Map<number, PlayerMention>();
    for (const m of mentions) byWeek.set(m.week, m);

    // For each week, compute windowed aggregations
    for (let week = 1; week <= 18; week++) {
      const window1 = [week];
      const window2 = [week, week - 1].filter((w) => w >= 1);
      const window4 = [week, week - 1, week - 2, week - 3].filter((w) => w >= 1);

      const agg = (weeks: number[]) => {
        let mentions = 0, upvotes = 0, positive = 0, negative = 0;
        for (const w of weeks) {
          const m = byWeek.get(w);
          if (m) {
            mentions += m.mentions;
            upvotes += m.upvotes;
            positive += m.positiveHits;
            negative += m.negativeHits;
          }
        }
        const sentiment = mentions > 0 ? (positive - negative) / mentions : 0;
        return { mentions, upvotes, sentiment, hype: upvotes * mentions };
      };

      const w1 = agg(window1);
      const w2 = agg(window2);
      const w4 = agg(window4);

      // Only include if there's any data in the 4-week window
      if (w4.mentions === 0) continue;

      const avg4wMentions = w4.mentions / window4.length;
      const mentionVelocity = avg4wMentions > 0 ? w1.mentions / avg4wMentions : 0;
      const sentimentVelocity = w1.sentiment - w4.sentiment;

      windowedData.push({
        player,
        season,
        week,
        mentions_1w: w1.mentions,
        upvotes_1w: w1.upvotes,
        sentiment_1w: Math.round(w1.sentiment * 100) / 100,
        hype_1w: w1.hype,
        mentions_2w: w2.mentions,
        upvotes_2w: w2.upvotes,
        sentiment_2w: Math.round(w2.sentiment * 100) / 100,
        hype_2w: w2.hype,
        mentions_4w: w4.mentions,
        upvotes_4w: w4.upvotes,
        sentiment_4w: Math.round(w4.sentiment * 100) / 100,
        hype_4w: w4.hype,
        mention_velocity: Math.round(mentionVelocity * 100) / 100,
        sentiment_velocity: Math.round(sentimentVelocity * 100) / 100,
      });
    }
  }

  console.log(`Windowed data: ${windowedData.length} player-week-window records`);

  // Also compute preseason aggregation (for draft model features)
  // Use weeks 1-4 sentiment as the "preseason buzz" feature
  const preseasonBuzz: Array<{
    player: string;
    season: number;
    mentions: number;
    upvotes: number;
    sentiment: number;
    hype: number;
  }> = [];

  for (const [key, mentions] of byPlayerSeason) {
    const [player, seasonStr] = key.split(':');
    const season = Number(seasonStr);

    // Early season (weeks 1-4) as proxy for preseason buzz
    const earlyMentions = mentions.filter((m) => m.week <= 4);
    if (earlyMentions.length === 0) continue;

    let totalMentions = 0, totalUpvotes = 0, totalPositive = 0, totalNegative = 0;
    for (const m of earlyMentions) {
      totalMentions += m.mentions;
      totalUpvotes += m.upvotes;
      totalPositive += m.positiveHits;
      totalNegative += m.negativeHits;
    }

    preseasonBuzz.push({
      player,
      season,
      mentions: totalMentions,
      upvotes: totalUpvotes,
      sentiment: totalMentions > 0 ? Math.round(((totalPositive - totalNegative) / totalMentions) * 100) / 100 : 0,
      hype: totalUpvotes * totalMentions,
    });
  }

  console.log(`Preseason buzz: ${preseasonBuzz.length} player-season records`);

  // Write output
  mkdirSync('public/data', { recursive: true });
  const output = {
    generated: new Date().toISOString(),
    seasons,
    rawMentions: allMentions,
    windowedSentiment: windowedData,
    preseasonBuzz,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output));
  const sizeMB = (JSON.stringify(output).length / 1024 / 1024).toFixed(1);
  console.log(`\nSaved to ${OUTPUT_PATH} (${sizeMB} MB)`);
}

main().catch((e) => {
  console.error('Reddit sentiment fetch failed:', e.message || e);
  // Don't fail the build
  process.exit(0);
});
