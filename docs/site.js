// Pixel icons: 8x8 maps painted onto the <canvas data-px> elements.
(function () {
  const PAL = { X: '#f07f2a', Y: '#ffd27a', D: '#8a3207', K: '#1b0d05', G: '#58a638', B: '#6b4a2b', S: '#e8c9a0', T: '#3a8fe0', W: '#f4ece4' };
  const ICONS = {
    chest: ['KKKKKKKK', 'KBBBBBBK', 'KBBBBBBK', 'KKKYYKKK', 'KBBYYBBK', 'KBBBBBBK', 'KBBBBBBK', 'KKKKKKKK'],
    arrow: ['...XX...', '...XX...', '.XXXXXX.', '..XXXX..', '...XX...', '........', 'DDDDDDDD', 'DDDDDDDD'],
    cube: ['..KKKK..', '.KYYYYK.', 'KYYYYXXK', 'KKKKKKKK', 'KXXKXXXK', 'KXXKXXDK', '.KXXXDK.', '..KKKK..'],
    shield: ['KKKKKKKK', 'KXXKKXXK', 'KXXXXXXK', 'KXXYYXXK', 'KXXYYXXK', '.KXXXXK.', '..KXXK..', '...KK...'],
    flame: ['....X...', '...XX...', '..XXXX..', '.XXYXXX.', '.XYYYXX.', '.XYYYYX.', '..XYYX..', '...XX...'],
    heads: ['.SSSS...', '.SKKS.SS', '.SSSSSKK', '.BBBB.SS', 'BBBBBB.B', '.......B', '........', '........'],
    steve: ['..BBBB..', '.BSSSSB.', '.SKSSKS.', '.SSBBSS.', 'TTTTTTTT', 'STTTTTTS', 'S.DDDD.S', '..D..D..'],
    globe: ['..GGGG..', '.GGBBGG.', 'GGBBGGTG', 'GBBGGTTG', 'GGGGTTBG', 'GTTTTBBG', '.GTTBBG.', '..GGGG..'],
    clock: ['..KKKK..', '.KWWWWK.', 'KWWKWWWK', 'KWWKWWWK', 'KWWKKKWK', 'KWWWWWWK', '.KWWWWK.', '..KKKK..'],
    gear: ['...XX...', '.X.XX.X.', '..XXXX..', 'XXXDDXXX', 'XXXDDXXX', '..XXXX..', '.X.XX.X.', '...XX...'],
    up: ['...XX...', '..XXXX..', '.XXXXXX.', 'XXXXXXXX', '...XX...', '...XX...', '...XX...', '...XX...'],
    camera: ['........', '..KK....', 'KKKKKKKK', 'KXXKKXXK', 'KXKWWKXK', 'KXKWWKXK', 'KXXKKXXK', 'KKKKKKKK'],
    bolt: ['....XX..', '...XX...', '..XX....', '.XXXXXX.', '...XX...', '..XX....', '.XX.....', 'X.......'],
  };
  document.querySelectorAll('canvas[data-px]').forEach((c) => {
    const rows = ICONS[c.dataset.px]; if (!rows) return;
    const g = c.getContext('2d');
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (PAL[ch]) { g.fillStyle = PAL[ch]; g.fillRect(x, y, 1, 1); } }));
  });
})();

// Tour: tabs switch the screenshot; auto-advances until the visitor picks one.
(function () {
  const tabs = [...document.querySelectorAll('.tour-tabs button')];
  const imgs = [...document.querySelectorAll('.shots img')];
  const cap = document.getElementById('caption');
  const TEXT = {
    home: 'Pick a profile, press PLAY. Auroria fetches Java, the game, libraries and assets on its own.',
    profiles: 'One card per setup: its own version, loader, mods, memory and icon. Import from other launchers.',
    mods: 'Browse Modrinth without leaving the launcher. Endless scroll, sorting, one-click installs.',
    skins: 'Your character in 3D. Upload a skin, wear it, switch capes.',
  };
  let auto = true, i = 0;
  const show = (k) => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.shot === k)));
    imgs.forEach((m) => m.classList.toggle('on', m.dataset.for === k));
    cap.textContent = TEXT[k];
  };
  tabs.forEach((t, n) => t.addEventListener('click', () => { auto = false; i = n; show(t.dataset.shot); }));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) setInterval(() => { if (!auto || document.hidden) return; i = (i + 1) % tabs.length; show(tabs[i].dataset.shot); }, 5000);
})();
