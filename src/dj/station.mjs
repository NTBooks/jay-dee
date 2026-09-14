// Station state machine persisted in dj_sessions / dj_queue / dj_log. Client-driven playback.
import { planSet, clampLength, SET_MAX } from './planner.mjs';
import { planAlbumSet } from './albums.mjs';
const REFILL_LENGTH = clampLength(Number(process.env.DJ_REFILL_LENGTH) || 6);
import { j, pj } from '../db/open.mjs';
import { nowIso } from '../util/hash.mjs';
import { config } from '../config.mjs';
import { log } from '../util/log.mjs';
import { costTotals } from '../llm/openrouter.mjs';
import { pruneVoiceCache } from './tts.mjs';


export class Station {
  constructor(db) {
    this.db = db; this.planning = null; this.progress = []; this.controller = null; // { sessionId, clientId, seenAt }
    // No planning survives a process restart: settle any session left mid-plan.
    this.db.prepare("UPDATE dj_sessions SET status='playing' WHERE status='refilling'").run();
    this.db.prepare("UPDATE dj_sessions SET status='failed', error='server restarted while planning', ended_at=? WHERE status='planning'").run(nowIso());
  }

  // After the database underneath us is replaced, nothing in memory refers to anything real any more: the session
  // being planned, the progress log and the driving client all belong to the old catalog's row ids.
  reset() {
    this.planning = null; this.progress = []; this.controller = null;
    this.db.prepare("UPDATE dj_sessions SET status='playing' WHERE status='refilling'").run();
    this.db.prepare("UPDATE dj_sessions SET status='failed', error='database restored', ended_at=? WHERE status IN ('planning','ready','playing')").run(nowIso());
  }

  current() {
    return this.db.prepare("SELECT * FROM dj_sessions WHERE status IN ('planning','ready','playing','refilling') ORDER BY id DESC LIMIT 1").get() || null;
  }

  async startSession(theme, { length = SET_MAX, mode = 'tracks' } = {}) {
    length = clampLength(length);
    mode = mode === 'albums' ? 'albums' : 'tracks';
    for (const s of this.db.prepare("SELECT id FROM dj_sessions WHERE status IN ('planning','ready','playing','refilling')").all()) this.endSession(s.id, 'replaced');
    const id = this.db.prepare('INSERT INTO dj_sessions(started_at, theme, persona, voice, status, model, mode) VALUES (?,?,?,?,?,?,?)')
      .run(nowIso(), theme, 'jay-dee', config.kokoro.voice, 'planning', config.openrouter.model, mode).lastInsertRowid;
    this.planning = this.plan(id, theme, length).catch((e) => {
      log.error(`planning failed: ${e.message}`);
      this.progress.push({ at: nowIso(), step: 'error', text: e.message.slice(0, 200), done: true, error: true });
      this.db.prepare("UPDATE dj_sessions SET status='failed', error=?, ended_at=? WHERE id=?").run(e.message.slice(0, 500), nowIso(), id);
    }).finally(() => { this.planning = null; });
    return id;
  }

  // Manual session (no LLM): explicit track ids, optional spoken intro. Used for testing and "just play these".
  async startManual(title, trackIds, { intro } = {}) {
    for (const s of this.db.prepare("SELECT id FROM dj_sessions WHERE status IN ('planning','ready','playing','refilling')").all()) this.endSession(s.id, 'replaced');
    const ids = trackIds.filter((id) => this.db.prepare('SELECT 1 FROM tracks WHERE jellyfin_id = ? AND removed_at IS NULL').get(id));
    if (!ids.length) throw new Error('no valid track ids');
    const sessionId = this.db.prepare('INSERT INTO dj_sessions(started_at, theme, persona, voice, status, model, plan_json) VALUES (?,?,?,?,?,?,?)')
      .run(nowIso(), title, 'manual', config.kokoro.voice, 'ready', 'manual', j({ title, manual: true })).lastInsertRowid;
    const ins = this.db.prepare('INSERT INTO dj_queue(session_id, position, kind, track_id, patter_hash, why, status) VALUES (?,?,?,?,?,?,?)');
    let pos = 0;
    if (intro) {
      const { renderPatter } = await import('./tts.mjs');
      const tts = await renderPatter(this.db, intro);
      ins.run(sessionId, pos++, 'patter', null, tts.hash, intro, 'queued');
    }
    for (const id of ids) ins.run(sessionId, pos++, 'track', id, null, 'manual pick', 'queued');
    return sessionId;
  }

  async plan(sessionId, theme, length, { append = false } = {}) {
    const played = this.db.prepare('SELECT track_id FROM dj_queue WHERE session_id = ? AND track_id IS NOT NULL').all(sessionId).map((r) => r.track_id);
    const recentNames = this.db.prepare(`SELECT COALESCE(t.resolved_artist, t.tag_album_artist) || ' - ' || COALESCE(t.resolved_title, t.tag_title) n FROM dj_queue q JOIN tracks t ON t.jellyfin_id = q.track_id WHERE q.session_id = ? ORDER BY q.position DESC LIMIT 30`).all(sessionId).map((r) => r.n);
    // refills carry no opener (the show is already on) and are shorter than the first set
    this.progress = [{ at: nowIso(), step: 'start', text: append ? `Refilling: ${length} more tracks for "${theme}"` : `New set: "${theme}"`, done: true }];
    const onProgress = (step, text, extra = {}) => {
      const last = this.progress.at(-1);
      if (last && last.step === step && !last.done) Object.assign(last, { text, at: nowIso(), ...extra });
      else this.progress.push({ at: nowIso(), step, text, ...extra });
    };
    const sess = this.db.prepare('SELECT mode FROM dj_sessions WHERE id = ?').get(sessionId);
    const set = sess?.mode === 'albums'
      ? await planAlbumSet(this.db, theme, { count: append ? 1 : 2, excludeAlbumIds: this.playedAlbums(sessionId), renderTts: true, opener: !append, onProgress })
      : await planSet(this.db, theme, { length, renderTts: true, playedRecently: recentNames, excludeIds: played, opener: !append, onProgress });
    const startPos = append ? (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM dj_queue WHERE session_id = ?').get(sessionId).p) : 0;
    const ins = this.db.prepare('INSERT INTO dj_queue(session_id, position, kind, track_id, patter_hash, why, status) VALUES (?,?,?,?,?,?,?)');
    const tx = this.db.transaction(() => {
      let pos = startPos;
      for (const it of set.items) {
        ins.run(sessionId, pos++, it.kind, it.track_id || null, it.tts?.hash || null, it.kind === 'patter' ? it.text : it.why, 'queued');
      }
      const prev = pj(this.db.prepare('SELECT plan_json FROM dj_sessions WHERE id = ?').get(sessionId)?.plan_json, {});
      this.db.prepare("UPDATE dj_sessions SET status = CASE WHEN status='planning' THEN 'ready' ELSE 'playing' END, plan_json = ? WHERE id = ?")
        .run(j({ ...prev, title: prev.title || set.title, station: prev.station || set.station || null, plan: set.plan, candidates: set.candidates, model: set.model, dropped: set.dropped, albums: set.albums }), sessionId);
    });
    tx();
    this.progress.push({ at: nowIso(), step: 'queued', text: `Queued ${set.items.filter((i) => i.kind === 'track').length} tracks and ${set.items.filter((i) => i.kind === 'patter').length} voice break(s)`, done: true });
    log.info(`session ${sessionId}: queued ${set.items.length} items (${set.items.filter((i) => i.kind === 'track').length} tracks)`);
    return set;
  }

  queue(sessionId) {
    return this.db.prepare(`SELECT q.*, COALESCE(t.resolved_title, t.tag_title) title, COALESCE(t.resolved_artist, ar.resolved_name, ar.tag_name, t.tag_album_artist) artist,
        COALESCE(al.resolved_title, al.tag_name) album, t.original_year year, t.album_id, ar.canonical_id artist_id, t.duration_s, t.container, p.text patter_text, p.duration_s patter_duration
      FROM dj_queue q LEFT JOIN tracks t ON t.jellyfin_id = q.track_id LEFT JOIN albums al ON al.jellyfin_id = t.album_id LEFT JOIN artists ar ON ar.jellyfin_id = t.album_artist_id
      LEFT JOIN patter p ON p.hash = q.patter_hash WHERE q.session_id = ? ORDER BY q.position`).all(sessionId);
  }

  state() {
    let s = this.current();
    if (s && s.status === 'refilling' && !this.planning) {
      this.db.prepare("UPDATE dj_sessions SET status='playing' WHERE id=?").run(s.id);
      s = { ...s, status: 'playing' };
    }
    if (!s) return { session: null, planning: !!this.planning, progress: this.progress, cost: costTotals() };
    const q = this.queue(s.id);
    const idx = q.findIndex((x) => x.status === 'playing');
    const nowPlaying = idx >= 0 ? { ...q[idx], feedback: q[idx].track_id ? this.feedbackFor(q[idx].track_id) : null } : null;
    const upcoming = q.filter((x) => x.status === 'queued').slice(0, 12);
    const history = q.filter((x) => x.status === 'played' || x.status === 'skipped').slice(-12);
    return { session: { id: s.id, theme: s.theme, status: s.status, started_at: s.started_at, title: pj(s.plan_json, {}).title, station: pj(s.plan_json, {}).station || null, error: s.error, mode: s.mode || 'tracks' }, planning: !!this.planning, progress: this.progress, nowPlaying, upcoming, history, queueLength: q.length, calls: this.calls(s.id), cost: costTotals({ since: s.started_at }), controller: this.controllerInfo(s.id) };
  }

  // Client reports the current item ended/skipped (or asks for the first). Returns the next item to play.
  // nextItemId lets a client that controls its own playlist (Webamp) declare which item it started.
  // One browser drives the queue at a time. Another client may take over explicitly (takeover=true) or after the driver goes quiet for 90 s.
  claimControl(sessionId, clientId, { takeover = false } = {}) {
    const c = this.controller;
    const stale = !c || c.sessionId !== sessionId || Date.now() - c.seenAt > 90_000;
    if (!clientId) return true;
    if (stale || takeover || c.clientId === clientId) { this.controller = { sessionId, clientId, seenAt: Date.now() }; return true; }
    return false;
  }
  // Claim or refresh the driver role without touching the queue. Playback used to announce itself only at the next
  // advance, i.e. when something finished, so a second player ran its own copy of the show for a whole track before
  // anyone noticed. Pressing play claims here instead, and the driver refreshes while it plays so the 90s staleness
  // window cannot hand the show to someone else mid-track.
  claim(sessionId, clientId, { takeover = false } = {}) {
    if (!this.claimControl(sessionId, clientId, { takeover })) {
      throw Object.assign(new Error('another player is driving this show'), { status: 409, controller: true });
    }
    return this.controllerInfo(sessionId);
  }

  controllerInfo(sessionId) {
    const c = this.controller;
    if (!c || c.sessionId !== sessionId) return null;
    return { clientId: c.clientId, idleMs: Date.now() - c.seenAt };
  }

  async advance(sessionId, { itemId, reason = 'ended', nextItemId, clientId, takeover = false, noRefill = false } = {}) {
    const s = this.db.prepare('SELECT * FROM dj_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('no such session');
    if (!this.claimControl(sessionId, clientId, { takeover })) throw Object.assign(new Error('another player is driving this show'), { status: 409, controller: true });
    const now = nowIso();
    const finish = (it, why) => {
      this.db.prepare('UPDATE dj_queue SET status = ?, ended_at = ?, reason = ? WHERE id = ?').run(why === 'skipped' ? 'skipped' : 'played', now, why, it.id);
      if (it.track_id) this.db.prepare('INSERT INTO dj_log(session_id, track_id, played_at, completed, skipped) VALUES (?,?,?,?,?)').run(sessionId, it.track_id, it.started_at || now, why === 'skipped' ? 0 : 1, why === 'skipped' ? 1 : 0);
    };
    if (itemId) {
      const it = this.db.prepare('SELECT * FROM dj_queue WHERE id = ? AND session_id = ?').get(itemId, sessionId);
      if (it && it.status === 'playing') {
        finish(it, reason);
      }
    }
    // anything still marked playing (client lost track) is closed out
    for (const it of this.db.prepare("SELECT * FROM dj_queue WHERE session_id = ? AND status = 'playing'").all(sessionId)) finish(it, 'superseded');
    let next = nextItemId ? this.db.prepare("SELECT * FROM dj_queue WHERE id = ? AND session_id = ? AND status IN ('queued','played','skipped')").get(nextItemId, sessionId) : null;
    if (!next) next = this.db.prepare("SELECT * FROM dj_queue WHERE session_id = ? AND status = 'queued' ORDER BY position LIMIT 1").get(sessionId);
    // Refill exactly when the LAST queued track starts (nothing queued after it), never on a count or a timer,
    // and not while the listener has shuffle on (the client tells us).
    const queuedAfterNext = next ? this.db.prepare("SELECT COUNT(*) n FROM dj_queue WHERE session_id = ? AND status = 'queued' AND kind = 'track' AND position > ?").get(sessionId, next.position).n : 0;
    if (next && next.kind === 'track' && queuedAfterNext === 0 && !noRefill && !this.planning && s.status !== 'ended' && s.model !== 'manual' && config.openrouter.apiKey) {
      this.db.prepare("UPDATE dj_sessions SET status='refilling' WHERE id=?").run(sessionId);
      this.planning = this.plan(sessionId, s.theme, REFILL_LENGTH, { append: true }).catch((e) => log.error(`refill failed: ${e.message}`)).finally(() => { this.planning = null; this.db.prepare("UPDATE dj_sessions SET status='playing' WHERE id=? AND status='refilling'").run(sessionId); });
    }
    if (!next) return null;
    this.db.prepare("UPDATE dj_queue SET status='playing', started_at=? WHERE id=?").run(now, next.id);
    this.db.prepare("UPDATE dj_sessions SET status='playing' WHERE id=? AND status IN ('ready','playing')").run(sessionId);
    return this.queue(sessionId).find((x) => x.id === next.id);
  }

  playedAlbums(sessionId) {
    return this.db.prepare('SELECT DISTINCT t.album_id a FROM dj_queue q JOIN tracks t ON t.jellyfin_id = q.track_id WHERE q.session_id = ? AND t.album_id IS NOT NULL').all(sessionId).map((r) => r.a);
  }

  // Album mode: drop the rest of the album that is playing (everything queued up to the next voice break / other album).
  skipAlbum(sessionId) {
    const s = this.db.prepare('SELECT * FROM dj_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('no such session');
    const q = this.queue(sessionId);
    const now = q.find((x) => x.status === 'playing');
    const fromPos = now ? now.position : -1;
    const queued = q.filter((x) => x.status === 'queued' && x.position > fromPos);
    let albumId = now?.album_id || null;
    if (!albumId) { const t = queued.find((x) => x.kind === 'track'); albumId = t?.album_id || null; }
    const skipped = [];
    for (const it of queued) {
      if (it.kind !== 'track' || it.album_id !== albumId) break;
      skipped.push(it);
    }
    const at = nowIso();
    const upd = this.db.prepare("UPDATE dj_queue SET status='skipped', ended_at=?, reason='album_skipped' WHERE id=?");
    for (const it of skipped) upd.run(at, it.id);
    // nothing left after the skip: plan the next album right away
    const left = this.db.prepare("SELECT COUNT(*) n FROM dj_queue WHERE session_id = ? AND status = 'queued' AND kind = 'track'").get(sessionId).n;
    if (!left && !this.planning && s.status !== 'ended' && s.model !== 'manual' && config.openrouter.apiKey) {
      this.db.prepare("UPDATE dj_sessions SET status='refilling' WHERE id=?").run(sessionId);
      this.planning = this.plan(sessionId, s.theme, REFILL_LENGTH, { append: true }).catch((e) => log.error(`refill failed: ${e.message}`)).finally(() => { this.planning = null; this.db.prepare("UPDATE dj_sessions SET status='playing' WHERE id=? AND status='refilling'").run(sessionId); });
    }
    return { skipped: skipped.map((x) => x.id), album: albumId, refilling: !left };
  }

  // Listener call-in: DJ replies on air (inserted right after the current item) and optionally re-plans everything queued.
  async callIn(sessionId, message) {
    const s = this.db.prepare('SELECT * FROM dj_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('no such session');
    if (!config.openrouter.apiKey) throw new Error('OPENROUTER_API_KEY missing in .env (needed for call-ins)');
    const { chat } = await import('../llm/openrouter.mjs');
    const { djSystemPrompt, callInPrompt } = await import('../llm/prompts.mjs');
    const { gatherCandidates } = await import('./candidates.mjs');
    const { selectSet } = await import('./planner.mjs');
    const { renderPatter } = await import('./tts.mjs');
    const q = this.queue(sessionId);
    const label = (x) => (x.kind === 'patter' ? null : `${x.artist} - ${x.title}${x.year ? ` (${x.year})` : ''}`);
    const now = q.find((x) => x.status === 'playing');
    const recent = q.filter((x) => x.status === 'played' && x.kind === 'track').slice(-8).map(label).filter(Boolean);
    const upcoming = q.filter((x) => x.status === 'queued' && x.kind === 'track').slice(0, 8).map(label).filter(Boolean);
    const priorCalls = this.db.prepare('SELECT message FROM dj_calls WHERE session_id = ? ORDER BY id').all(sessionId).map((c) => c.message).slice(-5);
    const plan = pj(s.plan_json, {});
    const theme = plan.theme_update || s.theme;
    const r = await chat({ purpose: 'callin', system: djSystemPrompt(), json: true, temperature: 0.7, maxTokens: 900, messages: [{ role: 'user', content: callInPrompt({ theme, message, nowPlaying: now ? (now.kind === 'patter' ? 'DJ talking' : label(now)) : null, recent, upcoming, priorCalls }) }] });
    const d = r.json || {};
    const reply = String(d.reply || '').trim() || 'Thanks for calling in.';
    const tts = await renderPatter(this.db, reply);
    const nowIsoStr = nowIso();
    const currentPos = now ? now.position : (q.filter((x) => x.status !== 'queued').at(-1)?.position ?? -1);
    let added = [];
    let replaced = [];
    let set = null;
    if (d.adjust) {
      const subPlan = { queries: Array.isArray(d.queries) && d.queries.length ? d.queries : [message], year_from: d.year_from || null, year_to: d.year_to || null,
        must_artists: d.must_artists || [], avoid_artists: d.avoid_artists || [], energy_curve: d.energy_curve || 'flat', title: d.theme_update || theme, notes: message };
      const played = q.filter((x) => x.track_id && x.status !== 'queued').map((x) => x.track_id);
      const candidates = await gatherCandidates(this.db, subPlan, { excludeIds: played });
      if (candidates.length) {
        set = await selectSet(this.db, `${theme}. Caller request: ${message}`, subPlan, candidates, { length: clampLength(Number(d.length) || REFILL_LENGTH), playedRecently: recent, opener: false });
      }
    }
    // render segue voice files BEFORE queueing so every inserted item has a playable url immediately
    const segueHashes = new Map();
    if (set) {
      for (const sg of set.segues || []) {
        try { const t = await renderPatter(this.db, sg.text); segueHashes.set(sg.after_index, t.hash); } catch (e) { log.warn(`segue tts failed: ${e.message}`); }
      }
    }
    const tx = this.db.transaction(() => {
      // renumber: keep everything up to and including the current item, then our insertions, then (if not adjusting) the old queue
      const queued = q.filter((x) => x.status === 'queued' && x.position > currentPos);
      let pos = currentPos + 1;
      const ins = this.db.prepare('INSERT INTO dj_queue(session_id, position, kind, track_id, patter_hash, why, status) VALUES (?,?,?,?,?,?,?)');
      const shift = this.db.prepare('UPDATE dj_queue SET position = ? WHERE id = ?');
      if (set) {
        replaced = queued.map((x) => x.id);
        this.db.prepare(`UPDATE dj_queue SET status='skipped', reason='call-in' WHERE id IN (${replaced.map(() => '?').join(',') || 'NULL'})`).run(...replaced);
        const id0 = ins.run(sessionId, pos++, 'patter', null, tts.hash, reply, 'queued').lastInsertRowid;
        added.push(id0);
        const segueAfter = new Map((set.segues || []).map((x) => [x.after_index, x.text]));
        set.picks.forEach((p, i) => {
          added.push(ins.run(sessionId, pos++, 'track', p.id, null, p.why || 'call-in pick', 'queued').lastInsertRowid);
          if (segueAfter.has(i) && segueHashes.has(i)) added.push(ins.run(sessionId, pos++, 'patter', null, segueHashes.get(i), segueAfter.get(i), 'queued').lastInsertRowid);
        });
        this.db.prepare('UPDATE dj_sessions SET plan_json = ? WHERE id = ?').run(j({ ...plan, theme_update: d.theme_update || plan.theme_update, last_call: message }), sessionId);
      } else {
        // just the reply, right after the current item; push the old queue back by one
        for (const x of queued.slice().reverse()) shift.run(x.position + 1, x.id);
        added.push(ins.run(sessionId, pos, 'patter', null, tts.hash, reply, 'queued').lastInsertRowid);
      }
      this.db.prepare('INSERT INTO dj_calls(session_id, message, reply, action, detail_json, at) VALUES (?,?,?,?,?,?)')
        .run(sessionId, message, reply, set ? 'adjust' : 'reply', j({ queries: d.queries, theme_update: d.theme_update, picks: set ? set.picks.map((p) => `${p.artist} - ${p.title}`) : [] }), nowIsoStr);
    });
    tx();
    return { reply, action: set ? 'adjust' : 'reply', replaced, added, picks: set ? set.picks.map((p) => `${p.artist} - ${p.title}`) : [] };
  }

  // Saved sets: snapshot of a session's tracks (played + queued) for later recall, replayed as a manual session (no LLM).
  saveSet(sessionId, name) {
    const s = this.db.prepare('SELECT * FROM dj_sessions WHERE id = ?').get(sessionId);
    if (!s) throw new Error('no such session');
    const ids = this.db.prepare("SELECT track_id FROM dj_queue WHERE session_id = ? AND kind = 'track' AND track_id IS NOT NULL AND status <> 'skipped' ORDER BY position").all(sessionId).map((r) => r.track_id);
    if (!ids.length) throw new Error('nothing to save yet');
    const title = String(name || pj(s.plan_json, {}).title || s.theme || 'Saved set').trim().slice(0, 120);
    const id = this.db.prepare('INSERT INTO saved_sets(name, theme, track_ids_json, created_at) VALUES (?,?,?,?)').run(title, s.theme, j(ids), nowIso()).lastInsertRowid;
    return { id, name: title, tracks: ids.length };
  }
  savedSets() {
    return this.db.prepare('SELECT id, name, theme, created_at, json_array_length(track_ids_json) tracks FROM saved_sets ORDER BY id DESC').all();
  }
  async playSaved(id) {
    const row = this.db.prepare('SELECT * FROM saved_sets WHERE id = ?').get(id);
    if (!row) throw new Error('no such saved set');
    return this.startManual(row.name, pj(row.track_ids_json, []));
  }
  deleteSaved(id) { return this.db.prepare('DELETE FROM saved_sets WHERE id = ?').run(id).changes; }

  feedbackFor(trackId) {
    const t = this.db.prepare('SELECT album_artist_id, (SELECT canonical_id FROM artists WHERE jellyfin_id = tracks.album_artist_id) canon FROM tracks WHERE jellyfin_id = ?').get(trackId);
    const tr = this.db.prepare("SELECT value FROM feedback WHERE entity_type='track' AND entity_id=?").get(trackId);
    const ar = t?.canon ? this.db.prepare("SELECT value FROM feedback WHERE entity_type='artist' AND entity_id=?").get(t.canon) : null;
    return { track: tr?.value || null, artist_blocked: ar?.value === 'block' };
  }
  setFeedback(trackId, action) {
    const t = this.db.prepare('SELECT jellyfin_id, (SELECT canonical_id FROM artists WHERE jellyfin_id = tracks.album_artist_id) canon, COALESCE(resolved_title, tag_title) title FROM tracks WHERE jellyfin_id = ?').get(trackId);
    if (!t) throw new Error('no such track');
    const now = nowIso();
    const put = (type, id, value) => this.db.prepare('INSERT INTO feedback(entity_type, entity_id, value, at) VALUES (?,?,?,?) ON CONFLICT(entity_type, entity_id) DO UPDATE SET value=excluded.value, at=excluded.at').run(type, id, value, now);
    const del = (type, id) => this.db.prepare('DELETE FROM feedback WHERE entity_type=? AND entity_id=?').run(type, id);
    const artistName = t.canon ? this.db.prepare('SELECT COALESCE(resolved_name, tag_name) n FROM artists WHERE jellyfin_id = ?').get(t.canon)?.n : 'this artist';
    let message = 'noted';
    if (action === 'up') { put('track', t.jellyfin_id, 'up'); message = `Liked "${t.title}": more like this`; }
    else if (action === 'down') { put('track', t.jellyfin_id, 'down'); message = `"${t.title}" will not be played again`; }
    else if (action === 'clear') { del('track', t.jellyfin_id); message = 'cleared'; }
    else if (action === 'block_artist' && t.canon) { put('artist', t.canon, 'block'); put('track', t.jellyfin_id, 'down'); message = `${artistName} is blocked from the station`; }
    else if (action === 'unblock_artist' && t.canon) { del('artist', t.canon); del('track', t.jellyfin_id); message = `${artistName} is back`; }
    return { feedback: this.feedbackFor(trackId), message };
  }

  calls(sessionId) {
    return this.db.prepare('SELECT id, message, reply, action, at FROM dj_calls WHERE session_id = ? ORDER BY id').all(sessionId);
  }

  endSession(sessionId, reason = 'stopped') {
    this.db.prepare("UPDATE dj_sessions SET status='ended', ended_at=?, error=COALESCE(error, ?) WHERE id=?").run(nowIso(), reason === 'stopped' ? null : reason, sessionId);
    this.db.prepare("UPDATE dj_queue SET status='skipped', reason='session ended' WHERE session_id=? AND status IN ('queued','playing')").run(sessionId);
    // The show this voice was written for is over, so its breaks are now dead weight on the volume.
    try { pruneVoiceCache(this.db); } catch (e) { log.warn(`voice cache prune failed: ${e.message}`); }
  }
}
