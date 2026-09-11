// Radio Mode backdrop: Geiss-style feedback visualizer fused with the current album art.
// Each frame: previous frame is re-drawn zoomed/rotated/wave-warped (feedback trails), the blurred cover
// is bled into the buffer so it gets swirled too, then a waveform ribbon + spectrum blobs are painted on top.
JayDee.viz = (() => {
  let canvas, ctx, off, offCtx, raf = null, running = false;
  let getAnalyser = () => null;
  let isPlaying = () => true;
  let idleSince = null;
  let freq = null, wave = null;
  let palette = [[127, 214, 164], [245, 196, 107], [120, 140, 255], [255, 120, 160]];
  let artToggle = false, currentArt = null, artImg = null, artAlpha = 0;
  let t0 = performance.now();
  let beatEnv = 0, lastBeat = 0, hue = 0;
  const STRIPS = 28;
  const blobs = Array.from({ length: 5 }, (_, i) => ({ fx: 0.09 + i * 0.031, fy: 0.071 + i * 0.027, px: i * 1.7, py: i * 0.9, band: i % 4 }));

  function resize() {
    if (!canvas) return;
    const r = canvas.parentElement.getBoundingClientRect();
    const scale = 0.6;
    canvas.width = Math.max(200, Math.round(r.width * scale));
    canvas.height = Math.max(150, Math.round(r.height * scale));
    off.width = canvas.width; off.height = canvas.height;
  }

  function audio() {
    const an = getAnalyser();
    if (!an) return null;
    if (!freq || freq.length !== an.frequencyBinCount) { freq = new Uint8Array(an.frequencyBinCount); wave = new Uint8Array(an.fftSize); }
    an.getByteFrequencyData(freq);
    an.getByteTimeDomainData(wave);
    const n = freq.length;
    const band = (a, b) => { let s = 0; const lo = Math.floor(n * a), hi = Math.max(lo + 1, Math.floor(n * b)); for (let i = lo; i < hi; i++) s += freq[i]; return s / (hi - lo) / 255; };
    return { bass: band(0.01, 0.06), lowMid: band(0.06, 0.15), mid: band(0.15, 0.35), high: band(0.35, 0.7), wave };
  }

  function fakeAudio(t) {
    const w = new Uint8Array(512);
    for (let i = 0; i < w.length; i++) w[i] = 128 + Math.sin(i / 14 + t * 2) * 30 * (0.6 + 0.4 * Math.sin(t * 0.7));
    return { bass: 0.3 + 0.15 * Math.sin(t * 0.9), lowMid: 0.25, mid: 0.2 + 0.05 * Math.sin(t * 1.3), high: 0.12, wave: w };
  }

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  function frame(now) {
    if (!running) return;
    // sleep while nothing is playing (after a short fade) or the tab is hidden; wake via the 1 s check below
    // sleep when the tab is hidden, the canvas is not on screen (other mode), or nothing is playing
    const visible = !!canvas.offsetParent;
    if (document.hidden || !visible || !isPlaying()) { idleSince ??= now; if (!visible || now - idleSince > 2500) { raf = null; return; } } else idleSince = null;
    raf = requestAnimationFrame(frame);
    const w = canvas.width, h = canvas.height;
    const t = (now - t0) / 1000;
    const sp = audio() || fakeAudio(t);
    const bassHit = sp.bass > 0.58 && now - lastBeat > 240;
    if (bassHit) { lastBeat = now; beatEnv = 1; }
    beatEnv *= 0.92;
    hue = (hue + 0.25 + sp.high * 1.5) % 360;

    // 1. feedback: previous frame -> wave-warped strips, zoomed + rotated, slight fade + hue drift
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.clearRect(0, 0, w, h);
    try { offCtx.filter = `hue-rotate(${(0.4 + sp.mid * 2.5).toFixed(2)}deg)`; } catch {}
    offCtx.drawImage(canvas, 0, 0);
    offCtx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    const zoom = 1.012 + sp.bass * 0.02 + beatEnv * 0.015;
    ctx.rotate(Math.sin(t * 0.11) * 0.006 + 0.002);
    ctx.scale(zoom, zoom);
    ctx.globalAlpha = 0.90 + sp.bass * 0.04; // decay: trails live ~1-2 s, longer on loud passages
    const amp = 2 + sp.bass * 9 + beatEnv * 6;
    const sh = h / STRIPS;
    for (let i = 0; i < STRIPS; i++) {
      const y = i * sh;
      const dx = Math.sin(t * 1.3 + i * 0.45) * amp + Math.sin(t * 0.37 + i * 0.9) * amp * 0.5;
      ctx.drawImage(off, 0, y, w, sh + 1, -w / 2 + dx, -h / 2 + y, w, sh + 1);
    }
    ctx.restore();

    // 2. bleed the album art into the feedback buffer so the cover itself gets swirled
    if (artImg && artImg.complete && artImg.naturalWidth) {
      artAlpha = Math.min(artAlpha + 0.001, 0.02);
      ctx.globalAlpha = artAlpha;
      ctx.globalCompositeOperation = 'lighter';
      const s = Math.max(w / artImg.naturalWidth, h / artImg.naturalHeight) * (1.1 + Math.sin(t * 0.23) * 0.08);
      const dw = artImg.naturalWidth * s, dh = artImg.naturalHeight * s;
      ctx.drawImage(artImg, (w - dw) / 2 + Math.sin(t * 0.19) * w * 0.05, (h - dh) / 2 + Math.cos(t * 0.15) * h * 0.05, dw, dh);
      ctx.globalAlpha = 1;
    }

    // 3. waveform ribbon across the middle (classic Geiss oscilloscope, smeared by the feedback)
    ctx.globalCompositeOperation = 'lighter';
    const wv = sp.wave;
    if (wv && wv.length) {
      const c = palette[Math.floor(hue / 90) % palette.length];
      ctx.strokeStyle = rgba(c, 0.45 + sp.mid * 0.3);
      ctx.lineWidth = 1.4 + sp.bass * 1.5;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(wv.length / w));
      const yMid = h * (0.5 + Math.sin(t * 0.21) * 0.18);
      const gain = h * (0.12 + sp.lowMid * 0.25 + beatEnv * 0.1);
      for (let x = 0, i = 0; x < w; x++, i += step) {
        const v = (wv[i] - 128) / 128;
        const y = yMid + v * gain + Math.sin(x / w * 6.28 + t * 1.7) * 6;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 4. spectrum blobs on lissajous paths
    blobs.forEach((b, i) => {
      const e = [sp.bass, sp.lowMid, sp.mid, sp.high][b.band] || 0;
      const x = w / 2 + Math.sin(t * b.fx * 2 * Math.PI + b.px) * w * 0.38;
      const y = h / 2 + Math.cos(t * b.fy * 2 * Math.PI + b.py) * h * 0.38;
      const r = Math.max(10, (0.12 + e * 0.3 + beatEnv * 0.08) * Math.min(w, h));
      const c = palette[i % palette.length];
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(c, 0.05 + e * 0.14));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    });

    // 5. beat rings + radial spectrum spikes
    if (bassHit) {
      const c = palette[Math.floor(Math.random() * palette.length)];
      ctx.strokeStyle = rgba(c, 0.35); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(w / 2 + (Math.random() - 0.5) * w * 0.4, h / 2 + (Math.random() - 0.5) * h * 0.4, Math.min(w, h) * (0.06 + sp.bass * 0.1), 0, Math.PI * 2); ctx.stroke();
    }
    if (freq) {
      const c = palette[(Math.floor(hue / 90) + 1) % palette.length];
      ctx.strokeStyle = rgba(c, 0.16); ctx.lineWidth = 1;
      const bars = 48, base = Math.min(w, h) * 0.08, cx = w / 2 + Math.sin(t * 0.13) * w * 0.15, cy = h / 2 + Math.cos(t * 0.1) * h * 0.15;
      ctx.beginPath();
      for (let i = 0; i < bars; i++) {
        const v = freq[Math.floor(i / bars * freq.length * 0.5)] / 255;
        const a = (i / bars) * Math.PI * 2 + t * 0.4;
        ctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base);
        ctx.lineTo(cx + Math.cos(a) * (base + v * Math.min(w, h) * 0.22), cy + Math.sin(a) * (base + v * Math.min(w, h) * 0.22));
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function paletteFrom(img) {
    try {
      const c = document.createElement('canvas'); c.width = 24; c.height = 24;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      const buckets = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        if (max < 40 || sat < 0.18) continue;
        const key = `${r >> 5},${g >> 5},${b >> 5}`;
        const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += r; e.g += g; e.b += b; buckets.set(key, e);
      }
      const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 4).map((e) => {
        const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
        const k = 240 / (Math.max(r, g, b) || 1);
        return [Math.round(r * k), Math.round(g * k), Math.round(b * k)];
      });
      if (top.length >= 2) palette = top;
    } catch { /* keep palette */ }
  }

  function setArt(url) {
    if (!url || url === currentArt) return;
    currentArt = url;
    const a = document.getElementById('radioArtA'), b = document.getElementById('radioArtB');
    const img = new Image();
    img.onload = () => {
      paletteFrom(img);
      artImg = img; artAlpha = 0;
      if (!a || !b) return;
      const [show, hide] = artToggle ? [a, b] : [b, a];
      artToggle = !artToggle;
      show.style.backgroundImage = `url("${url}")`;
      show.classList.add('on'); hide.classList.remove('on');
    };
    img.src = url;
  }

  let waker = null;
  function start(canvasEl, analyserGetter, playingGetter) {
    canvas = canvasEl; ctx = canvas.getContext('2d');
    off = document.createElement('canvas'); offCtx = off.getContext('2d');
    getAnalyser = analyserGetter || (() => null);
    isPlaying = playingGetter || (() => true);
    resize();
    window.addEventListener('resize', resize);
    running = true;
    if (!raf) raf = requestAnimationFrame(frame);
    clearInterval(waker);
    waker = setInterval(() => { if (running && !raf && !document.hidden && canvas.offsetParent && isPlaying()) { idleSince = null; raf = requestAnimationFrame(frame); } }, 1000);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf); raf = null;
    clearInterval(waker); waker = null;
    window.removeEventListener('resize', resize);
  }
  return { start, stop, setArt, setAnalyser: (g) => { getAnalyser = g; } };
})();
