// Signing in through http://user:pass@host/ leaves the credentials in the document's base URL, and Chrome then
// refuses every app-relative fetch() from that page ("Request cannot be constructed from a URL that includes
// credentials") — which surfaces as the whole station looking unreachable. location.href hides the credentials, so
// the page cannot even tell; document.baseURI still carries them. Resolving "/api/..." against the origin instead
// sidesteps it for every call site in every script, so this runs before any of them.
(() => {
  const origin = location.origin;
  const f = window.fetch.bind(window);
  window.fetch = (input, init) => f(typeof input === 'string' && input.startsWith('/') ? origin + input : input, init);
})();

// Low effects: blurs are free on a GPU and ruinous without one. Chrome falls back to software rendering on plenty
// of machines (no compatible GPU, a driver on the blocklist, --disable-gpu, some VMs and remote sessions), and
// there every backdrop-filter is a CPU blur on every composite — enough to drop frames in unrelated tabs. Detect
// that up front and drop the effects; the setting is a plain switch, so a wrong guess either way is one click.
(() => {
  const KEY = 'jaydee.lowfx';
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  const softwareRendered = () => {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return true; // no WebGL at all: assume there is no GPU to lean on
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      return /swiftshader|llvmpipe|software|basic render|microsoft basic|mesa offscreen/i.test(r);
    } catch { return false; }
  };
  const on = saved === null ? softwareRendered() : saved === '1';
  document.documentElement.classList.toggle('lowfx-pending', on); // body may not exist yet
  window.JayDeeLowFx = {
    get: () => document.body.classList.contains('lowfx'),
    set(v) {
      document.body.classList.toggle('lowfx', !!v);
      try { localStorage.setItem(KEY, v ? '1' : '0'); } catch {}
    },
    auto: saved === null,
  };
})();

// Shared station client: theme submission, state polling, mode switching. Modes register with JayDee.modes.
window.JayDee = (() => {
  // Each browser tab identifies itself so only one player drives the shared show; others watch.
  let clientId = null;
  try { clientId = sessionStorage.getItem('jaydee.client'); } catch {}
  if (!clientId) { clientId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); try { sessionStorage.setItem('jaydee.client', clientId); } catch {} }
  const api = {
    state: () => fetch('/api/station/state').then((r) => r.json()),
    queue: () => fetch('/api/station/queue').then((r) => r.json()),
    theme: (theme, length, mode = 'tracks') => fetch('/api/dj/theme', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme, length, mode }) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; }),
    advance: (itemId, reason, nextItemId, takeover = false, shuffle = false) => fetch('/api/station/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId, reason, nextItemId, clientId, takeover, shuffle }) })
      .then(async (r) => { const j = await r.json(); if (r.status === 409) throw Object.assign(new Error(j.error || 'another player is driving this show'), { controller: true, state: j.state }); return j; }),
    stop: () => fetch('/api/station/stop', { method: 'POST' }).then((r) => r.json()),
    factoids: (trackId) => fetch(`/api/factoids/${trackId}`).then((r) => r.json()),
    skipAlbum: () => fetch('/api/station/skip-album', { method: 'POST' }).then((r) => r.json()),
    sets: () => fetch('/api/sets').then((r) => r.json()),
    saveSet: (name) => fetch('/api/sets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; }),
    playSet: (id) => fetch(`/api/sets/${id}/play`, { method: 'POST' }).then((r) => r.json()),
    deleteSet: (id) => fetch(`/api/sets/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    feedback: (track_id, action) => fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ track_id, action }) }).then((r) => r.json()),
    callIn: (message) => fetch('/api/dj/callin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; }),
    dbInfo: () => fetch('/api/admin/db').then((r) => r.json()),
    publishState: () => fetch('/api/admin/publish').then((r) => r.json()),
    publish: () => fetch('/api/admin/publish', { method: 'POST' }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; }),
    deleteBackup: (name) => fetch(`/api/admin/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.json()),
    // XHR rather than fetch: a few hundred megabytes deserves a progress bar, and fetch cannot report upload progress.
    uploadDb: (file, { dryRun = false, onProgress = () => {} } = {}) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/admin/restore${dryRun ? '?dry_run=1' : ''}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let j = {};
        try { j = JSON.parse(xhr.responseText); } catch { /* server said something that was not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(j);
        else reject(new Error(j.error || `${xhr.status} ${xhr.statusText}`));
      };
      xhr.onerror = () => reject(new Error('network error during upload'));
      xhr.onabort = () => reject(new Error('upload cancelled'));
      xhr.send(file);
    }),
  };

  const modes = {};
  let current = null;
  let lastState = null;
  const listeners = new Set();
  const trackListeners = new Set();
  const statusEl = () => document.getElementById('status');

  // The station is named after the show: the DJ picks a call sign for each request.
  let brandShown = null;
  function renderBrand(sess) {
    const name = sess && ['ready', 'playing', 'refilling', 'planning'].includes(sess.status) ? (sess.station || null) : null;
    if (name === brandShown) return;
    brandShown = name;
    document.getElementById('brandName').textContent = name ? name.toUpperCase() : 'JAY DEE';
    document.getElementById('brandSub').textContent = name ? 'with Jay Dee' : 'radio';
    document.title = name ? `${name} · Jay Dee` : 'Jay Dee Radio';
  }
  function setStatus(text, cls = '') { const el = statusEl(); el.textContent = text; el.className = `status ${cls}`; }

  // DJ booth: shows the planning back-and-forth while a set is being built; auto-hides ~8 s after it finishes.
  let boothHiddenBy = null; let boothDoneAt = null;
  function renderBooth(s) {
    const booth = document.getElementById('booth');
    const steps = s.progress || [];
    const busy = s.planning || s.session?.status === 'planning' || s.session?.status === 'refilling';
    if (!steps.length || boothHiddenBy === steps[0]?.at) { booth.hidden = true; return; }
    if (busy) boothDoneAt = null; else if (!boothDoneAt) boothDoneAt = Date.now();
    if (!busy && boothDoneAt && Date.now() - boothDoneAt > 8000) { booth.hidden = true; return; }
    booth.hidden = false;
    const t0 = Date.parse(steps[0].at);
    const now = Date.now();
    document.getElementById('boothElapsed').textContent = busy ? `${Math.round((now - t0) / 1000)}s` : `done in ${Math.round((Date.parse(steps.at(-1).at) - t0) / 1000)}s`;
    document.getElementById('boothSteps').innerHTML = steps.map((st, i) => {
      const active = !st.done && busy && i === steps.length - 1;
      const u = st.usage; const cost = u?.cost != null ? ` · $${Number(u.cost).toFixed(3)}` : '';
      const meta = u ? `${u.prompt_tokens ?? '?'}→${u.completion_tokens ?? '?'} tok${cost}` : '';
      const sub = st.queries ? st.queries.map((q) => `“${q}”`).join(' · ') : st.picks ? st.picks.slice(0, 10).join(' · ') : '';
      return `<li class="${st.error ? 'error' : st.done ? 'done' : active ? 'active' : ''}"><span class="ico"></span><span>${esc(st.text)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span><span class="meta">${esc(meta)}</span></li>`;
    }).join('');
  }

  let lastCostAt = null;
  function renderCost(s) {
    const c = s.cost; if (!c) return;
    const $ = (v, d = 3) => `$${Number(v || 0).toFixed(d)}`;
    const box = document.getElementById('cost');
    const k = c.key; // authoritative, from OpenRouter's key endpoint (UTC day); local log is per-call detail
    box.querySelector('.costShow').textContent = $(c.session);
    box.querySelector('.costDay').textContent = (k ? `today ${$(k.daily, 2)} · key ${$(k.usage, 2)}` : `today ${$(c.today, 2)}`) + (c.cap ? ` · cap ${$(c.cap, 2)}` : '');
    document.getElementById('costShowV').textContent = $(c.session); document.getElementById('costShowC').textContent = `${c.session_calls} call${c.session_calls === 1 ? '' : 's'} (local log)`;
    document.getElementById('costDayV').textContent = k ? $(k.daily, 2) : $(c.today, 2); document.getElementById('costDayC').textContent = k ? `OpenRouter, UTC day · local log ${$(c.today, 2)}` : `${c.today_calls} calls (local log)`;
    document.getElementById('costAllV').textContent = k ? $(k.usage, 2) : $(c.all, 2);
    document.getElementById('costAllC').textContent = k ? `of ${$(k.limit ?? 0, 0)} ${k.reset || ''} limit · ${$(k.remaining, 2)} left` : 'local log only';
    if (c.last) { document.getElementById('costLastV').textContent = $(c.last.cost, 4); document.getElementById('costLastC').textContent = `${c.last.purpose} · ${(c.last.model || '').split('/').pop()}`; }
    if (c.last && c.last.at !== lastCostAt) { if (lastCostAt) { box.classList.add('tick'); setTimeout(() => box.classList.remove('tick'), 1500); } lastCostAt = c.last.at; }
  }

  async function poll() {
    try {
      const s = await api.state();
      lastState = s;
      renderBooth(s);
      renderCost(s);
      const sess = s.session;
      renderBrand(sess);
      if (!sess) setStatus(s.planning ? 'planning…' : 'idle', s.planning ? 'busy' : '');
      else if (sess.status === 'failed') setStatus(`DJ failed: ${sess.error || 'unknown'}`, 'error');
      else setStatus(`${sess.status === 'planning' ? 'planning' : s.planning ? 'playing · refilling' : sess.status}${sess.mode === 'albums' ? ' · albums' : ''} · ${sess.title || sess.theme}`, s.planning || sess.status === 'planning' ? 'busy' : '');
      for (const fn of listeners) { try { fn(s); } catch (e) { console.error(e); } }
    } catch (e) { setStatus('server unreachable', 'error'); }
  }

  function switchMode(name) {
    if (name === current) return;
    if (current) modes[current]?.leave?.();
    current = name;
    document.body.dataset.mode = name;
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== name;
    for (const b of document.querySelectorAll('.mode')) b.classList.toggle('active', b.dataset.mode === name);
    try { localStorage.setItem('jaydee.mode', name); } catch {}
    modes[name]?.enter?.(lastState);
  }

  // Reporting must never be able to fail in a way that produces another report: a rejected fetch here raises
  // unhandledrejection, which calls report again. That loop once put 28k errors in a console in a few seconds.
  let reporting = false;
  let reportsLeft = 20; // and never flood the server log either
  const report = (msg) => {
    if (reporting || reportsLeft <= 0) return;
    reporting = true; reportsLeft--;
    try {
      fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, msg: String(msg).slice(0, 500), mode: document.body.dataset.mode }) })
        .catch(() => {})
        .finally(() => { reporting = false; });
    } catch { reporting = false; }
  };
  window.addEventListener('error', (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${e.reason?.message || e.reason}`));

  // ---- Catalog database panel: upload the workstation's jaydee.sqlite onto this server ----
  const dbUi = {};
  let picked = null;      // the File the user chose
  let checked = false;    // a dry run has passed for that exact file

  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  const countLine = (c) => `${c.tracks.toLocaleString()} tracks · ${c.albums.toLocaleString()} albums · ${c.artists.toLocaleString()} artists · ${c.embeddings.toLocaleString()} embeddings`;

  async function refreshDb() {
    const info = await api.dbInfo();
    dbUi.counts.textContent = countLine(info.counts);
    dbUi.file.textContent = info.file ? `${mb(info.file.bytes)}, updated ${new Date(info.file.modified).toLocaleString()}` : 'missing';
    const eph = info.storage && info.storage.persistent === false;
    dbUi.storage.hidden = !eph;
    if (eph) dbUi.storage.textContent = `${info.storage.dir} is not a mounted volume: this station's data is thrown away on the next redeploy. Add a volume with that destination path.`;
    dbUi.restore.title = info.restore_enabled ? '' : 'Set STATION_PASSWORD (or use the station from localhost) to enable restore';
    if (!info.restore_enabled) { dbUi.msg.textContent = 'Restore is disabled until STATION_PASSWORD is set, so a public URL cannot be used to overwrite your catalog.'; dbUi.msg.className = 'dbMsg warn'; }
    dbUi.backups.innerHTML = '';
    for (const b of info.backups) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="setName">${b.name}</span><span class="setMeta">${mb(b.bytes)}</span>`;
      const dl = document.createElement('a'); dl.className = 'mini'; dl.textContent = 'Download'; dl.href = `/api/admin/backups/${encodeURIComponent(b.name)}`;
      const del = document.createElement('button'); del.className = 'mini'; del.textContent = 'Delete';
      del.addEventListener('click', async () => { if (confirm(`Delete ${b.name}? This cannot be undone.`)) { await api.deleteBackup(b.name); refreshDb(); } });
      li.append(dl, del);
      dbUi.backups.append(li);
    }
    if (!info.backups.length) dbUi.backups.innerHTML = '<li class="dim">none yet — the first restore keeps a copy here</li>';
  }

  function setPicked(file) {
    picked = file; checked = false;
    dbUi.restore.disabled = true;
    dbUi.check.hidden = true; dbUi.bar.hidden = true; dbUi.msg.textContent = '';
    dbUi.picked.hidden = !file;
    if (file) dbUi.picked.textContent = `${file.name} · ${mb(file.size)} — checking…`;
    if (file) verifyPicked();
  }

  // Always dry-run first: the file goes up, the server reports what is inside it, and only then does Replace unlock.
  async function verifyPicked() {
    const file = picked;
    dbUi.bar.hidden = false; dbUi.barText.textContent = 'checking file…';
    try {
      const out = await api.uploadDb(file, { dryRun: true, onProgress: (p) => setBar(p, 'uploading for check') });
      if (picked !== file) return; // user changed their mind mid-upload
      checked = true;
      dbUi.picked.textContent = `${file.name} · ${mb(file.size)}`;
      dbUi.check.hidden = false;
      dbUi.check.innerHTML = `<b>This file holds</b> ${countLine(out.upload)}<br><b>Replacing</b> ${countLine(out.current)}`;
      dbUi.restore.disabled = false;
      setBar(1, 'checked — ready to replace');
    } catch (e) {
      if (picked !== file) return;
      dbUi.bar.hidden = true;
      dbUi.msg.textContent = e.message; dbUi.msg.className = 'dbMsg error';
      dbUi.picked.textContent = `${file.name} · ${mb(file.size)} — rejected`;
    }
  }

  function setBar(frac, label) {
    dbUi.bar.hidden = false;
    dbUi.barFill.style.width = `${Math.round(frac * 100)}%`;
    dbUi.barText.textContent = `${label} ${Math.round(frac * 100)}%`;
  }

  async function doRestore() {
    if (!picked || !checked) return;
    if (!confirm('Replace the catalog this station is serving?\n\nThe current database is kept on the server and listed under "Kept databases", so you can roll back. Any show playing right now will stop.')) return;
    dbUi.restore.disabled = true;
    dbUi.msg.textContent = ''; dbUi.msg.className = 'dbMsg';
    try {
      const out = await api.uploadDb(picked, { onProgress: (p) => setBar(p, 'uploading') });
      // clear the picker first: setPicked() resets the message area, which would wipe the result we are about to show
      setPicked(null);
      dbUi.fileInput.value = '';
      setBar(1, 'done');
      dbUi.msg.className = 'dbMsg ok';
      dbUi.msg.textContent = `Catalog replaced: ${countLine(out.after)}.${out.backup ? ` Previous database kept as ${out.backup}.` : ''}`;
      await refreshDb();
      poll();
    } catch (e) {
      dbUi.bar.hidden = true;
      dbUi.msg.className = 'dbMsg error';
      dbUi.msg.textContent = e.message;
      dbUi.restore.disabled = false;
    }
  }

  // ---- Publishing: send this machine's catalog to the station it feeds ----
  let pubTimer = null;

  function renderPublish(s) {
    const block = dbUi.publish;
    block.hidden = !s.configured;
    if (!s.configured) return;
    const rem = s.remote || {};
    dbUi.remoteUrl.textContent = rem.url || '—';
    dbUi.remoteCounts.textContent = rem.error ? rem.error : (rem.counts ? countLine(rem.counts) : '…');
    dbUi.remoteCounts.className = rem.error ? 'warnText' : '';
    // The mistake worth catching before a publish: the server has no volume, so whatever we send dies on redeploy.
    const eph = rem.storage && rem.storage.persistent === false;
    dbUi.remoteStorage.hidden = !eph;
    if (eph) dbUi.remoteStorage.textContent = `Heads up: ${rem.storage.dir} on the server is not a mounted volume, so anything published there is lost on the next redeploy. Add a volume with that destination path first.`;

    const j = s.job;
    const running = j && j.state === 'running';
    dbUi.publishBtn.disabled = running || Boolean(rem.error) || rem.reachable === false;
    dbUi.publishBtn.textContent = running ? 'Publishing…' : 'Publish this catalog';
    if (!j) { dbUi.pubBar.hidden = true; return; }

    dbUi.pubBar.hidden = false;
    const frac = j.total ? j.sent / j.total : 0;
    dbUi.pubBarFill.style.width = `${Math.round((j.state === 'done' ? 1 : frac) * 100)}%`;
    dbUi.pubBarText.textContent = j.state === 'done' ? 'published' : `${j.note} ${j.total ? `${Math.round(frac * 100)}%` : ''}`;
    if (j.state === 'failed') { dbUi.pubMsg.className = 'dbMsg error'; dbUi.pubMsg.textContent = j.error; dbUi.pubBar.hidden = true; }
    else if (j.state === 'done') {
      dbUi.pubMsg.className = 'dbMsg ok';
      const a = j.result?.after;
      dbUi.pubMsg.textContent = `Server updated: ${a ? `${countLine(a)}.` : ''}${j.result?.backup ? ` Its previous database is kept as ${j.result.backup}.` : ''}`;
    }
  }

  async function pollPublish() {
    try { const s = await api.publishState(); renderPublish(s); if (s.job?.state === 'running') return; } catch { /* panel may be closed */ }
    clearInterval(pubTimer); pubTimer = null;
  }

  async function refreshPublish() {
    try { renderPublish(await api.publishState()); } catch { /* leave the block as it was */ }
  }

  async function doPublish() {
    dbUi.pubMsg.textContent = ''; dbUi.pubMsg.className = 'dbMsg';
    dbUi.publishBtn.disabled = true;
    try {
      await api.publish();
      if (!pubTimer) pubTimer = setInterval(pollPublish, 700);
      pollPublish();
    } catch (e) {
      dbUi.pubMsg.className = 'dbMsg error'; dbUi.pubMsg.textContent = e.message;
      dbUi.publishBtn.disabled = false;
    }
  }

  function wireDbPanel() {
    const id = (x) => document.getElementById(x);
    Object.assign(dbUi, {
      panel: id('dbPanel'), counts: id('dbCounts'), file: id('dbFile'), picked: id('dbPicked'), check: id('dbCheck'),
      bar: id('dbBar'), barFill: id('dbBarFill'), barText: id('dbBarText'), restore: id('dbRestore'), msg: id('dbMsg'),
      backups: id('dbBackups'), fileInput: id('dbFileInput'), drop: id('dbDrop'),
      storage: id('dbStorage'), remoteStorage: id('dbRemoteStorage'),
      publish: id('dbPublish'), remoteUrl: id('dbRemoteUrl'), remoteCounts: id('dbRemoteCounts'),
      pubBar: id('dbPubBar'), pubBarFill: id('dbPubBarFill'), pubBarText: id('dbPubBarText'),
      publishBtn: id('dbPublishBtn'), pubMsg: id('dbPubMsg'),
    });
    id('dbBtn').addEventListener('click', () => {
      dbUi.panel.hidden = !dbUi.panel.hidden;
      if (!dbUi.panel.hidden) {
        refreshDb().catch((e) => { dbUi.msg.textContent = e.message; dbUi.msg.className = 'dbMsg error'; });
        refreshPublish();
      }
    });
    dbUi.publishBtn.addEventListener('click', doPublish);
    id('dbClose').addEventListener('click', () => { dbUi.panel.hidden = true; });
    id('dbPick').addEventListener('click', () => dbUi.fileInput.click());
    dbUi.fileInput.addEventListener('change', () => setPicked(dbUi.fileInput.files[0] || null));
    dbUi.restore.addEventListener('click', doRestore);
    for (const ev of ['dragenter', 'dragover']) dbUi.drop.addEventListener(ev, (e) => { e.preventDefault(); dbUi.drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) dbUi.drop.addEventListener(ev, (e) => { e.preventDefault(); dbUi.drop.classList.remove('over'); });
    dbUi.drop.addEventListener('drop', (e) => setPicked(e.dataTransfer.files[0] || null));
  }

  function boot() {
    // carry the pre-body decision onto <body>, where the rules hang, and wire the switch
    if (document.documentElement.classList.contains('lowfx-pending')) document.body.classList.add('lowfx');
    const fx = document.getElementById('lowFx');
    if (fx) {
      fx.checked = document.body.classList.contains('lowfx');
      fx.addEventListener('change', () => window.JayDeeLowFx.set(fx.checked));
    }
    // A hidden tab still composites; stop paying for effects nobody is looking at.
    const bg = () => document.body.classList.toggle('bgtab', document.hidden);
    document.addEventListener('visibilitychange', bg); bg();
    wireDbPanel();
    document.getElementById('themeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const theme = document.getElementById('themeInput').value.trim();
      if (!theme) return;
      setStatus('asking the DJ…', 'busy');
      boothHiddenBy = null; boothDoneAt = null;
      const albumMode = !!document.getElementById('albumMode')?.checked;
      try { await api.theme(theme, 10, albumMode ? 'albums' : 'tracks'); modes[current]?.onNewSession?.(); } catch (err) { setStatus(err.message, 'error'); }
      poll();
    });
    document.getElementById('cost').addEventListener('click', () => { const p = document.getElementById('costPanel'); p.hidden = !p.hidden; });
    document.addEventListener('click', (e) => { if (!e.target.closest('#cost') && !e.target.closest('#costPanel')) document.getElementById('costPanel').hidden = true; });
    document.getElementById('boothClose').addEventListener('click', () => { boothHiddenBy = (lastState?.progress || [])[0]?.at || 'x'; document.getElementById('booth').hidden = true; });
    for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => switchMode(b.dataset.mode));
    // First visit on a phone lands in TV mode (big art, thumb-sized transport); Winamp stays a tap away.
    let saved = null;
    try { saved = localStorage.getItem('jaydee.mode'); } catch {}
    if (!saved) saved = window.matchMedia('(max-width: 700px)').matches ? 'mc' : 'radio';
    switchMode(saved);
    poll();
    // poll faster while the DJ is planning so the booth feels live
    const tick = () => { const busy = lastState?.planning || ['planning', 'refilling'].includes(lastState?.session?.status); setTimeout(() => { poll().finally(tick); }, busy ? 1500 : 4000); };
    tick();
  }

  const fmt = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const isDriver = (state) => !state?.controller || state.controller.clientId === clientId || state.controller.idleMs > 90_000;
  const emitTrackChange = (state) => { if (state) lastState = state; for (const fn of trackListeners) { try { fn(lastState); } catch (e) { console.error(e); } } };
  return { api, modes, boot, switchMode, onState: (fn) => listeners.add(fn), onTrackChange: (fn) => trackListeners.add(fn), emitTrackChange, getState: () => lastState, setStatus, fmt, esc, clientId, isDriver };
})();
