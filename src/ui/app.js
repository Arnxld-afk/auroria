'use strict';
const NATIVE = !!(window.chrome && window.chrome.webview);
const hostSend = (m) => { try { window.chrome.webview.postMessage(m); } catch {} };
/* Auroria launcher UI. Talks to the local backend over /api with a per-session token. */

let TOKEN = location.hash.slice(1);
try { if (TOKEN) sessionStorage.setItem('auroria-token', TOKEN); else TOKEN = sessionStorage.getItem('auroria-token') || ''; } catch {}
history.replaceState(null, '', '/');

const S = {
  page: 'home', state: null, pings: {}, mods: null, modsServer: null, modTab: 'installed', modQuery: '',
  updates: null, browse: null, serverTag: 'all', serverQuery: '', skins: null, skinView: 'front',
  uploadVariant: 'CLASSIC', previewId: 'current', settingsTab: 'game', menuOpen: false, busy: {}, launchError: '',
  anim3d: 'walk', autoRotate: false, entering: false, enterUntil: 0,
  browseType: 'mod', browseSort: 'relevance', profileSort: 'played', browseTotal: 0, versions: null,
};
const compact = (n) => { n = Number(n || 0); return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n); };
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'x-auroria-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
let toastTimer;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2600);
}
const ICON = {
  msLogo: '<svg class="ms-logo" viewBox="0 0 21 21" aria-hidden="true"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>',
  play: '<svg viewBox="0 0 14 16" aria-hidden="true"><path d="M1 1l12 7-12 7z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

/* ---------------- skin rendering ---------------- */
const imgCache = new Map();
function loadImage(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });
  imgCache.set(src, p); return p;
}
function defaultSkin() {
  // Paints a full 64x64 Steve-style texture: every face of every box, with per-pixel shading noise like real skins.
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const px = (x, y, col, amt = 0.09) => { const [r, gg, b] = hex(col); const k = 1 + (rnd() - 0.5) * 2 * amt; g.fillStyle = `rgb(${Math.min(255, r * k) | 0},${Math.min(255, gg * k) | 0},${Math.min(255, b * k) | 0})`; g.fillRect(x, y, 1, 1); };
  const SKIN = '#b98260', SKIN_D = '#9c6a48', HAIR = '#3a2816', HAIR_L = '#4a3420', SHIRT = '#009c9c', SHIRT_D = '#008384', PANTS = '#2e2b8a', PANTS_D = '#242172', SHOE = '#5f5f5f';
  // box(u, v, w, h, d, fn(face, x, y) -> colour)
  const box = (u, v, w, h, d, fn) => {
    const faces = { top: [u + d, v, w, d], bottom: [u + d + w, v, w, d], right: [u, v + d, d, h], front: [u + d, v + d, w, h], left: [u + d + w, v + d, d, h], back: [u + d + w + d, v + d, w, h] };
    for (const [face, [fx, fy, fw, fh]] of Object.entries(faces))
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) px(fx + x, fy + y, fn(face, x, y, fw, fh));
  };
  box(0, 0, 8, 8, 8, (f, x, y) => {
    if (f === 'top') return rnd() > 0.85 ? HAIR_L : HAIR;
    if (f === 'bottom') return SKIN_D;
    if (f === 'back') return y < 7 ? (rnd() > 0.85 ? HAIR_L : HAIR) : SKIN_D;
    if (f === 'right' || f === 'left') { const bx = f === 'right' ? x : 7 - x; return y < 2 || (bx < 3 && y < 6) ? HAIR : y === 2 && bx > 5 ? HAIR : SKIN; }
    // front: hair fringe, eyes, nose, mouth
    if (y < 2) return HAIR;
    if (y === 2 && (x === 0 || x === 7)) return HAIR;
    if (y === 4 && x === 1) return '#f2f2f2'; if (y === 4 && x === 2) return '#4a3a8a';
    if (y === 4 && x === 5) return '#4a3a8a'; if (y === 4 && x === 6) return '#f2f2f2';
    if (y === 3 && (x === 1 || x === 2 || x === 5 || x === 6)) return SKIN_D;
    if (y === 5 && (x === 3 || x === 4)) return '#9a5f45';
    if (y === 6 && x >= 2 && x <= 5) return '#6b3e2a';
    if (y === 7 && x >= 1 && x <= 6) return HAIR_L;
    return SKIN;
  });
  box(16, 16, 8, 12, 4, (f, x, y) => {
    if (f === 'bottom') return PANTS_D;
    if (f === 'front' && y === 0 && (x === 3 || x === 4)) return SKIN;
    if (f === 'front' && y === 1 && (x === 3 || x === 4)) return SHIRT_D;
    if (y >= 11) return PANTS_D;
    return f === 'back' || f === 'left' ? SHIRT_D : SHIRT;
  });
  const arm = (f, x, y) => (f === 'top' ? SHIRT : f === 'bottom' ? SKIN_D : y < 4 ? (y === 3 ? SHIRT_D : SHIRT) : (f === 'back' || y === 11 ? SKIN_D : SKIN));
  box(40, 16, 4, 12, 4, arm); box(32, 48, 4, 12, 4, arm);
  const leg = (f, x, y) => (f === 'top' ? PANTS : f === 'bottom' ? SHOE : y >= 10 ? SHOE : f === 'back' || f === 'left' ? PANTS_D : PANTS);
  box(0, 16, 4, 12, 4, leg); box(16, 48, 4, 12, 4, leg);
  return c;
}
let DEFAULT_SKIN = null;
function skinParts(slim, back, legacy) {
  const aw = slim ? 3 : 4;
  // [sx, sy, sw, sh, dx, dy] in 16x32 layout; overlays follow.
  const base = back ? [
    [24, 8, 8, 8, 4, 0], [32, 20, 8, 12, 4, 8],
    legacy ? [52, 20, 4, 12, 12, 8, true] : [44 + aw * 2 - (slim ? 1 : 0) - aw + (slim ? 1 : 0), 52, aw, 12, 4 - aw, 8], // player's left arm on viewer's left
    [44 + aw + 4, 20, aw, 12, 12, 8], // right arm back on viewer's right
    legacy ? [12, 20, 4, 12, 4, 20, true] : [28, 52, 4, 12, 4, 20], [12, 20, 4, 12, 8, 20],
  ] : [
    [8, 8, 8, 8, 4, 0], [20, 20, 8, 12, 4, 8], [44, 20, aw, 12, 4 - aw, 8],
    legacy ? [44, 20, 4, 12, 12, 8, true] : [36, 52, aw, 12, 12, 8],
    [4, 20, 4, 12, 4, 20], legacy ? [4, 20, 4, 12, 8, 20, true] : [20, 52, 4, 12, 8, 20],
  ];
  const over = legacy ? (back ? [[56, 8, 8, 8, 4, 0]] : [[40, 8, 8, 8, 4, 0]]) : back ? [
    [56, 8, 8, 8, 4, 0], [32, 36, 8, 12, 4, 8], [48 + aw + 4, 52, aw, 12, 4 - aw, 8], [44 + aw + 4, 36, aw, 12, 12, 8], [12, 52, 4, 12, 4, 20], [12, 36, 4, 12, 8, 20],
  ] : [
    [40, 8, 8, 8, 4, 0], [20, 36, 8, 12, 4, 8], [44, 36, aw, 12, 4 - aw, 8], [52, 52, aw, 12, 12, 8], [4, 36, 4, 12, 4, 20], [4, 52, 4, 12, 8, 20],
  ];
  return base.concat(over);
}
function drawBody(canvas, img, { slim = false, back = false, scale = 10 } = {}) {
  const src = img || (DEFAULT_SKIN = DEFAULT_SKIN || defaultSkin());
  canvas.width = 16 * scale; canvas.height = 32 * scale;
  const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, canvas.width, canvas.height);
  const legacy = src.height === 32;
  for (const [sx, sy, sw, sh, dx, dy, mirror] of skinParts(slim, back, legacy)) {
    if (mirror) { g.save(); g.translate((dx + sw) * scale, 0); g.scale(-1, 1); g.drawImage(src, sx, sy, sw, sh, 0, dy * scale, sw * scale, sh * scale); g.restore(); }
    else g.drawImage(src, sx, sy, sw, sh, dx * scale, dy * scale, sw * scale, sh * scale);
  }
}
function drawHead(canvas, img, size) {
  const src = img || (DEFAULT_SKIN = DEFAULT_SKIN || defaultSkin());
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false;
  g.drawImage(src, 8, 8, 8, 8, 0, 0, size, size); g.drawImage(src, 40, 8, 8, 8, 0, 0, size, size);
}
function drawCape(canvas, img, scale = 4) {
  canvas.width = 10 * scale; canvas.height = 16 * scale;
  const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false;
  if (img) g.drawImage(img, 1, 1, 10, 16, 0, 0, 10 * scale, 16 * scale);
}
const skinUrl = (id) => `/api/skin-image?id=${encodeURIComponent(id)}&token=${TOKEN}&v=${S.skinStamp || 0}`;
async function paintSkins() {
  const prof = S.state && S.state.profile;
  for (const c of document.querySelectorAll('canvas[data-skin]')) {
    const id = c.dataset.skin;
    const img = id === 'default' || (id === 'current' && !(prof && prof.skin)) ? null : await loadImage(skinUrl(id));
    const slim = c.dataset.slim === '1';
    if (c.dataset.mode === 'head') drawHead(c, img, Number(c.dataset.size || 32));
    else drawBody(c, img, { slim, back: c.dataset.back === '1', scale: Number(c.dataset.scale || 10) });
  }
  for (const c of document.querySelectorAll('canvas[data-cape]')) drawCape(c, await loadImage(c.dataset.cape), 4);
}

/* ---------------- 3D player models (skinview3d) ---------------- */
const viewers = new Map(); // key -> { v, canvas, src, model, cape, anim, name, rotate }
// The 3D characters redraw every frame; stop that while nobody can see them (window hidden or minimized,
// or in the background while a game runs), which frees the GPU and CPU for Minecraft.
function sync3dPause() {
  const pause = document.hidden || (anyGame() && !document.hasFocus());
  for (const rec of viewers.values()) if (rec.v && rec.v.renderPaused !== pause) rec.v.renderPaused = pause;
}
document.addEventListener('visibilitychange', sync3dPause);
addEventListener('focus', sync3dPause); addEventListener('blur', sync3dPause);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
function makeAnim(kind) {
  const s3 = window.skinview3d; let a;
  if (kind === 'walk') { a = new s3.WalkingAnimation(); a.speed = 0.6; }
  else if (kind === 'run') { a = new s3.RunningAnimation(); a.speed = 0.75; }
  else if (kind === 'wave') { a = new s3.WaveAnimation('right'); }
  else if (kind === 'crouch') { a = new s3.CrouchAnimation(); a.speed = 0.8; }
  else a = new s3.IdleAnimation();
  if (REDUCED) a.paused = true;
  return a;
}
function capeUrlFor(prof) {
  const c = prof && prof.capes && prof.capes.find((x) => x.active);
  return c ? `/api/cape-image?url=${encodeURIComponent(c.url)}&token=${TOKEN}` : '';
}
function skinSource(id) {
  const prof = S.state && S.state.profile;
  if (id === 'default' || (id === 'current' && !(prof && prof.skin))) return 'default';
  return skinUrl(id);
}
// Real cast shadow: the rendered silhouette, flipped onto the ground plane and stretched away from the low sun behind-right.
function attachCastShadow(v, canvas, w, h) {
  const sh = document.createElement('canvas'); sh.width = w; sh.height = h; sh.className = 'cast-shadow';
  const g = sh.getContext('2d'); const V3 = v.camera.position.constructor; const foot = new V3();
  const draw = () => {
    foot.set(0, -16.25, 0); v.playerWrapper.localToWorld(foot); foot.project(v.camera);
    const fx = (foot.x + 1) / 2 * w, fy = (1 - foot.y) / 2 * h;
    const lean = 0.55, squash = 0.2; // lean: sideways shift per pixel of height; squash: ground foreshortening
    g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, w, h);
    g.save(); g.setTransform(1, 0, lean, -squash, fx, fy); g.drawImage(canvas, -fx, -fy); g.restore();
    g.globalCompositeOperation = 'source-in'; g.fillStyle = '#0a0602'; g.fillRect(0, 0, w, h);
    const fade = g.createLinearGradient(fx, 0, fx - h * lean, 0);
    fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(0.55, 'rgba(0,0,0,.55)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-in'; g.fillStyle = fade; g.fillRect(0, 0, w, h);
  };
  const orig = v.composer.render.bind(v.composer);
  v.composer.render = (...a) => { orig(...a); try { draw(); } catch {} if (v.__skinOk && v.__onFrame) { const f = v.__onFrame; v.__onFrame = null; f(); } }; // must run in the same task: the WebGL buffer is cleared after compositing
  return sh;
}
function mount3d() {
  const keep = new Set();
  for (const host of document.querySelectorAll('[data-3d]')) {
    const key = host.dataset['3d']; keep.add(key);
    const w = Number(host.dataset.w), h = Number(host.dataset.h);
    let rec = viewers.get(key);
    if (!rec) {
      const canvas = document.createElement('canvas');
      try {
        if (!window.skinview3d) throw new Error('no 3d');
        const v = new skinview3d.SkinViewer({ canvas, width: w, height: h });
        v.controls.enableZoom = false; v.controls.enablePan = false;
        v.fov = 30;
        // Classic skin-render pose: three-quarter view, camera a little above the head.
        v.camera.position.set(Number(host.dataset.cx || 0.55), Number(host.dataset.cy || 0.28), 1);
        v.zoom = Number(host.dataset.zoom || 0.85);
        v.controls.update();
        v.globalLight.intensity = 1.55; v.cameraLight.intensity = 1.25;
        if (key === 'home') { // backlit sunset: dim warm fill from the camera, a strong warm rim from the sun behind-right
          v.globalLight.intensity = 0.85; v.cameraLight.intensity = 0.32;
          const sun = new v.cameraLight.constructor('#ffb36b', 4.6); sun.decay = 0; sun.distance = 0; sun.position.set(46, 14, -42); v.scene.add(sun);
          v.__sun = sun;
          const bounce = new v.cameraLight.constructor('#6f7f3a', 0.7); bounce.decay = 0; bounce.distance = 0; bounce.position.set(-6, -40, 24); v.scene.add(bounce); // green light bounced off the grass
          // The photo's warm haze. skinview3d does not export THREE.Fog, so pass the duck-typed object three.js reads.
          v.scene.fog = { isFog: true, name: '', color: v.globalLight.color.clone().set('#c8925a'), near: 55, far: 420, clone() { return this; }, toJSON() { return {}; } };
          S.homeViewer = v; lightHome();
        }
        if (v.fxaaPass) v.fxaaPass.enabled = false; // keep pixels sharp like the game
        rec = { v, canvas, shadow: key === 'home' && v.composer ? attachCastShadow(v, canvas, w, h) : null };
        if (key === 'home') S.homeFrame = new Promise((res) => { v.__onFrame = res; });
      } catch { rec = { v: null, canvas }; if (key === 'home') S.homeFrame = Promise.resolve(); }
      viewers.set(key, rec);
      sync3dPause();
    }
    if (rec.shadow) host.appendChild(rec.shadow);
    host.appendChild(rec.canvas);
    const src = skinSource(host.dataset.skin); const model = host.dataset.slim === '1' ? 'slim' : 'default';
    if (!rec.v) { // WebGL unavailable: flat drawing
      if (rec.src !== src + model) { rec.src = src + model; (src === 'default' ? Promise.resolve(null) : loadImage(src)).then((img) => drawBody(rec.canvas, img, { slim: model === 'slim', scale: Math.floor(h / 36) })); }
      continue;
    }
    if (rec.src !== src || rec.model !== model) {
      rec.src = src; rec.model = model;
      try { Promise.resolve(rec.v.loadSkin(src === 'default' ? (DEFAULT_SKIN = DEFAULT_SKIN || defaultSkin()) : src, { model })).then(() => { rec.v.__skinOk = true; }, () => { rec.v.__skinOk = true; }); } catch { rec.v.__skinOk = true; }
    }
    const cape = host.dataset.cape || '';
    if (rec.cape !== cape) { rec.cape = cape; try { cape ? rec.v.loadCape(cape) : rec.v.resetCape(); } catch {} }
    const anim = host.dataset.anim || 'idle';
    if (rec.anim !== anim && !rec.tempAnim) { rec.anim = anim; rec.v.animation = makeAnim(anim); }
    const name = host.dataset.name || '';
    if (rec.name !== name) { rec.name = name; rec.v.nameTag = null; } // no floating name tag
    const rotate = host.dataset.rotate === '1' && !REDUCED;
    rec.v.autoRotate = rotate; rec.v.autoRotateSpeed = 1.2;
    if (key === 'home') {
      host.onmouseenter = () => { if (rec.tempAnim || REDUCED) return; rec.tempAnim = true; rec.v.animation = makeAnim('wave'); setTimeout(() => { rec.tempAnim = false; rec.anim = null; mount3d(); }, 2200); };
    }
  }
  for (const [k, rec] of viewers) if (!keep.has(k)) { try { rec.v && rec.v.dispose(); } catch {} viewers.delete(k); }
}

/* ---------------- helpers ---------------- */
const servers = () => (S.state ? S.state.config.servers : []);
const selected = () => servers().find((s) => s.id === S.state.settings.selectedServer) || servers()[0];
const thumbPos = (i) => ['10% 70%', '50% 20%', '90% 75%', '30% 40%', '70% 55%', '100% 25%'][i % 6];
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const LOADER_ICON = {
  vanilla: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>',
  fabric: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"/><path d="M5 5h14l-3.5 4.5L19 14H5"/></svg>',
  quilt: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16M4 12h16"/></svg>',
  forge: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3 8h17v3h-6v2.5l2 .5v3H8v-3l2-.5V11H8C6 11 4 10 3 8z"/><rect x="6" y="19" width="12" height="2" rx="1"/></svg>',
  neoforge: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3 8h17v3h-6v2.5l2 .5v3H8v-3l2-.5V11H8C6 11 4 10 3 8z" transform="translate(0 2)"/><rect x="6" y="20" width="12" height="2" rx="1"/><path d="M18 1v5M15.5 3.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
function loaderLabel(s) { return LOADER_NAMES[s.loader] || 'Vanilla'; }
function cmpVer(a, b) { const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number), pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; } return 0; }

/* ---------------- account chip ---------------- */
function renderAccount() {
  const el = $('#account'); const p = S.state.profile;
  const others = (S.state.accounts || []).filter((a) => !a.active);
  if (!p) { el.innerHTML = `<button class="chip signin" data-action="signin">${ICON.msLogo}Sign in with Microsoft</button>`; return; }
  el.innerHTML = `<button class="chip" data-action="menu" aria-expanded="${S.menuOpen}"><canvas data-skin="current" data-mode="head" data-size="32"></canvas>${esc(p.name)}${ICON.chevron}</button>
  ${S.menuOpen ? `<div class="menu">${others.length ? `<div class="menu-label">Switch account</div>${others.map((a) => `<button class="acct" data-action="switch-account" data-id="${esc(a.id)}"><canvas data-skin="acct:${esc(a.id)}" data-mode="head" data-size="24"></canvas>${esc(a.name)}</button>`).join('')}<div class="menu-sep"></div>` : ''}<button data-action="signin">${ICON.plus.replace('<svg', '<svg style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round"')}Add account</button><button data-action="refresh-profile">Refresh profile</button><button data-action="go" data-page="skins">Change skin</button><button data-action="logout">Sign out</button></div>` : ''}`;
}

/* ---------------- pages ---------------- */
// Game state of one profile (several can run at once); idle when it is not starting or running.
const IDLE = Object.freeze({ state: 'idle', progress: null });
function G(id) { const g = S.state && S.state.games && S.state.games[id || selected().id]; return g || IDLE; }
function setG(id, patch) { S.state.games = S.state.games || {}; S.state.games[id] = { ...G(id), ...patch }; }
const anyGame = () => Object.values((S.state && S.state.games) || {}).some((g) => g.state !== 'idle');
function pageHome() {
  const s = selected(); const g = G(s.id); const ping = S.pings[s.id]; const prof = S.state.profile;
  let online = '';
  if (s.address) online = ping && ping.online ? `<span class="dot on"></span><span class="tnum">${fmt(ping.players)} online</span>` : `<span class="dot"></span><span>${ping ? 'Offline' : 'Checking…'}</span>`;
  let btn;
  if (!prof) btn = `<button class="play" data-action="signin">SIGN IN TO PLAY</button>`;
  else if (g.state === 'preparing') {
    const pr = g.progress; const pct = pr && pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
    btn = `<button class="play busy" disabled aria-label="Preparing, ${pct} percent"><i class="fill" style="width:${pct}%"></i><span>${pct}%</span></button>`;
  } else if (g.state === 'running') btn = `<button class="play running" data-action="stop" title="Stop the game">PLAYING</button>`;
  else btn = `<button class="play" data-action="launch">${ICON.play}PLAY</button>`;
  let status = '';
  if (g.state === 'preparing' && g.progress) status = `<div class="status-line"><span class="spinner"></span>${esc(g.progress.stage)}${g.progress.total > 1 ? ` <span class="tnum">${fmt(g.progress.done)} / ${fmt(g.progress.total)}</span>` : ''}</div>`;
  else if (g.state === 'running') status = `<div class="status-line">Minecraft is running${g.account ? ` as ${esc(g.account)}` : ''}. Press PLAYING to stop it. <button class="linkish" data-action="logs">Game log</button></div>`;
  else if (S.launchError) status = `<div class="status-line err">${esc(S.launchError)} <button class="linkish" data-action="logs">Game log</button></div>`;
  else status = '<div class="status-line"></div>';
  return `<section class="home">
    <div class="hero">
      <div class="meta">${online ? `${online}<span class="sep">·</span>` : ''}<span>${esc(s.version)}</span><span class="sep">·</span><span>${loaderLabel(s)}</span>${(s.tags || [])[0] ? `<span class="sep">·</span><span style="text-transform:capitalize">${esc(s.tags[0])}</span>` : ''}</div>
      <h1 class="brand" aria-label="${esc(S.state.config.brand || 'AURORIA')}">${[...(S.state.config.brand || 'AURORIA')].map((c, i) => `<span class="ch" aria-hidden="true" style="--i:${i}">${esc(c)}</span>`).join('')}</h1>
      <div class="cta">${btn}<button class="server-link" data-action="go" data-page="servers"><small>Profile</small><span>${esc(s.name)}${ICON.chevron}</span></button></div>
      ${status}
    </div>
    <div class="character">
      <div class="viewer3d" role="img" aria-label="Your character. Drag to turn." data-3d="home" data-w="440" data-h="560" data-zoom="0.84" data-cx="0.85" data-cy="0.06"
        data-skin="current" data-slim="${prof && prof.skin && prof.skin.variant === 'SLIM' ? 1 : 0}" data-name="${esc(prof ? prof.name : 'Player')}"
        data-anim="${g.state === 'preparing' ? 'run' : g.state === 'running' ? 'walk' : 'idle'}" data-cape="${esc(capeUrlFor(prof))}"></div>
      <button class="btn" data-action="go" data-page="skins">Change skin</button>
    </div>
  </section>`;
}

function ago(ts) {
  if (!ts) return 'Never played';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'Played just now'; if (m < 60) return `Played ${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `Played ${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24); return `Played ${d} day${d > 1 ? 's' : ''} ago`;
}
const iconStyle = (color, icon) => icon ? `background:#000 url(${icon}) center/cover` : `background:${esc(color || '#f07f2a')}`;
function initials(name) { const w = String(name).trim().split(/\s+/); return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '')[1] || '')).toUpperCase(); }
function pageServers() {
  const sel = selected(); const loaders = [...new Set(servers().map((s) => s.loader || 'vanilla'))];
  const q = S.serverQuery.toLowerCase();
  let list = servers().filter((s) => (S.serverTag === 'all' || (s.loader || 'vanilla') === S.serverTag) && (!q || s.name.toLowerCase().includes(q) || s.version.includes(q)));
  list = list.slice().sort((a, b) => S.profileSort === 'name' ? a.name.localeCompare(b.name) : S.profileSort === 'version' ? cmpVer(b.version, a.version) : (b.lastPlayed || 0) - (a.lastPlayed || 0));
  const cards = list.map((s, i) => {
    const p = S.pings[s.id]; const isSel = s.id === sel.id;
    let srv;
    if (!s.address) srv = '<span class="sub">Singleplayer and any server</span>';
    else if (!p) srv = `<span class="sub">${esc(s.address)} · checking…</span>`;
    else if (!p.online) srv = `<span class="sub">${esc(s.address)} · offline</span>`;
    else srv = `<span class="sub tnum"><span class="dot-on"></span>${esc(s.address)} · ${fmt(p.players)}/${fmt(p.max)} online</span>`;
    const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
    const CLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    const act = (name, id, label, svg, cls = '') => `<button class="iconbtn ${cls}" data-action="${name}" data-id="${esc(id)}" aria-label="${label} ${esc(s.name)}" title="${label}">${svg}</button>`;
    return `<article class="card profile ${isSel ? 'selected' : ''}" style="--pc:${esc(s.color || '#f07f2a')}">
      <div class="p-cover" style="background-position:${thumbPos(i)}">
        <span class="p-loader">${LOADER_ICON[s.loader || 'vanilla'] || ''}${loaderLabel(s)}</span>
        ${G(s.id).state !== 'idle' ? `<span class="p-sel live"><span class="dot-on"></span>${G(s.id).state === 'running' ? 'Playing' : 'Starting'}</span>` : isSel ? `<span class="p-sel">${CHECK}Selected</span>` : ''}
      </div>
      <div class="p-body">
        <div class="p-head"><span class="p-icon big" style="${iconStyle(s.color, s.icon)}">${s.icon ? '' : esc(initials(s.name))}</span>
          <div class="p-title"><h3 title="${esc(s.name)}">${esc(s.name)}</h3><div class="p-ver"><span class="pill">${esc(s.version)}</span>${s.loaderVersion ? `<span class="pill dim">${esc(s.loaderVersion)}</span>` : ''}</div></div></div>
        <div class="p-meta">${srv}<span class="sub p-ago">${CLOCK}${ago(s.lastPlayed)}</span><span class="sub p-time tnum">${s.playMs ? `${fmtDur(s.playMs)} played` : 'No playtime yet'}${playBars(s)}</span></div>
        <div class="p-actions">
          <button class="btn primary small" data-action="play-profile" data-id="${esc(s.id)}" ${G(s.id).state !== 'idle' ? 'disabled' : ''}>${ICON.play.replace('<svg', '<svg style="width:11px;height:12px;fill:currentColor;stroke:none"')}Play</button>
          ${isSel ? '' : `<button class="btn soft small" data-action="select-server" data-id="${esc(s.id)}">Select</button>`}
          <span style="flex:1"></span>
          ${act('manage', s.id, 'Worlds, screenshots and servers', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>')}
          ${act('edit-server', s.id, 'Edit', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>')}
          ${act('p-more', s.id, 'More', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>', S.pMenu === s.id ? 'on' : '')}
          ${S.pMenu === s.id ? `<div class="menu p-menu" role="menu">
            <button role="menuitem" data-action="share-profile" data-id="${esc(s.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/></svg>Share as .mrpack</button>
            <button role="menuitem" data-action="dup-server" data-id="${esc(s.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>Duplicate</button>
            <button role="menuitem" data-action="profile-shortcut" data-id="${esc(s.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>Desktop shortcut</button>
            <button role="menuitem" data-action="open-profile" data-id="${esc(s.id)}">${ICON.folder}Open folder</button>
            <button role="menuitem" class="danger" data-action="delete-server" data-id="${esc(s.id)}">${ICON.trash}Delete</button></div>` : ''}
        </div>
      </div></article>`;
  }).join('');
  return `<header class="page-head"><h1>Profiles</h1><p>Each profile has its own version, loader, mods, worlds and settings.</p></header>
  <div class="toolbar"><div class="tabs" role="tablist">
    <button class="tab ${S.serverTag === 'all' ? 'active' : ''}" role="tab" aria-selected="${S.serverTag === 'all'}" data-action="server-tag" data-tag="all">All <span class="count">${servers().length}</span></button>
    ${loaders.map((t) => `<button class="tab ${S.serverTag === t ? 'active' : ''}" role="tab" aria-selected="${S.serverTag === t}" data-action="server-tag" data-tag="${esc(t)}">${esc(LOADER_NAMES[t] || t)}</button>`).join('')}
  </div><div class="inline">
    <label class="sort"><span class="sub">Sort</span><select id="profile-sort" class="input" aria-label="Sort profiles">${[['played', 'Last played'], ['name', 'Name'], ['version', 'Version']].map(([k, l]) => `<option value="${k}" ${S.profileSort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="search">${ICON.search}<input id="server-search" type="search" placeholder="Search profiles" aria-label="Search profiles" value="${esc(S.serverQuery)}"></label>
    <button class="btn" data-action="import-open">${ICON.upload}Import</button>
    <button class="btn primary" data-action="add-server">${ICON.plus}New profile</button></div></div>
  <div class="scroll"><div class="grid3">${cards}<button class="card add-server" data-action="add-server">${ICON.plus.replace('<svg', '<svg style="width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"')}<b>New profile</b><span class="sub">Any Minecraft version, any loader</span></button></div></div>`;
}
const shownMods = () => S.mods && (S.mods.some((m) => m.own) ? S.mods.filter((m) => m.slug !== 'axolotlclient') : S.mods);
function modRow(m) {
  const upd = S.updates && S.updates.find((u) => u.file === m.file);
  const icon = m.icon ? `<img src="${esc(m.icon)}" alt="">` : esc(m.title[0] || '?');
  const dup = m.projectId && m.enabled && (S.mods || []).some((x) => x !== m && x.enabled && x.projectId === m.projectId);
  return `<div class="mod${dup ? ' dup' : ''}"><div class="mod-name"><span class="icon">${icon}</span><div><b>${esc(m.slug === 'axolotlclient' ? 'Auroria Client' : m.title)}${m.client ? ' <span class="client-chip small">CLIENT</span>' : ''}${dup ? ' <span class="dup-chip" title="Two copies of this mod are switched on. Remove or turn off one, or the game will not start.">Duplicate</span>' : ''}</b><small>${m.own ? 'Your own client · HUD editor, zoom' : m.slug === 'axolotlclient' ? 'Powered by AxolotlClient' : esc(m.category || m.file)}</small></div></div>
    <span class="ver tnum">${esc(m.version || '—')}${upd ? '<span class="pill-upd">Update</span>' : ''}</span>
    ${m.own ? '<div class="mod-actions"><span class="client-chip small">ALWAYS ON</span></div>' : `<div class="mod-actions"><button class="iconbtn" data-action="mod-delete" data-file="${esc(m.file)}" aria-label="Remove ${esc(m.title)}">${ICON.trash}</button>
    <button class="switch" role="switch" aria-checked="${m.enabled}" aria-label="${esc(m.title)}" data-action="mod-toggle" data-file="${esc(m.file)}"></button></div>`}</div>`;
}
function browseRow(h) {
  const busy = S.busy[h.projectId];
  const btn = h.type === 'modpack' ? `<button class="btn soft small" data-action="pack-install" data-id="${esc(h.projectId)}" data-title="${esc(h.title)}" ${busy ? 'disabled' : ''}>${busy ? 'Installing…' : 'Install pack'}</button>`
    : h.installed ? '<span class="ok-tag">✓ Installed</span>'
    : `<button class="btn soft small" data-action="mod-install" data-id="${esc(h.projectId)}" data-type="${esc(h.type)}" ${busy ? 'disabled' : ''}>${busy ? 'Installing…' : 'Install'}</button>`;
  return `<div class="mod browse"><div class="mod-name"><span class="icon big">${h.icon ? `<img src="${esc(h.icon)}" alt="" loading="lazy">` : esc(h.title[0])}</span>
    <div><b>${esc(h.title)}</b><small>by ${esc(h.author)} · <span class="tnum">${compact(h.downloads)}</span> downloads</small>
    <p class="desc">${esc(h.description)}</p>${h.categories.length ? `<div class="chips">${h.categories.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}</div></div>
    <div class="mod-actions">${btn}</div></div>`;
}
function pageMods() {
  const s = selected(); const vanilla = s.loader === 'vanilla';
  if (vanilla) { if (S.modTab !== 'packs') S.modTab = 'browse'; if (S.browseType !== 'modpack') S.browseType = 'resourcepack'; }
  const head = `<header class="page-head"><h1>${vanilla ? 'Resource packs' : 'Mods'}</h1><p>${esc(s.name)} · ${esc(s.version)} ${loaderLabel(s)}${s.loaderVersion ? ` ${esc(s.loaderVersion)}` : ''}${!vanilla && S.mods ? ` · ${shownMods().length} installed` : ''}${vanilla ? ' · vanilla profiles take resource packs only' : ''} · <button class="linkish" data-action="edit-server" data-id="${esc(s.id)}">${vanilla ? 'Change version' : 'Change version or loader'}</button></p></header>`;
  const updCount = S.updates ? S.updates.length : 0;
  let body;
  if (S.modTab === 'browse') {
    const types = vanilla ? [['resourcepack', 'Resource packs'], ['modpack', 'Modpacks']] : [['mod', 'Mods'], ['resourcepack', 'Resource packs'], ['shader', 'Shaders'], ['modpack', 'Modpacks']];
    const skel = Array.from({ length: 6 }, () => '<div class="mod browse"><div class="mod-name"><span class="icon big sk"></span><div><b class="sk" style="width:180px">&nbsp;</b><small class="sk" style="width:140px;margin-top:6px">&nbsp;</small><p class="desc sk" style="width:80%">&nbsp;</p></div></div><span></span></div>').join('');
    const rows = S.browse == null ? skel
      : S.browse.error ? `<div class="empty"><strong>Modrinth is not reachable</strong>${esc(S.browse.error)}</div>`
      : S.browse.length ? S.browse.map(browseRow).join('') + browseMoreHtml()
      : S.browseType === 'modpack' ? '<div class="empty"><strong>Nothing found</strong>No modpacks match that search.</div>'
      : `<div class="empty"><strong>Nothing found</strong>No ${S.browseType === 'mod' ? 'mods' : S.browseType === 'shader' ? 'shaders' : 'resource packs'} match for Minecraft ${esc(s.version)}.</div>`;
    body = `<div class="card list"><div class="browse-bar">
      <div class="seg" role="radiogroup" aria-label="Project type">${types.map(([k, l]) => `<button role="radio" aria-checked="${S.browseType === k}" data-action="browse-type" data-v="${k}">${l}</button>`).join('')}</div>
      ${S.browseType === 'modpack' ? `<label class="sort"><span class="sub">Minecraft</span><select id="pack-mc" class="input" aria-label="Minecraft version"><option value="">Any version</option>${(S.versions ? S.versions.versions.filter((v) => v.type === 'release') : []).map((v) => `<option value="${esc(v.id)}" ${S.packMc === v.id ? 'selected' : ''}>${esc(v.id)}</option>`).join('')}</select></label>` : ''}
      <label class="sort"><span class="sub">Sort</span><select id="browse-sort" class="input" aria-label="Sort results">${[['relevance', 'Relevance'], ['downloads', 'Downloads'], ['follows', 'Follows'], ['newest', 'Newest'], ['updated', 'Recently updated']].map(([k, l]) => `<option value="${k}" ${S.browseSort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <span class="sub tnum" style="margin-left:auto">${S.browseTotal ? `${compact(S.browseTotal)} results on Modrinth` : ''}</span>
    </div><div class="list-body">${rows}</div></div>`;
  } else if (S.modTab === 'packs' || S.modTab === 'shaders') {
    body = packsBody(S.modTab === 'shaders' ? 'shader' : 'resourcepack');
  } else {
    let mods = shownMods();
    if (mods && S.modTab === 'updates') mods = mods.filter((m) => S.updates && S.updates.some((u) => u.file === m.file));
    if (mods && S.modQuery) mods = mods.filter((m) => m.title.toLowerCase().includes(S.modQuery.toLowerCase()));
    const rows = mods == null ? Array.from({ length: 6 }, () => '<div class="mod"><div class="mod-name"><span class="icon sk"></span><div><b class="sk" style="width:170px">&nbsp;</b><small class="sk" style="width:240px;margin-top:5px">&nbsp;</small></div></div><span class="sk" style="width:60px">&nbsp;</span><span></span></div>').join('')
      : mods.length ? mods.map(modRow).join('')
      : `<div class="empty"><strong>${S.modTab === 'updates' ? 'Everything is up to date' : 'No mods yet'}</strong>${S.modTab === 'updates' ? '' : 'Auroria Client and profile mods install the first time you press Play. Find more under Browse.'}</div>`;
    body = `<div class="card list"><div class="list-head"><span>MOD</span><span>VERSION</span><span style="text-align:right">ON</span></div><div class="list-body">${rows}</div></div>`;
  }
  const folder = S.modTab === 'packs' || (S.modTab === 'browse' && S.browseType === 'resourcepack') ? ['resourcepacks', 'Open resource packs folder'] : S.modTab === 'shaders' || (S.modTab === 'browse' && S.browseType === 'shader') ? ['shaderpacks', 'Open shaders folder'] : ['mods', 'Open mods folder'];
  const packTabs = `<button class="tab ${S.modTab === 'packs' ? 'active' : ''}" role="tab" data-action="mod-tab" data-tab="packs">Packs</button>${vanilla ? '' : `<button class="tab ${S.modTab === 'shaders' ? 'active' : ''}" role="tab" data-action="mod-tab" data-tab="shaders">Shaders</button>`}`;
  const tabs = vanilla ? `<div class="tabs" role="tablist">${packTabs}<button class="tab ${S.modTab === 'browse' ? 'active' : ''}" role="tab" data-action="mod-tab" data-tab="browse">Browse</button></div>` : `<div class="tabs" role="tablist">
    <button class="tab ${S.modTab === 'installed' ? 'active' : ''}" role="tab" data-action="mod-tab" data-tab="installed">Installed <span class="count">${S.mods ? shownMods().length : ''}</span></button>
    <button class="tab ${S.modTab === 'updates' ? 'active' : ''}" role="tab" data-action="mod-tab" data-tab="updates">Updates ${updCount ? `<span style="color:var(--accent)">${updCount}</span>` : ''}</button>
    ${packTabs}
    <button class="tab ${S.modTab === 'browse' ? 'active' : ''}" role="tab" data-action="mod-tab" data-tab="browse">Browse</button></div>`;
  return head + `<div class="toolbar">${tabs}<label class="search">${ICON.search}<input id="mod-search" type="search" placeholder="${S.modTab === 'browse' ? 'Search Modrinth' : 'Search your mods'}" aria-label="Search" value="${esc(S.modQuery)}"></label></div>
  <div class="mods-layout">${body}
    <aside class="side">
      ${vanilla ? '' : `<section class="card"><h2>${S.updates == null ? 'Checking for updates…' : updCount ? `${updCount} update${updCount > 1 ? 's' : ''} ready` : 'All mods up to date'}</h2>
        <p>${updCount ? esc(S.updates.map((u) => u.title).slice(0, 3).join(', ')) + (updCount > 3 ? ' and more' : '') + ' have new versions.' : 'Updates come from Modrinth.'}</p>
        <button class="btn primary" style="width:100%;margin-top:16px" data-action="mod-update-all" ${!updCount || S.busy.update ? 'disabled' : ''}>${S.busy.update ? 'Updating…' : 'Update all'}</button></section>`}
      ${S.modTab === 'shaders' ? '<section class="card"><h2>Shaders need Iris or OptiFine</h2><p>Pick one shader here and it is switched on the next time you play. Install Iris from Browse if you have not yet.</p><button class="btn soft small" style="margin-top:14px" data-action="find-iris">Find Iris</button></section>' : ''}
      ${S.modTab === 'packs' ? '<section class="card"><h2>Load order</h2><p>Drag packs that are on to change their order. The top pack wins when two packs change the same thing, like in game.</p></section>' : ''}
      ${S.modTab === 'browse' && S.browseType === 'shader' ? '<section class="card"><h2>Shaders need Iris</h2><p>Install the Iris Shaders mod from the Mods list, then pick a shader in game under Video Settings.</p><button class="btn soft small" style="margin-top:14px" data-action="find-iris">Find Iris</button></section>' : ''}
      <section class="card"><h2>Performance</h2>
        <div class="row-between" style="margin-top:16px"><label for="mods-ram" style="font-weight:600">Memory</label><b class="tnum" id="ram-label">${S.state.settings.ramGB} GB</b></div>
        <input id="mods-ram" type="range" min="1" max="16" value="${S.state.settings.ramGB}" style="margin-top:10px">
        <p>4 to 8 GB suits most modded servers.</p></section>
      <button class="btn" data-action="open" data-what="${folder[0]}">${ICON.folder}${folder[1]}</button>
    </aside></div>`;
}

function pageSkins() {
  const prof = S.state.profile; const lib = (S.skins && S.skins.library) || [];
  const pid = S.previewId; const item = lib.find((x) => x.id === pid);
  const slim = pid === 'current' ? !!(prof && prof.skin && prof.skin.variant === 'SLIM') : item ? item.variant === 'SLIM' : false;
  const tiles = [];
  tiles.push(`<button class="tile ${pid === 'current' ? 'selected' : ''}" data-action="preview-skin" data-id="current"><canvas data-skin="current" data-mode="head" data-size="56"></canvas><b>${esc(prof ? prof.name : 'Default')}</b><small class="on">Equipped</small></button>`);
  for (const s of lib) tiles.push(`<div class="tile ${pid === s.id ? 'selected' : ''}"><button class="iconbtn tile-del" data-action="skin-delete" data-id="${esc(s.id)}" aria-label="Delete ${esc(s.name)}">${ICON.trash}</button>
    <button style="border:0;background:transparent;display:flex;flex-direction:column;align-items:center;gap:10px" data-action="preview-skin" data-id="${esc(s.id)}"><canvas data-skin="${esc(s.id)}" data-mode="head" data-size="56"></canvas><b>${esc(s.name)}</b><small>${s.variant === 'SLIM' ? 'Slim' : 'Classic'}</small></button></div>`);
  tiles.push(`<button class="tile add" data-action="skin-upload">${ICON.plus.replace('<svg', '<svg style="width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round"')}<b>Add skin</b><small>64×64 PNG</small></button>`);
  const capes = prof ? prof.capes : [];
  const capeHtml = !prof ? '<p class="sub">Sign in to see your capes.</p>' : `<button class="cape ${capes.some((c) => c.active) ? '' : 'selected'}" data-action="cape" data-id=""><span class="none"></span>None</button>` +
    capes.map((c) => `<button class="cape ${c.active ? 'selected' : ''}" data-action="cape" data-id="${esc(c.id)}"><canvas data-cape="${esc(c.url)}"></canvas>${esc(c.alias)}</button>`).join('');
  return `<header class="page-head"><h1>Skins</h1><p>Your look in every Auroria server.</p></header>
  <div class="skins-layout">
    <section class="card preview" aria-label="Preview">
      <div class="seg preview-anims" role="radiogroup" aria-label="Animation">${[['idle', 'Idle'], ['walk', 'Walk'], ['run', 'Run'], ['wave', 'Wave'], ['crouch', 'Crouch']].map(([k, l]) => `<button role="radio" aria-checked="${S.anim3d === k}" data-action="anim3d" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="viewer3d" role="img" aria-label="3D preview. Drag to turn." data-3d="skins" data-w="360" data-h="480" data-zoom="0.8" data-cx="0.5" data-cy="0.3"
        data-skin="${esc(pid)}" data-slim="${slim ? 1 : 0}" data-name="${esc(prof ? prof.name : 'Player')}" data-anim="${S.anim3d}"
        data-cape="${pid === 'current' ? esc(capeUrlFor(prof)) : ''}" data-rotate="${S.autoRotate ? 1 : 0}"></div>
      <div class="preview-tools">
        ${pid !== 'current' ? `<button class="btn primary" data-action="skin-apply" data-id="${esc(pid)}" ${!prof || S.busy.apply ? 'disabled' : ''}>${S.busy.apply ? 'Applying…' : prof ? 'Wear this skin' : 'Sign in to wear'}</button>` : '<span class="sub">Currently worn · drag to turn</span>'}
        <button class="btn" data-action="auto-rotate" aria-pressed="${S.autoRotate}">${ICON.rotate}${S.autoRotate ? 'Stop spin' : 'Spin'}</button>
      </div>
    </section>
    <div class="scroll" style="margin-top:0">
      <div class="row-between"><h2 style="margin:0;font-size:16px">Your skins</h2>
        <div class="inline"><div class="seg" role="radiogroup" aria-label="Arm style for uploads"><button role="radio" aria-checked="${S.uploadVariant === 'CLASSIC'}" data-action="variant" data-v="CLASSIC">Classic</button><button role="radio" aria-checked="${S.uploadVariant === 'SLIM'}" data-action="variant" data-v="SLIM">Slim</button></div>
        <button class="btn primary" data-action="skin-upload">${ICON.upload}Upload skin</button></div></div>
      <div class="tiles">${tiles.join('')}</div>
      <h2 style="margin:28px 0 0;font-size:16px">Capes</h2>
      <div class="capes">${capeHtml}</div>
    </div>
  </div>`;
}

function pageSettings() {
  const st = S.state.settings; const t = S.settingsTab; const prof = S.state.profile;
  const sw = (key, label) => `<span class="toggle-row"><button class="switch" role="switch" aria-checked="${!!st[key]}" aria-label="${esc(label)}" data-action="set-toggle" data-key="${key}"></button>${esc(label)}</span>`;
  let panel = '';
  if (t === 'game') panel = `
    <div class="field"><div><div class="label">Window size</div><div class="hint">Used when custom size is on</div></div>
      <div class="inline"><label class="sr" for="set-w" hidden>Width</label><input class="input num tnum" id="set-w" type="number" value="${st.width}" data-setting="width">
      <span class="sub">×</span><label for="set-h" hidden>Height</label><input class="input num tnum" id="set-h" type="number" value="${st.height}" data-setting="height">${sw('customResolution', 'Use custom size')}</div></div>
    <div class="field"><div><div class="label">Fullscreen</div><div class="hint">Start Minecraft in fullscreen</div></div>${sw('fullscreen', 'Fullscreen')}</div>`;
  else if (t === 'java') panel = `
    <div class="field"><div><label class="label" for="set-ram">Memory</label><div class="hint">4 to 8 GB suits most modded servers</div></div>
      <div class="inline"><input id="set-ram" type="range" min="1" max="16" value="${st.ramGB}" style="flex:1"><b class="tnum" id="ram-label" style="width:56px;text-align:right">${st.ramGB} GB</b></div></div>
    <div class="field"><div><label class="label" for="set-java">Java executable</label><div class="hint">Leave empty to use the Java that Auroria downloads for each version</div></div>
      <input class="input" id="set-java" type="text" placeholder="Automatic" value="${esc(st.javaPath)}" data-setting="javaPath"></div>`;
  else if (t === 'launcher') panel = `
    <div class="field"><div><div class="label">While playing</div><div class="hint">Off closes the launcher once Minecraft starts</div></div>${sw('keepOpen', 'Keep launcher open')}</div>
    <div class="field"><div><div class="label">Notifications</div><div class="hint">Windows notifications when Minecraft closes or crashes, a modpack finishes installing, or an update is ready. Adds Auroria to the Start menu, which Windows needs to show them.</div></div>${sw('notifications', 'Show notifications')}</div>
    <div class="field"><div><div class="label">Updates</div><div class="hint">Asks GitHub for a newer Auroria each time it starts. Nothing about you is sent.</div></div>${sw('updateCheck', 'Check for updates')}</div>
    <div class="field"><div><div class="label">Discord status</div><div class="hint">Shows the profile you are playing on your Discord profile, while the launcher is open</div></div>${sw('discordPresence', 'Show in Discord')}</div>
    <div class="field"><div><div class="label">Folders</div><div class="hint">Worlds, screenshots and downloads</div></div>
      <div class="inline"><button class="btn" data-action="open" data-what="game">${ICON.folder}Game folder</button><button class="btn" data-action="open" data-what="data">${ICON.folder}Launcher folder</button></div></div>
`;
  else if (t === 'look') {
    const cur = (st.accent || '#f07f2a').toLowerCase();
    panel = `<div class="field"><div><div class="label">Accent colour</div><div class="hint">Buttons, highlights and selections. The flame stays orange.</div></div>
      <div class="accents">${ACCENTS.map(([c, n]) => `<button class="accent-sw ${cur === c ? 'on' : ''}" data-action="accent-pick" data-v="${c}" title="${n}" aria-label="${n}" style="--c:${c}"></button>`).join('')}
      <label class="accent-sw custom ${ACCENTS.some(([c]) => c === cur) ? '' : 'on'}" title="Custom colour" style="--c:${cur}"><input type="color" id="accent-custom" value="${cur}" aria-label="Custom accent colour"></label></div></div>`;
  } else if (t === 'account') panel = `
    <div class="field"><div><div class="label">Microsoft account</div><div class="hint">${prof ? 'Signed in' : 'Not signed in'}</div></div>
      <div class="inline">${prof ? `<b>${esc(prof.name)}</b><button class="btn" data-action="logout">Sign out</button>` : `<button class="btn primary" data-action="signin">${ICON.msLogo}Sign in with Microsoft</button>`}</div></div>
    <div class="field"><div><div class="label">Sign-in app</div><div class="hint">Which Microsoft app ID Auroria signs in with</div></div>
      <div class="inline"><span class="sub tnum" style="word-break:break-all">${S.state.clientId ? 'Your app · ' + esc(S.state.clientId) : 'Built-in (Minecraft Launcher)'}</span><button class="btn" data-action="client-setup">${S.state.clientId ? 'Change' : 'Use my own ID'}</button>${S.state.clientId ? '<button class="btn" data-action="client-builtin">Use built-in</button>' : ''}</div></div>`;
  else panel = `
    <div class="field"><div><div class="label">Auroria Launcher</div><div class="hint">Version ${esc(S.state.version)}</div></div><div class="sub">Not affiliated with Mojang or Microsoft. Minecraft is a trademark of Mojang Studios.</div></div>
    <div class="field"><div><div class="label">Data folder</div></div><div class="sub" style="word-break:break-all">${esc(S.state.dataDir)}</div></div>`;
  const tabs = [['game', 'Game'], ['java', 'Java and memory'], ['launcher', 'Launcher'], ['look', 'Appearance'], ['account', 'Account'], ['about', 'About']];
  return `<header class="page-head"><h1>Settings</h1><p>Changes save automatically and apply the next time you press Play.</p></header>
  <div class="settings-layout${Date.now() - (S.settingsFx || 0) < 200 ? ' fx' : ''}"><nav class="subnav" aria-label="Settings sections">${tabs.map(([k, l]) => `<button class="${t === k ? 'active' : ''}" data-action="settings-tab" data-tab="${k}">${l}</button>`).join('')}</nav>
  <div class="card form">${panel}</div></div>`;
}

/* ---------------- launch check and crash popups ---------------- */
async function startLaunch(id, join) {
  S.launchError = ''; setG(id, { state: 'preparing', progress: { stage: 'Getting ready', done: 0, total: 1 } }); render();
  try { await api('POST', '/api/launch', { serverId: id, join: join || '' }); } catch (e) { S.launchError = e.message; setG(id, { state: 'idle', progress: null }); render(); }
}
// One row per problem, with a Delete button for each mod involved (two copies show both, so you pick which one goes).
function chkRows(problems) {
  return problems.map((p) => `<li class="chk-item"><div class="chk-text">${esc(p.text)}${p.type === 'missing' && p.dep ? `<button class="btn small primary chk-fix" data-action="chk-install" data-dep="${esc(p.dep)}">Install ${esc(p.depName || p.dep)}</button>` : ''}</div>${(p.mods || []).length ? `<div class="chk-mods">${p.mods.map((m) => `<div class="chk-mod"><span class="chk-name"><b>${esc(m.name)}${m.version ? ` <i>${esc(m.version)}</i>` : ''}</b><small>${esc(m.file)}</small></span><button class="btn small danger" data-action="chk-delete" data-file="${esc(m.file)}">Delete</button></div>`).join('')}</div>` : ''}</li>`).join('');
}
function launchCheckModal(s, chk) {
  S.launchChk = { id: s.id, outdated: chk.outdated, name: s.name };
  const clear = !chk.problems.length && !chk.outdated.length;
  const li = (t) => `<li>${esc(t)}</li>`;
  const more = chk.outdated.length > 6 ? `<li class="more">and ${chk.outdated.length - 6} more</li>` : '';
  modal(`<h2>${clear ? 'All clear' : 'Before you play'}</h2><p class="sub" style="margin:6px 0 0">${clear ? 'No problems left in ' : 'Checked the mods in '}${esc(s.name)}.</p>
    ${chk.problems.length ? `<div class="chk-block err"><b>These will probably stop the game from starting</b><ul>${chkRows(chk.problems)}</ul></div>` : ''}
    ${chk.outdated.length ? `<div class="chk-block warn"><b>${chk.outdated.length} mod${chk.outdated.length > 1 ? 's are' : ' is'} out of date</b><ul>${chk.outdated.slice(0, 6).map((u) => li(`${u.title}${u.from && u.to ? `  ${u.from} to ${u.to}` : ''}`)).join('')}${more}</ul></div>` : ''}
    <div class="modal-actions"><button class="btn" data-action="close">Cancel</button><button class="btn" data-action="go-mods">Open mods</button>${chk.outdated.length ? '<button class="btn" data-action="launch-update">Update and play</button>' : ''}<button class="btn primary" data-action="launch-anyway">${clear ? 'Play' : 'Play anyway'}</button></div>`, true);
}
function crashModal(ev) {
  const c = ev.crash;
  modal(`<h2>${esc(c ? c.title : 'Minecraft could not start')}</h2>
    ${c && c.lines.length ? `<div class="chk-block err"><ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}
    <div id="crash-fix"></div>
    <p class="sub" style="margin:12px 0 0">${esc(c ? c.hint : ev.error || '')}</p>
    <div class="modal-actions"><button class="btn" data-action="close">Close</button>${c && c.kind === 'mods' || c && c.kind === 'mixin' ? '<button class="btn" data-action="go-mods">Open mods</button>' : ''}${S.logs.length ? '<button class="btn" data-action="log-upload" title="Upload the game log to mclo.gs and copy the link">Upload log</button>' : ''}<button class="btn primary" data-action="go-logs">View logs</button></div>`, true);
  if (c && (c.kind === 'mods' || c.kind === 'mixin')) {
    const sid = ev.serverId || selected().id; S.launchChk = { id: sid, outdated: [], name: '' };
    api('GET', `/api/launch-check?server=${encodeURIComponent(sid)}`).then((chk) => { const el = $('#crash-fix'); if (el && chk.problems.length) el.innerHTML = `<div class="chk-block err"><b>Found in your mods</b><ul>${chkRows(chk.problems)}</ul></div>`; }).catch(() => {});
  }
}

/* ---------------- profile extras: playtime, manage window (worlds, screenshots, servers, settings sync) ---------------- */
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
function fmtDur(ms) { const m = Math.round((ms || 0) / 60000); if (m < 60) return `${m}m`; const h = Math.floor(m / 60); return h < 100 ? `${h}h ${m % 60}m` : `${h}h`; }
function playBars(s) {
  const days = s.playDays || {}; const vals = [];
  for (let i = 6; i >= 0; i--) vals.push(days[new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)] || 0);
  const max = Math.max(...vals, 1);
  return `<span class="p-bars" title="Last 7 days">${vals.map((v) => `<i class="${v ? 'on' : ''}" style="height:${v ? Math.max(3, Math.round((v / max) * 14)) : 2}px"></i>`).join('')}</span>`;
}
const profileImg = (sid, kind, name) => `/api/profile-image?server=${encodeURIComponent(sid)}&kind=${kind}&name=${encodeURIComponent(name)}&token=${TOKEN}`;
const MG = { id: '', tab: 'worlds', worlds: null, shots: null, pings: {}, confirm: '' };
const mgServer = () => servers().find((x) => x.id === MG.id);
function manageModal(id, tab) {
  Object.assign(MG, { id, tab: tab || 'worlds', worlds: null, shots: null, snaps: null, confirm: '' });
  const s = mgServer(); if (!s) return;
  const tabs = [['worlds', 'Worlds'], ['snaps', 'Snapshots'], ['perf', 'Performance'], ['shots', 'Screenshots'], ['servers', 'Servers'], ['options', 'Settings sync']];
  modal(`<div class="mg-head"><span class="p-icon" style="${iconStyle(s.color, s.icon)}">${s.icon ? '' : esc(initials(s.name))}</span>
      <div><h2>${esc(s.name)}</h2><p class="sub">${esc(s.version)} ${loaderLabel(s)} · ${s.playMs ? `${fmtDur(s.playMs)} played` : 'Not played yet'}</p></div></div>
    <div class="tabs mg-tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab ${MG.tab === k ? 'active' : ''}" role="tab" aria-selected="${MG.tab === k}" data-action="mg-tab" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="mg-body" id="mg-body"></div>
    <div class="modal-actions"><button class="btn" data-action="close">Close</button></div>`, true);
  mgDraw(); mgLoad();
}
function mgDraw() { const b = $('#mg-body'); const s = mgServer(); if (b && s) b.innerHTML = mgBody(s); }
async function mgLoad() {
  const s = mgServer(); if (!s) return;
  if (MG.tab === 'worlds') { try { MG.worlds = await api('GET', `/api/worlds?server=${encodeURIComponent(s.id)}`); } catch (e) { MG.worlds = []; toast(e.message, true); } }
  if (MG.tab === 'shots') { try { MG.shots = await api('GET', `/api/shots?server=${encodeURIComponent(s.id)}`); } catch (e) { MG.shots = []; toast(e.message, true); } }
  if (MG.tab === 'servers') for (const x of s.serverList || []) mgPing(x.address);
  if (MG.tab === 'snaps' || MG.tab === 'perf') return mgLoadExtra();
  mgDraw();
}
async function mgPing(address) {
  MG.pings[address] = null; mgDraw();
  try { MG.pings[address] = await api('GET', `/api/servers/ping-one?address=${encodeURIComponent(address)}`); } catch { MG.pings[address] = { online: false }; }
  mgDraw();
}
const SPIN = (t) => `<div class="sub mg-empty"><span class="spinner"></span>${t}</div>`;
function mgBody(s) {
  if (MG.tab === 'snaps' || MG.tab === 'perf') return mgExtraBody(s);
  if (MG.tab === 'worlds') {
    if (!MG.worlds) return SPIN('Reading worlds…');
    const rows = MG.worlds.map((w) => `<div class="mg-world"><div class="mg-row"><span class="mg-ico">${w.icon ? `<img src="${profileImg(s.id, 'world', w.name)}" alt="">` : ''}</span>
        <div class="mg-info"><b>${esc(w.name)}</b><small>${fmtBytes(w.size)} · ${esc(ago(w.modified).replace('Played', 'Changed'))} · ${w.backups.length} backup${w.backups.length === 1 ? '' : 's'}</small></div>
        <button class="btn small" data-action="mg-backup" data-world="${esc(w.name)}">Back up</button></div>
      ${w.backups.length ? `<div class="mg-backups">${w.backups.map((b) => `<div class="mg-brow"><span class="tnum">${esc(new Date(b.time).toLocaleString())} · ${fmtBytes(b.size)}</span>
        <button class="btn small ${MG.confirm === `r:${b.file}` ? 'primary' : ''}" data-action="mg-restore" data-file="${esc(b.file)}">${MG.confirm === `r:${b.file}` ? 'Confirm restore' : 'Restore'}</button>
        <button class="btn small ${MG.confirm === `d:${b.file}` ? 'danger' : ''}" data-action="mg-delbk" data-file="${esc(b.file)}">${MG.confirm === `d:${b.file}` ? 'Confirm delete' : 'Delete'}</button></div>`).join('')}</div>` : ''}</div>`).join('');
    return `${rows || '<div class="sub mg-empty">No worlds yet. Play this profile and create one.</div>'}
      <p class="sub mg-note">Restoring replaces the world with the backup. Auroria backs up the current world first, so nothing is lost.</p>
      <div class="inline mg-foot"><button class="btn small" data-action="mg-open" data-v="saves">${ICON.folder}Open saves folder</button><button class="btn small" data-action="mg-open" data-v="backups">${ICON.folder}Open backups folder</button></div>`;
  }
  if (MG.tab === 'shots') {
    if (!MG.shots) return SPIN('Finding screenshots…');
    return `${MG.shots.length ? `<div class="mg-shots">${MG.shots.map((x) => `<button class="mg-shot" data-action="mg-shot" data-file="${esc(x.file)}" title="${esc(x.file)}"><img src="${profileImg(s.id, 'shot', x.file)}" alt="" loading="lazy"><span>${esc(new Date(x.time).toLocaleDateString())}</span></button>`).join('')}</div>`
      : '<div class="sub mg-empty">No screenshots yet. Press F2 in game to take one.</div>'}
      <div class="inline mg-foot"><button class="btn small" data-action="mg-shot">${ICON.folder}Open screenshots folder</button></div>`;
  }
  if (MG.tab === 'servers') {
    const idle = G(MG.id).state === 'idle';
    const rows = (s.serverList || []).map((x, i) => {
      const p = MG.pings[x.address];
      const st = p === undefined || p === null ? '<span class="spinner"></span>Checking…' : !p.online ? '<span style="color:var(--err)">Offline</span>'
        : `<span class="dot-on"></span>${fmt(p.players)}/${fmt(p.max)} online · ${p.latency} ms${p.motd ? ` · ${esc(p.motd)}` : ''}`;
      return `<div class="mg-row"><div class="mg-info"><b>${esc(x.name)}</b><small class="mg-srv">${esc(x.address)} · ${st}</small></div>
        <button class="btn primary small" data-action="mg-join" data-addr="${esc(x.address)}" ${idle ? '' : 'disabled'}>Join</button>
        <button class="iconbtn danger" data-action="mg-del-server" data-i="${i}" aria-label="Remove ${esc(x.name)}" title="Remove">${ICON.trash}</button></div>`;
    }).join('');
    return `${rows || '<div class="sub mg-empty">No servers saved for this profile yet.</div>'}
      <div class="mg-add"><input class="input" id="mg-sname" maxlength="40" placeholder="Name"><input class="input" id="mg-saddr" placeholder="play.example.net"><button class="btn" data-action="mg-add-server">${ICON.plus}Add</button></div>
      <p class="sub mg-note">Join starts this profile and drops you straight into that server.</p>`;
  }
  const others = servers().filter((x) => x.id !== s.id);
  if (!others.length) return '<div class="sub mg-empty">Make a second profile to copy settings between them.</div>';
  return `<p class="sub" style="margin:4px 0 14px">Copy your Minecraft settings from another profile into ${esc(s.name)}.</p>
    <div class="form-grid"><label for="mg-from">Copy from</label><select class="input" id="mg-from">${others.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.version)}</option>`).join('')}</select>
    <span>What</span><div class="mg-checks">${[['controls', 'Controls and key binds'], ['video', 'Video settings'], ['sound', 'Sound volumes']].map(([k, l]) => `<label><input type="checkbox" class="mg-grp" value="${k}" checked> ${l}</label>`).join('')}</div></div>
    <div class="inline mg-foot"><button class="btn primary" data-action="mg-sync">Copy settings</button><span class="sub" id="mg-sync-out"></span></div>`;
}
/* ---------------- resource packs and shaders ---------------- */
async function loadPacks() {
  const type = S.modTab === 'shaders' ? 'shader' : 'resourcepack'; const sid = selected().id;
  if (!S.packs || S.packs.type !== type || S.packs.sid !== sid) { S.packs = { type, sid, list: null }; render(); }
  try { S.packs = { type, sid, list: await api('GET', `/api/packs?server=${encodeURIComponent(sid)}&type=${type}`) }; } catch (e) { S.packs = { type, sid, list: [] }; toast(e.message, true); }
  render();
}
const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
function packsBody(type) {
  const ok = S.packs && S.packs.type === type && S.packs.sid === selected().id;
  const list = ok ? S.packs.list : null;
  const del = (n) => `<button class="iconbtn" data-action="pack-delete" data-name="${esc(n)}" aria-label="Delete ${esc(n)}" title="Delete">${ICON.trash}</button>`;
  const clean = (n) => esc(n.replace(/\.zip$/i, ''));
  let rows;
  if (!list) rows = '<div class="empty"><span class="spinner"></span></div>';
  else if (!list.length) rows = `<div class="empty"><strong>No ${type === 'shader' ? 'shaders' : 'resource packs'} yet</strong>Find some under Browse, or drop .zip files into the folder.</div>`;
  else if (type === 'shader') {
    const any = list.some((x) => x.enabled);
    rows = [`<div class="mod pack"><div class="mod-name"><span class="radio ${any ? '' : 'on'}"></span><div><b>Off</b><small>Play without shaders</small></div></div><span></span><div class="mod-actions"><button class="btn small ${any ? '' : 'primary'}" data-action="shader-pick" data-name="">${any ? 'Use' : 'In use'}</button></div></div>`,
      ...list.map((x) => `<div class="mod pack"><div class="mod-name"><span class="radio ${x.enabled ? 'on' : ''}"></span><div><b>${clean(x.name)}</b><small>${esc(x.name)}</small></div></div><span></span><div class="mod-actions">${del(x.name)}<button class="btn small ${x.enabled ? 'primary' : ''}" data-action="shader-pick" data-name="${esc(x.name)}">${x.enabled ? 'In use' : 'Use'}</button></div></div>`)].join('');
  } else {
    const on = list.filter((x) => x.enabled); const off = list.filter((x) => !x.enabled);
    const row = (x, i) => `<div class="mod pack ${x.enabled ? 'drag' : ''}" ${x.enabled ? 'draggable="true"' : ''} data-name="${esc(x.name)}"><div class="mod-name">${x.enabled ? `<span class="grip" title="Drag to reorder">${GRIP}</span><span class="pack-pos tnum">${i + 1}</span>` : '<span class="grip off"></span><span class="pack-pos"></span>'}<div><b>${clean(x.name)}</b><small>${esc(x.name)}</small></div></div><span></span>
      <div class="mod-actions">${del(x.name)}<button class="switch" role="switch" aria-checked="${x.enabled}" aria-label="${clean(x.name)}" data-action="pack-toggle" data-name="${esc(x.name)}"></button></div></div>`;
    rows = `${on.length ? `<div class="pack-sec">On · top wins</div><div id="pack-on">${on.map(row).join('')}</div>` : ''}${off.length ? `<div class="pack-sec">Off</div>${off.map((x) => row(x, 0)).join('')}` : ''}`;
  }
  return `<div class="card list"><div class="list-head"><span>${type === 'shader' ? 'SHADER' : 'RESOURCE PACK'}</span><span></span><span style="text-align:right">${type === 'shader' ? '' : 'ON'}</span></div><div class="list-body">${rows}</div></div>`;
}
async function savePackOrder(order) {
  try { S.packs.list = await api('POST', '/api/packs/order', { server: selected().id, order }); } catch (e) { toast(e.message, true); }
  render();
}
let packDrag = null;
document.addEventListener('dragstart', (e) => { const r = e.target.closest && e.target.closest('.pack.drag'); if (!r) return; packDrag = r; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', r.dataset.name); } catch {} });
document.addEventListener('dragover', (e) => {
  if (!packDrag) return; const over = e.target.closest && e.target.closest('#pack-on .pack.drag'); if (!over || over === packDrag) { if (over) e.preventDefault(); return; }
  e.preventDefault(); const r = over.getBoundingClientRect(); over.parentNode.insertBefore(packDrag, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
});
document.addEventListener('drop', (e) => { if (packDrag) e.preventDefault(); });
document.addEventListener('dragend', () => {
  if (!packDrag) return; packDrag.classList.remove('dragging'); packDrag = null;
  const order = [...document.querySelectorAll('#pack-on .pack.drag')].map((x) => x.dataset.name);
  const before = (S.packs.list || []).filter((x) => x.enabled).map((x) => x.name);
  if (order.join('\n') !== before.join('\n')) savePackOrder(order);
});

/* ---------------- theme ---------------- */
const ACCENTS = [['#f07f2a', 'Ember'], ['#e5484d', 'Redstone'], ['#f5b82e', 'Gold'], ['#5fb34a', 'Emerald'], ['#2ec4b6', 'Diamond'], ['#4a8fe0', 'Lapis'], ['#9b6cf0', 'Amethyst'], ['#e85d9e', 'Pink']];
const applyAccent = (hex) => { window.auroriaAccent(hex); lightHome(); };
// The home character is lit by the theme's scene: sun, fill and haze take its colours.
function lightHome() {
  const v = S.homeViewer; const t = window.auroriaTheme; if (!v || !t || !v.__sun) return;
  v.__sun.color.set(t.sun); v.globalLight.color.set(t.amb); if (t.cam) v.cameraLight.color.set(t.cam); else { v.cameraLight.color.set(t.sun); v.cameraLight.color.lerp(v.globalLight.color, 0.5); }
  if (v.scene.fog) v.scene.fog.color.set(t.fog);
}

/* ---------------- snapshots and presets (manage window) ---------------- */
async function mgLoadExtra() {
  const s = mgServer(); if (!s) return;
  if (MG.tab === 'snaps') { try { MG.snaps = await api('GET', `/api/snapshots?server=${encodeURIComponent(s.id)}`); } catch (e) { MG.snaps = []; toast(e.message, true); } }
  if (MG.tab === 'perf' && !MG.presets) { try { MG.presets = await api('GET', '/api/presets'); } catch (e) { toast(e.message, true); } }
  mgDraw();
}
const SNAP_LABEL = { manual: 'Saved by you', 'before-update': 'Before updating mods', 'before-restore': 'Before restoring a snapshot' };
function mgExtraBody(s) {
  if (MG.tab === 'snaps') {
    if (!MG.snaps) return SPIN('Reading snapshots…');
    const rows = MG.snaps.map((x) => `<div class="mg-row"><div class="mg-info"><b>${esc(new Date(x.time).toLocaleString())}</b><small>${esc(SNAP_LABEL[x.label] || x.label)} · ${fmtBytes(x.size)}</small></div>
      <button class="btn small ${MG.confirm === `sr:${x.file}` ? 'primary' : ''}" data-action="snap-restore" data-file="${esc(x.file)}">${MG.confirm === `sr:${x.file}` ? 'Confirm restore' : 'Restore'}</button>
      <button class="btn small ${MG.confirm === `sd:${x.file}` ? 'danger' : ''}" data-action="snap-delete" data-file="${esc(x.file)}">${MG.confirm === `sd:${x.file}` ? 'Confirm delete' : 'Delete'}</button></div>`).join('');
    return `<div class="inline mg-foot" style="margin:0 0 10px"><button class="btn primary small" data-action="snap-take">${ICON.plus}Take snapshot</button></div>
      ${rows || '<div class="sub mg-empty">No snapshots yet.</div>'}
      <p class="sub mg-note">A snapshot saves this profile's mods and their settings. Auroria takes one by itself before updating mods, so a bad update can be undone. Restoring takes a snapshot of the current state first.</p>`;
  }
  if (!MG.presets) return SPIN('Loading presets…');
  const cards = MG.presets.presets.map((p) => `<div class="preset ${s.preset === p.key ? 'on' : ''}"><b>${esc(p.name)}</b>
      <ul><li>${p.ramGB} GB memory</li><li>${p.video.renderDistance} chunk view distance</li><li>${p.video.graphics ? 'Fancy' : 'Fast'} graphics</li><li>${p.video.maxFps >= 260 ? 'Unlimited' : p.video.maxFps} FPS cap</li></ul>
      <button class="btn small ${s.preset === p.key ? '' : 'primary'}" data-action="preset-apply" data-v="${p.key}">${s.preset === p.key ? 'Apply again' : 'Apply'}</button></div>`).join('');
  return `<p class="sub" style="margin:4px 0 14px">One click sets memory, Java garbage-collector flags and video settings for ${esc(s.name)}. Your PC has ${MG.presets.totalGB} GB of RAM.</p>
    <div class="presets">${cards}</div>
    <p class="sub mg-note">Video settings are written to this profile's options.txt, so you can still change them in game afterwards.</p>`;
}

// Modpacks often have builds for several Minecraft versions: pick one, then the pack version for it.
async function packModal(id, title) {
  S.packPick = { id, title, versions: null };
  modal(`<h2>Install ${esc(title)}</h2><p class="sub" style="margin:6px 0 0">It becomes a new profile with its own folder.</p><div id="pk-body">${SPIN('Finding versions…')}</div>`);
  let list = [];
  try { list = await api('GET', `/api/modpacks/versions?projectId=${encodeURIComponent(id)}`); } catch (e) { toast(e.message, true); }
  if (!S.packPick || S.packPick.id !== id) return;
  S.packPick.versions = list;
  const mcs = [...new Set(list.flatMap((v) => v.gameVersions))].sort((a, b) => cmpVer(b, a));
  const want = S.packMc && mcs.includes(S.packMc) ? S.packMc : mcs[0];
  const box = $('#pk-body'); if (!box) return;
  box.innerHTML = list.length ? `<div class="form-grid"><label for="pk-mc">Minecraft</label><select class="input" id="pk-mc">${mcs.map((m) => `<option value="${esc(m)}" ${m === want ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      <label for="pk-ver">Pack version</label><select class="input" id="pk-ver"></select></div>
      <div class="modal-actions"><button class="btn" data-action="close">Cancel</button><button class="btn primary" data-action="pack-go">Install</button></div>`
    : '<div class="sub mg-empty">This modpack has no versions to install.</div><div class="modal-actions"><button class="btn" data-action="close">Close</button></div>';
  if (list.length) packVersionOptions();
}
function packVersionOptions() {
  const P = S.packPick; const mc = ($('#pk-mc') || {}).value; const sel = $('#pk-ver'); if (!P || !sel) return;
  const fits = P.versions.filter((v) => v.gameVersions.includes(mc));
  sel.innerHTML = fits.map((v, i) => `<option value="${esc(v.id)}">${esc(v.number)}${v.loaders.length ? ` · ${esc(v.loaders.map((l) => LOADER_NAMES[l] || l).join(', '))}` : ''}${i === 0 ? ' · newest' : ''}</option>`).join('');
}

let depResolve = null;
// Asks before removing or turning off a mod that other installed mods list as required.
async function confirmDependents(file, verb) {
  let names = [];
  try { names = await api('GET', `/api/mods/dependents?server=${encodeURIComponent(selected().id)}&file=${encodeURIComponent(file)}`); } catch {}
  if (!names.length) return true;
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  return new Promise((resolve) => {
    depResolve = resolve;
    modal(`<h2>Other mods need this one</h2><p>${esc(list)} ${names.length > 1 ? 'require' : 'requires'} it. ${verb === 'Remove' ? 'Removing' : 'Turning off'} it will probably stop the game from starting.</p>
      <div class="modal-actions"><button class="btn" data-action="dep-answer" data-v="0">Keep it</button><button class="btn danger" data-action="dep-answer" data-v="1">${verb} anyway</button></div>`);
  });
}
const javaFor = (v) => (cmpVer(v, '1.17') < 0 ? 8 : cmpVer(v, '1.18') < 0 ? 16 : cmpVer(v, '1.20.5') < 0 ? 17 : 21);
function pmJavaHint() {
  const sel = $('#pm-java'); const hint = $('#pm-java-hint'); if (!sel || !hint) return;
  const v = ($('#srv-version') || {}).value || '';
  const need = javaFor(/^\d/.test(v) ? v : PM.version || '1.20.1');
  const opt = sel.selectedOptions[0]; const major = Number(opt && opt.dataset.major) || 0;
  hint.innerHTML = !sel.value ? `Auroria downloads and uses Java ${need} for this version.`
    : major && major !== need ? `<span style="color:var(--warn)">This version expects Java ${need}. Java ${major} may not start it.</span>` : `Uses ${esc(sel.value)}`;
}
async function pmJavaLoad(s) {
  try {
    const r = await api('GET', `/api/java?server=${encodeURIComponent((s && s.id) || selected().id)}`);
    const sel = $('#pm-java'); if (!sel) return;
    const cur = (s && s.javaPath) || '';
    sel.innerHTML = '<option value="">Automatic</option>' + r.list.map((j) => `<option value="${esc(j.path)}" data-major="${j.major}" ${j.path === cur ? 'selected' : ''} title="${esc(j.path)}">Java ${j.major || '?'} (${esc(j.version)}) · ${esc(j.source)}</option>`).join('')
      + (cur && !r.list.some((j) => j.path === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : '');
    pmJavaHint();
  } catch {}
}

/* ---------------- game logs ---------------- */
const LOG_MAX = 5000, LOG_SHOWN = 2500;
// Each profile's game keeps its own log; S.logs, S.logCounts and S.logSeq always mean the log on screen (S.logSid).
S.logBufs = {}; S.logSid = '';
const logBuf = (sid) => (S.logBufs[sid || ''] = S.logBufs[sid || ''] || { logs: [], counts: { info: 0, warn: 0, error: 0, debug: 0 }, seq: 0 });
Object.defineProperties(S, {
  logs: { get: () => logBuf(S.logSid).logs, set: (v) => { logBuf(S.logSid).logs = v; } },
  logCounts: { get: () => logBuf(S.logSid).counts, set: (v) => { logBuf(S.logSid).counts = v; } },
  logSeq: { get: () => logBuf(S.logSid).seq, set: (v) => { logBuf(S.logSid).seq = v; } },
});
Object.assign(S, { logs: [], logCounts: { info: 0, warn: 0, error: 0, debug: 0 }, logSeq: 0, logShown: 0, logLevel: 'all', logQuery: '', logFollow: true, logWrap: true, logSession: false });
function logClassify(t, prev) {
  if (/^Caused by:/.test(t)) return 'error';
  if (/^\s+at\s|^\s*\.\.\.\s\d+\smore/.test(t)) return prev || 'error';
  if (/\b(FATAL|SEVERE)\b|\bERROR\b|\/ERROR\]|Exception\b/.test(t)) return 'error';
  if (/\bWARN(ING)?\b/.test(t)) return 'warn';
  if (/\b(DEBUG|TRACE)\b/.test(t)) return 'debug';
  return 'info';
}
function logAdd(text, sid = S.logSid) {
  const b = logBuf(sid);
  const prev = b.logs.length ? b.logs[b.logs.length - 1].lvl : '';
  const e = { n: ++b.seq, text, lvl: logClassify(text, prev) };
  b.logs.push(e); b.counts[e.lvl]++;
  if (b.logs.length > LOG_MAX) b.counts[b.logs.shift().lvl]--;
  return e;
}
function logReset(sid = S.logSid) { S.logBufs[sid || ''] = null; logBuf(sid); if (sid === S.logSid) S.logShown = 0; if (S.page === 'logs') render(true); navLogsVisible(); }
const logMatches = (e) => (S.logLevel === 'all' || e.lvl === S.logLevel) && (!S.logQuery || e.text.toLowerCase().includes(S.logQuery.toLowerCase()));
function logHtml(e) {
  let body;
  if (S.logQuery) { const re = new RegExp(`(${S.logQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'); body = e.text.split(re).map((p, i) => (i % 2 ? `<mark>${esc(p)}</mark>` : esc(p))).join(''); }
  else body = esc(e.text);
  return `<div class="ll lv-${e.lvl}"><span class="ln">${e.n}</span><span class="lt">${body}</span></div>`;
}
function logViewHtml() {
  const list = S.logs.filter(logMatches); S.logShown = list.length;
  return list.length ? list.slice(-LOG_SHOWN).map(logHtml).join('') : `<div class="log-empty">${S.logs.length ? 'No lines match your search.' : 'No output yet.'}</div>`;
}
function logCounters() {
  const c = S.logCounts, set = { all: S.logs.length, info: c.info, warn: c.warn, error: c.error, debug: c.debug };
  document.querySelectorAll('[data-action="log-level"]').forEach((b) => { b.querySelector('.count').textContent = fmt(set[b.dataset.v]); });
  const el = $('#log-count'); if (el) el.textContent = `${fmt(S.logShown)} of ${fmt(S.logs.length)} lines`;
}
function logRepaint() {
  const v = $('#logview'); if (!v) return;
  v.innerHTML = logViewHtml(); if (S.logFollow) v.scrollTop = v.scrollHeight; logCounters();
}
function navLogsVisible() {
  const n = $('#nav-logs'); if (!n || !S.state) return;
  const live = anyGame();
  n.hidden = !(live || S.page === 'logs'); // only while a game is starting or running (or while you are on the page)
  n.classList.toggle('live', live);
}
let logRaf = 0; const logPend = [];
function logIngest(line, sid) { logPend.push([line, sid || '']); if (!logRaf) logRaf = requestAnimationFrame(logFlush); }
function logFlush() {
  logRaf = 0; const v = S.page === 'logs' ? $('#logview') : null; let html = '';
  for (const [l, sid] of logPend.splice(0)) { const e = logAdd(l, sid); if (v && sid === S.logSid && logMatches(e)) { html += logHtml(e); S.logShown++; } }
  if (v) {
    if (html) { const em = v.querySelector('.log-empty'); if (em) em.remove(); v.insertAdjacentHTML('beforeend', html); while (v.childElementCount > LOG_SHOWN) v.firstElementChild.remove(); if (S.logFollow) v.scrollTop = v.scrollHeight; }
    logCounters();
  }
  navLogsVisible();
}
function logAfterRender() { const v = $('#logview'); if (v && S.logFollow) v.scrollTop = v.scrollHeight; logCounters(); }
function pageLogs() {
  const g = G(S.logSid); const srv = servers().find((s) => s.id === S.logSid); const nm = esc(srv ? srv.name : 'Minecraft');
  const sessions = Object.keys(S.logBufs).filter((k) => k && S.logBufs[k] && (S.logBufs[k].logs.length || G(k).state !== 'idle'));
  const pick = sessions.length > 1 ? `<div class="seg log-pick" role="radiogroup" aria-label="Which game">${sessions.map((k) => { const x = servers().find((s) => s.id === k); return `<button role="radio" aria-checked="${k === S.logSid}" data-action="log-session" data-v="${esc(k)}">${G(k).state !== 'idle' ? '<span class="dot-on"></span>' : ''}${esc(x ? x.name : k)}</button>`; }).join('')}</div>` : '';
  const status = g.state === 'running' ? `<span class="dot-on"></span>${nm} is running` : g.state === 'preparing' ? `<span class="spinner"></span>Preparing ${nm}…`
    : S.logs.length ? 'The game is closed. Showing the last session.' : 'Nothing has run yet. Press Play and the output appears here.';
  const seg = [['all', 'All'], ['info', 'Info'], ['warn', 'Warnings'], ['error', 'Errors'], ['debug', 'Debug']].map(([k, l]) => `<button role="radio" aria-checked="${S.logLevel === k}" class="lv-${k}" data-action="log-level" data-v="${k}">${l}<span class="count">0</span></button>`).join('');
  return `<header class="page-head logs-head"><div><h1>Game logs</h1><p class="log-status">${status}</p></div>
    <div class="inline">${g.state !== 'idle' ? `<button class="btn" data-action="stop" data-id="${esc(S.logSid)}">Stop game</button>` : ''}</div></header>${pick}
  <div class="toolbar logbar"><div class="seg" role="radiogroup" aria-label="Log level">${seg}</div>
    <div class="inline"><label class="search">${ICON.search}<input id="log-search" type="search" placeholder="Search the log" aria-label="Search the log" value="${esc(S.logQuery)}"></label>
      <button class="btn small ${S.logWrap ? 'on' : ''}" data-action="log-wrap" aria-pressed="${S.logWrap}">Wrap</button>
      <button class="btn small" data-action="log-copy">Copy</button>
      <button class="btn small" data-action="log-save">Save</button>
      <button class="btn small" data-action="log-upload" title="Upload to mclo.gs and copy the link">Upload</button>
      <button class="btn small" data-action="log-clear">Clear</button></div></div>
  <div class="logview ${S.logWrap ? 'wrap' : ''}" id="logview" tabindex="0" role="log" aria-label="Game output">${logViewHtml()}</div>
  <div class="logfoot"><span id="log-count"></span><button class="btn small" id="log-jump" data-action="log-follow" ${S.logFollow ? 'hidden' : ''}>Jump to latest</button></div>`;
}
let logSearchTimer;
document.addEventListener('scroll', (e) => {
  if (!e.target || e.target.id !== 'logview') return;
  const v = e.target; S.logFollow = v.scrollHeight - v.scrollTop - v.clientHeight < 24;
  const j = $('#log-jump'); if (j) j.hidden = S.logFollow;
}, true);

const PAGES = { home: pageHome, servers: pageServers, mods: pageMods, skins: pageSkins, logs: pageLogs, settings: pageSettings };
let renderTimer = null;
function render(force) {
  if (!S.state) return;
  // Hold data-driven re-renders until the page entrance animation has played.
  if (!force && Date.now() < S.enterUntil) { clearTimeout(renderTimer); renderTimer = setTimeout(() => render(true), S.enterUntil - Date.now() + 10); return; }
  clearTimeout(renderTimer);
  const focusId = document.activeElement && document.activeElement.id;
  const caret = document.activeElement && 'selectionStart' in document.activeElement ? document.activeElement.selectionStart : null;
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n.dataset.page === S.page));
  $('#app').classList.toggle('is-home', S.page === 'home');
  if (NATIVE) S.state.windowControls = true;
  $('#app').classList.toggle('frameless', !!S.state.windowControls);
  $('#winctl').hidden = !S.state.windowControls;
  renderAccount();
  const page = $('#page');
  const lbTop = ($('.list-body') || {}).scrollTop || 0;
  page.innerHTML = PAGES[S.page]();
  const lb = $('.list-body'); if (lb && lbTop) lb.scrollTop = lbTop;
  hookBrowse();
  if (S.page === 'logs') logAfterRender();
  navLogsVisible();
  if (S.entering) {
    S.entering = false; page.classList.remove('enter'); void page.offsetWidth; page.classList.add('enter');
    S.enterUntil = REDUCED ? 0 : Date.now() + 800;
  } else if (Date.now() >= S.enterUntil) page.classList.remove('enter');
  const act = document.querySelector('.nav.active'); const ind = $('.rail-indicator');
  if (act && ind) { ind.style.opacity = '1'; ind.style.transform = `translateY(${act.offsetTop + act.offsetHeight / 2 - 14}px)`; }
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (caret != null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch {} } }
  mount3d();
  S.paintP = paintSkins();
}

/* ---------------- data loading ---------------- */
async function loadPings() {
  try { const list = await api('GET', '/api/servers/ping'); for (const p of list) S.pings[p.id] = p; render(); } catch {}
}
/* ---------------- import from other launchers ---------------- */
async function importModal() {
  modal(`<h2>Import profiles</h2><p class="sub" style="margin:6px 0 0">Copies a profile from another launcher into Auroria. Your original stays untouched.</p>
    <div id="imp-list" class="imp-list"><div class="sub" style="padding:14px 0;display:flex;gap:8px;align-items:center"><span class="spinner"></span>Looking for other launchers…</div></div>
    <div class="modal-actions"><button class="btn" data-action="imp-file">${ICON.upload}From a .mrpack file</button><button class="btn" data-action="close">Close</button></div>`);
  let list = [];
  try { list = await api('GET', '/api/import/scan'); } catch (e) { list = []; toast(e.message, true); }
  const box = $('#imp-list'); if (!box) return;
  box.innerHTML = list.length ? list.map((e) => `<div class="imp-row"><div class="imp-info"><b>${esc(e.name)}</b><small>${esc(e.source)} · ${esc(e.version)} · ${esc(LOADER_NAMES[e.loader] || e.loader)}</small></div><button class="btn small" data-action="imp-run" data-id="${esc(e.id)}">Import</button></div>`).join('')
    : '<div class="sub" style="padding:14px 0">No other launchers found. Modrinth App, Prism Launcher, PolyMC, MultiMC, CurseForge and the Minecraft Launcher are checked. You can still import a Modrinth modpack file.</div>';
}
async function importDone(r, label) {
  S.state.config.servers = r.servers;
  await saveSettings({ selectedServer: r.id });
  closeModal(); S.mods = null; S.modsServer = null; render(); loadPings();
  toast(r.failed ? `${label} imported. ${r.failed} mod file${r.failed > 1 ? 's' : ''} could not be downloaded.` : `${label} imported and selected`, !!r.failed);
}
async function loadMods(force) {
  const s = selected();
  if (s.loader === 'vanilla') return;
  if (!force && S.modsServer === s.id && S.mods) return;
  S.modsServer = s.id; S.mods = null; S.updates = null; render();
  try { S.mods = await api('GET', `/api/mods?server=${encodeURIComponent(s.id)}`); } catch (e) { S.mods = []; toast(e.message, true); }
  modsSigBusy = true; try { S.modsSig = await api('GET', `/api/mods/sig?server=${encodeURIComponent(s.id)}`); } catch {} modsSigBusy = false;
  render();
  try { S.updates = await api('GET', `/api/mods/updates?server=${encodeURIComponent(s.id)}`); } catch { S.updates = []; }
  render();
}
// Mods dropped into (or deleted from) the folder by hand show up without a restart: poll a cheap file signature, then reload.
let modsSigBusy = false;
async function checkModsFolder() {
  const s = selected();
  if (modsSigBusy || document.hidden || S.page !== 'mods' || s.loader === 'vanilla' || !S.mods || S.modsServer !== s.id || S.modTab === 'browse') return;
  modsSigBusy = true;
  try {
    const sig = await api('GET', `/api/mods/sig?server=${encodeURIComponent(s.id)}`);
    if (sig === S.modsSig) return;
    S.modsSig = sig;
    const known = new Map((S.mods || []).map((m) => [m.sha1, m]));
    const fast = await api('GET', `/api/mods?server=${encodeURIComponent(s.id)}&fast=1`);
    S.mods = fast.map((m) => ({ ...(known.get(m.sha1) || {}), ...m, ...(known.get(m.sha1) ? { title: known.get(m.sha1).title } : {}) }));
    render();
    S.mods = await api('GET', `/api/mods?server=${encodeURIComponent(s.id)}`); render();
    try { S.updates = await api('GET', `/api/mods/updates?server=${encodeURIComponent(s.id)}`); render(); } catch {}
  } catch {} finally { modsSigBusy = false; }
}
let searchTimer;
let searchSeq = 0;
function browseMoreHtml() {
  if (!Array.isArray(S.browse) || S.browse.length >= (S.browseTotal || 0)) return '';
  return `<div id="browse-sentinel" style="padding:16px;text-align:center"><button class="btn" data-action="browse-more" ${S.busy.more ? 'disabled' : ''}>${S.busy.more ? 'Loading…' : `Load more <span class="sub tnum">(${compact(S.browseTotal - S.browse.length)} left)</span>`}</button></div>`;
}
let browseIO = null;
function hookBrowse() {
  if (browseIO) { browseIO.disconnect(); browseIO = null; }
  const sen = document.getElementById('browse-sentinel'); const body = $('.list-body');
  if (!sen || !body || S.browseErr) return;
  browseIO = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && !S.busy.more) searchMods(true); }, { root: body, rootMargin: '0px 0px 500px 0px' });
  browseIO.observe(sen);
}
async function searchMods(append) {
  const s = selected(); const seq = ++searchSeq;
  if (append) { if (S.busy.more) return; S.busy.more = true; const b = document.querySelector('#browse-sentinel .btn'); if (b) { b.disabled = true; b.textContent = 'Loading…'; } }
  else { S.browse = null; S.browseTotal = 0; S.browseErr = false; render(); }
  const offset = append && Array.isArray(S.browse) ? S.browse.length : 0;
  try {
    if (S.browseType === 'modpack' && !S.versions) api('GET', '/api/versions').then((v) => { S.versions = v; if (S.page === 'mods') render(); }).catch(() => {});
    const r = await api('GET', `/api/mods/search?server=${encodeURIComponent(s.id)}&q=${encodeURIComponent(S.modQuery)}&type=${S.browseType}&sort=${S.browseSort}&offset=${offset}${S.browseType === 'modpack' && S.packMc ? `&mc=${encodeURIComponent(S.packMc)}` : ''}`);
    if (seq !== searchSeq) return;
    S.browse = append && Array.isArray(S.browse) ? S.browse.concat(r.hits) : r.hits; S.browseTotal = r.total;
    S.busy.more = false;
    const body = $('.list-body');
    if (append && body && S.page === 'mods' && S.modTab === 'browse') {
      const old = document.getElementById('browse-sentinel'); if (old) old.remove();
      body.insertAdjacentHTML('beforeend', r.hits.map(browseRow).join('') + browseMoreHtml()); hookBrowse(); return;
    }
  } catch (e) { if (seq !== searchSeq) return; if (append) { S.browseErr = true; toast(e.message, true); } else S.browse = { error: e.message }; }
  S.busy.more = false; render();
}
async function loadSkins() { try { S.skins = await api('GET', '/api/skins'); render(); } catch (e) { toast(e.message, true); } }

function go(page) {
  S.page = page; S.menuOpen = false; S.entering = true; S.enterUntil = 0; render(true);
  if (page === 'servers' || page === 'home') loadPings();
  if (page === 'mods') {
    if (selected().loader === 'vanilla') { S.modTab = 'browse'; S.browseType = 'resourcepack'; searchMods(); }
    else { if (S.browseType === 'resourcepack' && S.modTab === 'browse' && S.lastVanilla) S.browseType = 'mod'; loadMods(); if (S.modTab === 'browse') searchMods(); }
    S.lastVanilla = selected().loader === 'vanilla';
    if (S.modTab === 'packs' || S.modTab === 'shaders') loadPacks();
  }
  if (page === 'skins') loadSkins();
}

/* ---------------- modals ---------------- */
function modal(html, wide) { $('#modal-body').className = 'modal' + (wide ? ' wide' : ''); $('#modal-body').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; if (S.authActive) { api('POST', '/api/auth/cancel').catch(() => {}); S.authActive = false; } }
async function signIn() {
  if (!S.state.hasClientId) { setupModal(); return; }
  modal(`<h2>Sign in with Microsoft</h2><p><span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>Getting a sign-in code…</p>`);
  try {
    const r = await api('POST', '/api/auth/start'); S.authActive = true; S.authUri = r.verificationUri;
    modal(`<h2>Sign in with Microsoft</h2><p>Open the Microsoft sign-in page and enter this code.${S.state.authMode === 'launcher' ? ' Microsoft will show the request as coming from the Minecraft Launcher.' : ''} Auroria finishes signing in by itself once you are done.</p>
      <div class="code">${esc(r.userCode)}</div><p class="sub" id="auth-status" style="display:flex;gap:8px;align-items:center"><span class="spinner"></span>Waiting for you to sign in…</p>
      <div class="modal-actions"><button class="btn" data-action="close">Cancel</button><button class="btn" data-action="copy" data-text="${esc(r.userCode)}">Copy code</button><button class="btn primary" data-action="open-auth">Open sign-in page</button></div>`);
  } catch (e) { modal(`<h2>Sign-in failed</h2><p>${esc(e.message)}</p><div class="modal-actions"><button class="btn" data-action="close">Close</button></div>`); }
}
const PROFILE_COLORS = ['#f07f2a', '#e0a030', '#5fb34a', '#3fa7a0', '#4a8fe0', '#8a6ad0', '#d4483a', '#8f857b'];
const PM = {}; // modal state
async function serverModal(s) {
  const editing = !!s;
  s = s || { name: '', address: '', version: '', loader: 'fabric', loaderVersion: '', mods: [], color: PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)], ramGB: 0, description: '' };
  Object.assign(PM, { id: s.id || '', version: s.version, loader: s.loader || 'vanilla', loaderVersion: s.loaderVersion || '', color: s.color || '#f07f2a', icon: s.icon || '', filter: 'release' });
  const loaderBtns = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].map((l) => `<button role="radio" aria-checked="${PM.loader === l}" data-action="pm-loader" data-v="${l}">${LOADER_ICON[l]}${LOADER_NAMES[l]}</button>`).join('');
  modal(`<h2>${editing ? 'Edit profile' : 'New profile'}</h2>
    <div class="form-grid">
      <label for="srv-name">Name</label>
      <div class="inline" style="flex-wrap:nowrap"><button class="p-icon" id="pm-icon" data-action="pm-icon-pick" title="Click to use your own icon" aria-label="Choose profile icon" style="${iconStyle(PM.color, PM.icon)};flex:none">${PM.icon ? '' : esc(initials(s.name || 'New'))}</button><input class="input" id="srv-name" maxlength="48" placeholder="Survival 1.21" value="${esc(s.name)}" style="flex:1"></div>
      <span>Colour</span><div class="inline" style="gap:6px 14px"><div class="swatches" role="radiogroup" aria-label="Profile colour">${PROFILE_COLORS.map((c) => `<button role="radio" aria-checked="${c === PM.color}" aria-label="Colour ${c}" data-action="pm-color" data-v="${c}" style="background:${c}"></button>`).join('')}</div><button class="linkish" id="pm-icon-clear-btn" data-action="pm-icon-clear" ${PM.icon ? '' : 'hidden'}>Remove icon</button></div>
      <span>Game version</span>
      <div class="inline" style="flex-wrap:nowrap"><div class="seg" role="radiogroup" aria-label="Version type" style="display:inline-flex;flex:none">${[['release', 'Releases'], ['snapshot', 'Snapshots'], ['old', 'Beta and alpha']].map(([k, l]) => `<button role="radio" aria-checked="${PM.filter === k}" data-action="pm-filter" data-v="${k}">${l}</button>`).join('')}</div>
        <div style="flex:1;min-width:0" id="pm-version-wrap"><select class="input" id="srv-version" style="width:100%"><option>Loading versions…</option></select></div></div>
      <span>Loader</span><div class="seg wrap" role="radiogroup" aria-label="Loader">${loaderBtns}</div>
      <label for="pm-loader-version" id="pm-lv-label">Loader version</label>
      <div id="pm-lv-wrap"><select class="input" id="pm-loader-version" style="width:100%"><option value="">Recommended</option></select><div class="hint" id="pm-lv-hint"></div></div>
    </div>
    <details class="adv"${s.address || (s.mods || []).length || s.ramGB ? ' open' : ''}><summary>More options</summary>
    <div class="form-grid">
      <label for="srv-address">Join server</label>
      <div><div class="inline" style="flex-wrap:nowrap"><input class="input" id="srv-address" style="flex:1" placeholder="Optional: play.example.net (Play joins it)" value="${esc(s.address)}"><button class="btn" data-action="srv-check">Check</button></div>
        <div class="hint" id="srv-check-out" style="display:flex;gap:8px;align-items:center"></div></div>
      <label for="pm-ram">Memory</label>
      <select class="input" id="pm-ram" style="width:200px"><option value="0">Default (${S.state.settings.ramGB} GB)</option>${[2, 3, 4, 6, 8, 10, 12, 16].map((g) => `<option value="${g}" ${Number(s.ramGB) === g ? 'selected' : ''}>${g} GB</option>`).join('')}</select>
      <label for="pm-java">Java</label>
      <div><select class="input" id="pm-java" style="width:100%"><option value="">Automatic</option>${s.javaPath ? `<option value="${esc(s.javaPath)}" selected>${esc(s.javaPath)}</option>` : ''}</select><div class="hint" id="pm-java-hint"></div></div>
      ${(S.state.accounts || []).length > 1 ? `<label for="pm-account">Account</label>
      <div><select class="input" id="pm-account" style="width:100%"><option value="">The account selected in the top corner</option>${S.state.accounts.map((a) => `<option value="${esc(a.id)}" ${s.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select><div class="hint">Give each profile its own account to play several at the same time.</div></div>` : ''}
      <label for="srv-mods" id="pm-mods-label">Auto-install mods</label>
      <div id="srv-mods-field"><input class="input" id="srv-mods" style="width:100%" placeholder="Modrinth names: fabric-api, sodium" title="Installed the first time you press Play" value="${esc((s.mods || []).join(', '))}"></div>
    </div></details>
    <p id="srv-error" style="color:var(--err);margin:12px 0 0" hidden></p>
    <div class="modal-actions">${editing ? `<button class="btn" style="margin-right:auto" data-action="delete-server" data-id="${esc(s.id)}">${ICON.trash}Delete</button>` : ''}<button class="btn" data-action="close">Cancel</button><button class="btn primary" data-action="srv-save">${editing ? 'Save changes' : 'Create profile'}</button></div>`);
  $('#srv-name').addEventListener('input', (e) => { if (!PM.icon) $('#pm-icon').textContent = initials(e.target.value || 'New'); });
  pmLoaderUi(); pmJavaHint(); pmJavaLoad(editing ? s : null);
  try {
    if (!S.versions) S.versions = await api('GET', '/api/versions');
    if (!PM.version) PM.version = S.versions.latest.release;
    const cur = S.versions.versions.find((v) => v.id === PM.version);
    if (cur) PM.filter = cur.type === 'release' ? 'release' : cur.type === 'snapshot' ? 'snapshot' : 'old';
    document.querySelectorAll('[data-action="pm-filter"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === PM.filter)));
    pmVersions();
  } catch {
    $('#pm-version-wrap').innerHTML = `<input class="input" id="srv-version" style="width:200px" placeholder="1.21.1" value="${esc(PM.version || '1.21.1')}"><div class="hint">Version list unavailable offline. Type a version.</div>`;
  }
  pmLoaderVersions();
}
function pmVersions() {
  const sel = $('#srv-version'); if (!sel || sel.tagName !== 'SELECT' || !S.versions) return;
  const want = PM.filter === 'old' ? ['old_beta', 'old_alpha'] : [PM.filter];
  const list = S.versions.versions.filter((v) => want.includes(v.type));
  if (!list.some((v) => v.id === PM.version)) PM.version = list[0] ? list[0].id : PM.version;
  sel.innerHTML = list.map((v) => `<option value="${esc(v.id)}" ${v.id === PM.version ? 'selected' : ''}>${esc(v.id)}${v.id === S.versions.latest.release ? '  (latest)' : ''}</option>`).join('');
  sel.onchange = () => { PM.version = sel.value; pmLoaderVersions(); };
}
function pmLoaderUi() {
  const hint = $('#pm-client-hint');
  if (hint) hint.textContent = PM.loader === 'fabric' || PM.loader === 'quilt'
    ? 'HUD mods, keystrokes, CPS, FPS, zoom and freelook (Right Shift in game), FPS boosts, and the Auroria menu look. Installs on first Play.'
    : PM.loader === 'vanilla' ? 'Adds the Auroria menu look (1.20 and newer). Pick Fabric or Quilt for the HUD and FPS mods.'
    : 'Adds the Auroria menu look. The HUD and FPS mods need Fabric or Quilt.';
  document.querySelectorAll('[data-action="pm-loader"]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === PM.loader)));
  const modded = PM.loader !== 'vanilla';
  for (const id of ['pm-lv-wrap', 'pm-lv-label', 'srv-mods-field', 'pm-mods-label']) { const el = document.getElementById(id); if (el) el.hidden = !modded; }
}
let lvSeq = 0;
async function pmLoaderVersions() {
  if (PM.loader === 'vanilla') return;
  const sel = $('#pm-loader-version'); const hint = $('#pm-lv-hint'); if (!sel) return;
  const seq = ++lvSeq; sel.disabled = true; hint.textContent = 'Finding builds…';
  try {
    const list = await api('GET', `/api/loader-versions?loader=${PM.loader}&mc=${encodeURIComponent(PM.version || '')}`);
    if (seq !== lvSeq) return;
    if (!list.length) { sel.innerHTML = '<option value="">None available</option>'; hint.textContent = `${LOADER_NAMES[PM.loader]} has no build for Minecraft ${PM.version}. Pick another version or loader.`; hint.style.color = 'var(--err)'; return; }
    sel.innerHTML = `<option value="">Recommended (${esc((list.find((x) => x.recommended) || list.find((x) => x.stable) || list[0]).id)})</option>` +
      list.map((v) => `<option value="${esc(v.id)}" ${v.id === PM.loaderVersion ? 'selected' : ''}>${esc(v.id)}${v.recommended ? ' · recommended' : v.stable ? '' : ' · beta'}</option>`).join('');
    sel.disabled = false; hint.textContent = PM.loader === 'forge' || PM.loader === 'neoforge' ? 'The installer runs once on first Play and takes about a minute.' : ''; hint.style.color = '';
    sel.onchange = () => { PM.loaderVersion = sel.value; };
  } catch (e) { if (seq !== lvSeq) return; sel.innerHTML = '<option value="">Recommended</option>'; sel.disabled = false; hint.textContent = 'Could not load the build list. Recommended is used.'; hint.style.color = ''; }
}
function setupModal(err) {
  modal(`<h2>Use your own app ID</h2>
    <p>Optional. Auroria signs in through the Minecraft Launcher's app ID by default. To sign in as your own app instead:</p>
    <ol class="steps">
      <li>Open <button class="linkish" data-action="ext" data-url="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade">Azure app registrations</button> and choose <b>New registration</b>. Name it Auroria and pick <b>Personal Microsoft accounts only</b>.</li>
      <li>In <b>Authentication</b>, turn on <b>Allow public client flows</b> and save.</li>
      <li>Ask Mojang to allow the app at <button class="linkish" data-action="ext" data-url="https://aka.ms/mce-reviewappid">aka.ms/mce-reviewappid</button>. Sign-in works once they approve it.</li>
      <li>Copy the <b>Application (client) ID</b> and paste it here.</li>
    </ol>
    <label for="client-id" class="label" style="display:block;font-weight:700;margin-top:6px">Application (client) ID</label>
    <input class="input" id="client-id" style="width:100%;margin-top:8px" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(S.state.clientId || '')}">
    ${err ? `<p style="color:var(--err);margin:10px 0 0">${esc(err)}</p>` : ''}
    <div class="modal-actions"><button class="btn" style="margin-right:auto" data-action="client-builtin">Use built-in sign-in</button><button class="btn" data-action="close">Cancel</button><button class="btn primary" data-action="save-client">Save</button></div>`);
}

/* ---------------- actions ---------------- */
async function saveSettings(patch) {
  try { S.state.settings = await api('POST', '/api/settings', patch); } catch (e) { toast(e.message, true); }
}
const actions = {
  go: (el) => go(el.dataset.page),
  menu: () => { S.menuOpen = !S.menuOpen; renderAccount(); paintSkins(); },
  signin: () => signIn(),
  close: () => closeModal(),
  'open-auth': () => api('POST', '/api/open', { what: 'url', url: S.authUri || 'https://www.microsoft.com/link' }),
  copy: async (el) => { try { await navigator.clipboard.writeText(el.dataset.text); toast('Code copied'); } catch { toast('Select the code and copy it'); } },
  logout: async () => { const r = await api('POST', '/api/auth/logout'); Object.assign(S.state, r); S.skinStamp = Date.now(); imgCache.clear(); S.menuOpen = false; render(); toast(r.profile ? `Signed out. Now playing as ${r.profile.name}` : 'Signed out'); },
  'switch-account': async (el) => { try { Object.assign(S.state, await api('POST', '/api/auth/switch', { id: el.dataset.id })); S.skinStamp = Date.now(); imgCache.clear(); S.previewId = 'current'; S.menuOpen = false; render(); toast(`Switched to ${S.state.profile.name}`); } catch (e) { toast(e.message, true); } },
  'refresh-profile': async () => { try { S.state.profile = await api('POST', '/api/profile/refresh'); S.skinStamp = Date.now(); imgCache.clear(); S.menuOpen = false; render(); toast('Profile updated'); } catch (e) { toast(e.message, true); } },
  launch: async () => {
    const s = selected(); if (G(s.id).state !== 'idle') return;
    if (s.loader !== 'vanilla') {
      S.launchError = ''; setG(s.id, { state: 'preparing', progress: { stage: 'Checking your mods', done: 0, total: 1 } }); render();
      let chk = null; try { chk = await api('GET', `/api/launch-check?server=${encodeURIComponent(s.id)}`); } catch {}
      setG(s.id, { state: 'idle', progress: null }); render();
      if (chk && (chk.problems.length || chk.outdated.length)) return launchCheckModal(s, chk);
    }
    return startLaunch(s.id);
  },
  'launch-anyway': () => { closeModal(); startLaunch(selected().id); },
  'launch-update': async () => {
    const c = S.launchChk; closeModal(); if (!c) return;
    setG(c.id, { state: 'preparing', progress: { stage: 'Updating mods', done: 0, total: 1 } }); render();
    try { await api('POST', '/api/mods/update', { server: c.id, updates: c.outdated }); S.mods = null; S.modsServer = null; } catch (e) { toast(e.message, true); }
    startLaunch(c.id);
  },
  'chk-delete': async (el) => {
    if (el.dataset.armed !== '1') { // two clicks: the first arms the button so a stray click cannot delete a mod
      el.dataset.armed = '1'; el.textContent = 'Click again to delete'; el.classList.add('armed');
      setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; el.textContent = 'Delete'; el.classList.remove('armed'); } }, 3500); return;
    }
    const c = S.launchChk; if (!c) return; el.disabled = true; el.textContent = 'Deleting…';
    try {
      await api('POST', '/api/mods/delete', { server: c.id, file: el.dataset.file, fast: true }); S.mods = null; S.modsServer = null;
      const chk = await api('GET', `/api/launch-check?server=${encodeURIComponent(c.id)}`);
      const s = servers().find((x) => x.id === c.id) || selected();
      if (document.getElementById('crash-fix')) { const box = $('#crash-fix'); box.innerHTML = chk.problems.length ? `<div class="chk-block err"><b>Found in your mods</b><ul>${chkRows(chk.problems)}</ul></div>` : '<div class="chk-block ok"><b>No problems found in your mods now. Try playing again.</b></div>'; toast('Mod deleted'); }
      else { launchCheckModal(s, chk); toast('Mod deleted'); }
    } catch (e) { toast(e.message, true); el.disabled = false; el.textContent = 'Delete'; }
  },
  'chk-install': async (el) => {
    const c = S.launchChk; if (!c) return; el.disabled = true; el.innerHTML = '<span class="spinner"></span>Installing…';
    try {
      const r = await api('POST', '/api/mods/install-dep', { server: c.id, dep: el.dataset.dep }); S.mods = null; S.modsServer = null;
      const chk = await api('GET', `/api/launch-check?server=${encodeURIComponent(c.id)}`);
      const s = servers().find((x) => x.id === c.id) || selected();
      if (document.getElementById('crash-fix')) { $('#crash-fix').innerHTML = chk.problems.length ? `<div class="chk-block err"><b>Found in your mods</b><ul>${chkRows(chk.problems)}</ul></div>` : '<div class="chk-block ok"><b>No problems found in your mods now. Try playing again.</b></div>'; }
      else launchCheckModal(s, chk);
      toast(`${r.title} installed`);
    } catch (e) { toast(e.message, true); el.disabled = false; el.textContent = `Install ${el.dataset.dep}`; }
  },
  'go-mods': () => { closeModal(); go('mods'); },
  'go-logs': () => { closeModal(); go('logs'); },
  stop: (el) => api('POST', '/api/stop', { serverId: el.dataset.id || selected().id }),
  'log-session': (el) => { S.logSid = el.dataset.v; S.logShown = 0; render(true); },
  logs: () => go('logs'),
  'log-level': (el) => { S.logLevel = el.dataset.v; render(true); },
  'log-wrap': (el) => { S.logWrap = !S.logWrap; el.classList.toggle('on', S.logWrap); el.setAttribute('aria-pressed', String(S.logWrap)); const v = $('#logview'); if (v) v.classList.toggle('wrap', S.logWrap); },
  'log-clear': () => { S.logs = []; S.logSeq = 0; S.logCounts = { info: 0, warn: 0, error: 0, debug: 0 }; render(true); },
  'log-follow': () => { S.logFollow = true; const v = $('#logview'); if (v) v.scrollTop = v.scrollHeight; const j = $('#log-jump'); if (j) j.hidden = true; },
  'log-copy': async () => { try { await navigator.clipboard.writeText(S.logs.filter(logMatches).map((e) => e.text).join('\n')); toast('Copied the shown lines'); } catch { toast('Could not copy. Use Save instead.', true); } },
  'log-save': () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([S.logs.map((e) => e.text).join('\n')], { type: 'text/plain' }));
    a.download = `auroria-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'log-upload': async (el) => {
    if (!S.logs.length) { toast('Nothing to upload yet', true); return; }
    el.disabled = true; el.textContent = 'Uploading…';
    try {
      const r = await api('POST', '/api/logs/upload', { content: S.logs.map((e) => e.text).join('\n') });
      let copied = true; try { await navigator.clipboard.writeText(r.url); } catch { copied = false; }
      await api('POST', '/api/open', { what: 'url', url: r.url }).catch(() => {});
      toast(copied ? 'Uploaded to mclo.gs. Link copied.' : `Uploaded: ${r.url}`);
    } catch (e) { toast(e.message, true); }
    finally { el.disabled = false; el.textContent = 'Upload'; }
  },
  'server-tag': (el) => { S.serverTag = el.dataset.tag; render(); },
  'select-server': async (el) => { await saveSettings({ selectedServer: el.dataset.id }); S.mods = null; S.modsServer = null; render(); toast(`Switched to ${selected().name}`); },
  'play-here': () => { go('home'); if (S.state.profile && G().state === 'idle') actions.launch(); },
  'mod-tab': (el) => { S.modTab = el.dataset.tab; S.modQuery = ''; render(); if (S.modTab === 'browse') searchMods(); if (S.modTab === 'packs' || S.modTab === 'shaders') loadPacks(); },
  'mod-toggle': async (el) => {
    const file = el.dataset.file;
    if (el.getAttribute('aria-checked') === 'true' && !(await confirmDependents(file, 'Turn off'))) return;
    try { S.mods = await api('POST', '/api/mods/toggle', { server: selected().id, file }); render(); } catch (e) { toast(e.message, true); }
  },
  'mod-delete': async (el) => {
    const file = el.dataset.file;
    if (!(await confirmDependents(file, 'Remove'))) return;
    try { S.mods = await api('POST', '/api/mods/delete', { server: selected().id, file }); render(); toast('Mod removed'); } catch (e) { toast(e.message, true); }
  },
  'dep-answer': (el) => { closeModal(); const r = depResolve; depResolve = null; if (r) r(el.dataset.v === '1'); },
  'mod-install': async (el) => {
    const id = el.dataset.id; const type = el.dataset.type || 'mod'; S.busy[id] = true; render();
    try {
      const r = await api('POST', '/api/mods/install', { server: selected().id, projectId: id, type, withDeps: true });
      S.mods = r.mods;
      if (Array.isArray(S.browse)) S.browse = S.browse.map((h) => (h.projectId === id ? { ...h, installed: true } : h));
      toast(type === 'mod' ? (r.deps ? `Mod installed, plus ${r.deps} mod${r.deps > 1 ? 's' : ''} it needs` : 'Mod installed') : type === 'shader' ? 'Shader installed. Pick it in game under Video Settings.' : 'Resource pack installed. Turn it on in game under Resource Packs.');
    } catch (e) { toast(e.message, true); }
    delete S.busy[id]; render();
  },
  'pack-install': (el) => packModal(el.dataset.id, el.dataset.title || 'Modpack'),
  'pack-go': async (el) => {
    const P = S.packPick; if (!P) return; const versionId = $('#pk-ver').value;
    el.disabled = true; el.innerHTML = '<span class="spinner"></span>Installing…'; S.busy[P.id] = true;
    toast('Downloading the modpack. Big packs take a few minutes.');
    try { await importDone(await api('POST', '/api/modpacks/install', { projectId: P.id, versionId }), P.title); }
    catch (e) { toast(e.message, true); el.disabled = false; el.textContent = 'Install'; }
    delete S.busy[P.id]; render();
  },
  manage: (el) => manageModal(el.dataset.id),
  'profile-shortcut': async (el) => {
    try { const r = await api('POST', '/api/profile/shortcut', { server: el.dataset.id }); toast(`Added "${r.name}" to your desktop. It opens Auroria and plays this profile.`); }
    catch (e) { toast(e.message, true); }
  },
  'pack-toggle': async (el) => {
    const n = el.dataset.name; const on = (S.packs.list || []).filter((x) => x.enabled).map((x) => x.name);
    savePackOrder(on.includes(n) ? on.filter((x) => x !== n) : [n, ...on]);
  },
  'pack-delete': async (el) => {
    const n = el.dataset.name; const type = S.packs.type;
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.classList.add('armed'); el.title = 'Click again to delete'; toast(`Click the bin again to delete ${n}`); return; }
    try { S.packs.list = await api('POST', '/api/packs/delete', { server: selected().id, type, name: n }); toast('Deleted'); } catch (e) { toast(e.message, true); }
    render();
  },
  'shader-pick': async (el) => {
    try { S.packs.list = await api('POST', '/api/packs/shader', { server: selected().id, name: el.dataset.name }); toast(el.dataset.name ? 'Shader switched on for your next game' : 'Shaders switched off'); } catch (e) { toast(e.message, true); }
    render();
  },
  'snap-take': async (el) => {
    el.disabled = true; el.innerHTML = '<span class="spinner"></span>Saving…';
    try { MG.snaps = await api('POST', '/api/snapshots/take', { server: MG.id }); toast('Snapshot saved'); } catch (e) { toast(e.message, true); }
    mgDraw();
  },
  'snap-restore': async (el) => {
    const f = el.dataset.file;
    if (MG.confirm !== `sr:${f}`) { MG.confirm = `sr:${f}`; mgDraw(); return; }
    MG.confirm = ''; el.disabled = true; el.innerHTML = '<span class="spinner"></span>Restoring…';
    try { MG.snaps = await api('POST', '/api/snapshots/restore', { server: MG.id, file: f }); S.mods = null; S.modsServer = null; toast('Snapshot restored. The previous state was saved first.'); } catch (e) { toast(e.message, true); }
    mgDraw();
  },
  'snap-delete': async (el) => {
    const f = el.dataset.file;
    if (MG.confirm !== `sd:${f}`) { MG.confirm = `sd:${f}`; mgDraw(); return; }
    MG.confirm = '';
    try { MG.snaps = await api('POST', '/api/snapshots/delete', { server: MG.id, file: f }); } catch (e) { toast(e.message, true); }
    mgDraw();
  },
  'preset-apply': async (el) => {
    el.disabled = true;
    try { const r = await api('POST', '/api/profile/preset', { server: MG.id, preset: el.dataset.v }); S.state.config.servers = r.servers; toast(`${el.closest('.preset').querySelector('b').textContent} applied`); } catch (e) { toast(e.message, true); }
    mgDraw();
  },
  'accent-pick': async (el) => { applyAccent(el.dataset.v); await saveSettings({ accent: el.dataset.v }); render(); },
  'p-more': (el) => { S.pMenu = S.pMenu === el.dataset.id ? '' : el.dataset.id; render(); },
  'share-profile': async (el) => {
    const s = servers().find((x) => x.id === el.dataset.id); el.disabled = true;
    toast(`Packing ${s ? s.name : 'the profile'}…`);
    try {
      const r = await api('POST', '/api/profile/export', { server: el.dataset.id });
      toast(`Saved ${r.file.split(/[\\/]/).pop()} to Downloads. Friends can import it in Auroria, the Modrinth App or Prism.`);
    } catch (e) { toast(e.message, true); }
    el.disabled = false;
  },
  'mg-tab': (el) => {
    MG.tab = el.dataset.v; MG.confirm = '';
    document.querySelectorAll('[data-action="mg-tab"]').forEach((b) => { b.classList.toggle('active', b === el); b.setAttribute('aria-selected', String(b === el)); });
    mgDraw(); mgLoad();
  },
  'mg-backup': async (el) => {
    el.disabled = true; el.innerHTML = '<span class="spinner"></span>Backing up…';
    try { const r = await api('POST', '/api/worlds/backup', { server: MG.id, world: el.dataset.world }); MG.worlds = r.worlds; toast('World backed up'); }
    catch (e) { toast(e.message, true); }
    mgDraw();
  },
  'mg-restore': async (el) => {
    const f = el.dataset.file;
    if (MG.confirm !== `r:${f}`) { MG.confirm = `r:${f}`; mgDraw(); return; }
    MG.confirm = ''; el.disabled = true; el.innerHTML = '<span class="spinner"></span>Restoring…';
    try { const r = await api('POST', '/api/worlds/restore', { server: MG.id, file: f }); MG.worlds = r.worlds; toast('World restored. The previous version was backed up first.'); }
    catch (e) { toast(e.message, true); }
    mgDraw();
  },
  'mg-delbk': async (el) => {
    const f = el.dataset.file;
    if (MG.confirm !== `d:${f}`) { MG.confirm = `d:${f}`; mgDraw(); return; }
    MG.confirm = '';
    try { const r = await api('POST', '/api/worlds/delete-backup', { server: MG.id, file: f }); MG.worlds = r.worlds; toast('Backup deleted'); }
    catch (e) { toast(e.message, true); }
    mgDraw();
  },
  'mg-open': (el) => api('POST', '/api/worlds/open', { server: MG.id, backups: el.dataset.v === 'backups' }).catch((e) => toast(e.message, true)),
  'mg-shot': (el) => api('POST', '/api/shots/open', { server: MG.id, file: el.dataset.file || '' }).catch((e) => toast(e.message, true)),
  'mg-add-server': async () => {
    const s = mgServer(); const name = $('#mg-sname').value.trim(); const address = $('#mg-saddr').value.trim();
    if (!address) { toast('Enter the server address', true); return; }
    try { const r = await api('POST', '/api/profile/servers', { server: s.id, list: [...(s.serverList || []), { name, address }] }); S.state.config.servers = r.servers; mgDraw(); mgPing(address); }
    catch (e) { toast(e.message, true); }
  },
  'mg-del-server': async (el) => {
    const s = mgServer(); const list = (s.serverList || []).filter((_, i) => i !== Number(el.dataset.i));
    try { const r = await api('POST', '/api/profile/servers', { server: s.id, list }); S.state.config.servers = r.servers; mgDraw(); }
    catch (e) { toast(e.message, true); }
  },
  'mg-join': async (el) => {
    const id = MG.id; const addr = el.dataset.addr;
    if (!S.state.profile) { signIn(); return; }
    if (id !== S.state.settings.selectedServer) { await saveSettings({ selectedServer: id }); S.mods = null; S.modsServer = null; }
    closeModal(); go('home'); startLaunch(id, addr);
  },
  'mg-sync': async (el) => {
    const groups = [...document.querySelectorAll('.mg-grp:checked')].map((c) => c.value); const out = $('#mg-sync-out');
    el.disabled = true;
    try {
      const r = await api('POST', '/api/options/sync', { from: $('#mg-from').value, to: MG.id, groups });
      out.textContent = `${r.changed} setting${r.changed === 1 ? '' : 's'} copied.${r.skippedKeys ? ' Key binds were skipped: they use a different format before and after Minecraft 1.13.' : ''}`;
    } catch (e) { out.textContent = ''; toast(e.message, true); }
    el.disabled = false;
  },
  'update-now': async (el) => {
    const u = S.update; if (!u) return;
    if (!u.canApply) { api('POST', '/api/open', { what: 'url', url: u.url }).catch(() => {}); return; }
    el.disabled = true; el.innerHTML = '<span class="spinner"></span>Downloading…';
    try { await api('POST', '/api/update/apply'); $('#update-bar').innerHTML = `<span><b>Installing Auroria ${esc(u.latest)}</b> Restarting…</span>`; }
    catch (e) { toast(e.message, true); el.disabled = false; el.textContent = 'Update now'; }
  },
  'update-later': () => { $('#update-bar').hidden = true; },
  'browse-type': (el) => { S.browseType = el.dataset.v; searchMods(); },
  'browse-more': () => searchMods(true),
  'find-iris': () => { S.browseType = 'mod'; S.modQuery = 'iris'; searchMods(); },
  'add-server': () => serverModal(null),
  'edit-server': (el) => serverModal(servers().find((s) => s.id === el.dataset.id)),
  'delete-server': async (el) => {
    const s = servers().find((x) => x.id === el.dataset.id);
    modal(`<h2>Delete ${esc(s.name)}?</h2><p>It leaves your profile list. Its folder with worlds, mods and screenshots stays on your computer.</p>
      <div class="modal-actions"><button class="btn" data-action="close">Keep it</button><button class="btn primary" data-action="confirm-delete-server" data-id="${esc(s.id)}">Delete profile</button></div>`);
  },
  'confirm-delete-server': async (el) => {
    try { const r = await api('POST', '/api/servers/delete', { id: el.dataset.id }); S.state.config.servers = r.servers; S.state.settings = r.settings; closeModal(); render(); toast('Profile deleted'); }
    catch (e) { toast(e.message, true); }
  },
  'dup-server': async (el) => {
    try { const r = await api('POST', '/api/servers/duplicate', { id: el.dataset.id }); S.state.config.servers = r.servers; render(); toast('Profile duplicated'); }
    catch (e) { toast(e.message, true); }
  },
  'open-profile': (el) => api('POST', '/api/open', { what: 'profile', id: el.dataset.id }).catch((e) => toast(e.message, true)),
  'play-profile': async (el) => {
    if (el.dataset.id !== S.state.settings.selectedServer) { await saveSettings({ selectedServer: el.dataset.id }); S.mods = null; S.modsServer = null; }
    go('home');
    if (!S.state.profile) signIn(); else if (G().state === 'idle') actions.launch();
  },
  win: (el) => NATIVE ? hostSend(el.dataset.v) : api('POST', '/api/window', { action: el.dataset.v }).catch(() => {}),
  'pm-loader': (el) => { PM.loader = el.dataset.v; PM.loaderVersion = ''; pmLoaderUi(); pmLoaderVersions(); },
  'pm-filter': (el) => { PM.filter = el.dataset.v; document.querySelectorAll('[data-action="pm-filter"]').forEach((b) => b.setAttribute('aria-checked', String(b === el))); pmVersions(); pmLoaderVersions(); },
  'import-open': () => importModal(),
  'imp-run': async (el) => {
    const row = el.closest('.imp-row'); const name = row.querySelector('b').textContent;
    document.querySelectorAll('[data-action="imp-run"], [data-action="imp-file"]').forEach((b) => { b.disabled = true; });
    el.innerHTML = '<span class="spinner"></span>Copying…';
    try { await importDone(await api('POST', '/api/import/run', { id: el.dataset.id }), name); }
    catch (e) { toast(e.message, true); document.querySelectorAll('[data-action="imp-run"], [data-action="imp-file"]').forEach((b) => { b.disabled = false; }); el.textContent = 'Import'; }
  },
  'imp-file': () => $('#mrpack-file').click(),
  'pm-icon-pick': () => $('#icon-file').click(),
  'pm-icon-clear': () => { PM.icon = ''; $('#pm-icon-clear-btn').hidden = true; $('#pm-icon').setAttribute('style', `${iconStyle(PM.color, '')};flex:none`); $('#pm-icon').textContent = initials($('#srv-name').value || 'New'); },
  'pm-color': (el) => { PM.color = el.dataset.v; if (!PM.icon) $('#pm-icon').style.background = PM.color; document.querySelectorAll('[data-action="pm-color"]').forEach((b) => b.setAttribute('aria-checked', String(b === el))); },
  'srv-check': async () => {
    const out = $('#srv-check-out'); const a = $('#srv-address').value.trim();
    out.innerHTML = '<span class="spinner"></span>Checking…';
    try { const p = await api('GET', `/api/servers/ping-one?address=${encodeURIComponent(a)}`); out.innerHTML = p.online ? `<span style="color:var(--ok)">Online · ${fmt(p.players)}/${fmt(p.max)} players · ${esc(p.version)} · ${p.latency} ms</span>` : '<span style="color:var(--err)">No answer from that address</span>'; }
    catch (e) { out.innerHTML = `<span style="color:var(--err)">${esc(e.message)}</span>`; }
  },
  'srv-save': async () => {
    const body = { id: PM.id || undefined, name: $('#srv-name').value, address: $('#srv-address').value, version: ($('#srv-version') || {}).value || PM.version,
      client: true, loader: PM.loader, loaderVersion: PM.loader === 'vanilla' ? '' : ($('#pm-loader-version') || {}).value || '', mods: $('#srv-mods').value, color: PM.color, icon: PM.icon, ramGB: Number($('#pm-ram').value) || 0, javaPath: ($('#pm-java') || {}).value || '', ...($('#pm-account') ? { accountId: $('#pm-account').value } : {}) };
    try {
      const r = await api('POST', '/api/servers/save', body); S.state.config.servers = r.servers;
      if (!body.id) await saveSettings({ selectedServer: r.id });
      closeModal(); S.mods = null; S.modsServer = null; render(); loadPings(); toast(body.id ? 'Profile saved' : 'Profile created and selected');
    } catch (e) { const er = $('#srv-error'); if (er) { er.textContent = e.message; er.hidden = false; } }
  },
  'mod-update-all': async () => {
    S.busy.update = true; render();
    try { S.mods = await api('POST', '/api/mods/update', { server: selected().id, updates: S.updates }); S.updates = []; toast('Mods updated'); } catch (e) { toast(e.message, true); }
    S.busy.update = false; render();
  },
  open: (el) => api('POST', '/api/open', { what: el.dataset.what }).catch((e) => toast(e.message, true)),
  'preview-skin': (el) => { S.previewId = el.dataset.id; render(); },
  'auto-rotate': () => { S.autoRotate = !S.autoRotate; render(true); },
  anim3d: (el) => { S.anim3d = el.dataset.v; render(true); },
  ext: (el) => api('POST', '/api/open', { what: 'url', url: el.dataset.url }),
  'save-client': async () => {
    const v = ($('#client-id') || {}).value || '';
    try { const r = await api('POST', '/api/config/client-id', { clientId: v }); S.state.clientId = r.clientId; S.state.authMode = r.clientId ? 'azure' : 'launcher'; closeModal(); render(); toast(r.clientId ? 'Using your own app ID. Sign in again to use it.' : 'Using built-in sign-in'); }
    catch (e) { setupModal(e.message); }
  },
  'client-setup': () => setupModal(),
  'client-builtin': async () => { try { await api('POST', '/api/config/client-id', { clientId: '' }); S.state.clientId = ''; S.state.authMode = 'launcher'; closeModal(); render(); toast('Using built-in sign-in'); } catch (e) { toast(e.message, true); } },
  variant: (el) => { S.uploadVariant = el.dataset.v; render(); },
  'skin-upload': () => $('#skin-file').click(),
  'skin-delete': async (el) => { try { S.skins.library = await api('POST', '/api/skins/delete', { id: el.dataset.id }); if (S.previewId === el.dataset.id) S.previewId = 'current'; render(); } catch (e) { toast(e.message, true); } },
  'skin-apply': async (el) => {
    S.busy.apply = true; render();
    try { S.state.profile = await api('POST', '/api/skins/apply', { id: el.dataset.id }); S.skinStamp = Date.now(); imgCache.clear(); S.previewId = 'current'; toast('Skin changed. It shows in game within a minute.'); }
    catch (e) { toast(e.message, true); }
    S.busy.apply = false; render();
  },
  cape: async (el) => { try { S.state.profile = await api('POST', '/api/capes/apply', { capeId: el.dataset.id || null }); render(); toast('Cape updated'); } catch (e) { toast(e.message, true); } },
  'settings-tab': (el) => { if (S.settingsTab === el.dataset.tab) return; S.settingsTab = el.dataset.tab; S.settingsFx = Date.now(); render(true); },
  'set-toggle': async (el) => { const k = el.dataset.key; await saveSettings({ [k]: !S.state.settings[k] }); render(); },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (S.pMenu && (!el || el.dataset.action !== 'p-more')) { S.pMenu = ''; const m = $('.p-menu'); if (m) m.remove(); document.querySelectorAll('[data-action="p-more"].on').forEach((b) => b.classList.remove('on')); }
  if (!el) { if (S.menuOpen && !e.target.closest('.account')) { S.menuOpen = false; renderAccount(); paintSkins(); } return; }
  if (el.disabled) return;
  const fn = actions[el.dataset.action]; if (fn) { e.preventDefault(); fn(el); }
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'log-search') { S.logQuery = t.value; clearTimeout(logSearchTimer); logSearchTimer = setTimeout(logRepaint, 120); }
  else if (t.id === 'server-search') { S.serverQuery = t.value; render(); }
  else if (t.id === 'mod-search') { S.modQuery = t.value; if (S.modTab === 'browse') { clearTimeout(searchTimer); searchTimer = setTimeout(searchMods, 400); } else render(); }
  else if (t.id === 'mods-ram' || t.id === 'set-ram') { const l = $('#ram-label'); if (l) l.textContent = `${t.value} GB`; }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'pm-java' || t.id === 'srv-version') pmJavaHint();
  if (t.id === 'accent-custom') { applyAccent(t.value); await saveSettings({ accent: t.value }); render(); }
  if (t.id === 'browse-sort') { S.browseSort = t.value; searchMods(); }
  else if (t.id === 'pack-mc') { S.packMc = t.value; searchMods(); }
  else if (t.id === 'pk-mc') packVersionOptions();
  else if (t.id === 'profile-sort') { S.profileSort = t.value; render(); }
  else if (t.id === 'mods-ram' || t.id === 'set-ram') await saveSettings({ ramGB: Number(t.value) });
  else if (t.dataset && t.dataset.setting) { const k = t.dataset.setting; await saveSettings({ [k]: t.type === 'number' ? Number(t.value) : t.value.trim() }); toast('Saved'); }
});
$('#mrpack-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  document.querySelectorAll('[data-action="imp-run"], [data-action="imp-file"]').forEach((b) => { b.disabled = true; });
  toast(`Importing ${f.name}. Mods download in the background of this step, so it can take a minute.`);
  try {
    const data = await new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => j(new Error('Could not read that file.')); fr.readAsDataURL(f); });
    await importDone(await api('POST', '/api/import/mrpack', { data }), f.name.replace(/\.mrpack$/i, ''));
  } catch (err) { toast(err.message, true); document.querySelectorAll('[data-action="imp-run"], [data-action="imp-file"]').forEach((b) => { b.disabled = false; }); }
});
$('#icon-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That file is not a readable image.')); i.src = URL.createObjectURL(f); });
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 128, 128);
    URL.revokeObjectURL(img.src);
    PM.icon = c.toDataURL('image/png'); $('#pm-icon-clear-btn').hidden = false;
    const el = $('#pm-icon'); el.setAttribute('style', `${iconStyle(PM.color, PM.icon)};flex:none`); el.textContent = '';
  } catch (err) { toast(err.message, true); }
});
$('#skin-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
  try { S.skins.library = await api('POST', '/api/skins/upload', { name: f.name.replace(/\.png$/i, ''), variant: S.uploadVariant, data }); S.previewId = S.skins.library[S.skins.library.length - 1].id; render(); toast('Skin added. Press "Wear this skin" to use it.'); }
  catch (err) { toast(err.message, true); }
});

/* ---------------- events from backend ---------------- */
function connectEvents() {
  const es = new EventSource(`/api/events?token=${TOKEN}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'progress') { if (ev.serverId) { setG(ev.serverId, { progress: ev }); if (S.page === 'home' || S.page === 'servers') render(); } }
    else if (ev.type === 'game') {
      const sid = ev.serverId; const was = G(sid).state;
      setG(sid, { state: ev.state, account: ev.account || '', ...(ev.state === 'idle' ? { progress: null } : {}) });
      if (ev.state === 'preparing' && was !== 'running' && !(S.logBufs[sid] && S.logBufs[sid].live)) { logReset(sid); logBuf(sid).live = true; S.logSid = sid; }
      if (ev.state === 'idle') logBuf(sid).live = false;
      sync3dPause();
      if (ev.state === 'idle' && (ev.crash || ev.error)) { S.logSid = sid; crashModal(ev); }
      if (ev.error && sid === selected().id) S.launchError = ev.error;
      if (ev.state === 'running') { S.launchError = ''; toast('Minecraft is starting'); }
      if (ev.state === 'idle' && S.page === 'mods') loadMods(true);
      render();
    } else if (ev.type === 'auth') {
      if (ev.status === 'success') { S.authActive = false; S.state.profile = ev.profile; S.state.accounts = ev.accounts; S.skinStamp = Date.now(); imgCache.clear(); closeModal(); render(); toast(`Signed in as ${ev.profile.name}`); }
      else if (ev.status === 'error') { S.authActive = false; modal(`<h2>Sign-in failed</h2><p>${esc(ev.message)}</p><div class="modal-actions"><button class="btn" data-action="close">Close</button><button class="btn primary" data-action="signin">Try again</button></div>`); }
      else if (ev.status === 'working') { const st = $('#auth-status'); if (st) st.innerHTML = '<span class="spinner"></span>Signed in to Microsoft. Checking your Minecraft account…'; }
    } else if (ev.type === 'log') logIngest(ev.line, ev.serverId);
    else if (ev.type === 'quit') { window.close(); }
    else if (ev.type === 'notice') { toast(ev.message); }
    else if (ev.type === 'autoplay') autoPlay(ev.id);
    else if (ev.type === 'window') { S.state.windowControls = NATIVE || !!ev.ready; render(true); }
  };
  es.onerror = () => { /* EventSource retries by itself */ };
}

// Frameless window: drag by the top strip or the empty part of the sidebar.
// In Auroria's own window (WebView2) the host moves the window natively, with snapping; in the Edge fallback we move it ourselves.
let lastDown = { t: 0, x: 0, y: 0 };
let drag = null;
const dragZone = (t) => (t.closest && t.closest('[data-drag]')) || (t.classList && t.classList.contains('rail') ? t : null);
document.addEventListener('pointerdown', async (e) => {
  if (!S.state || !S.state.windowControls || e.button !== 0) return;
  const zone = dragZone(e.target); if (!zone) return;
  e.preventDefault();
  if (NATIVE) {
    const dbl = e.timeStamp - lastDown.t < 350 && Math.abs(e.screenX - lastDown.x) < 6 && Math.abs(e.screenY - lastDown.y) < 6;
    lastDown = dbl ? { t: 0, x: 0, y: 0 } : { t: e.timeStamp, x: e.screenX, y: e.screenY };
    hostSend(dbl ? 'max' : 'drag');
    return;
  }
  const start = { sx: e.screenX, sy: e.screenY, id: e.pointerId };
  try { zone.setPointerCapture(e.pointerId); } catch {}
  const r = await api('POST', '/api/window', { action: 'rect' }).catch(() => ({ x: null }));
  if (r.x == null || r.max) return;
  drag = { ...start, x: r.x, y: r.y, dpr: window.devicePixelRatio || 1, busy: false, next: null };
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.next = { x: drag.x + Math.round((e.screenX - drag.sx) * drag.dpr), y: drag.y + Math.round((e.screenY - drag.sy) * drag.dpr) };
  if (drag.busy) return;
  drag.busy = true;
  requestAnimationFrame(async () => {
    const d = drag; if (!d || !d.next) { if (d) d.busy = false; return; }
    const p = d.next; d.next = null;
    await api('POST', '/api/window', { action: 'pos', x: p.x, y: p.y }).catch(() => {});
    d.busy = false;
  });
});
const endDrag = () => { drag = null; };
document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
document.addEventListener('dblclick', (e) => { if (!NATIVE && S.state && S.state.windowControls && dragZone(e.target)) api('POST', '/api/window', { action: 'max' }).catch(() => {}); });

// The window never scrolls as a whole; only inner panels do.
window.addEventListener('scroll', () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); });
/* ---------------- custom dropdowns ----------------
   Every native <select> stays the source of truth (value, options, change events, existing handlers). A styled button
   replaces it visually and opens a listbox portalled to <body>, so modals and scroll areas never clip it. */
const DD_CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const DD_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
let ddOpen = null; // { sel, btn, list, idx }
function ddSync(sel) {
  const d = sel._dd; if (!d) return;
  const o = sel.options[sel.selectedIndex];
  d.label.textContent = o ? o.text : '';
  d.btn.disabled = sel.disabled;
}
function ddClose(focusBtn) {
  if (!ddOpen) return;
  const { btn, list } = ddOpen; ddOpen = null;
  list.remove(); btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('open');
  if (focusBtn) btn.focus();
}
function ddHighlight(i, scroll = true) {
  if (!ddOpen) return;
  const opts = [...ddOpen.list.children]; if (!opts.length) return;
  ddOpen.idx = Math.max(0, Math.min(opts.length - 1, i));
  opts.forEach((o, n) => o.classList.toggle('hl', n === ddOpen.idx));
  if (scroll) opts[ddOpen.idx].scrollIntoView({ block: 'nearest' });
}
function ddPick(i) {
  if (!ddOpen) return;
  const { sel } = ddOpen; const changed = sel.selectedIndex !== i;
  sel.selectedIndex = i; ddSync(sel); ddClose(true);
  if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
}
function ddShow(sel) {
  const d = sel._dd; if (!d || sel.disabled) return;
  ddClose();
  const list = document.createElement('div'); list.className = 'dd-list'; list.setAttribute('role', 'listbox');
  [...sel.options].forEach((o, i) => {
    const el = document.createElement('div'); el.className = 'dd-opt'; el.setAttribute('role', 'option'); el.dataset.i = i;
    el.setAttribute('aria-selected', String(i === sel.selectedIndex)); el.disabled = o.disabled;
    el.innerHTML = `<span></span>${DD_CHECK}`; el.firstChild.textContent = o.text;
    list.appendChild(el);
  });
  document.body.appendChild(list);
  const r = d.btn.getBoundingClientRect();
  list.style.minWidth = `${r.width}px`;
  const h = Math.min(list.scrollHeight, 300); const below = innerHeight - r.bottom - 12; const up = below < h && r.top > below;
  list.style.maxHeight = `${Math.max(120, Math.min(300, up ? r.top - 12 : below))}px`;
  list.style.left = `${Math.max(8, Math.min(r.left, innerWidth - list.offsetWidth - 8))}px`;
  list.style[up ? 'bottom' : 'top'] = up ? `${innerHeight - r.top + 6}px` : `${r.bottom + 6}px`;
  list.classList.toggle('up', up);
  d.btn.setAttribute('aria-expanded', 'true'); d.btn.classList.add('open');
  ddOpen = { sel, btn: d.btn, list, idx: sel.selectedIndex };
  ddHighlight(sel.selectedIndex);
}
function ddEnhance(sel) {
  if (sel._dd || sel.multiple) return;
  const wrap = document.createElement('div'); wrap.className = 'dd';
  if (sel.style.width) wrap.style.width = sel.style.width;
  if (sel.style.flex) wrap.style.flex = sel.style.flex;
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = `${sel.className} dd-btn`;
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  const label = document.createElement('span'); label.className = 'dd-label';
  btn.append(label); btn.insertAdjacentHTML('beforeend', DD_CHEVRON);
  sel.parentNode.insertBefore(wrap, sel); wrap.append(btn, sel);
  sel.classList.add('dd-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
  sel._dd = { wrap, btn, label };
  btn.addEventListener('click', () => (ddOpen && ddOpen.sel === sel ? ddClose() : ddShow(sel)));
  btn.addEventListener('keydown', (e) => {
    if (ddOpen && ddOpen.sel === sel) {
      if (e.key === 'ArrowDown') { e.preventDefault(); ddHighlight(ddOpen.idx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); ddHighlight(ddOpen.idx - 1); }
      else if (e.key === 'Home') { e.preventDefault(); ddHighlight(0); }
      else if (e.key === 'End') { e.preventDefault(); ddHighlight(1e9); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ddPick(ddOpen.idx); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ddClose(true); }
      else if (e.key === 'Tab') ddClose();
      else if (e.key.length === 1) { const n = [...sel.options].findIndex((o, i) => i > ddOpen.idx && o.text.toLowerCase().startsWith(e.key.toLowerCase())); if (n >= 0) ddHighlight(n); }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); ddShow(sel); }
  });
  new MutationObserver(() => ddSync(sel)).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  ddSync(sel);
}
function ddScan(root) { (root.querySelectorAll ? root.querySelectorAll('select') : []).forEach(ddEnhance); if (root.matches && root.matches('select')) ddEnhance(root); }
document.addEventListener('pointerdown', (e) => {
  if (!ddOpen) return;
  const opt = e.target.closest && e.target.closest('.dd-opt');
  if (opt && ddOpen.list.contains(opt)) { e.preventDefault(); ddPick(Number(opt.dataset.i)); return; }
  if (!ddOpen.btn.contains(e.target)) ddClose();
}, true);
document.addEventListener('pointermove', (e) => { const o = ddOpen && e.target.closest && e.target.closest('.dd-opt'); if (o && ddOpen.list.contains(o)) ddHighlight(Number(o.dataset.i), false); });
addEventListener('resize', () => ddClose());
addEventListener('blur', () => ddClose());
document.addEventListener('scroll', (e) => { if (ddOpen && !ddOpen.list.contains(e.target)) ddClose(); }, true);
new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) ddScan(n); }).observe(document.body, { childList: true, subtree: true });
ddScan(document.body);

// The window stays hidden (native host) and a flame splash covers the page until everything visible is ready: fonts, the background,
// skin heads and the first lit frame of the 3D character. Then both fade in together, so nothing pops in afterwards.
async function revealWhenLoaded() {
  const cap = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 4500))]);
  const img = (u) => new Promise((res) => { const i = new Image(); i.onload = i.onerror = res; i.src = u; });
  try { await cap(Promise.all([document.fonts.load('800 24px Oxanium'), document.fonts.load('700 24px Monocraft'), document.fonts.load('700 14px "Plus Jakarta Sans"'), document.fonts.ready, img('/bg.jpg'), img('/favicon.ico'), S.paintP, S.homeFrame])); } catch {}
  await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 200); }); // frames can pause in a hidden window: never wait on them alone
  document.body.classList.add('ready');
  S.entering = true; render(true); // entrance animations start now, not behind the splash
  hostSend('ready');
  api('POST', '/api/ui-ready', { ms: Math.round(performance.now()) }).catch(() => {});
  setTimeout(() => { const b = $('#boot'); if (b) b.remove(); }, 700);
}
(async function boot() {
  try { S.state = await api('GET', '/api/state'); }
  catch (e) { $('#page').innerHTML = `<div class="empty"><strong>Auroria could not start</strong>${esc(e.message)}. Close this window and open Auroria again.</div>`; return; }
  applyAccent(S.state.settings.accent);
  render(); connectEvents(); loadPings(); revealWhenLoaded();
  if (S.state.autoPlay) autoPlay(S.state.autoPlay);
  api('GET', '/api/logs').then((r) => {
    for (const [sid, lines] of Object.entries(r.games || {})) { lines.forEach((l) => logAdd(l, sid)); if (!S.logSid || G(sid).state !== 'idle') S.logSid = sid; }
    render();
  }).catch(() => {});
  setInterval(() => { if (S.page === 'home' || S.page === 'servers') loadPings(); }, 30000);
  setInterval(checkModsFolder, 1500);
  window.addEventListener('focus', checkModsFolder);
  if (S.state.settings.updateCheck !== false) setTimeout(checkForUpdate, 2500);
})();
// A desktop shortcut started (or re-focused) Auroria for one profile: select it and press Play.
async function autoPlay(id) {
  if (!servers().some((x) => x.id === id)) return;
  S.state.settings.selectedServer = id; S.mods = null; S.modsServer = null;
  go('home');
  if (!S.state.profile) signIn(); else if (G().state === 'idle') actions.launch();
}
async function checkForUpdate() {
  try {
    const u = await api('GET', '/api/update/check'); if (!u.available) return;
    S.update = u; const bar = $('#update-bar');
    bar.innerHTML = `<span><b>Auroria ${esc(u.latest)} is out</b>You have ${esc(u.current)}.</span><button class="btn primary small" data-action="update-now">${u.canApply ? 'Update now' : 'Download'}</button><button class="iconbtn" data-action="update-later" aria-label="Later" title="Later"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button>`;
    bar.hidden = false;
  } catch {}
}
