/* ==========================================================================
   shaders.js — GLSL for the five GPU passes
   --------------------------------------------------------------------------
   1 FLOW      a small texture of velocities: curl-noise turbulence, currents
               along the pathways, the outward push of the injury; and one of
               how far the outline swells where regions are in use
   2 PARTICLES moves ~260 000 particles (position + velocity in a float texture)
   3 ADVECT    the previous image is smeared along the flow and fades: this
               turns particles into fibres, streaks and marbled tissue
   4 POINTS    draws the particles additively on top
   5 COMPOSITE relief lighting, bloom, glowing nuclei, signals, the injury
               ring with its lightning cracks, tone mapping
   ========================================================================== */

const GLSL_COMMON = `
#define A 1.2698413
#define NP 6
#define K 16
#define NG 32

float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

vec3 mod289(vec3 x){ return x - floor(x * (1. / 289.)) * 289.; }
vec4 mod289(vec4 x){ return x - floor(x * (1. / 289.)) * 289.; }
vec4 permute(vec4 x){ return mod289(((x * 34.) + 1.) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1. / 6., 1. / 3.);
  const vec4 D = vec4(0., .5, 1., 2.);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1. - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0., i1.z, i2.z, 1.)) + i.y + vec4(0., i1.y, i2.y, 1.)) + i.x + vec4(0., i1.x, i2.x, 1.));
  float n_ = .142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49. * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7. * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1. - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2. + 1.;
  vec4 s1 = floor(b1) * 2. + 1.;
  vec4 sh = -step(h, vec4(0.));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.);
  m = m * m;
  return 42. * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/* brain silhouette — keep in sync with brainSDF() in brain.js */
uniform sampler2D uGrow;   // how far the outline swells around the growth sites (FS_GROW)
float sdEll(vec2 p, vec2 c, vec2 r){ vec2 q = (p - c) / r; return (length(q) - 1.) * min(r.x, r.y); }
float sdCap(vec2 p, vec2 a, vec2 b, float r){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h) - r; }
float smin(float a, float b, float k){ float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
float brain(vec2 p){
  float d = sdEll(p, vec2(.50 * A, .40), vec2(.40 * A, .30));
  d = smin(d, sdEll(p, vec2(.30 * A, .41), vec2(.22 * A, .28)), .05);
  d = smin(d, sdEll(p, vec2(.74 * A, .43), vec2(.20 * A, .24)), .05);
  d = smin(d, sdEll(p, vec2(.50 * A, .60), vec2(.25 * A, .13)), .04);
  d = smin(d, sdEll(p, vec2(.78 * A, .685), vec2(.12 * A, .085)), .015);
  d = smin(d, sdCap(p, vec2(.64 * A, .60), vec2(.60 * A, .93), .03), .03);
  d += .006 * sin(p.x * 37. + 1.3) * sin(p.y * 41. + .7) + .004 * sin(p.x * 83. + p.y * 61.);
  d -= textureLod(uGrow, vec2(p.x / A, 1. - p.y), 0.).r;   // regions swell where they are used
  return d;
}

/* colourful tissue palette: indigo → teal → violet → magenta → ember */
vec3 tissue(float t){
  t = clamp(t, 0., 1.) * 4.;
  vec3 c0 = vec3(.16, .20, .62), c1 = vec3(.05, .60, .66), c2 = vec3(.52, .30, .92), c3 = vec3(.92, .24, .58), c4 = vec3(1., .52, .22);
  if (t < 1.) return mix(c0, c1, t);
  if (t < 2.) return mix(c1, c2, t - 1.);
  if (t < 3.) return mix(c2, c3, t - 2.);
  return mix(c3, c4, t - 3.);
}
vec2 toUv(vec2 p){ return vec2(p.x / A, 1. - p.y); }
`;

const VS_QUAD = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;

/* ---------- 1 FLOW ---------- */
const FS_FLOW = `#version 300 es
precision highp float;
${GLSL_COMMON}
uniform vec2 uPts[NP * K];
uniform float uMul[NP * K];
uniform float uStr[NP];
uniform vec4 uLesion;
uniform float uLesionK, uTurb, uTime;
in vec2 vUv;
out vec4 o;

float psi(vec2 p, float t){ return snoise(vec3(p * 2.0, t)) + .5 * snoise(vec3(p * 4.7, t * 1.3 + 5.)); }

void main(){
  vec2 p = vec2(vUv.x * A, 1. - vUv.y);
  float t = uTime * .03, e = .0015;
  vec2 v = vec2(psi(p + vec2(0., e), t) - psi(p - vec2(0., e), t),
              -(psi(p + vec2(e, 0.), t) - psi(p - vec2(e, 0.), t))) / (2. * e);
  v *= .011 * uTurb;

  float best = 0., bid = 0.;
  for (int i = 0; i < NP; i++) {
    float s = uStr[i];
    if (s < .01) continue;
    float wid = .007 + .015 * s;
    for (int k = 0; k < K - 1; k++) {
      vec2 a = uPts[i * K + k], b = uPts[i * K + k + 1], ba = b - a;
      float h = clamp(dot(p - a, ba) / dot(ba, ba), 0., 1.);
      float d = length(p - a - ba * h);
      float m = mix(uMul[i * K + k], uMul[i * K + k + 1], h);
      float w = s * m * exp(-d * d / (wid * wid));
      v += normalize(ba) * w * .16;
      if (w > best) { best = w; bid = float(i) + (float(k) + h) / float(K - 1) * .98; }
    }
  }

  if (uLesion.z > 0.) {
    vec2 d = p - uLesion.xy; float L = length(d) + 1e-4, r = uLesion.z;
    v += d / L * smoothstep(r * 1.3, r * .5, L) * .16 * uLesionK;            // tissue slowly withdraws
    v += vec2(-d.y, d.x) / L * exp(-pow((L - r) / (r * .3), 2.)) * .04 * uLesionK;
  }
  o = vec4(v, best, bid);
}`;

/* how far the outline swells around the growth sites, read by brain() */
const FS_GROW = `#version 300 es
precision highp float;
${GLSL_COMMON}
uniform vec4 uGro[NG];
in vec2 vUv;
out vec4 o;
void main(){
  vec2 p = vec2(vUv.x * A, 1. - vUv.y);
  float s = 0.;
  for (int i = 0; i < NG; i++) {        // keep in sync with brainSDF() in brain.js
    vec4 g = uGro[i];
    if (g.z < .005) continue;
    vec2 q = p - g.xy;
    s += .04 * g.z * exp(-dot(q, q) / .01);
  }
  o = vec4(s, 0., 0., 1.);
}`;

/* ---------- 2 PARTICLES ---------- */
const FS_PARTICLES = `#version 300 es
precision highp float;
${GLSL_COMMON}
uniform sampler2D uPos, uFlow;
uniform float uDt, uClock, uStoryT, uAttract, uInit, uField;
uniform vec4 uBurst[8];
uniform vec4 uLesion;
uniform float uLesionK;
out vec4 o;

void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 id = vec2(ij);
  vec4 P = texelFetch(uPos, ij, 0);
  float seed = hash12(id + .5), kind = hash12(id * 1.7 + 3.1);
  float rate = .16 + .22 * hash12(id * 2.3 + 7.);
  float ph = fract(uClock * rate + seed), php = fract((uClock - uDt) * rate + seed);
  vec2 pos = P.xy, vel = P.zw;

  if (ph < php || uInit > .5) {
    // respawn — sometimes inside a fresh explosion
    float cyc = floor(uClock * rate + seed);
    float pick = hash12(id + cyc * 1.31);
    bool done = false;
    for (int b = 0; b < 8; b++) {
      vec4 B = uBurst[b];
      float age = uStoryT - B.z;
      if (B.w > 0. && age >= 0. && age < .45 && pick < .4 * B.w) {
        vec2 r2 = hash22(id + cyc * 7.7 + float(b));
        float ang = r2.x * 6.2832;
        vec2 dir = vec2(cos(ang), sin(ang));
        pos = B.xy + dir * .004 * r2.y;
        vel = dir * (.2 + .45 * r2.y * r2.y) * B.w;
        done = true; break;
      }
    }
    if (!done) {
      pos = vec2(.5 * A, .4);
      for (int t = 0; t < 8; t++) {
        vec2 q = hash22(id + cyc * 3.17 + float(t) * 11.3) * vec2(A, 1.);
        if (brain(q) < -.005) { pos = q; break; }
      }
      vel = vec2(0.);
    }
  } else {
    vec2 uv = toUv(pos);
    vec4 F = texture(uFlow, uv);
    vec2 target = F.xy;
    float bd = brain(pos);
    if (kind < .35) {   // "seekers" gather into the pathways
      float e = .006;
      float gx = texture(uFlow, uv + vec2(e / A, 0.)).z - texture(uFlow, uv - vec2(e / A, 0.)).z;
      float gy = texture(uFlow, uv - vec2(0., e)).z - texture(uFlow, uv + vec2(0., e)).z;
      target += vec2(gx, gy) / (2. * e) * uAttract * .003;
    }
    float wander = uField * step(hash12(id * 3.7 + 1.3), .4);   // ?field=1: some particles may leave the brain
    if (wander > .5) {  // ... and stream out into its surroundings, in slow plumes
      float plume = smoothstep(-.3, .6, snoise(vec3(pos * 2.5, uClock * .06)));
      target += normalize(pos - vec2(.5 * A, .44) + 1e-4) * plume * smoothstep(-.2, 0., bd) * .22;
    }
    vel = mix(vel, target, 1. - exp(-uDt * 2.2));

    for (int b = 0; b < 8; b++) {     // shock shell of each explosion
      vec4 B = uBurst[b];
      float age = uStoryT - B.z;
      if (B.w > 0. && age >= 0. && age < 1.4) {
        vec2 d = pos - B.xy; float L = length(d) + 1e-4;
        float R = age * .32;
        vel += d / L * exp(-pow((L - R) / .03, 2.)) * exp(-age * 2.) * 2.2 * uDt * B.w;
      }
    }
    if (uLesion.z > 0.) {                  // no blast: the tissue quietly withdraws from the injury
      vec2 d = pos - uLesion.xy; float L = length(d) + 1e-4, r = uLesion.z;
      if (L < r) vel += d / L * (1. - L / r) * 2. * uDt * uLesionK;
    }
    if (bd > 0. && wander < .5) vel *= exp(-uDt * 1.5);
    pos += vel * uDt;
  }
  o = vec4(pos, vel);
}`;

/* ---------- 3 ADVECT ---------- */
const FS_ADVECT = `#version 300 es
precision highp float;
${GLSL_COMMON}
uniform sampler2D uPrev, uFlow;
uniform float uDt, uDecay, uPrune, uField;
uniform vec2 uTexel;
uniform vec4 uLesion;
uniform float uLesionK;
in vec2 vUv;
out vec4 o;
void main(){
  vec4 F = texture(uFlow, vUv);
  vec2 uv = vUv - vec2(F.x / A, -F.y) * uDt * .5;
  vec3 c = textureLod(uPrev, uv, 0.).rgb;
  vec3 n = textureLod(uPrev, uv + vec2(uTexel.x, 0.), 0.).rgb + textureLod(uPrev, uv - vec2(uTexel.x, 0.), 0.).rgb
         + textureLod(uPrev, uv + vec2(0., uTexel.y), 0.).rgb + textureLod(uPrev, uv - vec2(0., uTexel.y), 0.).rgb;
  c = mix(c, n * .25, .1);
  float dec = uDecay * mix(1., mix(.978, 1., smoothstep(.03, .3, F.z)), uPrune);
  vec2 p = vec2(vUv.x * A, 1. - vUv.y);
  if (uLesion.z > 0. && length(p - uLesion.xy) < uLesion.z) dec *= mix(1., .9, uLesionK);
  if (brain(p) > .01) dec *= mix(.965, .985, uField);   // ?field=1: longer streaks outside the brain
  o = vec4(c * dec, 1.);
}`;

/* ---------- 4 POINTS ---------- */
const VS_POINTS = `#version 300 es
precision highp float;
${GLSL_COMMON}
uniform sampler2D uPos, uFlow;
uniform float uClock, uStoryT, uPointSize, uReveal, uPrune, uGain, uField, uBody;
uniform vec3 uPathCol[NP];
uniform vec3 uPulse[NP];
uniform vec4 uLesion;
uniform float uLesionK;
out vec3 vCol;
void main(){
  int N = textureSize(uPos, 0).x;
  ivec2 ij = ivec2(gl_VertexID % N, gl_VertexID / N);
  vec2 id = vec2(ij);
  vec4 P = texelFetch(uPos, ij, 0);
  vec2 pos = P.xy;
  float seed = hash12(id + .5), kind = hash12(id * 1.7 + 3.1);
  float rate = .16 + .22 * hash12(id * 2.3 + 7.);
  float ph = fract(uClock * rate + seed);
  float life = smoothstep(0., .06, ph) * smoothstep(1., .7, ph);

  vec2 uv = toUv(pos);
  vec4 F = texture(uFlow, uv);
  float bd = brain(pos), inside = smoothstep(.012, -.02, bd);

  // tissue colour drifts slowly across the brain
  float hue = .5 + .42 * sin(pos.x * 2.4 + sin(pos.y * 3.3 + uClock * .05) * 2.1 + uClock * .025) + .28 * sin(pos.y * 5.1 - pos.x * 1.7 + uClock * .04);
  vec3 c = tissue(hue * .75 + seed * .25);
  // gyri: folds of the cortex show as brighter ridges
  float g = 1. - abs(snoise(vec3(pos * vec2(6.5, 7.5), 3.7)));
  // outside the brain a particle almost vanishes; with ?field=1 a wanderer stays, darker the further it drifts
  float wander = uField * step(hash12(id * 3.7 + 1.3), .4);
  float spill = mix(.05, .8 * exp(-max(bd, 0.) / .3), wander);
  float a = .42 * mix(spill, 1., inside) * (.3 + 1.0 * g * g);

  float prox = F.z;
  int pid = clamp(int(floor(F.w)), 0, NP - 1);
  float ps = fract(F.w) / .98;
  float pk = smoothstep(.04, .5, prox);
  c = mix(c, uPathCol[pid], pk * .9);
  a *= mix(1., .5 + 1.6 * pk, uPrune);
  a *= 1. + pk * (kind < .35 ? 1.2 : .4);
  a *= mix(uBody, 1., pk);                 // with ?field=1 the tissue is lifted against the world around it

  // signals travelling along the pathway light up the fibres
  vec3 pu = uPulse[pid];
  float boost = 0.;
  for (int k = 0; k < 3; k++) if (pu[k] >= 0.) boost += exp(-pow((ps - pu[k]) / .022, 2.));
  boost *= pk;
  c = mix(c, vec3(1., .96, .88), min(boost, 1.) * .55);
  a *= 1. + boost * 3.;

  // fast particles (explosions, the blast) burn hot
  float sp = length(P.zw);
  float hot = smoothstep(.2, .6, sp);
  c = mix(c, vec3(1., .82, .58), hot * .5);
  a *= 1. + hot * 3.;

  if (uLesion.z > 0.) {                    // a warm glow gathers at the border of the injury
    float L = length(pos - uLesion.xy);
    float rim = exp(-pow((L - uLesion.z) / (uLesion.z * .25), 2.)) * uLesionK;
    c = mix(c, vec3(1., .42, .28), rim * .6);
    a *= 1. + rim;
  }

  float rv = smoothstep(uReveal * 1.25 - .25, uReveal * 1.25, length((pos - vec2(.5 * A, .45)) * vec2(.8, 1.)) * 1.3);
  a *= (1. - rv) * life * uGain;

  vCol = c * a;
  gl_Position = vec4(uv * 2. - 1., 0., 1.);
  gl_PointSize = uPointSize * (kind < .35 ? 1.25 : 1.);
}`;

const FS_POINTS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 o;
void main(){ o = vec4(vCol, 1.); }`;

/* ---------- 5 COMPOSITE ---------- */
const FS_COMPOSITE = `#version 300 es
precision highp float;
${GLSL_COMMON}
uniform sampler2D uTrail;
uniform vec2 uTexel, uRes;
uniform float uClock, uStoryT, uBump, uBloom, uExposure, uFade;
uniform vec4 uLesion;
uniform float uLesionK;
uniform vec4 uNuc[12];
uniform vec4 uGlow[40];
uniform vec3 uPathCol[NP];
in vec2 vUv;
out vec4 o;

float lum(vec3 c){ return dot(c, vec3(.3, .5, .2)); }

void main(){
  vec3 c = textureLod(uTrail, vUv, 0.).rgb;
  vec2 e = uTexel * 1.5;
  float lx = lum(textureLod(uTrail, vUv + vec2(e.x, 0.), 0.).rgb) - lum(textureLod(uTrail, vUv - vec2(e.x, 0.), 0.).rgb);
  float ly = lum(textureLod(uTrail, vUv + vec2(0., e.y), 0.).rgb) - lum(textureLod(uTrail, vUv - vec2(0., e.y), 0.).rgb);
  // relief lighting: the trail image is treated as a height field
  vec3 N = normalize(vec3(-lx * uBump, -ly * uBump, 1.));
  vec3 Ld = normalize(vec3(-.45, .55, .7));
  float diff = max(dot(N, Ld), 0.);
  float spec = pow(max(dot(reflect(-Ld, N), vec3(0., 0., 1.)), 0.), 16.);
  float l = lum(c);
  vec3 col = c * (.3 + 1.0 * diff) + vec3(spec) * min(l, 1.2) * .35;
  col += (textureLod(uTrail, vUv, 3.).rgb * .55 + textureLod(uTrail, vUv, 5.).rgb * .45) * uBloom;

  vec2 p = vec2(vUv.x * A, 1. - vUv.y);

  for (int i = 0; i < 12; i++) {            // nuclei at the ends of each pathway
    vec4 n = uNuc[i];
    if (n.z <= .01) continue;
    float d2 = dot(p - n.xy, p - n.xy);
    vec3 pc = uPathCol[int(n.w)];
    col += (pc * (exp(-d2 / .0012) * .35 + exp(-d2 / .00012) * 1.2) + vec3(1.) * exp(-d2 / .000015) * .8) * n.z;
  }
  for (int i = 0; i < 40; i++) {            // signals, incoming experience, sparks
    vec4 g = uGlow[i];
    if (g.z <= .01) continue;
    float d2 = dot(p - g.xy, p - g.xy);
    vec3 gc = g.w < 0. ? vec3(1., .45, .3) : uPathCol[int(g.w)];
    col += (gc * exp(-d2 / .0006) * .45 + vec3(1., .97, .9) * exp(-d2 / .00003) * 1.1) * g.z;
  }

  col = 1. - exp(-col * uExposure);

  if (uLesion.z > 0. && uLesionK > .001) {   // the injury: a quiet dark region, a softly glowing cracked border
    vec2 d = p - uLesion.xy; float D = length(d), r = uLesion.z, age = uStoryT - uLesion.w, k = uLesionK;
    float crater = smoothstep(r * 1.05, r * .45, D);
    col *= 1. - crater * .85 * k;
    float breathe = .85 + .15 * sin(age * .6);
    float cr = pow(1. - abs(snoise(vec3(d * 30., age * .05))), 16.);
    float cr2 = pow(1. - abs(snoise(vec3(d * 62. + 4., age * .08))), 20.);
    float band = exp(-pow((D - r) / (r * .25), 2.));
    float rim = exp(-pow((D - r) / (r * .045), 2.));
    col += vec3(1., .45, .3) * (rim * .45 + (cr + cr2 * .5) * band * .5 + cr * .06 * crater) * k * breathe;
  }

  vec2 q = vUv - .5;
  col *= 1. - dot(q, q) * .9;
  col += (hash12(vUv * uRes + fract(uClock) * 97.) - .5) * .025;
  col *= 1. - uFade;
  o = vec4(max(col, 0.), 1.);
}`;
