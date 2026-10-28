/* ==========================================================================
   life.js — the slow rhythm of a lifetime
   --------------------------------------------------------------------------
   There are no chapters. Pathways are born, practised, abandoned and pruned
   on their own; injuries happen now and then and heal. What changes slowly
   is the *character* of the brain over one "lifetime": young and exuberant,
   then pruning and specialising, then settled and calmer. At the end the
   brain dissolves and a new one, never the same, begins to grow.

   The keyframes below are blended smoothly over the lifetime (at = 0..1).

   turb      swirling of the tissue
   burst     explosions of new connections per second
   spawn     chance per second that an empty slot sprouts a new pathway
   grow      how fast a new pathway becomes visible
   practice  share of new pathways that the "environment" starts to use
   decay     strength lost per second by every pathway
   forget    extra strength lost per second by pathways no longer used
   prune     how much the tissue outside the pathways dims
   attract   how strongly particles gather into pathways
   injury    how likely injuries are (0 = none)
   ========================================================================== */

const LIFE = {
  duration: 1440,          // seconds per lifetime (24 minutes)
  dissolve: 30,            // seconds of fading out at the end of a lifetime
  keys: [
    { at: 0.00, turb: 1.05, burst: 1.1, spawn: 0.30, grow: 1.0, practice: 0.35, decay: 0.000, forget: 0.012, prune: 0.00, attract: 0.4, injury: 0.0 },
    { at: 0.12, turb: 0.95, burst: 0.7, spawn: 0.20, grow: 1.0, practice: 0.50, decay: 0.002, forget: 0.016, prune: 0.25, attract: 0.8, injury: 0.0 },
    { at: 0.30, turb: 0.80, burst: 0.25, spawn: 0.08, grow: 0.8, practice: 0.65, decay: 0.004, forget: 0.024, prune: 0.80, attract: 1.2, injury: 1.0 },
    { at: 0.70, turb: 0.72, burst: 0.15, spawn: 0.05, grow: 0.7, practice: 0.60, decay: 0.004, forget: 0.028, prune: 0.85, attract: 1.3, injury: 1.0 },
    { at: 1.00, turb: 0.62, burst: 0.08, spawn: 0.03, grow: 0.6, practice: 0.45, decay: 0.005, forget: 0.030, prune: 0.90, attract: 1.1, injury: 0.5 }
  ]
};
