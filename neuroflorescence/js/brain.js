/* ==========================================================================
   brain.js — the plasticity model (runs on the CPU, steers the shaders)
   --------------------------------------------------------------------------
   World coordinates: x from 0 to ASPECT (80/63), y from 0 (top) to 1 (bottom).
   The brain is seen from the side, facing left.

   Six slots hold pathways between two regions of the cortex. Each pathway
   lives its own life:
     candidate   it sprouts and becomes faintly visible
     practised   sparks of "experience" arrive from outside the brain and
                 travel along it; every signal that gets through makes it
                 stronger (Hebbian learning). A stronger pathway is thicker,
                 more colourful and carries its signals faster
     neglected   the environment stops using it; it fades and is pruned,
                 and the slot is free for a new pathway
   While a pathway is practised, the two regions it links swell, so the
   outline of the brain itself changes with use; when practice stops they
   slowly shrink back (growth sites, shared with brain() in the shaders).
   Now and then an injury darkens a small region. Pathways through it fall
   silent, new growth appears at its border, the pathways bend around it and
   the detour is learned again. Slowly the damage settles into a faint scar.
   ========================================================================== */

(function (global) {
  'use strict';

  const ASPECT = 80 / 63;
  const K = 16;            // points per pathway
  const NP = 6;            // pathway slots
  const NG = 32;           // growth sites: regions that swell with use
  const GROW_AMP = 0.04, GROW_R = 0.1;
  const GROW = Array.from({ length: NG }, () => ({ x: 0, y: 0, a: 0, owner: null }));
  const COLORS = [
    [1.0, 0.62, 0.22], [0.22, 0.82, 1.0], [1.0, 0.32, 0.70],
    [0.60, 0.48, 1.0], [0.40, 1.0, 0.62], [1.0, 0.55, 0.45]
  ];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- brain silhouette (signed distance; < 0 is inside) ----------
     Keep in sync with brain() in shaders.js. */
  function sdEll(px, py, cx, cy, rx, ry) {
    const qx = (px - cx) / rx, qy = (py - cy) / ry;
    return (Math.hypot(qx, qy) - 1) * Math.min(rx, ry);
  }
  function sdCap(px, py, ax, ay, bx, by, r) {
    const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
    const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
    return Math.hypot(pax - bax * h, pay - bay * h) - r;
  }
  function smin(a, b, k) {
    const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
    return b + (a - b) * h - k * h * (1 - h);
  }
  function brainSDF(x, y) {
    const A = ASPECT;
    let d = sdEll(x, y, 0.50 * A, 0.40, 0.40 * A, 0.30);
    d = smin(d, sdEll(x, y, 0.30 * A, 0.41, 0.22 * A, 0.28), 0.05);
    d = smin(d, sdEll(x, y, 0.74 * A, 0.43, 0.20 * A, 0.24), 0.05);
    d = smin(d, sdEll(x, y, 0.50 * A, 0.60, 0.25 * A, 0.13), 0.04);
    d = smin(d, sdEll(x, y, 0.78 * A, 0.685, 0.12 * A, 0.085), 0.015);
    d = smin(d, sdCap(x, y, 0.64 * A, 0.60, 0.60 * A, 0.93, 0.03), 0.03);
    d += 0.006 * Math.sin(x * 37 + 1.3) * Math.sin(y * 41 + 0.7) + 0.004 * Math.sin(x * 83 + y * 61);
    for (const g of GROW) {
      if (g.a < 0.005) continue;
      const dx = x - g.x, dy = y - g.y;
      d -= GROW_AMP * g.a * Math.exp(-(dx * dx + dy * dy) / (GROW_R * GROW_R));
    }
    return d;
  }
  const CENTER = [0.5 * ASPECT, 0.44];

  class Director {
    constructor(seed) { this.reset(seed); }

    reset(seed) {
      this.rand = mulberry32((seed >>> 0) || 1);
      const R = this.rand;
      this.time = 0;
      this.lesion = null;
      this.bursts = [];
      this.burstCarry = 0;
      this.sparks = [];
      this.inputs = [];
      this.nextInjury = 0;
      for (const g of GROW) { g.a = 0; g.owner = null; }
      const offset = Math.floor(R() * COLORS.length);
      this.paths = Array.from({ length: NP }, (_, i) => ({
        i, active: false, col: COLORS[(i + offset) % COLORS.length],
        pts: Array.from({ length: K }, () => [0, 0]), target: null, mul: new Array(K).fill(1),
        s: 0, pulses: [], stage: 'empty', timer: 0, srcFlash: 0, dstFlash: 0, entry: [0, 0], cool: R() * 6, sites: []
      }));
    }

    /* claim a growth site at a region; the free site that has shrunk the most is reused */
    claim(q, p) {
      let g = null;
      for (const c of GROW) if (!c.owner && (!g || c.a < g.a)) g = c;
      g.x = q[0]; g.y = q[1]; g.a = 0; g.owner = p;
      return g;
    }

    /* a point in the cortex, a little inside the outline */
    cortexPoint() {
      const R = this.rand;
      for (let t = 0; t < 60; t++) {
        const x = R() * ASPECT, y = R() * 0.9;
        const d = brainSDF(x, y);
        if (d < -0.03 && d > -0.13) return [x, y];
      }
      return [0.3 * ASPECT, 0.4];
    }

    spawn(p) {
      const R = this.rand;
      for (let attempt = 0; attempt < 25; attempt++) {
        const f = this.cortexPoint(), t = this.cortexPoint();
        const dist = Math.hypot(t[0] - f[0], t[1] - f[1]);
        if (dist < 0.3 || dist > 0.85) continue;
        const mx = (f[0] + t[0]) / 2, my = (f[1] + t[1]) / 2, nx = -(t[1] - f[1]) / dist, ny = (t[0] - f[0]) / dist;
        const bend = (R() - 0.5) * 0.25;
        const v = [mx + nx * bend * dist, my + ny * bend * dist];
        const c = [2 * v[0] - mx, 2 * v[1] - my];
        const ph1 = R() * 6.28, ph2 = R() * 6.28, amp = 0.01 + R() * 0.012;
        const pts = [];
        let ok = true;
        for (let k = 0; k < K; k++) {
          const u = k / (K - 1), iu = 1 - u;
          let x = iu * iu * f[0] + 2 * iu * u * c[0] + u * u * t[0];
          let y = iu * iu * f[1] + 2 * iu * u * c[1] + u * u * t[1];
          const dx = 2 * iu * (c[0] - f[0]) + 2 * u * (t[0] - c[0]);
          const dy = 2 * iu * (c[1] - f[1]) + 2 * u * (t[1] - c[1]);
          const l = Math.hypot(dx, dy) || 1;
          const o = Math.sin(Math.PI * u) * amp * (Math.sin(u * 7 + ph1) + 0.6 * Math.sin(u * 17 + ph2));
          x += -dy / l * o; y += dx / l * o;
          if (brainSDF(x, y) > -0.02) { ok = false; break; }
          pts.push([x, y]);
        }
        if (!ok) continue;
        p.pts = pts; p.mul = new Array(K).fill(1); p.target = null;
        p.s = 0; p.pulses = []; p.active = true; p.stage = 'candidate';
        p.timer = 10 + R() * 20;
        // where experience comes in from: outside the brain, beyond the source region
        const ox = f[0] - CENTER[0], oy = f[1] - CENTER[1], ol = Math.hypot(ox, oy) || 1;
        p.entry = [Math.max(0.03, Math.min(ASPECT - 0.03, f[0] + ox / ol * 0.32)),
                   Math.max(0.03, Math.min(0.97, f[1] + oy / ol * 0.32))];
        if (this.lesion) this.detour(p, true);
        return;
      }
    }

    point(p, u) {
      const f = Math.max(0, Math.min(1, u)) * (K - 1), k = Math.min(K - 2, Math.floor(f)), t = f - k;
      const a = p.pts[k], b = p.pts[k + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }

    /* index (0..1) of the first point inside an open injury, or 2 if none */
    breakAt(p) {
      const L = this.lesion;
      if (!L || L.k < 0.3) return 2;
      for (let k = 0; k < K; k++) {
        if (Math.hypot(p.pts[k][0] - L.x, p.pts[k][1] - L.y) < L.r * 1.2) return k / (K - 1);
      }
      return 2;
    }

    /* plan a detour around the injury on the side where there is more brain */
    detour(p, immediate) {
      const L = this.lesion;
      const dx = p.pts[K - 1][0] - p.pts[0][0], dy = p.pts[K - 1][1] - p.pts[0][1], dl = Math.hypot(dx, dy) || 1;
      let sx = -dy / dl, sy = dx / dl;
      const room = s => brainSDF(L.x + sx * s * L.r * 1.7, L.y + sy * s * L.r * 1.7);
      if (room(-1) < room(1)) { sx = -sx; sy = -sy; }
      let hit = false;
      const target = p.pts.map((q, k) => {
        let vx = q[0] - L.x, vy = q[1] - L.y;
        if (Math.hypot(vx, vy) > L.r * 1.55) return q.slice();
        hit = true;
        p.mul[k] = immediate ? 0.3 : 0;
        const d = vx * sx + vy * sy;
        if (d < 0) { vx -= 2 * d * sx; vy -= 2 * d * sy; }
        let l = Math.hypot(vx, vy);
        if (l < 1e-4) { vx = sx; vy = sy; l = 1; }
        return [L.x + vx / l * L.r * 1.6, L.y + vy / l * L.r * 1.6];
      });
      if (!hit) return;
      if (immediate) p.pts = target; else p.target = target;
    }

    injure() {
      const R = this.rand;
      const strong = this.paths.filter(p => p.active && p.stage === 'practice' && p.s > 0.35);
      let x, y;
      if (strong.length) {
        const p = strong[Math.floor(R() * strong.length)];
        const q = p.pts[4 + Math.floor(R() * 8)];
        x = q[0] + (R() - 0.5) * 0.03; y = q[1] + (R() - 0.5) * 0.03;
      } else {
        [x, y] = this.cortexPoint();
      }
      if (brainSDF(x, y) > -0.09) return false;
      this.lesion = { x, y, r: 0.06 + R() * 0.025, t0: this.time, age: 0, k: 0 };
      for (const p of this.paths) if (p.active) this.detour(p, false);
      return true;
    }

    update(dt, P) {
      const R = this.rand;
      this.time += dt;
      const L = this.lesion;

      // injuries: rare, quiet, and they heal into a faint scar
      if (L) {
        L.age += dt;
        // opens over a few seconds, stays while the brain adapts, then slowly settles
        L.k = Math.min(1, L.age / 5) * (1 - Math.min(1, Math.max(0, (L.age - 160) / 120)));
        if (L.age > 280) {
          this.lesion = null;
          for (const p of this.paths) p.target = null;
          this.nextInjury = this.time + 200 + R() * 240;
        }
      } else if (P.injury > 0.05) {
        if (this.nextInjury === 0) this.nextInjury = this.time + 60 + R() * 120;
        if (this.time > this.nextInjury && !this.injure()) this.nextInjury = this.time + 10;
      }
      const rewire = L && L.age > 10 ? 1 : 0;

      for (const p of this.paths) {
        if (!p.active) {
          p.cool -= dt;
          if (p.cool <= 0 && R() < P.spawn * dt) this.spawn(p);
          continue;
        }
        if (p.stage === 'candidate') {
          p.s += P.grow * dt * 0.12 * (0.42 - p.s);
          p.timer -= dt;
          if (p.timer <= 0) {
            if (R() < P.practice) {
              p.stage = 'practice'; p.timer = 60 + R() * 140; p.input = 0.5;
              p.sites = [this.claim(p.pts[0], p), this.claim(p.pts[K - 1], p)];
            } else p.stage = 'neglect';
          }
        } else if (p.stage === 'practice') {
          p.timer -= dt;
          // experience arrives from outside the brain
          p.input -= dt;
          if (p.input <= 0) {
            p.input = 0.9 + R() * 0.7;
            this.inputs.push({ p, u: 0 });
          }
          if (p.timer <= 0) p.stage = 'neglect';
        }
        p.s = Math.max(0, p.s - (P.decay + (p.stage === 'neglect' ? P.forget : 0)) * dt);
        if (p.stage === 'neglect' && p.s < 0.02 && !p.pulses.length) {
          p.active = false; p.stage = 'empty'; p.cool = 4 + R() * 10; p.s = 0;
          for (const g of p.sites) g.owner = null;
          p.sites = [];
          continue;
        }

        // rewiring around the injury
        if (p.target && rewire) {
          const k = 1 - Math.exp(-dt * 0.1);
          p.pts.forEach((q, j) => {
            q[0] += (p.target[j][0] - q[0]) * k; q[1] += (p.target[j][1] - q[1]) * k;
            if (p.mul[j] < 1) p.mul[j] = Math.min(1, p.mul[j] + 0.01 * dt);
          });
        }

        const brk = this.breakAt(p), next = [];
        for (const u of p.pulses) {
          const nu = u + dt * (0.16 + 0.34 * p.s);   // a well-learned pathway conducts faster
          if (nu >= brk) {                  // the signal dies at the edge of the injury
            const q = this.point(p, brk);
            this.sparks.push({ x: q[0], y: q[1], a: 0.6 });
          } else if (nu >= 1) {             // it got through: Hebbian strengthening
            p.s = Math.min(1, p.s + 0.06 * (1 - p.s));
            for (let k = 0; k < K; k++) p.mul[k] = Math.min(1, p.mul[k] + 0.15 * (1 - p.mul[k]));
            p.dstFlash = 0.6;
          } else next.push(nu);
        }
        p.pulses = next;
        p.srcFlash *= Math.exp(-dt * 2);
        p.dstFlash *= Math.exp(-dt * 1.6);
      }

      // regions grow while their pathway is practised, and shrink back slowly once it is not
      const gIn = 1 - Math.exp(-dt / 40), gOut = Math.exp(-dt / 150);
      for (const g of GROW) {
        if (g.owner && g.owner.stage === 'practice') g.a += (g.owner.s - g.a) * gIn;
        else g.a *= gOut;
      }

      // sparks of experience drifting in from outside
      this.inputs = this.inputs.filter(inp => {
        inp.u += dt / 1.6;
        if (!inp.p.active) return false;
        if (inp.u >= 1) { inp.p.pulses.push(0); inp.p.srcFlash = 0.6; return false; }
        return true;
      });

      // explosions of new connections (young brain; border of an injury)
      const nearLesion = L && L.age > 10 && L.age < 170 ? 0.35 : 0;
      this.burstCarry += (P.burst + nearLesion) * dt;
      while (this.burstCarry >= 1) {
        this.burstCarry--;
        let pos, w = 0.85;
        if (L && R() < nearLesion / (P.burst + nearLesion)) {
          const a = R() * Math.PI * 2;
          pos = [L.x + Math.cos(a) * L.r * 1.35, L.y + Math.sin(a) * L.r * 1.35]; w = 0.6;
        } else {
          for (let t = 0; t < 30; t++) {
            const x = R() * ASPECT, y = R();
            if (brainSDF(x, y) < -0.03) { pos = [x, y]; break; }
          }
          pos = pos || CENTER;
        }
        this.bursts.push({ x: pos[0], y: pos[1], t0: this.time, w });
      }
      this.bursts = this.bursts.filter(b => this.time - b.t0 < 1.6).slice(-8);

      for (const s of this.sparks) s.a *= Math.exp(-dt * 2.5);
      this.sparks = this.sparks.filter(s => s.a > 0.02).slice(-6);
    }

    /* everything the shaders need, packed into typed arrays */
    uniforms(out) {
      const pts = out.pts || (out.pts = new Float32Array(NP * K * 2));
      const mul = out.mul || (out.mul = new Float32Array(NP * K));
      const str = out.str || (out.str = new Float32Array(NP));
      const pul = out.pul || (out.pul = new Float32Array(NP * 3));
      const col = out.col || (out.col = new Float32Array(NP * 3));
      const nuc = out.nuc || (out.nuc = new Float32Array(12 * 4));
      const glo = out.glo || (out.glo = new Float32Array(40 * 4));
      const bur = out.bur || (out.bur = new Float32Array(8 * 4));
      const gro = out.gro || (out.gro = new Float32Array(NG * 4));
      glo.fill(0); bur.fill(0); nuc.fill(0); str.fill(0);
      GROW.forEach((g, j) => gro.set([g.x, g.y, g.a, 0], j * 4));
      let g = 0;
      const glow = (x, y, a, id) => { if (g < 40) { glo.set([x, y, a, id], g * 4); g++; } };
      this.paths.forEach((p, i) => {
        col.set(p.col, i * 3);
        for (let j = 0; j < 3; j++) pul[i * 3 + j] = -1;
        if (!p.active) return;
        for (let k = 0; k < K; k++) {
          pts[(i * K + k) * 2] = p.pts[k][0]; pts[(i * K + k) * 2 + 1] = p.pts[k][1];
          mul[i * K + k] = p.mul[k];
        }
        str[i] = p.s;
        for (let j = 0; j < 3; j++) pul[i * 3 + j] = j < p.pulses.length ? p.pulses[p.pulses.length - 1 - j] : -1;
        const a = p.pts[0], b = p.pts[K - 1], base = Math.min(1, p.s * 0.9) * 0.6;
        nuc.set([a[0], a[1], base + p.srcFlash, i], i * 8);
        nuc.set([b[0], b[1], base + p.dstFlash, i], i * 8 + 4);
        for (const u of p.pulses) { const q = this.point(p, u); glow(q[0], q[1], 0.85, i); }
      });
      for (const inp of this.inputs) {
        const p = inp.p, e = p.entry, s = p.pts[0], u = inp.u;
        // a gentle curve from outside toward the source region
        const cx = (e[0] + s[0]) / 2 + (s[1] - e[1]) * 0.25, cy = (e[1] + s[1]) / 2 - (s[0] - e[0]) * 0.25;
        const iu = 1 - u;
        const x = iu * iu * e[0] + 2 * iu * u * cx + u * u * s[0], y = iu * iu * e[1] + 2 * iu * u * cy + u * u * s[1];
        glow(x, y, 0.45 * Math.min(1, u * 4), p.i);
      }
      for (const s of this.sparks) glow(s.x, s.y, s.a, -1);
      this.bursts.forEach((b, j) => bur.set([b.x, b.y, b.t0, b.w], j * 4));
      const L = this.lesion;
      out.lesion = L ? [L.x, L.y, L.r, L.t0] : [0, 0, 0, 0];
      out.lesionK = L ? L.k : 0;
      return out;
    }
  }

  global.Director = Director;
  global.brainSDF = brainSDF;
  global.BRAIN_ASPECT = ASPECT;
})(window);
