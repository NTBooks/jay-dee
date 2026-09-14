// Radio Mode: Webamp (Winamp 2 in the browser) drives playback; its playlist shows previous + upcoming.
(() => {
  const { api, modes, onState, fmt, esc } = JayDee;
  let webamp = null;
  const inPlaylist = new Set(); // queue item ids already appended to Webamp
  let playingItem = null;       // queue item id currently playing per our bookkeeping
  let disposed = true;

  const itemFromUrl = (url) => { const m = /[?&]q=(\d+)/.exec(url || ''); return m ? Number(m[1]) : null; };

  function toTrack(it) {
    if (it.kind === 'patter') return { url: it.url, metaData: { artist: 'Jay Dee', title: `»» ${(it.text || '').slice(0, 60)}` }, duration: it.duration_s || undefined };
    return { url: it.url, metaData: { artist: it.artist || '', title: `${it.title}${it.year ? ` (${it.year})` : ''}` }, duration: it.duration_s || undefined };
  }

  async function ensureWebamp() {
    if (webamp && !disposed) return webamp;
    const node = document.getElementById('winamp');
    // Phones: main + playlist only (the equalizer starts closed) so the stack fits above the queue panel.
    const phone = window.matchMedia('(max-width: 700px), (max-height: 500px)').matches;
    const windowLayout = phone ? { main: { position: { top: 0, left: 0 } }, playlist: { position: { top: 116, left: 0 } } } : undefined;
    webamp = new window.Webamp({ initialTracks: [], zIndex: 3, enableHotkeys: false, ...(windowLayout ? { windowLayout } : {}) });
    disposed = false;
    await webamp.renderWhenReady(node);
    modes.radio.webamp = () => webamp;
    // the visualizer is started by modes.radio.enter (with the is-playing getter), never here: mounting can happen in TV mode
    // Webamp renders into a #webamp root appended to <body> with its windows stacked at the origin.
    // Offset the root so the stack sits inside the left pane (the windows stay draggable).
    positionRoot();
    window.addEventListener('resize', positionRoot);
    installMediaSession();
    webamp.onTrackDidChange((track) => {
      const next = track ? itemFromUrl(track.url) : null;
      if (next === playingItem) return;
      // Safety net: an entry the server replaced (call-in) that somehow survived pruning is skipped.
      if (next && !inPlaylist.has(next)) { try { webamp.nextTrack(); } catch {} return; }
      const prev = playingItem;
      playingItem = next;
      let shuffle = false; try { shuffle = !!webamp.store.getState().media.shuffle; } catch {}
      api.advance(prev, prev ? 'ended' : undefined, next, takeoverNext, shuffle).then((r) => { takeoverNext = false; passive = false; render(r.state); JayDee.emitTrackChange(r.state); })
        .catch((e) => { if (e.controller) goPassive(e.state); else console.error(e); });
    });
    return webamp;
  }

  // Webamp positions its window stack itself (relative to the pane at render time); measure where the main
  // window ended up and shift the #webamp root so the stack sits centred near the top of the pane.
  function positionRoot() {
    const root = document.getElementById('webamp');
    const pane = document.getElementById('winamp');
    const main = document.getElementById('main-window');
    if (!root || !pane || !main) return;
    root.style.position = 'absolute';
    root.style.left = '0px'; root.style.top = '0px';
    const p = pane.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    const targetX = Math.max(12, Math.round(p.left + (p.width - 275) / 2));
    const targetY = Math.round(p.top + 28);
    root.style.left = `${Math.round(targetX - m.left)}px`;
    root.style.top = `${Math.round(targetY - m.top + window.scrollY)}px`;
  }

  // Lock screen / notification / headset controls (Media Session API): title, art and transport for the shared engine.
  // Chrome on Android and Safari on iOS show these for the <audio> element Webamp plays through.
  const ms = () => ('mediaSession' in navigator ? navigator.mediaSession : null);
  let msInstalled = false, msItemId = null;
  function installMediaSession() {
    const s = ms(); if (!s || msInstalled) return; msInstalled = true;
    const bind = (action, fn) => { try { s.setActionHandler(action, fn); } catch { /* unsupported action */ } };
    bind('play', () => JayDee.engine.play());
    bind('pause', () => JayDee.engine.pause());
    bind('stop', () => JayDee.engine.stop());
    bind('nexttrack', () => JayDee.engine.next());
    bind('previoustrack', () => { try { webamp.previousTrack(); } catch {} });
    setInterval(() => { try { s.playbackState = JayDee.engine.isPlaying() ? 'playing' : 'paused'; } catch {} }, 1000);
  }
  function updateMediaSession(now) {
    const s = ms(); if (!s || !now || now.id === msItemId) return;
    msItemId = now.id;
    try {
      const art = now.kind === 'track' && now.album_id ? [{ src: `${location.origin}/art/album/${now.album_id}`, sizes: '512x512', type: 'image/jpeg' }] : [];
      const station = JayDee.getState()?.session?.station || 'Jay Dee';
      s.metadata = new MediaMetadata(now.kind === 'patter'
        ? { title: `${station} · voice break`, artist: 'Jay Dee', album: JayDee.getState()?.session?.title || '', artwork: [] }
        : { title: now.title || '', artist: now.artist || '', album: now.album || '', artwork: art });
    } catch { /* MediaMetadata unavailable */ }
  }
  // Phone transport bar (Winamp's own buttons are too small for thumbs).
  document.getElementById('rPrev').addEventListener('click', () => { try { webamp.previousTrack(); } catch {} });
  document.getElementById('rPlay').addEventListener('click', () => (passive ? JayDee.engine.takeover() : JayDee.engine.play()));
  document.getElementById('rPause').addEventListener('click', () => JayDee.engine.pause());
  document.getElementById('rNext').addEventListener('click', () => JayDee.engine.next());
  setInterval(() => { const on = !!webamp && !disposed && JayDee.engine.isPlaying(); document.getElementById('rPlay').hidden = on; document.getElementById('rPause').hidden = !on; }, 800);

  // Browsers keep an AudioContext created before any user gesture suspended; resume it on the first gesture we get.
  const unlockAudio = async () => { try { const ctx = webamp?.media?._context; if (ctx && ctx.state === 'suspended') { await ctx.resume(); const st = webamp.store.getState(); if (st.media.status === 'PLAYING') { webamp.pause(); webamp.play(); } } } catch {} };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
  let currentTrackForFb = null, rDownTimer = null;
  async function rFeedback(action) { if (!currentTrackForFb) return; const r = await api.feedback(currentTrackForFb.track_id, action); JayDee.setStatus(r.message || 'noted', ''); JayDee.api.state().then(render); }
  document.getElementById('rfbUp').addEventListener('click', () => rFeedback(currentTrackForFb?.feedback?.track === 'up' ? 'clear' : 'up'));
  document.getElementById('rfbDown').addEventListener('click', () => { clearTimeout(rDownTimer); rDownTimer = setTimeout(() => { const fb = currentTrackForFb?.feedback || {}; rFeedback(fb.artist_blocked ? 'unblock_artist' : fb.track === 'down' ? 'clear' : 'down'); }, 260); });
  document.getElementById('rfbDown').addEventListener('dblclick', () => { clearTimeout(rDownTimer); rFeedback(currentTrackForFb?.feedback?.artist_blocked ? 'unblock_artist' : 'block_artist'); });
  let passive = false, takeoverNext = false;
  // Hold the show while playing. The claim goes stale after 90s server-side, and tracks are longer than that, so
  // without a refresh a second player would find the role free mid-track and start a competing copy.
  setInterval(() => {
    if (passive || disposed || !JayDee.engine?.isPlaying()) return;
    api.control().catch((e) => { if (e.controller) goPassive(e.state); });
  }, 30_000);
  function goPassive(state) {
    passive = true;
    try { webamp.pause(); } catch {}
    const st = document.getElementById('status'); st.textContent = 'another player is driving this show'; st.className = 'status busy';
    document.getElementById('takeover').hidden = false;
  }
  async function syncPlaylist(state) {
    if (!state?.session || disposed) return;
    // Someone else holds the show: stop before playing over them, rather than finding out at the next advance.
    if (!passive && !JayDee.isDriver(state) && JayDee.engine?.isPlaying()) { goPassive(state); return; }
    if (passive) return; // watching only until the user takes over
    try { await syncPlaylistInner(state); } catch (e) { console.error('syncPlaylist failed', e); }
  }
  let engineSession = null;
  async function syncPlaylistInner(state) {
    // A different session than the one loaded in the engine (new theme, saved set, replaced show): wipe the deck,
    // whichever mode asked for it. Otherwise old tracks keep playing against a queue the server has retired.
    if (state.session.id !== engineSession) {
      engineSession = state.session.id;
      inPlaylist.clear(); playingItem = null;
      try { webamp.setTracksToPlay([]); } catch {}
    }
    const q = await api.queue();
    const first = inPlaylist.size === 0;
    // On first load also (re)start whatever the server thinks is playing, so a page reload resumes the set.
    const fresh = q.items.filter((it) => (it.status === 'queued' || (first && it.status === 'playing')) && it.url && !inPlaylist.has(it.id));
    if (!fresh.length) return;
    fresh.forEach((it) => inPlaylist.add(it.id));
    // First batch: load + start (setTracksToPlay loads track 1; if autoplay is blocked the user presses Play).
    if (first) { webamp.setTracksToPlay(fresh.map(toTrack)); return; }
    const st = webamp.store.getState();
    const atEnd = st.media.status !== 'PLAYING' && (st.playlist.currentTrack == null || st.playlist.trackOrder.indexOf(st.playlist.currentTrack) === st.playlist.trackOrder.length - 1);
    webamp.appendTracks(fresh.map(toTrack));
    // Radio never stops: if Webamp had run off the end of its playlist while the DJ was refilling, roll straight on.
    if (atEnd) { try { webamp.nextTrack(); webamp.play(); } catch (e) { console.warn('auto-continue failed', e); } }
  }

  function render(state) {
    if (!state) return;
    const now = state.nowPlaying;
    const card = document.getElementById('nowCard');
    if (now) {
      if (now.kind === 'track' && now.album_id) JayDee.viz.setArt(`/art/album/${now.album_id}`);
      card.querySelector('.art').style.backgroundImage = now.kind === 'track' && now.album_id ? `url(/art/album/${now.album_id})` : 'none';
      card.querySelector('.t').textContent = now.kind === 'patter' ? 'Jay Dee' : `${now.title}${now.year ? ` (${now.year})` : ''}`;
      card.querySelector('.a').textContent = now.kind === 'patter' ? (now.patter_text || now.why || '') : `${now.artist || ''} · ${now.album || ''}`;
      const fb = now.feedback || {}; const up = document.getElementById('rfbUp'), down = document.getElementById('rfbDown');
      up.disabled = down.disabled = now.kind !== 'track';
      up.classList.toggle('on', fb.track === 'up'); down.classList.toggle('on', fb.track === 'down'); down.classList.toggle('skull', !!fb.artist_blocked);
      down.textContent = fb.artist_blocked ? '\u{1F480}' : '\u{1F44E}';
      currentTrackForFb = now.kind === 'track' ? now : null;
      updateMediaSession(now);
    }
    const li = (it) => it.kind === 'patter'
      ? `<li class="patter"><div class="thumb">DJ</div><div class="txt"><div class="t">${esc((it.patter_text || it.why || '').slice(0, 80))}</div><div class="a">voice break</div></div></li>`
      : `<li><div class="thumb" style="background-image:url(/art/album/${it.album_id || ''})"></div><div class="txt"><div class="t">${esc(it.title)}${it.year ? ` <span class="a">(${it.year})</span>` : ''}</div><div class="a">${esc(it.artist || '')} · ${esc(it.album || '')} ${fmt(it.duration_s)}</div></div></li>`;
    document.getElementById('upNext').innerHTML = (state.upcoming || []).map(li).join('');
    document.getElementById('history').innerHTML = (state.history || []).slice().reverse().map(li).join('');
    const spoken = [...(state.history || []).filter((x) => x.status === 'played'), ...(now ? [now] : [])].filter((x) => x.kind === 'patter').slice(-6).map((x) => ({ t: x.started_at || '', cls: '', text: x.patter_text || x.why || '' }));
    const calls = (state.calls || []).slice(-6).flatMap((c) => [{ t: c.at, cls: 'caller', text: c.message }, { t: c.at, cls: 'dj', text: c.reply }]);
    const lines = [...spoken, ...calls].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    document.getElementById('transcript').innerHTML = lines.map((x) => `<p class="line ${x.cls}">${esc(x.text)}</p>`).join('');
  }

  // Remove queue items from Webamp's playlist (used when a call-in replaces the upcoming tracks).
  function removeFromWebamp(queueIds) {
    if (!webamp || disposed || !queueIds.length) return;
    try {
      const st = webamp.store.getState();
      const want = new Set(queueIds.map(Number));
      const ids = Object.values(st.tracks || {}).filter((t) => want.has(itemFromUrl(t.url))).map((t) => t.id);
      if (ids.length) webamp.store.dispatch({ type: 'REMOVE_TRACKS', ids });
      queueIds.forEach((id) => inPlaylist.delete(Number(id)));
    } catch (e) { console.warn('could not prune Webamp playlist', e); }
  }

  async function callIn(message) {
    const st = document.getElementById('callinStatus');
    st.textContent = 'ringing…'; st.className = 'callinStatus busy';
    try {
      const r = await api.callIn(message);
      removeFromWebamp(r.replaced || []);
      await syncPlaylist(r.state);
      render(r.state);
      st.textContent = r.action === 'adjust' ? `re-planned ${r.picks.length} tracks` : 'on air'; st.className = 'callinStatus';
      document.getElementById('callinInput').value = '';
    } catch (e) { st.textContent = e.message; st.className = 'callinStatus error'; }
  }
  document.getElementById('takeover').addEventListener('click', () => JayDee.engine.takeover());
  // saved sets
  async function renderSets() {
    const list = await api.sets();
    document.getElementById('savedSets').innerHTML = list.length ? list.map((s) => `<li><span class="txt"><span class="t">${esc(s.name)}</span><span class="a">${s.tracks} tracks · ${new Date(s.created_at).toLocaleDateString()}</span></span><button data-play="${s.id}" title="Play this set (replaces the current show)">&#9654;</button><button data-del="${s.id}" title="Delete">&times;</button></li>`).join('') : '<li class="dim">No saved sets yet</li>';
  }
  document.getElementById('saveSet').addEventListener('click', async () => {
    const name = prompt('Name this set', JayDee.getState()?.session?.title || '');
    if (name === null) return;
    try { const r = await api.saveSet(name); JayDee.setStatus(`saved "${r.name}" (${r.tracks} tracks)`, ''); renderSets(); } catch (e) { JayDee.setStatus(e.message, 'error'); }
  });
  document.getElementById('savedSets').addEventListener('click', async (e) => {
    const p = e.target.closest('[data-play]'), d = e.target.closest('[data-del]');
    if (p) { await api.playSet(p.dataset.play); JayDee.setStatus('loading saved set…', 'busy'); }
    if (d) { await api.deleteSet(d.dataset.del); renderSets(); }
  });
  renderSets();
  document.getElementById('callinForm').addEventListener('submit', (e) => { e.preventDefault(); const m = document.getElementById('callinInput').value.trim(); if (m) callIn(m); });
  document.getElementById('callinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('callinForm').requestSubmit(); } });

  // Shared engine: both modes play through this one Webamp instance. Mode switches only show/hide the windows.
  JayDee.engine = {
    ensure: ensureWebamp,
    play: async () => {
      try {
        // Claim the show before making a sound. Without this a second player runs its own copy of the same queue
        // until the next advance: two systems play the same track and the same voice break a moment apart, which
        // in one room comb-filters into something slurred and distorted rather than sounding like two players.
        try { await api.control(); }
        catch (e) { if (e.controller) { await ensureWebamp(); goPassive(e.state); return; } }
        await ensureWebamp();
        const st = webamp.store.getState();
        if (!st.playlist.trackOrder.length) { inPlaylist.clear(); playingItem = null; await syncPlaylist(JayDee.getState()); }
        else webamp.play();
        // if the browser kept the audio context suspended (mounted before any click), resume it now under this gesture
        try { const ctx = webamp.media?._context; if (ctx && ctx.state === 'suspended') await ctx.resume(); } catch {}
        const st2 = webamp.store.getState();
        if (st2.media.status !== 'PLAYING') webamp.play();
      } catch (e) { console.error('engine.play failed', e); }
    },
    pause: () => { try { webamp.pause(); } catch {} },
    next: () => { try { webamp.nextTrack(); } catch {} },
    stop: () => { try { webamp.stop(); } catch {} },
    // "playing" only counts when the browser's audio context is actually running; a suspended context is silence
    isPlaying: () => { try { const ctx = webamp.media?._context; return !disposed && webamp.store.getState().media.status === 'PLAYING' && !(ctx && ctx.state === 'suspended'); } catch { return false; } },
    audioBlocked: () => { try { const ctx = webamp.media?._context; return !!(ctx && ctx.state === 'suspended'); } catch { return false; } },
    isPassive: () => passive,
    prune: (queueIds) => removeFromWebamp(queueIds || []),
    // queue item id of the track Webamp currently has loaded (the one source of truth for "what is playing")
    currentItemId: () => { try { const st = webamp.store.getState(); const t = st.playlist.currentTrack != null ? st.tracks[st.playlist.currentTrack] : null; return t ? itemFromUrl(t.url) : null; } catch { return null; } },
    takeover: () => {
      passive = false; takeoverNext = true;
      document.getElementById('takeover').hidden = true;
      inPlaylist.clear(); playingItem = null;
      // Take the role now, so the player we are taking it from goes passive on its next poll instead of both
      // playing until whichever one finishes an item first.
      api.control(true).catch(() => {});
      syncPlaylist(JayDee.getState()).catch(console.error);
    },
  };

  modes.radio = {
    async enter(state) {
      await ensureWebamp();
      document.body.classList.remove('hideWinamp');
      positionRoot();
      JayDee.viz.start(document.getElementById('radioViz'), () => { try { return webamp && !disposed ? webamp.media.getAnalyser() : null; } catch { return null; } }, () => JayDee.engine.isPlaying());
      render(state);
      await syncPlaylist(state);
    },
    leave() {
      // keep the engine running; just hide the Winamp windows and pause the (invisible) visualizer
      JayDee.viz.stop();
      document.body.classList.add('hideWinamp');
    },
    onNewSession() { /* the engine resets itself when the session id changes (see syncPlaylistInner) */ },
  };

  // The engine runs whatever mode is showing: mount at boot and keep the playlist in sync from every poll.
  onState(async (state) => {
    if (!webamp || disposed) { await ensureWebamp(); if (document.body.dataset.mode !== 'radio') document.body.classList.add('hideWinamp'); }
    render(state);
    syncPlaylist(state).catch(console.error);
  });
})();
