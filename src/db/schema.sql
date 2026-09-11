-- Jay Dee schema. Idempotent: every statement is CREATE ... IF NOT EXISTS.
-- Convention: tag_* columns come from Jellyfin/ID3 and are UNTRUSTED identification hints.
-- Resolved columns (no prefix) come from external identification + research and are the
-- only ones downstream code (embeddings, DJ, playlists) may read.

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT, finished_at TEXT,
  status TEXT,                      -- running | ok | failed
  jf_total_audio INT, jf_total_albums INT, jf_total_artists INT,
  added_artists INT DEFAULT 0, added_albums INT DEFAULT 0, added_tracks INT DEFAULT 0,
  updated_tracks INT DEFAULT 0,
  removed_artists INT DEFAULT 0, removed_albums INT DEFAULT 0, removed_tracks INT DEFAULT 0,
  carried_over INT DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, collection_type TEXT, locations_json TEXT,
  included INT DEFAULT 1,            -- 0 = never play from this library
  only_months TEXT,                  -- e.g. "11,12": included only in these months (seasonal libraries)
  last_seen_run INT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS artists (
  jellyfin_id TEXT PRIMARY KEY,
  rid INTEGER UNIQUE NOT NULL,
  -- tag (untrusted)
  tag_name TEXT NOT NULL, tag_sort_name TEXT, tag_genres_json TEXT, overview TEXT,
  name_key TEXT NOT NULL,
  canonical_id TEXT,
  -- resolved
  mb_artist_id TEXT, resolved_name TEXT, resolved_sort_name TEXT,
  artist_type TEXT, country TEXT, begin_year INT, end_year INT,
  genres_json TEXT, image_url_ext TEXT,
  resolution TEXT DEFAULT 'tag_only',   -- mbid_tag | mb_match_high | mb_match_low | claude_confirmed | tag_only
  resolution_confidence REAL, resolution_note TEXT, resolved_at TEXT,
  mb_json TEXT,
  -- library facts
  image_tag TEXT, backdrop_tags_json TEXT, path TEXT,
  is_album_artist INT DEFAULT 0, is_compilation INT DEFAULT 0, is_collab INT DEFAULT 0, library_ids_json TEXT,
  track_count INT DEFAULT 0, album_count INT DEFAULT 0,
  veto INT DEFAULT 0, veto_reason TEXT,
  raw_json TEXT, first_seen_run INT, last_seen_run INT, removed_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_artists_key ON artists(name_key);
CREATE INDEX IF NOT EXISTS ix_artists_mb ON artists(mb_artist_id);
CREATE INDEX IF NOT EXISTS ix_artists_canon ON artists(canonical_id);

CREATE TABLE IF NOT EXISTS albums (
  jellyfin_id TEXT PRIMARY KEY,
  rid INTEGER UNIQUE NOT NULL,
  tag_name TEXT NOT NULL, tag_year INT, tag_premiere_date TEXT, tag_genres_json TEXT, tag_album_artist_name TEXT, overview TEXT,
  title_key TEXT NOT NULL,
  album_artist_id TEXT, library_id TEXT,
  -- resolved
  mb_album_id TEXT, mb_release_group_id TEXT,
  resolved_title TEXT, resolved_artist TEXT,
  year INT, release_date TEXT, release_type TEXT,     -- album|single|ep|compilation|soundtrack|live|remix|other
  genres_json TEXT,
  resolution TEXT DEFAULT 'tag_only', resolution_confidence REAL, resolution_note TEXT, resolved_at TEXT,
  mb_tracklist_json TEXT, mb_json TEXT,
  -- library facts
  is_compilation INT DEFAULT 0, track_count INT, runtime_ticks INT, image_tag TEXT, path TEXT,
  raw_json TEXT, first_seen_run INT, last_seen_run INT, removed_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_albums_artist ON albums(album_artist_id);
CREATE INDEX IF NOT EXISTS ix_albums_key ON albums(title_key);
CREATE INDEX IF NOT EXISTS ix_albums_mb ON albums(mb_release_group_id);

CREATE TABLE IF NOT EXISTS tracks (
  jellyfin_id TEXT PRIMARY KEY,
  rid INTEGER UNIQUE NOT NULL,
  tag_title TEXT NOT NULL, tag_album TEXT, tag_artists_json TEXT, tag_album_artist TEXT,
  tag_year INT, tag_premiere_date TEXT, tag_genres_json TEXT, tag_mb_recording_id TEXT,
  title_key TEXT NOT NULL,
  album_id TEXT, album_artist_id TEXT, library_id TEXT,
  -- resolved
  mb_recording_id TEXT, mb_work_id TEXT,
  resolved_title TEXT, resolved_artist TEXT,
  original_year INT, original_date TEXT, album_year INT,
  genres_json TEXT, is_cover INT, original_artist TEXT,
  resolution TEXT DEFAULT 'tag_only', resolution_confidence REAL, resolution_note TEXT, resolved_at TEXT,
  -- library facts
  disc_no INT, track_no INT, runtime_ticks INT, duration_s REAL,
  container TEXT, path TEXT, normalization_gain REAL, has_lyrics INT,
  date_created TEXT, image_tag TEXT,
  bpm INT, key_text TEXT,
  raw_json TEXT, first_seen_run INT, last_seen_run INT, removed_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS ix_tracks_aa ON tracks(album_artist_id);
CREATE INDEX IF NOT EXISTS ix_tracks_year ON tracks(original_year);
CREATE INDEX IF NOT EXISTS ix_tracks_tkey ON tracks(title_key);
CREATE INDEX IF NOT EXISTS ix_tracks_mb ON tracks(mb_recording_id);

CREATE TABLE IF NOT EXISTS track_artists (
  track_id TEXT NOT NULL, artist_id TEXT NOT NULL, position INT,
  PRIMARY KEY (track_id, artist_id)
);
CREATE INDEX IF NOT EXISTS ix_track_artists_artist ON track_artists(artist_id);

CREATE TABLE IF NOT EXISTS discrepancies (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT NOT NULL,
  tag_value TEXT, resolved_value TEXT, detected_at TEXT,
  PRIMARY KEY (entity_type, entity_id, field)
);

CREATE TABLE IF NOT EXISTS research (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('artist','album','track')),
  entity_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'pending',   -- pending | packet | done | draft | derived | skipped | failed
  tier TEXT,                               -- deep | medium | derived | notable
  priority INT DEFAULT 0,
  attempts INT DEFAULT 0, last_error TEXT,
  batch_id TEXT, claimed_at TEXT,
  packet_json TEXT, packet_at TEXT,
  sources_json TEXT,
  summary TEXT, blurb TEXT,
  genres_json TEXT, moods_json TEXT, era TEXT, origin TEXT, tags_json TEXT,
  active_from INT, active_to INT, energy INT,
  dj_hooks_json TEXT, extra_json TEXT,
  confidence REAL, model TEXT, result_hash TEXT,
  needs_review INT DEFAULT 0, updated_at TEXT,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS ix_research_stage ON research(entity_type, stage, priority DESC);
CREATE INDEX IF NOT EXISTS ix_research_batch ON research(batch_id);

CREATE TABLE IF NOT EXISTS research_log (
  id INTEGER PRIMARY KEY, entity_type TEXT, entity_id TEXT, event TEXT, detail TEXT, at TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  rid INTEGER, text_hash TEXT, model TEXT, dims INT, vector BLOB, updated_at TEXT,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS dj_sessions (
  id INTEGER PRIMARY KEY, started_at TEXT, ended_at TEXT,
  theme TEXT, persona TEXT, voice TEXT,
  status TEXT,          -- planning | ready | playing | refilling | ended | failed
  plan_json TEXT, model TEXT, error TEXT,
  mode TEXT             -- tracks (default) | albums
);
CREATE TABLE IF NOT EXISTS dj_queue (
  id INTEGER PRIMARY KEY, session_id INT NOT NULL,
  position INT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('track','patter')),
  track_id TEXT, patter_hash TEXT, why TEXT,
  status TEXT DEFAULT 'queued',   -- queued | playing | played | skipped
  started_at TEXT, ended_at TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_dj_queue_session ON dj_queue(session_id, position);
CREATE TABLE IF NOT EXISTS patter (
  hash TEXT PRIMARY KEY, text TEXT, voice TEXT, speed REAL, file_path TEXT, duration_s REAL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS dj_calls (
  id INTEGER PRIMARY KEY, session_id INT, message TEXT, reply TEXT, action TEXT, detail_json TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS saved_sets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, theme TEXT, track_ids_json TEXT NOT NULL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  entity_type TEXT NOT NULL,   -- track | artist
  entity_id TEXT NOT NULL,
  value TEXT NOT NULL,         -- up | down | block
  at TEXT,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS dj_log (
  id INTEGER PRIMARY KEY, session_id INT, track_id TEXT, played_at TEXT, completed INT, skipped INT
);
CREATE INDEX IF NOT EXISTS ix_djlog_track ON dj_log(track_id, played_at);

-- Research resolved through canonical artist (merged variants inherit the canonical row's research)
CREATE VIEW IF NOT EXISTS v_artist_research AS
  SELECT a.jellyfin_id AS artist_id, a.canonical_id, r.*
  FROM artists a
  JOIN research r ON r.entity_type = 'artist' AND r.entity_id = COALESCE(a.canonical_id, a.jellyfin_id);
