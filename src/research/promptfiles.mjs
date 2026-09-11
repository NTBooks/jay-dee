// Ready-to-run subagent prompt files, one per agent, so the conductor never carries packet JSON in its own context.
//   deep  : one artist per file, Sonnet, hard web budget (1 fetch + 2 searches)
//   light : several artists per file, Haiku, no web at all (packet-only summaries for the long tail)
import fs from 'node:fs';
import path from 'node:path';
import { instructions } from './prompts.mjs';
import { config } from '../config.mjs';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const fence = (o) => '```json\n' + JSON.stringify(o, null, 1) + '\n```';

function deepPrompt(type, e, dir, batch) {
  const name = e.name || e.title || e.entity_id;
  const wiki = e.wikipedia?.url ? `the Wikipedia article ${e.wikipedia.url}` : 'the Wikipedia article for this act (find it with your first search)';
  return `# Deep research: ${name}  (${type}, batch ${batch})

You are a music researcher for a personal radio-DJ knowledge base. Research this ONE ${type} and write ONE JSON file.

HARD BUDGET (this runs at scale, do not exceed it): at most ONE WebFetch, which should be ${wiki}, and at most TWO WebSearch calls (use their snippets; do not fetch the hits). No Bash, no npm commands, no reading other files: everything else you need is in this file. Aim to finish in 5 tool calls including the Write.

What to find: origin/formation, sound and how it evolved, key records, reputation, collaborations, side projects, influences (these become "upstream" edges), film/TV/game placements, anything usable as on-air patter. Concrete facts, no fluff.

${instructions(type)}

PACKET (facts already gathered by scripts; tag_* values come from ID3 tags and are often wrong):
${fence(e)}

OUTPUT: write exactly one JSON object with the Write tool to \`${path.join(dir, e.entity_id + '.json')}\`. "entity_id" must be "${e.entity_id}". Put the URLs you actually used in "sources". Then reply with ONE line: the file path and your confidence. Nothing else.
`;
}

function lightPrompt(type, entities, dir, batch) {
  const names = entities.map((e) => e.name || e.title || e.entity_id).join(' | ');
  return `# Light research: ${entities.length} ${type}s  (batch ${batch})
${names}

You are a music researcher for a personal radio-DJ knowledge base. Write ONE JSON file per ${type} below, from the packet facts ONLY.

IMPORTANT: the file you write is a NEW object in the SCHEMA shape below (entity_id, summary, blurb, genres, moods, ...). Never copy or echo the packet JSON into the output: an output containing keys like "library", "musicbrainz", "wikipedia" or "taste_profile_mentions" is wrong and will be rejected.

RULES OF THIS TIER: no WebSearch, no WebFetch, no Bash, no reading other files. Everything you may use is in this file: the Wikipedia summary, MusicBrainz genres/dates/urls, the library evidence, the prior draft (if any; treat it as a hint, not a source), and taste-profile mentions. If the packet is thin, write a short honest summary (40-90 words) built on what IS known (genre, era, country, the records the listener owns) and set confidence 0.5 or lower. Never guess years or facts; leave unknown OPTIONAL fields null. But genres, moods, dj_hooks and era must never be empty: when the packet is thin, derive genres from the MusicBrainz tags or the library's genre hints (or use "unclassified"), pick one plain mood word, and set era from the years of the owned tracks (e.g. "2000s"). Add "tier": "light" to every JSON object. "sources" = the packet's own URLs (Wikipedia / MusicBrainz) or [].

${instructions(type)}

${entities.map((e) => `## ${e.name || e.title || e.entity_id}  -> write to \`${path.join(dir, e.entity_id + '.json')}\`  (entity_id "${e.entity_id}")\n${fence(e)}`).join('\n\n')}

OUTPUT: one Write per ${type}, exactly ${entities.length} files. Then reply with ONE line listing the ${entities.length} file paths. Nothing else.
`;
}

export function writePromptFiles(type, packet, { tier = 'deep', perAgent = tier === 'light' ? (type === 'album' ? 3 : 5) : 1 } = {}) {
  const batch = packet.batch_id, dir = packet.write_results_to || path.join(config.dataDir, 'results', batch);
  const outDir = path.join(config.dataDir, 'packets', batch);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  const ents = packet.entities || [];
  for (let i = 0; i < ents.length; i += perAgent) {
    const group = ents.slice(i, i + perAgent);
    const n = String(files.length + 1).padStart(2, '0');
    const file = path.join(outDir, `${n}-${tier}-${slug(group[0].name || group[0].title)}${group.length > 1 ? `+${group.length - 1}` : ''}.md`);
    fs.writeFileSync(file, tier === 'light' ? lightPrompt(type, group, dir, batch) : deepPrompt(type, group[0], dir, batch));
    files.push({ file, entities: group.map((e) => e.entity_id), names: group.map((e) => e.name || e.title) });
  }
  return { dir: outDir, files, model: tier === 'light' ? 'haiku' : 'sonnet' };
}
