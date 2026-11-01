// Live HUD demo: real FPS from rAF, real key and click state, real clock.
(function () {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const keys = {};
  document.querySelectorAll('kbd[data-k]').forEach((el) => { keys[el.dataset.k] = el; });
  const mouse = { 0: document.querySelector('kbd[data-m="0"]'), 2: document.querySelector('kbd[data-m="2"]') };
  const clicks = { 0: [], 2: [] };

  addEventListener('keydown', (e) => { const el = keys[e.key.toLowerCase()]; if (el && !e.ctrlKey && !e.metaKey) el.classList.add('on'); });
  addEventListener('keyup', (e) => { const el = keys[e.key.toLowerCase()]; if (el) el.classList.remove('on'); });
  addEventListener('blur', () => Object.values(keys).forEach((el) => el.classList.remove('on')));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('mousedown', (e) => {
    if (!mouse[e.button]) return;
    mouse[e.button].classList.add('on');
    clicks[e.button].push(performance.now());
    stage.focus({ preventScroll: true });
  });
  addEventListener('mouseup', (e) => { if (mouse[e.button]) mouse[e.button].classList.remove('on'); });

  let frames = 0, last = performance.now();
  function loop(now) {
    frames++;
    if (now - last >= 500) {
      $('fps').textContent = Math.round(frames * 1000 / (now - last));
      frames = 0; last = now;
      const cut = now - 1000;
      for (const b of [0, 2]) clicks[b] = clicks[b].filter((t) => t > cut);
      $('cps').textContent = clicks[0].length + ' | ' + clicks[2].length;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  const tick = () => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  tick(); setInterval(tick, 10000);
})();
