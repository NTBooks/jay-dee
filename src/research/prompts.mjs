// Result schemas + instructions shared by Claude Code subagents (via the jaydee-research skill) and bulk mode.

export const SCHEMAS = {
  artist: {
    version: 'artist.v1',
    shape: {
      entity_id: 'string (copy from packet)',
      identity: { mb_artist_id: 'string|null (MusicBrainz artist MBID you are confident in; keep the packet one unless it is wrong)', confirmed: 'boolean', note: 'string' },
      summary: 'string, 120-250 words: who they are, history, sound, why they matter; concrete and specific',
      blurb: 'string, <= 30 words, DJ one-liner',
      genres: ['1-6 strings, lowercase, specific (e.g. "vaporwave", "celtic punk", "nerd rock")'],
      moods: ['2-8 strings, lowercase adjectives (e.g. "playful", "melancholy", "driving", "warm nostalgia")'],
      era: 'string like "1990s", "2010s-present"',
      origin: 'string "City, Country" or best known',
      active_from: 'integer year|null', active_to: 'integer year|null (null if still active)',
      tags: ['0-10 free tags: scene, instrumentation, themes, contexts ("halloween", "road trip", "game score")'],
      key_albums: ['0-6 album titles, ONLY ones that exist in the packet library list or are well-known releases'],
      upstream: ['0-6 strings: influences, source acts, side projects, collaborators (advocacy-graph edges)'],
      dj_hooks: ['exactly 3 short factual sentences a radio DJ could say on air'],
      energy: 'integer 1-5 typical energy',
      confidence: 'number 0-1',
      sources: [{ name: 'string', url: 'string' }],
    },
  },
  album: {
    version: 'album.v1',
    shape: {
      entity_id: 'string',
      identity: { mb_release_group_id: 'string|null', confirmed: 'boolean', note: 'string' },
      year: 'integer original release year of this album (research it; the tag year in the packet may be wrong)',
      album_type: 'studio|live|compilation|soundtrack|ep|remix|single|other',
      summary: 'string, 80-180 words: context, sound, reception, where it sits in the catalog',
      blurb: 'string <= 30 words',
      genres: ['1-6 strings'], moods: ['2-8 strings'], era: 'string',
      notable_tracks: ['0-6 titles that appear in the packet tracklist ONLY'],
      context: 'string <= 60 words: recording circumstances, concept, or notable facts',
      dj_hooks: ['exactly 2 on-air sentences'],
      energy: 'integer 1-5',
      confidence: 'number 0-1',
      sources: [{ name: 'string', url: 'string' }],
    },
  },
  track: {
    version: 'track.v1',
    shape: {
      entity_id: 'string',
      identity: { mb_recording_id: 'string|null', note: 'string' },
      original_year: 'integer|null year the recording was first released (NOT the compilation/reissue year)',
      summary: 'string, 40-120 words',
      blurb: 'string <= 25 words',
      moods: ['2-6 strings'], energy: 'integer 1-5', tempo_feel: 'slow|mid|upbeat|fast',
      themes: ['0-6 lyrical/thematic tags'],
      is_cover: 'boolean', original_artist: 'string|null (if cover)',
      notable_reason: 'string <= 30 words: why this track stands out',
      dj_hooks: ['1-2 on-air sentences'],
      confidence: 'number 0-1',
      sources: [{ name: 'string', url: 'string' }],
    },
  },
};

export function instructions(type) {
  const common = `You are researching one ${type} from a personal music library for a radio-DJ knowledge base.
Write for a listener who is a craft-and-wit connoisseur: specific facts, no marketing fluff, no hedging filler.
RULES:
- Use the packet facts (MusicBrainz, Wikipedia, Last.fm) as the backbone. Values marked tag_* / "untrusted" come from ID3 tags and are often WRONG (especially years and genres) - verify, never repeat them as fact.
- Never invent albums, tracks, or collaborations. key_albums/notable_tracks must come from the packet lists.
- If the packet identity looks wrong (e.g. a different artist with the same name), say so in identity.note, set confirmed=false, and research the artist the LIBRARY actually contains (use the library album/track titles as evidence).
- Output ONLY a JSON object matching the schema. No prose outside JSON.`;
  const perType = {
    artist: `- summary should cover: origin/formation, sound and evolution, key records, reputation, and anything a DJ could use for a segue (side projects, collaborations, film/game placements).
- upstream = who influenced them / who they came from / side projects and collaborators. This feeds an "advocacy graph", so prefer documented relationships over vibes.`,
    album: `- The album's original release year is a research target; compilations and reissues in the library often carry the reissue year in tags.
- notable_tracks must be titles from the packet tracklist.`,
    track: `- original_year is the recording's first release, not the album it appears on here (best-of / soundtrack / reissue).
- If the track is a cover or parody, say what it covers.`,
  };
  return `${common}\n${perType[type]}\nSCHEMA (${SCHEMAS[type].version}):\n${JSON.stringify(SCHEMAS[type].shape, null, 2)}`;
}
