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

  const report = (msg) => { try { fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, msg: String(msg).slice(0, 500), mode: document.body.dataset.mode }) }); } catch {} };
  window.addEventListener('error', (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${e.reason?.message || e.reason}`));

  function boot() {
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
