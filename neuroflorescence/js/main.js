/* ==========================================================================
   main.js — WebGL set-up, the frame loop and (minimal) controls
   --------------------------------------------------------------------------
   The piece is ambient: no text, no interaction, no beginning or end. A
   lifetime (see life.js) lasts about 24 minutes, then the brain dissolves
   and a new one grows. Every lifetime is different.

   URL options (all optional):
     ?ui=0          kiosk mode: no buttons, no cursor; reloads itself after an error
     ?label=1       show a small title label in the corner
     ?res=4k        always render at 3840 × 3024
     ?seed=12       choose a variation        ?speed=2     play faster
     ?start=600     jump to second 600 of the lifetime
     ?life=600      length of a lifetime in seconds (default 1440)
     ?particles=512 particle grid size (512 → 262 144 particles)
     ?sim=1920      width of the simulation buffer
     ?field=1       prototype: the brain spills out in plumes into the screen around it
   Keys:  F fullscreen · L label · Space pause
   ========================================================================== */

(function () {
  'use strict';

  const q = new URLSearchParams(location.search);
  const small = Math.min(screen.width, screen.height) < 700;
  const CFG = {
    seed: parseInt(q.get('seed'), 10) || 1,
    label: q.get('label') === '1',
    ui: q.get('ui') !== '0',
    speed: parseFloat(q.get('speed')) || 1,
    res4k: q.get('res') === '4k',
    start: parseFloat(q.get('start')) || 0,
    life: parseFloat(q.get('life')) || LIFE.duration,
    grid: parseInt(q.get('particles'), 10) || (small ? 256 : 512),
    simMax: parseInt(q.get('sim'), 10) || (small ? 1024 : 1920),
    field: q.get('field') === '1',
    fieldBody: 1.5,        // with ?field=1, how much the brain's tissue is lifted against its surroundings
    decay: 0.962,          // trail persistence per frame at 60 fps
    bump: 12,              // strength of the relief lighting
    bloom: 0.55,
    exposure: 1.55
  };

  const ASPECT = BRAIN_ASPECT;
  const FONT = '"Inter", "Helvetica Neue", Arial, sans-serif';
  const FLOW_W = 320, FLOW_H = 252;

  const stage = document.getElementById('stage');
  const canvas = document.getElementById('art');
  const overlay = document.getElementById('overlay');
  const octx = overlay.getContext('2d');
  if (!CFG.ui) document.body.classList.add('kiosk');

  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) {
    document.getElementById('nogl').hidden = false;
    if (!CFG.ui) setTimeout(() => location.reload(), 60000);   // kiosk: WebGL may be back after a GPU crash
    return;
  }
  // a GPU reset (driver crash, sleep, display change) takes the context away for good: start afresh
  canvas.addEventListener('webglcontextlost', () => setTimeout(() => location.reload(), 3000));

  /* ---------- tiny WebGL helpers ---------- */
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
    return { p, u, tex: 0 };
  }
  function use(P) { gl.useProgram(P.p); P.tex = 0; return P; }
  function set(P, name, v) {
    const u = P.u[name];
    if (!u) return;
    switch (u.type) {
      case gl.FLOAT: typeof v === 'number' ? gl.uniform1f(u.loc, v) : gl.uniform1fv(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.SAMPLER_2D:
        gl.activeTexture(gl.TEXTURE0 + P.tex); gl.bindTexture(gl.TEXTURE_2D, v);
        gl.uniform1i(u.loc, P.tex); P.tex++; break;
      default: gl.uniform1f(u.loc, v);
    }
  }
  function texture(w, h, ifmt, fmt, type, filter, data = null) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(t) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  }

  const P_FLOW = program(VS_QUAD, FS_FLOW);
  const P_GROW = program(VS_QUAD, FS_GROW);
  const P_PART = program(VS_QUAD, FS_PARTICLES);
  const P_ADV = program(VS_QUAD, FS_ADVECT);
  const P_PTS = program(VS_POINTS, FS_POINTS);
  const P_COMP = program(VS_QUAD, FS_COMPOSITE);
  gl.bindVertexArray(gl.createVertexArray());

  /* ---------- buffers ---------- */
  const flowTex = texture(FLOW_W, FLOW_H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
  const flowFbo = target(flowTex);
  const growTex = texture(FLOW_W, FLOW_H, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.LINEAR);
  const growFbo = target(growTex);

  const G = CFG.grid, NPART = G * G;
  const pos = [0, 1].map(() => texture(G, G, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST));
  const posFbo = pos.map(target);
  let pi = 0;

  function seedParticles() {
    const d = new Float32Array(NPART * 4);
    let r = (seed * 9301 + 49297) % 233280;
    const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < NPART; i++) {
      let x = 0.5 * ASPECT, y = 0.4;
      for (let t = 0; t < 20; t++) {
        const cx = rnd() * ASPECT, cy = rnd();
        if (brainSDF(cx, cy) < 0) { x = cx; y = cy; break; }
      }
      d[i * 4] = x; d[i * 4 + 1] = y;
    }
    for (const t of pos) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, G, G, gl.RGBA, gl.FLOAT, d);
    }
  }

  let simW = 0, simH = 0, trail = [], trailFbo = [], ti = 0;
  function buildTrail() {
    for (const t of trail) gl.deleteTexture(t);
    for (const f of trailFbo) gl.deleteFramebuffer(f);
    simW = Math.min(canvas.width, CFG.simMax);
    simH = Math.round(simW / ASPECT);
    trail = [0, 1].map(() => texture(simW, simH, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR_MIPMAP_LINEAR));
    trail.forEach(t => { gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D); });
    trailFbo = trail.map(target);
    clearTrail();
  }
  function clearTrail() {
    for (const f of trailFbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /* ---------- the lifetime ---------- */
  const KEYS = Object.keys(LIFE.keys[0]).filter(k => k !== 'at');
  const director = new Director(CFG.seed);
  const U = {};
  let lifeT = 0, clock = 0, seed = CFG.seed, paused = false, needInit = true;

  const clamp01 = x => Math.max(0, Math.min(1, x));
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  /* the character of the brain at this point of its life, blended between keyframes */
  function paramsAt(t) {
    const f = clamp01(t / CFG.life), ks = LIFE.keys;
    let i = 0;
    while (i < ks.length - 2 && f > ks[i + 1].at) i++;
    const a = ks[i], b = ks[i + 1], k = smooth(a.at, b.at, f), out = {};
    for (const key of KEYS) out[key] = a[key] + (b[key] - a[key]) * k;
    return out;
  }

  function restart(newSeed) {
    seed = newSeed; lifeT = 0;
    clock = (seed * 997) % 3600;    // the shaders get the clock as a 32-bit float: keep it small, but new for every brain
    director.reset(seed);
    seedParticles(); clearTrail(); needInit = true;   // no trace of the old brain may show through
  }

  let P = paramsAt(0);
  function step(dt) {
    lifeT += dt; clock += dt;
    if (lifeT >= CFG.life) restart(seed + 1);     // a new brain, never the same
    P = paramsAt(lifeT);
    director.update(dt, P);
  }
  const dissolve = () => smooth(CFG.life - LIFE.dissolve, CFG.life - 0.5, lifeT);

  /* ---------- GPU frame ---------- */
  function quad() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

  function simulate(dt) {
    director.uniforms(U);
    const T = director.time;
    gl.disable(gl.BLEND);

    // 1 flow field
    gl.bindFramebuffer(gl.FRAMEBUFFER, flowFbo);
    gl.viewport(0, 0, FLOW_W, FLOW_H);
    use(P_FLOW);
    set(P_FLOW, 'uPts', U.pts); set(P_FLOW, 'uMul', U.mul); set(P_FLOW, 'uStr', U.str);
    set(P_FLOW, 'uLesion', U.lesion); set(P_FLOW, 'uLesionK', U.lesionK);
    set(P_FLOW, 'uTurb', P.turb); set(P_FLOW, 'uTime', clock);
    quad();
    // ... and how far the outline swells around the growth sites (read by brain())
    gl.bindFramebuffer(gl.FRAMEBUFFER, growFbo);
    use(P_GROW);
    set(P_GROW, 'uGro', U.gro);
    quad();

    // 2 particles
    gl.bindFramebuffer(gl.FRAMEBUFFER, posFbo[1 - pi]);
    gl.viewport(0, 0, G, G);
    use(P_PART);
    set(P_PART, 'uPos', pos[pi]); set(P_PART, 'uFlow', flowTex);
    set(P_PART, 'uDt', dt); set(P_PART, 'uClock', clock); set(P_PART, 'uStoryT', T);
    set(P_PART, 'uAttract', P.attract); set(P_PART, 'uInit', needInit ? 1 : 0);
    set(P_PART, 'uBurst', U.bur); set(P_PART, 'uLesion', U.lesion); set(P_PART, 'uLesionK', U.lesionK);
    set(P_PART, 'uGrow', growTex); set(P_PART, 'uField', CFG.field ? 1 : 0);
    quad();
    pi = 1 - pi; needInit = false;

    // 3 smear the previous image along the flow
    gl.bindFramebuffer(gl.FRAMEBUFFER, trailFbo[1 - ti]);
    gl.viewport(0, 0, simW, simH);
    use(P_ADV);
    set(P_ADV, 'uPrev', trail[ti]); set(P_ADV, 'uFlow', flowTex);
    set(P_ADV, 'uDt', dt); set(P_ADV, 'uDecay', Math.pow(CFG.decay, dt * 60 / Math.max(CFG.speed, 1)));
    set(P_ADV, 'uPrune', P.prune); set(P_ADV, 'uTexel', [1 / simW, 1 / simH]);
    set(P_ADV, 'uLesion', U.lesion); set(P_ADV, 'uLesionK', U.lesionK); set(P_ADV, 'uGrow', growTex);
    set(P_ADV, 'uField', CFG.field ? 1 : 0);
    quad();

    // 4 particles on top, additive
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    use(P_PTS);
    set(P_PTS, 'uPos', pos[pi]); set(P_PTS, 'uFlow', flowTex);
    set(P_PTS, 'uClock', clock); set(P_PTS, 'uStoryT', T);
    set(P_PTS, 'uPointSize', Math.max(1, simW / 1280));
    set(P_PTS, 'uReveal', Math.min(1.2, lifeT / 10)); set(P_PTS, 'uPrune', P.prune);
    set(P_PTS, 'uGain', 0.09 * (512 * 512 / NPART) * Math.pow(simW / 1920, 2) * (dt * 60 / CFG.speed));   // same brightness at any frame rate
    set(P_PTS, 'uField', CFG.field ? 1 : 0); set(P_PTS, 'uBody', CFG.field ? CFG.fieldBody : 1);
    set(P_PTS, 'uPathCol', U.col); set(P_PTS, 'uPulse', U.pul);
    set(P_PTS, 'uLesion', U.lesion); set(P_PTS, 'uLesionK', U.lesionK); set(P_PTS, 'uGrow', growTex);
    gl.drawArrays(gl.POINTS, 0, NPART);
    gl.disable(gl.BLEND);

    ti = 1 - ti;
    gl.bindTexture(gl.TEXTURE_2D, trail[ti]);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  function composite() {
    director.uniforms(U);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    use(P_COMP);
    set(P_COMP, 'uTrail', trail[ti]);
    set(P_COMP, 'uTexel', [1 / simW, 1 / simH]); set(P_COMP, 'uRes', [canvas.width, canvas.height]);
    set(P_COMP, 'uClock', clock); set(P_COMP, 'uStoryT', director.time);
    set(P_COMP, 'uBump', CFG.bump); set(P_COMP, 'uBloom', CFG.bloom); set(P_COMP, 'uExposure', CFG.exposure);
    set(P_COMP, 'uFade', dissolve());
    set(P_COMP, 'uLesion', U.lesion); set(P_COMP, 'uLesionK', U.lesionK);
    set(P_COMP, 'uNuc', U.nuc); set(P_COMP, 'uGlow', U.glo); set(P_COMP, 'uPathCol', U.col);
    quad();
  }

  /* ---------- optional label (2D canvas on top) ---------- */
  function drawLabel() {
    const Wd = overlay.width, Hd = overlay.height;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, Wd, Hd);
    if (!CFG.label) return;
    const x = Wd * 0.035, y = Hd * 0.955;
    octx.textBaseline = 'alphabetic';
    octx.font = `600 ${Hd * 0.02}px ${FONT}`;
    octx.fillStyle = 'rgba(240,240,250,0.8)';
    octx.fillText('Neuroflorescence', x, y - Hd * 0.024);
    octx.font = `300 ${Hd * 0.014}px ${FONT}`;
    octx.fillStyle = 'rgba(220,222,240,0.65)';
    octx.fillText('A brain that keeps rewiring itself. Live, and never the same twice.', x, y);
  }

  /* ---------- sizing ---------- */
  let quality = 1;
  function fit() {
    const vw = window.innerWidth, vh = window.innerHeight;
    let w = vw, h = vw / ASPECT;
    if (h > vh) { h = vh; w = vh * ASPECT; }
    stage.style.width = w + 'px';
    stage.style.height = h + 'px';
    const pw = CFG.res4k ? 3840 : Math.round(Math.min(3840, w * Math.min(window.devicePixelRatio || 1, 2) * quality));
    canvas.width = overlay.width = pw;
    canvas.height = overlay.height = Math.round(pw / ASPECT);
    buildTrail();
    drawLabel();
  }

  /* ---------- main loop ---------- */
  let last = performance.now(), slow = 0, frames = 0;
  function frame(now) {
    try { tick(now); } catch (err) {
      console.error(err);
      if (!CFG.ui) setTimeout(() => location.reload(), 5000);   // kiosk: never stay frozen
      return;
    }
    requestAnimationFrame(frame);
  }
  function tick(now) {
    const real = (now - last) / 1000;
    last = now;
    if (!paused) {
      const dt = Math.min(real, 1 / 20) * CFG.speed;
      let rest = dt;
      while (rest > 1e-6) { const d = Math.min(rest, 1 / 30); step(d); rest -= d; }
      simulate(Math.min(dt, 1 / 15));
    }
    composite();

    if (!CFG.res4k) {
      frames++; if (real > 0.034) slow++;
      if (frames >= 120) {
        if (slow > 70 && quality > 0.5) { quality *= 0.8; fit(); }
        frames = 0; slow = 0;
      }
    }
  }

  /* ---------- controls ---------- */
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }
  document.getElementById('fs').addEventListener('click', toggleFullscreen);
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (k === 'f') toggleFullscreen();
    else if (k === 'l') { CFG.label = !CFG.label; drawLabel(); }
    else if (k === ' ') { paused = !paused; e.preventDefault(); }
  });
  let idleTimer = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  }
  window.addEventListener('mousemove', wake);
  window.addEventListener('touchstart', wake, { passive: true });
  window.addEventListener('resize', fit);

  /* ---------- start ---------- */
  function start() {
    fit();
    seedParticles();
    wake();
    if (CFG.start > 0) {               // the model is cheap: fast-forward it on the CPU
      const target = Math.min(CFG.start, CFG.life - 1);
      while (lifeT < target) step(1 / 20);
    }
    last = performance.now();
    requestAnimationFrame(frame);
  }

  const fontReady = document.fonts && document.fonts.load
    ? Promise.race([
        Promise.all([document.fonts.load('600 40px Inter'), document.fonts.load('300 40px Inter')]),
        new Promise(r => setTimeout(r, 1500))
      ])
    : Promise.resolve();
  fontReady.then(start, start);

  // hooks for testing
  window.NEUROFLORESCENCE = {
    director, get t() { return lifeT; },
    pause(v) { paused = v; },
    advance(sec, dt = 1 / 20) {
      for (let t = 0; t < sec; t += dt) { step(dt); simulate(dt); }
      composite(); gl.finish();
    }
  };
})();
