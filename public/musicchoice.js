// TV mode: a full-bleed skin over the shared Webamp engine (JayDee.engine from radio.js).
// It never owns audio: switching modes is purely visual. It presents state.nowPlaying and maps its transport onto the engine.
(() => {
  const { api, modes, onState, esc } = JayDee;
  let current = null;
  let facts = [], factIdx = 0, factTimer = null;
  let bgTimer = null, bgToggle = false, bgImages = [], bgIdx = 0;

  // Backgrounds: small images look compressed full-bleed, so they are pre-blurred by downscaling into a canvas
  // (cheap, done once) instead of a live CSS blur on a full-screen layer (which burns GPU every frame).
  const bgCache = new Map();
  function prepBg(url) {
    return new Promise((res) => {
      if (!url) return res(null);
      if (bgCache.has(url)) return res(bgCache.get(url));
      const im = new Image();
      im.onload = () => {
        const w = im.naturalWidth, need = Math.max(window.innerWidth, window.innerHeight);
        const target = w < 500 ? 48 : w < 900 ? 96 : w < need * 0.7 ? 240 : 0;
        let src = url;
        if (target) {
          try { const c = document.createElement('canvas'); const ar = im.naturalHeight / w; c.width = target; c.height = Math.max(1, Math.round(target * ar)); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, c.width, c.height); src = c.toDataURL('image/jpeg', 0.8); } catch { src = url; }
        }
        const entry = { src, natural: w }; bgCache.set(url, entry); res(entry);
      };
      im.onerror = () => res(null);
      im.src = url;
    });
  }
  function setBg(entry) {
    const a = document.getElementById('mcBgA'), b = document.getElementById('mcBgB');
    const [show, hide] = bgToggle ? [a, b] : [b, a];
    bgToggle = !bgToggle;
    show.style.backgroundImage = `url("${entry.src}")`;
    show.classList.add('on'); hide.classList.remove('on');
  }
  function rotateBg() { if (!bgImages.length || document.body.classList.contains('paused')) return; bgIdx = (bgIdx + 1) % bgImages.length; setBg(bgImages[bgIdx]); }

  // ---- idle screensaver (DVD-logo bounce); the loop only runs while the idle layer is visible ----
  const idle = { raf: null, x: 80, y: 80, vx: 2.2, vy: 1.7, on: false, parked: false, hintTimer: null };
  const DVD_COLORS = ['#7fd6a4', '#f5c46b', '#8fb8ff', '#ff8fb1', '#c9a0ff', '#ffd27f', '#7fe3e0'];
  function dvdFrame() {
    if (!idle.on || document.body.dataset.mode !== 'mc' || document.hidden) { idle.raf = null; return; }
    const stage = document.getElementById('mc').getBoundingClientRect();
    const logo = document.getElementById('dvdLogo');
    const w = stage.width, h = stage.height, lw = logo.offsetWidth, lh = logo.offsetHeight;
    if (idle.parked) {
      const t = performance.now() / 1000;
      logo.style.transform = `translate(${Math.round((w - lw) / 2 + Math.sin(t * 0.6) * 12)}px, ${Math.round((h - lh) / 2 - 6 * (h / 100) + Math.cos(t * 0.45) * 8)}px)`;
    } else {
      idle.x += idle.vx; idle.y += idle.vy;
      let hit = false;
      if (idle.x <= 0) { idle.x = 0; idle.vx = Math.abs(idle.vx); hit = true; }
      if (idle.x + lw >= w) { idle.x = w - lw; idle.vx = -Math.abs(idle.vx); hit = true; }
      if (idle.y <= 0) { idle.y = 0; idle.vy = Math.abs(idle.vy); hit = true; }
      if (idle.y + lh >= h) { idle.y = h - lh; idle.vy = -Math.abs(idle.vy); hit = true; }
      if (hit) logo.style.setProperty('--dvd', DVD_COLORS[Math.floor(Math.random() * DVD_COLORS.length)]);
      logo.style.transform = `translate(${idle.x}px, ${idle.y}px)`;
    }
    idle.raf = requestAnimationFrame(dvdFrame);
  }
  function kickIdle() { if (idle.on && !idle.raf && !document.hidden && document.body.dataset.mode === 'mc') idle.raf = requestAnimationFrame(dvdFrame); }
  document.addEventListener('visibilitychange', kickIdle);
  function setIdle(on, hint, { parked = false } = {}) {
    const layer = document.getElementById('mcIdle');
    const hintEl = document.getElementById('mcIdleHint');
    idle.on = on; idle.parked = parked;
    layer.classList.toggle('off', !on);
    layer.classList.toggle('talking', on && parked);
    document.querySelector('.mcStage').classList.toggle('off', on);
    document.querySelector('.lowerThird').classList.toggle('off', on && !parked);
    kickIdle();
    clearTimeout(idle.hintTimer);
    hintEl.classList.remove('on');
    if (on && hint) idle.hintTimer = setTimeout(() => { hintEl.textContent = hint; hintEl.classList.add('on'); }, hint.startsWith('Jay Dee') ? 300 : 4000);
  }

  // ---- facts ----
  let cornerFacts = [], cornerIdx = 0, cornerTimer = null;
  function showFact() {
    const el = document.getElementById('factoid');
    if (!facts.length) { el.textContent = ''; return; }
    el.classList.add('fade');
    setTimeout(() => { el.textContent = facts[factIdx % facts.length].text; factIdx++; el.classList.remove('fade'); }, 600);
  }
  function showCorner() {
    const card = document.getElementById('mcCorner');
    if (!cornerFacts.length) { card.hidden = true; return; }
    const f = cornerFacts[cornerIdx % cornerFacts.length]; cornerIdx++;
    card.classList.add('fade');
    setTimeout(() => {
      document.getElementById('mcCornerKind').textContent = f.kind === 'album' ? 'ABOUT THE ALBUM' : f.kind === 'artist' ? 'ABOUT THE ARTIST' : 'DID YOU KNOW';
      document.getElementById('mcCornerText').textContent = f.text;
      card.hidden = false; card.classList.remove('fade');
    }, 600);
  }
  function splitFacts(all) {
    const corner = all.filter((f) => f.kind === 'artist' || f.kind === 'album');
    let lower = all.filter((f) => f.kind !== 'artist' && f.kind !== 'album');
    if (!lower.length) lower = corner.slice(0, 2);
    return { corner, lower };
  }

  // ---- presenting whatever the engine is playing ----
  async function present(item) {
    current = item;
    const title = document.getElementById('mcTitle'), artist = document.getElementById('mcArtist'), album = document.getElementById('mcAlbum'), eyebrow = document.getElementById('mcEyebrow');
    clearInterval(factTimer); clearInterval(bgTimer); clearInterval(cornerTimer);
    renderFeedback(item);
    if (!item) { facts = []; cornerFacts = []; showFact(); showCorner(); setIdle(true, 'Type a theme above and press Go'); return; }
    if (item.kind === 'patter') {
      setIdle(true, null, { parked: true });
      document.getElementById('mcCover').hidden = true;
      facts = [{ text: item.patter_text || item.text || item.why || '' }]; factIdx = 0; showFact();
      return;
    }
    setIdle(false);
    const sess = JayDee.getState()?.session; const call = (sess?.station || 'JAY DEE').toUpperCase();
    eyebrow.textContent = sess?.mode === 'albums' ? `${call} · TV · ALBUM MODE` : `${call} · TV`;
    title.textContent = item.title; artist.textContent = item.artist || ''; album.textContent = `${item.album || ''}${item.year ? ` · ${item.year}` : ''}`;
    const cover = document.getElementById('mcCover');
    cover.hidden = true;
    const art = item.album_id ? `/art/album/${item.album_id}` : null;
    const artistArt = item.artist_id ? `/art/artist/${item.artist_id}` : null;
    const showCover = (url) => { if (!url) return; const img = new Image(); img.onload = () => { if (current === item) { cover.src = url; cover.hidden = false; } }; img.src = url; };
    showCover(art);
    bgImages = []; bgIdx = 0;
    Promise.all([prepBg(artistArt), prepBg(art)]).then(([a, c]) => {
      if (current !== item) return;
      bgImages = [a, c].filter(Boolean);
      if (!c && a) showCover(artistArt);
      if (bgImages.length) setBg(bgImages[0]);
    });
    bgTimer = setInterval(rotateBg, 25000);
    let all = [];
    try { const f = await api.factoids(item.track_id); all = f.facts || []; } catch { all = []; }
    if (current !== item) return;
    const { corner, lower } = splitFacts(all);
    facts = lower; factIdx = 0; showFact();
    factTimer = setInterval(showFact, 22000);
    cornerFacts = corner; cornerIdx = 0; showCorner();
    cornerTimer = setInterval(showCorner, 35000);
  }
  function renderUpNext(state) {
    const tracks = (state?.upcoming || []).filter((x) => x.kind === 'track');
    const nowAlbum = state?.nowPlaying?.album_id || null;
    const el = document.getElementById('mcUpNext');
    if (state?.session?.mode === 'albums') {
      const left = tracks.filter((x) => x.album_id === nowAlbum).length;
      const nextAlbum = tracks.find((x) => x.album_id !== nowAlbum);
      el.innerHTML = [left ? `${left} MORE FROM THIS ALBUM` : '', nextAlbum ? `NEXT ALBUM · ${esc(nextAlbum.artist || '')} — ${esc(nextAlbum.album || '')}` : ''].filter(Boolean).join('  ·  ');
      return;
    }
    const up = tracks.slice(0, 2);
    el.innerHTML = up.length ? 'UP NEXT · ' + up.map((x) => `${esc(x.artist || '')} — ${esc(x.title)}`).join('  ·  ') : '';
  }

  // ---- thumbs: up / down (toggle) / double-click down = block the artist (skull, click again to undo) ----
  function renderFeedback(item) {
    const up = document.getElementById('fbUp'), down = document.getElementById('fbDown');
    const show = !!(item && item.kind === 'track');
    up.hidden = down.hidden = !show;
    if (!show) return;
    const fb = item.feedback || {};
    up.classList.toggle('on', fb.track === 'up');
    down.classList.toggle('on', fb.track === 'down');
    down.classList.toggle('skull', !!fb.artist_blocked);
    down.title = fb.artist_blocked ? `${item.artist} is blocked. Click to unblock` : fb.track === 'down' ? 'Blocked. Click to undo; double-click to block the whole artist' : 'Never play this again (double-click: block the artist)';
    up.title = fb.track === 'up' ? 'Liked. Click to undo' : 'Play more like this';
  }
  let downClickTimer = null;
  async function feedback(action) {
    if (!current || current.kind !== 'track') return;
    const r = await api.feedback(current.track_id, action);
    current.feedback = r.feedback; renderFeedback(current);
    JayDee.setStatus(r.message || 'noted', '');
  }
  document.getElementById('fbUp').addEventListener('click', () => feedback(current?.feedback?.track === 'up' ? 'clear' : 'up'));
  document.getElementById('fbDown').addEventListener('click', () => {
    clearTimeout(downClickTimer);
    downClickTimer = setTimeout(() => { const fb = current?.feedback || {}; feedback(fb.artist_blocked ? 'unblock_artist' : fb.track === 'down' ? 'clear' : 'down'); }, 260);
  });
  document.getElementById('fbDown').addEventListener('dblclick', () => { clearTimeout(downClickTimer); feedback(current?.feedback?.artist_blocked ? 'unblock_artist' : 'block_artist'); });

  // ---- transport + watchdog on the shared engine ----
  const engine = () => JayDee.engine;
  function showPlay(hint) { document.getElementById('mcPlayHint').textContent = hint || 'Press play'; document.getElementById('mcPlayOverlay').hidden = false; }
  function hidePlay() { document.getElementById('mcPlayOverlay').hidden = true; }
  let notPlayingSince = null;
  // TV mode on a phone or tablet is a display: keep the screen awake while music plays (released on pause / mode switch).
  let wakeLock = null, wakeBusy = false;
  async function keepAwake(on) {
    try {
      if (!('wakeLock' in navigator) || wakeBusy) return;
      if (on && !wakeLock && !document.hidden) { wakeBusy = true; wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      else if (!on && wakeLock) { const l = wakeLock; wakeLock = null; await l.release(); }
    } catch { wakeLock = null; } finally { wakeBusy = false; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && document.body.dataset.mode === 'mc' && engine()?.isPlaying()) keepAwake(true); });
  function watchdog(state) {
    if (!engine()) return;
    const live = state?.session && ['ready', 'playing', 'refilling'].includes(state.session.status);
    const playing = engine().isPlaying();
    document.body.classList.toggle('paused', !playing);
    keepAwake(playing);
    document.getElementById('mcStart').hidden = playing; document.getElementById('mcPause').hidden = !playing;
    if (!live) { hidePlay(); notPlayingSince = null; return; }
    if (engine().isPassive()) { showPlay('Another player is driving this show. Take over here'); return; }
    if (playing) { hidePlay(); notPlayingSince = null; return; }
    notPlayingSince ??= Date.now();
    if (engine().audioBlocked?.()) { showPlay('Click to enable audio'); return; }
    if (state?.session?.status === 'ready' || Date.now() - notPlayingSince > 3500) showPlay('Press play');
  }

  function sync(state) {
    if (document.body.dataset.mode !== 'mc') return;
    renderUpNext(state);
    document.getElementById('mcSkipAlbum').hidden = state?.session?.mode !== 'albums';
    // Webamp's loaded track is the truth; the server's nowPlaying can lag a skip by a poll or two.
    let now = state?.nowPlaying || null;
    const engineId = engine().currentItemId?.();
    if (engineId && now?.id !== engineId) {
      const hit = [...(state?.upcoming || []), ...(state?.history || [])].find((x) => x.id === engineId);
      if (hit) now = hit;
    }
    if ((now?.id || null) !== (current?.id || null)) present(now);
    else if (now && current) { current.feedback = now.feedback; renderFeedback(current); }
    if (!now && (state?.session?.status === 'planning' || (state?.planning && !state.session))) setIdle(true, 'Jay Dee is planning your set…');
    else if (!now && state?.session?.status === 'ready') setIdle(true, 'Your set is ready');
    watchdog(state);
  }

  modes.mc = {
    enter(state) { current = undefined; setIdle(true, null); sync(state || JayDee.getState()); },
    leave() { clearInterval(factTimer); clearInterval(bgTimer); clearInterval(cornerTimer); idle.on = false; hidePlay(); document.body.classList.remove('paused'); keepAwake(false); },
    onNewSession() { current = undefined; setIdle(true, 'Jay Dee is planning your set…'); },
  };

  document.getElementById('mcPlayBig').addEventListener('click', () => { hidePlay(); engine().isPassive() ? engine().takeover() : engine().play(); });
  document.getElementById('mcStart').addEventListener('click', () => { engine().isPassive() ? engine().takeover() : engine().play(); });
  document.getElementById('mcPause').addEventListener('click', () => engine().pause());
  document.getElementById('mcSkip').addEventListener('click', () => engine().next());
  document.getElementById('mcSkipAlbum').addEventListener('click', async () => {
    try {
      const r = await api.skipAlbum();
      if (r.error) { JayDee.setStatus(r.error, 'error'); return; }
      engine().prune?.(r.skipped || []);
      engine().next();
      if (r.refilling) JayDee.setStatus('next album coming up…', 'busy');
    } catch (e) { JayDee.setStatus(e.message, 'error'); }
  });
  // album mode checkbox (remembered per browser)
  const albumBox = document.getElementById('albumMode');
  try { albumBox.checked = localStorage.getItem('jaydee.albumMode') === '1'; } catch {}
  albumBox.addEventListener('change', () => { try { localStorage.setItem('jaydee.albumMode', albumBox.checked ? '1' : '0'); } catch {} });
  document.getElementById('mcStop').addEventListener('click', async () => { engine().stop(); await api.stop(); present(null); });
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.mode !== 'mc' || e.target.matches('input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); engine().isPlaying() ? engine().pause() : engine().play(); }
    else if (e.key === 'n' || e.key === 'N') engine().next();
    else if (e.key === 'p' || e.key === 'P') engine().play();
  });

  onState(sync);
  JayDee.onTrackChange?.((state) => sync(state));
  setInterval(() => { if (document.body.dataset.mode === 'mc') watchdog(JayDee.getState()); }, 1500);
})();
