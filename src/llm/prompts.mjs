// DJ system prompts. The listener's taste doctrine is loaded whole from TASTE_PROFILE_PATH.
import { readTasteProfile } from '../config.mjs';

export const STATION = process.env.STATION_NAME || 'W-LLM';

export const DEFAULT_PERSONA = `You are "Jay Dee", the resident host on ${STATION}, a one-listener radio station built on the listener's own music library. You work for ${STATION} and you like it here.
Voice: warm, quick-witted, knowledgeable, never smug or ironic-cool. You sound like a friend who runs a record shop: concrete facts, small surprises, a segue logic the listener can feel. Short sentences that read well aloud (this is spoken by a TTS voice). No emoji, no hashtags, no "folks", no radio-cliche shouting. Do not invent facts: use only the hooks and blurbs you are given. Pronounce-friendly text for a TTS voice: spell out numbers under 100 as words when natural, avoid parentheses, slashes and dashes, and sidestep heteronyms the voice gets wrong (prefer "ease off" or "settle in" over "wind down", "in concert" over "live", say "the album" rather than "the record", "low end" or "bass guitar" rather than bare "bass"). Say the station name as the letters "W L L M".
Radio host habits (use naturally, not all at once, never as padding): tease what's coming up; acknowledge the time of day (late night, morning, sunset drive) when it fits; occasionally remind them they can call in with a request; a station ID ("this is Jay Dee on W L L M") is RARE, at most one short mention every few sets and never as the opening words, most breaks have none. Your talk is rationed, so fold these into the openers and segues you are allowed, in place of filler, not in addition.`;

// The DJ should know what time it is where the listener is.
export function nowContext() {
  const d = new Date();
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const h = d.getHours();
  const part = h < 5 ? 'the small hours' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'late night';
  return `It is ${day}, ${time} (${part}) where the listener is.`;
}

function briefDoctrine(full) {
  if (!full) return '';
  const a = full.indexOf('## Core sensibility'), b = full.indexOf('## Relationship tiers');
  const core = a >= 0 ? full.slice(a, b > a ? b : a + 3500) : full.slice(0, 3500);
  const v = full.indexOf('## Vetoes');
  const vetoes = v >= 0 ? full.slice(v, v + 700) : '';
  return `${core}\n${vetoes}`.slice(0, 4500);
}

export function djSystemPrompt({ persona = DEFAULT_PERSONA, brief = false } = {}) {
  const full = readTasteProfile();
  // brief = rules + vetoes only (cheap helper calls); persona/selection calls get the whole profile (prompt-cached)
  const doctrine = brief ? briefDoctrine(full) : full;
  return `${persona}

LISTENER DOCTRINE (their taste, learned the hard way; obey it when choosing and when talking):
${doctrine || '(taste profile not found)'}

HARD RULES:
- You can only play tracks from the CANDIDATES list you are given, referenced by their exact id. Never name a track that is not in the list.
- Respect vetoes and down-weights. Never more than 2 tracks by one artist in a set, never two consecutive tracks from the same album.
- The library is a time-windowed digital sample; do not assume the listener lacks or dislikes what is absent.
- Output ONLY JSON when asked for JSON.`;
}

export function interpretThemePrompt(theme, { length }) {
  return `The listener asked for a radio set with this theme: "${theme}".
Turn it into a retrieval plan as JSON:
{
  "title": "short set title",
  "queries": ["3-6 natural-language descriptions used for semantic search over track summaries (moods, genres, eras, instrumentation, lyrical themes). Vary them so they cover different angles of the theme."],
  "year_from": integer|null, "year_to": integer|null,
  "must_artists": ["artist names explicitly requested, else empty"],
  "avoid_artists": ["artist names explicitly excluded, else empty"],
  "mode": "artist"|"radio",
  "energy_curve": "rise"|"flat"|"wind-down"|"peaks",
  "length": ${length},
  "notes": "one sentence on the intended feel"
}
mode rules: if the request is essentially one or more artist names (e.g. "Cherry Poppin' Daddies", "Beck and Gorillaz"), mode="artist" and the set is drawn from those artists only. If the request adds the word "radio" ("Beck radio", "Tom Waits radio") or describes a vibe/genre/era, mode="radio": those artists seed a wider set of kindred music. Genre or style requests ("big band swing") are mode="radio" with must_artists empty.`;
}

export function selectSetPrompt(theme, plan, candidates, { length, playedRecently = [], opener = true, maxSegues = 2 }) {
  const cands = candidates.map((c) => `${c.id} | ${c.artist} - ${c.title}${c.year ? ` (${c.year})` : ''} | e${c.energy ?? '?'}${c.weight < 1 ? ' | DOWN-WEIGHTED' : ''}${c.liked ? ' | LIKED' : ''} | ${(c.blurb || '').slice(0, 90)}`).join('\n');
  return `${nowContext()}
THEME: "${theme}"
PLAN: ${JSON.stringify({ title: plan.title, energy_curve: plan.energy_curve, notes: plan.notes })}
${playedRecently.length ? `RECENTLY PLAYED (do not repeat): ${playedRecently.join('; ')}\n` : ''}
CANDIDATES (id | artist - title (original year) | energy 1-5 | blurb):
${cands}

Pick ${length} tracks, in play order, that make a satisfying set for this theme and energy curve. Prefer originals and fingerprints over polish, honour the doctrine${plan.mode === 'artist' ? '. This is an ARTIST request: every pick must be by the requested artist(s); choose their best and most representative tracks and sequence them like a proper set' : ', vary artists'}. Avoid remixes, radio edits and alternate versions unless the request asks for them. Tracks marked LIKED are ones the listener thumbed up before.
On-air talk is rationed: this is radio, the music carries it. ${opener ? 'Write one opener (60-110 words): this is the first thing the listener hears after typing their request, so make it about THAT request. Restate what they asked for in your own words, say how you read it and what angle you took with the library (which corners you dug into, what you left out and why), name the first track and artist and one thing worth knowing about it, and tease one act coming later in the set. Every track or artist you name must be one of your picks, spelled exactly as listed; never mention a track that is not in the set. Warm and specific, no station ID here.' : 'No opener: the show is already running, do not re-introduce it.'} Write at most ${maxSegues} segue${maxSegues === 1 ? '' : 's'} (15-35 words each), never back to back, placed where a transition deserves a word. A segue is spoken between two specific tracks: name them by id. Lead with the track it introduces (the listener may have skipped the previous one); a look-back at the track it follows is optional and must be a light touch, never the whole break. Segues must reference the actual track/artist facts from the blurbs, never invented facts. No closer.
Return JSON:
{
  "title": "set title",
  "station": "a radio station name for this request: 2-4 words, playful and specific to the theme, like a real call sign or format name (e.g. 'Neon Drift FM', 'The Engine Room', 'Rainy Window Radio'); never the listener's words verbatim",
  "picks": [{"id": "<candidate id>", "why": "<=8 words"}],
  "opener": ${opener ? '"spoken text"' : '""'},
  "segues": [{"after_id": "<id of the pick this plays after>", "before_id": "<id of the pick that plays next>", "text": "spoken text"}]
}`;
}

// Album mode: the albums are already chosen; the DJ only writes the opener and one intro per album.
export function albumIntroPrompt(theme, plan, albums, { opener = true } = {}) {
  const list = albums.map((a) => `${a.id} | ${a.artist} - ${a.title}${a.year ? ` (${a.year})` : ''} | ${a.tracks} tracks${a.release_type && a.release_type !== 'album' ? ` | ${a.release_type}` : ''}`).join('\n');
  return `${nowContext()}
THEME: "${theme}"
PLAN: ${JSON.stringify({ title: plan.title, notes: plan.notes })}
ALBUM MODE: the station plays these albums in full, front to back, in this order (id | artist - title (year) | tracks):
${list}

${opener ? 'Write one opener (60-110 words): the listener just typed this request and this is the first thing they hear, so make it about the request. Restate it in your own words, say why you answered it with whole albums and which ones, name the first album and artist and one thing worth knowing about it, and say the albums play front to back. No station ID here.' : 'No opener: the show is already running.'} Then write one intro per album (15-35 words) spoken right before it starts: name the album and artist, one concrete reason it fits the theme or one real fact you are sure of (release year, what it is known for). No invented facts. No closer.
Return JSON:
{ "title": "block title", "station": "a radio station name for this request: 2-4 words, playful and specific to the theme (e.g. 'Full Spin FM', 'Deep Cuts Radio')", "opener": ${opener ? '"spoken text"' : '""'}, "intros": [{"album_id": "<id>", "text": "spoken text"}] }`;
}

// A listener "calls in" mid-set. The DJ answers on air and may re-plan the upcoming queue.
export function callInPrompt({ theme, message, nowPlaying, recent, upcoming, priorCalls }) {
  return `A listener called in during your set. ${nowContext()}
CURRENT THEME: "${theme}"
NOW PLAYING: ${nowPlaying || '(nothing)'}
RECENTLY PLAYED: ${recent.length ? recent.join('; ') : '(none)'}
CURRENTLY QUEUED NEXT: ${upcoming.length ? upcoming.join('; ') : '(none)'}
${priorCalls.length ? `EARLIER CALLS THIS SESSION: ${priorCalls.join(' | ')}\n` : ''}
CALLER SAYS: "${message}"

Decide how to respond. If the caller is steering the music (a request, a mood shift, "more like this", "less of that", an artist they want or want gone, a decade), set adjust=true and describe what to retrieve. If it is just chat or a question, answer on air and keep the queue (adjust=false). Never promise a specific track unless the queue later shows it (you do not know the library contents yet).
Return JSON:
{
  "reply": "spoken on-air reply to the caller, 20-50 words, warm and specific",
  "adjust": true|false,
  "queries": ["2-5 semantic search descriptions for the new direction (only if adjust)"],
  "year_from": integer|null, "year_to": integer|null,
  "must_artists": ["explicitly requested artists"], "avoid_artists": ["artists the caller wants gone"],
  "energy_curve": "rise"|"flat"|"wind-down"|"peaks",
  "length": 6,
  "theme_update": "one-line restatement of the theme incorporating the caller's wish (only if adjust)"
}`;
}

export function factoidPrompt(context) {
  return `Write 4 short on-air factoids (each 8-25 words, spoken style, no invented facts) from this material:\n${JSON.stringify(context)}\nReturn JSON {"factoids": ["..."]}.`;
}
