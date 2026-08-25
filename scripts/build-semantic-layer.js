/**
 * Compiles nflverse data dictionaries into a TypeScript semantic layer module.
 * Run: node scripts/build-semantic-layer.js
 *
 * Reads both formats nflverse ships. The CSVs are older snapshots; the JSON
 * exports are current and carry types and roughly twice as many fields. Where
 * both describe the same dataset they are MERGED, JSON winning on conflict,
 * because StatHead's own data still carries a few columns nflverse has since
 * renamed (recent_team, interceptions, sacks, sack_yards) and dropping their
 * descriptions would leave the chat context unable to explain columns the user
 * is actually looking at.
 *
 * StatHead's own corrections live in OVERRIDES below. That is deliberate: this
 * script rewrites src/semantic-layer.ts on every `npm run build`, so a hand-edit
 * to the generated file survives until the next build and then silently
 * vanishes. OVERRIDES is where such an edit is durable.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const DICT_DIR = join(import.meta.dirname, '..', 'src', 'dictionaries');
const OUTPUT = join(import.meta.dirname, '..', 'src', 'semantic-layer.ts');

/** Simple CSV parser that handles quoted fields */
function parseCsv(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (char === '\r' && !inQuotes) {
      // skip \r
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  return lines.map((line) => {
    const fields = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = !inQ;
        }
      } else if (c === ',' && !inQ) {
        fields.push(field.trim());
        field = '';
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  });
}

// Map dictionary filenames to dataset display names
const DATASET_NAMES = {
  dictionary_pbp: 'Play-by-Play',
  dictionary_playerstats: 'Player Stats (Weekly)',
  dictionary_team_stats: 'Team Stats (Weekly)',
  dictionary_schedules: 'Games & Schedules',
  dictionary_snap_counts: 'Snap Counts',
  dictionary_combine: 'NFL Combine',
  dictionary_draft_picks: 'Draft Picks',
  dictionary_injuries: 'Injuries',
  dictionary_pfr_passing: 'PFR Advanced Stats',
  dictionary_rosters: 'Rosters',
  dictionary_nextgenstats: 'Next Gen Stats',
  dictionary_contracts: 'Contracts',
  dictionary_depth_charts: 'Depth Charts',
  dictionary_ftn_charting: 'FTN Charting',
  dictionary_trades: 'Trades',
  dictionary_ff_rankings: 'Fantasy Rankings (FantasyPros ECR/ADP)',
};

// nflverse names the same dataset differently across formats. Fold the aliases
// onto one canonical key so app code keeps referring to a stable name — the
// tab-to-dataset map at the bottom of this file and src/context.ts both do.
const KEY_ALIASES = {
  dictionary_player_stats: 'dictionary_playerstats',
};

// StatHead's corrections to the upstream dictionaries, applied last so a
// regeneration reproduces them instead of reverting them.
//   drop:     fields to remove outright
//   describe: descriptions to replace, keyed by field
// A stale entry is reported rather than ignored — see the check after the merge.
const OVERRIDES = {
  dictionary_playerstats: {
    // nflverse stopped publishing `dakota`, an EPA+CPOE composite. The nearest
    // live field is `passing_cpoe`, but they are not the same statistic, so the
    // old name is removed rather than quietly repointed to the new one.
    drop: ['dakota'],
    describe: {
      passing_cpoe:
        'Completion percentage over expected. Replaces the old `dakota` field, which was an EPA+CPOE composite nflverse no longer publishes — the two are not the same statistic, so `dakota` was removed rather than quietly repointed.',
    },
  },
};

const clean = (v) => (typeof v === 'string' ? v.replace(/"/g, '').trim() : '');

/** CSV dictionaries: a Field/Description header, sometimes a type column. */
function columnsFromCsv(text, file) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.toLowerCase().replace(/"/g, ''));
  const fieldIdx = header.findIndex((h) => h === 'field' || h === 'field_name');
  const descIdx = header.findIndex((h) => h === 'description' || h === 'desc');
  const typeIdx = header.findIndex((h) => h === 'type' || h === 'data_type');

  if (fieldIdx === -1 || descIdx === -1) {
    console.warn(`Skipping ${file}: no field/description columns found in header: ${header}`);
    return [];
  }

  const columns = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length <= Math.max(fieldIdx, descIdx)) continue;
    const field = clean(row[fieldIdx]);
    if (!field) continue;
    const type = typeIdx >= 0 ? clean(row[typeIdx]) : '';
    columns.push({ field, description: clean(row[descIdx]), ...(type ? { type } : {}) });
  }
  return columns;
}

/** JSON dictionaries: an array of { field, data_type, description }. */
function columnsFromJson(text, file) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn(`Skipping ${file}: not valid JSON (${e.message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`Skipping ${file}: expected an array of column definitions`);
    return [];
  }
  const columns = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const field = clean(row.field ?? row.field_name);
    if (!field) continue;
    const type = clean(row.data_type ?? row.type);
    columns.push({
      field,
      description: clean(row.description ?? row.desc),
      ...(type ? { type } : {}),
    });
  }
  return columns;
}

// Read every dictionary, keeping each source separate until the merge below.
// JSON is listed after CSV so it wins ties.
const files = readdirSync(DICT_DIR)
  .filter((f) => f.endsWith('.csv') || f.endsWith('.json'))
  .sort((a, b) => Number(a.endsWith('.json')) - Number(b.endsWith('.json')));

const datasets = {};

for (const file of files) {
  const isJson = file.endsWith('.json');
  const rawKey = basename(file, isJson ? '.json' : '.csv');
  const key = KEY_ALIASES[rawKey] || rawKey;
  const columns = isJson
    ? columnsFromJson(readFileSync(join(DICT_DIR, file), 'utf-8'), file)
    : columnsFromCsv(readFileSync(join(DICT_DIR, file), 'utf-8'), file);
  if (!columns.length) continue;

  const existing = datasets[key];
  if (!existing) {
    datasets[key] = { name: DATASET_NAMES[key] || key, columns };
    console.log(`  ${datasets[key].name}: ${columns.length} columns (${file})`);
    continue;
  }

  // Merge. The newer source replaces descriptions it shares with the older one
  // and contributes its extra fields; fields only the older source knows about
  // are kept, because StatHead's data may still carry them under those names.
  const byField = new Map(existing.columns.map((c) => [c.field, c]));
  let replaced = 0;
  let added = 0;
  for (const col of columns) {
    if (byField.has(col.field)) replaced++;
    else added++;
    byField.set(col.field, col);
  }
  const kept = existing.columns.filter((c) => !columns.some((n) => n.field === c.field));
  existing.columns = [...byField.values()];
  console.log(
    `  ${existing.name}: merged ${file} — ${replaced} replaced, ${added} added, ` +
      `${kept.length} kept from the older dictionary` +
      (kept.length ? ` (${kept.map((c) => c.field).join(', ')})` : '')
  );
}

// Apply StatHead's corrections, and report any that no longer apply. A silently
// ignored override is how a correction rots back out of the file.
for (const [key, rules] of Object.entries(OVERRIDES)) {
  const dataset = datasets[key];
  if (!dataset) {
    console.warn(`  ! override for unknown dataset ${key}`);
    continue;
  }
  for (const field of rules.drop ?? []) {
    const before = dataset.columns.length;
    dataset.columns = dataset.columns.filter((c) => c.field !== field);
    if (dataset.columns.length === before) {
      console.warn(`  ! stale override: ${key}.${field} is already gone upstream — drop the rule`);
    } else {
      console.log(`  ${dataset.name}: dropped ${field} (StatHead override)`);
    }
  }
  for (const [field, description] of Object.entries(rules.describe ?? {})) {
    const col = dataset.columns.find((c) => c.field === field);
    if (!col) {
      console.warn(`  ! stale override: ${key}.${field} no longer exists — the description is lost`);
      continue;
    }
    col.description = description;
    console.log(`  ${dataset.name}: redescribed ${field} (StatHead override)`);
  }
}

// Generate TypeScript module
const tsContent = `// AUTO-GENERATED by scripts/build-semantic-layer.js
// Source: nflverse/nflreadr data dictionaries
// Do not edit manually.

export interface ColumnDef {
  field: string;
  description: string;
  type?: string;
}

export interface DatasetDef {
  name: string;
  columns: ColumnDef[];
}

export const SEMANTIC_LAYER: Record<string, DatasetDef> = ${JSON.stringify(datasets, null, 2)};

/**
 * Get a human-readable description of a dataset's columns.
 */
export function describeDataset(key: string): string {
  const dataset = SEMANTIC_LAYER[key];
  if (!dataset) return '';
  const lines = [\`## \${dataset.name} Data Dictionary\`, ''];
  for (const col of dataset.columns) {
    lines.push(\`- **\${col.field}**\${col.type ? \` (\${col.type})\` : ''}: \${col.description}\`);
  }
  return lines.join('\\n');
}

/**
 * Get a compact column listing for a dataset (for context windows).
 */
export function describeDatasetCompact(key: string): string {
  const dataset = SEMANTIC_LAYER[key];
  if (!dataset) return '';
  return dataset.columns
    .map((c) => \`\${c.field}: \${c.description}\`)
    .join('\\n');
}

/**
 * Get the semantic layer description for all datasets relevant to a tab.
 */
export function getSemanticContextForTab(tab: string): string {
  const TAB_TO_DATASETS: Record<string, string[]> = {
    stats: ['dictionary_playerstats'],
    compare: ['dictionary_playerstats'],
    scoring: ['dictionary_playerstats'],
    adp: ['dictionary_ff_rankings', 'dictionary_playerstats'],
    games: ['dictionary_schedules'],
    snaps: ['dictionary_snap_counts'],
    combine: ['dictionary_combine'],
    draft: ['dictionary_draft_picks'],
    injuries: ['dictionary_injuries'],
    advanced: ['dictionary_pfr_passing'],
    pbp: ['dictionary_pbp'],
  };

  const keys = TAB_TO_DATASETS[tab] || [];
  if (keys.length === 0) return '';

  const parts = ['\\n--- DATA DICTIONARY (Semantic Layer) ---'];
  for (const key of keys) {
    parts.push(describeDataset(key));
  }
  parts.push('--- END DATA DICTIONARY ---');
  return parts.join('\\n\\n');
}
`;

writeFileSync(OUTPUT, tsContent);
console.log(`\nGenerated ${OUTPUT}`);
console.log(`Total datasets: ${Object.keys(datasets).length}`);
