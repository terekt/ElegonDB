/* Elegon rotation simulator -------------------------------------------------
   An event-driven combat model for a single target over a fixed fight, and a
   search that finds the priority order which plays it best.

   Nothing here touches the DOM, so the same file runs in the page and under
   node for the test suite. It reads the catalogue the rest of the site reads
   (window.ELEGON) and re-derives every number from the formulas in app.js
   rather than keeping a second copy of them:

     damage      = base   x  1 + 0.04(level-1)  x  (1 + 0.01 Strength)  x  rank  x  amp  x  weapon
     healing     = base   x  1 + 0.04(level-1)  x  (1 + 0.01 Grace)     x  rank  x  amp  x  weapon
     tick        = fxAmt  x  1 + 0.024(level-1) x  (1 + 0.01 stat)      x  rank  x  amp  x  weapon
     cast time   = base / (1 + max(alacrity bonus, amp))
     global cd   = 1.50 / (1 + tempo bonus)
     bonus(r)    = 0.4 r / (r + 20 + level)

   The one thing the catalogue does not carry is the size of the class
   resource pool, so it is a setting rather than a constant, and the panel says
   which value produced the answer.                                          */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ElegonSim = api;
}(typeof self !== "undefined" ? self : this, function () {
"use strict";

/* Effect types, as SpellTooltipFormatter names them. */
const FX_STUN = 1, FX_DOT = 2, FX_HOT = 3, FX_REDUCE = 4, FX_POWER = 5;
const KNOWN_FX = new Set([FX_STUN, FX_DOT, FX_HOT, FX_REDUCE, FX_POWER]);
const GCD_BASE = 1.5;
const EPS = 1e-9;

/* ---- the game's formulas, mirrored ---------------------------------------
   Duplicated from app.js only because this file must also run under node,
   where there is no page to have loaded it. The test suite checks the two
   agree, so a change to one that is not made to the other fails the build
   rather than quietly producing a different answer than the planner shows. */
const ratingBonus = (r, level) => 0.4 * Math.max(0, r) / (Math.max(0, r) + 20 + level);
const mitigation = f => Math.min(0.60, Math.max(0, f) / (Math.max(0, f) + 500));
const maxHealth = (base, level, vitality) => base + 8 * (level - 1) + 10 * vitality;
const DEFENSE_PER_POINT = 0.0002;

/* Three independent reductions applied in turn, so they multiply: adding them
   would let 60% Fortitude and an 80% Stonewall cancel a hit entirely. The buff
   term is the STRONGEST live damage reduction and never their sum — two of them
   up at once is worth exactly the better one, which is what makes Encase's 50%
   worth nothing on top of a Guard already running at 50%. */
const takenFraction = (fortitude, buff, defense) =>
  (1 - mitigation(fortitude)) * (1 - buff) * (1 - defense);

/* BreachInstability.GrowthMultiplier, the damage half. Float32 either side of
   the multiply, as the game does it. */
const f32 = Math.fround;
const enemyDamageMult = t => {
  if (!t || t <= 0) return 1;
  const capped = Math.min(t, 10);
  return f32(f32(Math.pow(1.10, capped)) * f32(Math.pow(1.03, t - capped)));
};
const levelMul = level => 1 + 0.04 * (level - 1);
const effectLevelMul = level => 1 + 0.024 * (level - 1);
const talentMul = rank => 1 + 0.2 * Math.max(0, rank - 1);
const gcdFor = (tempo, level) => GCD_BASE / (1 + ratingBonus(tempo, level));

/* A spell whose amount arrives in instalments. Type 8 is Living Scripture,
   which the client has no wording for but which carries an amount and a tick,
   so it is treated as periodic and flagged as inferred wherever it is shown. */
const isPeriodic = s => s.fx === FX_DOT || s.fx === FX_HOT
                     || (s.fxAmt > 0 && s.fxTick > 0 && !KNOWN_FX.has(s.fx));
const healsOverTime = s => s.fx === FX_HOT || (!KNOWN_FX.has(s.fx) && s.fxBuff);

/* ---- who a spell reaches -------------------------------------------------
   The catalogue says how a spell is delivered, and that is what decides how it
   behaves against more than one enemy. A melee arc and a ground area cover
   everything standing in them; a chain hits its target and ricochets to three
   more at 65% each, which the two chain spells say in so many words; everything
   else is one target however many are in front of you.                       */
const DLV_ARC = 2, DLV_GROUND = 5, DLV_CHAIN = 11;
const REACHES_ALL = new Set([DLV_ARC, DLV_GROUND]);
const CHAIN_EXTRA = 3, CHAIN_FRACTION = 0.65;

/** How many times a spell's direct value lands, given a pack of this size. */
function directReach(dlv, targets) {
  if (REACHES_ALL.has(dlv)) return targets;
  if (dlv === DLV_CHAIN) return 1 + Math.min(CHAIN_EXTRA, targets - 1) * CHAIN_FRACTION;
  return 1;
}

/* Where the hit lands relative to the end of the cast. A spell carries its own
   impact delay where it has one; otherwise the handler applies a fixed delay
   per delivery kind, and a projectile adds flight time on top. */
function landDelay(s, timing, range) {
  const fixed = s.impact || ({1: timing.meleeImpact, 2: timing.arcImpact,
                              4: timing.rangedImpact})[s.dlv] || 0;
  if (s.dlv === 3 && s.maxR) {
    const speed = s.projSpeed || timing.projectileSpeed;
    if (speed) return fixed + Math.min(range == null ? s.maxR : range, s.maxR) / speed;
  }
  return fixed;
}

/* ---- what counts as part of a rotation -----------------------------------
   A rotation is made of things that raise the number being measured. Anything
   that only keeps you alive or moves you is left out, and the reason is kept
   so the panel can say why rather than silently dropping half a class.       */
const OMIT = {
  defensive: "reduces damage taken — no effect on output",
  control:   "crowd control with no damage of its own",
  mobility:  "movement, deals nothing",
  utility:   "not a combat action",
  healing:   "healing, not damage",
  damage:    "damage, not healing",
  wrongClass:"another class",
  tooHigh:   "not learned at this level",
  exclusive: "the other half of an either/or choice",
};

/** Every spell this class could bring to the given rotation, and what it does. */
function candidates(D, opts) {
  const cls = String(opts.cls), level = opts.level, healMode = !!opts.healing;
  const tankMode = !!opts.survival;
  const kept = [], dropped = [];
  for (const s of D.spells) {
    if (s.name === "Recall" || s.id === (D.spellTiming || {}).autoAttackSpellId) continue;
    if (String(s.cls) !== cls) continue;
    if (s.lvl > level) { dropped.push({s, why: OMIT.tooHigh}); continue; }

    const periodic = isPeriodic(s);
    const hots = periodic && healsOverTime(s);
    const amp  = s.fx === FX_POWER;
    const direct = s.base > 0;
    const givesHeal = s.heals || s.hybrid;

    let why = null;
    if (tankMode) {
      /* Staying alive is the question, so anything that reduces a hit, stops
         one landing, or puts health back counts — and so does everything that
         deals damage, because damage is the tie-break once the damage taken is
         as low as it will go. Only movement with nothing attached is left out. */
      const stops = s.fx === FX_REDUCE || s.fx === FX_STUN;
      const mends = periodic && hots && s.dlv === 0;
      const hurts = (direct && !s.heals) || (periodic && !hots);
      if (!stops && !mends && !hurts && !amp)
        why = s.dlv === 7 || s.dlv === 9 ? OMIT.mobility : OMIT.utility;
      if (why) dropped.push({s, why}); else kept.push(s);
      continue;
    }
    if (s.fx === FX_REDUCE) why = OMIT.defensive;
    else if (amp) why = null;                                  // buffs always count
    else if (healMode) {
      if (!givesHeal && !hots) why = direct || (periodic && !hots) ? OMIT.damage : null;
      if (!givesHeal && !hots && !why) why = s.dlv === 7 || s.dlv === 9 ? OMIT.mobility
                                          : s.fx === FX_STUN ? OMIT.control : OMIT.utility;
    } else {
      const damages = (direct && !s.heals) || (periodic && !hots);
      if (!damages) why = s.heals || hots ? OMIT.healing
                        : s.dlv === 7 || s.dlv === 9 ? OMIT.mobility
                        : s.fx === FX_STUN ? OMIT.control : OMIT.utility;
    }
    if (why) dropped.push({s, why});
    else kept.push(s);
  }
  return {kept, dropped};
}

/* Flamestorm and Arcane Tempest are the same slot in the talent tree, so a
   build has one or the other and the two have to be solved separately. */
/* Flamestorm or Arcane Tempest for the Mage; Encase or Stonewall for the
   Knight. The second pair only ever shows up in the survival rotation, because
   neither spell is a candidate when the thing being measured is damage. */
const EXCLUSIVE_PAIRS = [[15, 28], [11, 22]];
function exclusiveChoices(spells) {
  const ids = new Set(spells.map(s => s.id));
  const out = [];
  for (const pair of EXCLUSIVE_PAIRS) {
    const live = pair.filter(id => ids.has(id));
    if (live.length > 1) out.push(live);
  }
  return out;
}

/* ---- turning a spell into an action --------------------------------------
   Everything the loop needs, resolved once, with the two amp-dependent parts
   left as unbuffed bases: the buff is dynamic, so its multiplier is applied at
   the moment of the cast rather than baked in here.                          */
function makeAction(s, C) {
  const rank = C.ranks && C.ranks[s.id] != null ? C.ranks[s.id] : C.rank;
  const tm = talentMul(rank);
  const wep = 1 + C.weaponPower;
  const periodic = isPeriodic(s);
  const hots = periodic && healsOverTime(s);
  const heals = C.healing ? (s.heals || s.hybrid) : false;
  const statFor = h => 1 + 0.01 * (h ? C.grace : C.strength);

  const a = {
    id: s.id, name: s.name, spell: s, rank,
    cost: s.cost || 0, gen: s.gen || 0, cd: s.cd || 0,
    castBase: (s.instant || !s.cast) ? 0 : s.cast,
    land: landDelay(s, C.timing, C.range),
    isBuff: s.fx === FX_POWER,
    buffAmt: s.fx === FX_POWER ? s.fxAmt : 0,
    buffDur: s.fx === FX_POWER ? s.fxDur : 0,
    isPeriodic: periodic,
    heals: !!heals,
    hot: hots,
    refresh: 0,                                   // set by the solver
    inferredFx: periodic && !KNOWN_FX.has(s.fx),
    dlv: s.dlv,
    /* The survival side of a spell: how much of a hit it stops, how long it
       keeps the enemy from swinging, and what it puts back. */
    mit: s.fx === FX_REDUCE ? s.fxAmt : 0,
    mitDur: s.fx === FX_REDUCE ? s.fxDur : 0,
    stun: s.fx === FX_STUN ? s.fxDur : 0,
    /* A ground area or an arc puts its effect on the whole pack at once. A
       single-target effect has to be applied to each enemy separately, which is
       a global cooldown each — so it is tracked per target rather than once. */
    hitsAll: REACHES_ALL.has(s.dlv),
    chains: s.dlv === DLV_CHAIN,
    reach: directReach(s.dlv, C.targets),
  };

  /* Direct value. In healing mode a hybrid heals rather than strikes, which is
     the whole of Smite's role on a healing bar. */
  a.direct = C.healing
    ? (heals ? s.base * levelMul(C.level) * statFor(true) * tm * wep : 0)
    : (s.heals ? 0 : s.base * levelMul(C.level) * statFor(false) * tm * wep);

  if (periodic) {
    a.tick = s.fxAmt * effectLevelMul(C.level) * statFor(hots) * tm * wep;
    a.tickInterval = s.fxTick;
    a.tickDur = s.fxDur;
    a.ticks = Math.floor(s.fxDur / s.fxTick);
    a.tickHeals = hots;
    /* A damage-over-time on a healing bar, or the reverse, contributes nothing
       to the number being measured even though the spell is worth bringing. */
    if (C.healing !== hots) { a.tick = 0; a.ticks = 0; }
  } else {
    a.tick = 0; a.ticks = 0;
  }

  /* A heal over time on yourself is not part of the damage being measured, but
     it is squarely part of surviving — so in the tank rotation it is tracked on
     its own line rather than through the damage one. */
  if (C.survival && periodic && hots && s.dlv === 0) {
    a.healTick = s.fxAmt * effectLevelMul(C.level) * (1 + 0.01 * C.grace) * tm * wep;
    a.healTicks = Math.floor(s.fxDur / s.fxTick);
    a.healInterval = s.fxTick;
    a.healDur = s.fxDur;
  } else {
    a.healTick = 0; a.healTicks = 0;
  }

  a.tracksPeriodic = a.ticks > 0;
  a.tracksHeal = a.healTicks > 0;
  a.tracksMit = a.mit > 0;
  return a;
}

/** The whole build, resolved: stats, level, rank, and the actions available. */
function model(D, cfg) {
  const C = {
    targets: Math.max(1, Math.round(cfg.targets || 1)),
    level: cfg.level, cls: String(cfg.cls), rank: cfg.rank == null ? 1 : cfg.rank,
    ranks: cfg.ranks || null,
    strength: cfg.strength || 0, grace: cfg.grace || 0,
    alacrity: cfg.alacrity || 0, tempo: cfg.tempo || 0,
    weaponPower: cfg.weaponPower || 0,
    healing: !!cfg.healing,
    survival: !!cfg.survival,
    vitality: cfg.vitality || 0, fortitude: cfg.fortitude || 0,
    defense: Math.min(400, Math.max(0, cfg.defense || 0)) * DEFENSE_PER_POINT,
    timing: D.spellTiming || {},
    range: cfg.range,
  };
  const {kept, dropped} = candidates(D, {cls: C.cls, level: C.level,
                                        healing: C.healing, survival: C.survival});
  const picked = cfg.exclude ? kept.filter(s => !cfg.exclude.includes(s.id)) : kept;
  for (const id of cfg.exclude || [])
    if (kept.some(s => s.id === id)) dropped.push({s: kept.find(s => s.id === id), why: OMIT.exclusive});

  const actions = picked.map(s => makeAction(s, C));

  /* The filler: no cost, no cooldown, and it feeds the bar. Every class has
     exactly one, and it is the reason the loop can never stall. */
  const gen = actions.filter(a => a.gen > 0 && !a.cost && !a.cd)
                     .sort((x, y) => y.gen - x.gen)[0] || null;

  /* The weapon swing is a melee action: Auto Attack carries a maximum range of
     4, so a caster standing off does not get one. Knights default to on and
     everyone else to off, and the panel says which was assumed. */
  const auto = (D.spells || []).find(s => s.id === (D.spellTiming || {}).autoAttackSpellId);
  const inMelee = cfg.inMelee == null ? C.cls === "1" : !!cfg.inMelee;
  const autoDmg = (!C.healing && auto)
    ? auto.base * levelMul(C.level) * (1 + 0.01 * C.strength) * (1 + C.weaponPower) : 0;
  const autoRange = auto ? auto.maxR : 0;

  /* What is hitting you, and how hard once instability has scaled it. The
     player's own 3s cycle is the only attack interval the catalogue has, and
     every creature measured swings on it.

     More than one can be on you, so this resolves to a list of individuals —
     three of a kind are three separate clocks, not one creature hitting three
     times as hard. That distinction matters: a stun holds one of them, and a
     pack that swings together is a very different fight from one that swings in
     turn. They are dealt in evenly around the cycle for exactly that reason,
     which for a single attacker is the same schedule as before. */
  const pack = (cfg.enemies && cfg.enemies.length ? cfg.enemies
               : cfg.enemy ? [cfg.enemy] : []);
  const eTier = (pack[0] || {}).tier || 0;
  const foes = [];
  for (const e of pack) {
    const tier = e.tier == null ? eTier : e.tier;
    const each = (e.damage || 0) * enemyDamageMult(tier);
    const interval = e.interval || D.attackInterval || 3;
    const many = Math.max(1, Math.round(e.count || 1));
    for (let i = 0; i < many; i++)
      foes.push({raw: each, interval, base: e.damage || 0, tier,
                 id: e.id, name: e.name || "", boss: !!e.boss,
                 stunnable: e.stunnable !== false, first: 0});
  }
  for (let i = 0; i < foes.length; i++)
    foes[i].first = foes[i].interval * (i + 1) / foes.length;
  const raw = foes.reduce((t, f) => t + f.raw, 0);
  const health = maxHealth(((D.classes || {})[C.cls] || {}).health_base || 162,
                           C.level, C.vitality);

  return {
    cfg: C, actions, dropped, generator: gen, targets: C.targets,
    survival: C.survival, health,
    fortitude: C.fortitude, defense: C.defense,
    /* The individuals, and a summary of them for anything that only wants to
       know how hard the fight hits. */
    foes,
    enemy: {raw, tier: eTier, count: foes.length,
            interval: (foes[0] || {}).interval || D.attackInterval || 3,
            stunnable: foes.some(f => f.stunnable),
            name: (pack[0] || {}).name || "",
            base: foes.reduce((t, f) => t + f.base, 0)},
    /* Someone else's healing, as a flat rate. Difficult content is not soloed,
       and a tank measured without a healer is measured in a fight that does not
       happen — but a second full rotation behind this one would be a second
       solve per point of every curve, so it arrives as a number. */
    healer: Math.max(0, cfg.healerHps || 0),
    gcd: gcdFor(C.tempo, C.level),
    alacrityBonus: ratingBonus(C.alacrity, C.level),
    tempoBonus: ratingBonus(C.tempo, C.level),
    autoDmg, autoInterval: D.attackInterval || 3, autoRange, inMelee,
    autoOn: cfg.autoAttack !== false && !C.healing && inMelee,
    duration: cfg.duration || 300,
    resourceMax: cfg.resourceMax || 100,
    resourceStart: cfg.resourceStart || 0,
    /* An effect over time locks in the buff that was up when it was CAST and keeps it for
       every tick, even after that buff has expired. Measured in game rather than read from
       the catalogue, which carries no flag for it - so the right play is to re-apply a dot
       the instant a buff goes up. Always on: it is what the game does, not a preference. */
    snapshot: cfg.snapshot !== false,
    round: cfg.round !== false,
    exclusive: exclusiveChoices(kept),
  };
}

/* ---- the fight -----------------------------------------------------------
   One pass over the fight, playing the given priority list. There is no queue
   of scheduled hits because a hit changes nothing about the state — it is
   recorded and forgotten — so the only clocks that matter are the next action,
   the next weapon swing, and each live periodic's next tick.                 */
function simulate(M, order, opts) {
  opts = opts || {};
  const keepLog = !!opts.log;
  const dur = M.duration, maxR = M.resourceMax;
  const priority = order;

  let t = 0, nextAction = 0;
  let nextAuto = M.autoOn ? 0 : Infinity;
  let resource = Math.min(M.resourceStart, maxR);
  let ampAmt = 0, ampUntil = -1;
  let total = 0, wasted = 0, idle = 0, actions = 0;

  /* The incoming half of the fight, when there is one. */
  const tank = !!M.survival && M.enemy.raw > 0;
  const guards = new Map();          // live damage reductions, by spell
  const mends = new Map();           // live self-heals, by spell
  /* One record per attacker: when it next swings, and how long it is held. The
     first entry is the one you are facing, so a single-target stun lands there;
     an arc or a ground effect holds the lot. */
  const foes = tank ? (M.foes || []).map(f => ({f, next: f.first, held: -1})) : [];
  const perFoe = new Map();
  for (const fo of foes) {
    const k = fo.f.name || "Enemy";
    if (!perFoe.has(k)) perFoe.set(k, {name: k, id: fo.f.id, count: 0, swings: 0, amount: 0});
    perFoe.get(k).count += 1;
  }
  const stunUntilOf = () => Math.max(...foes.map(fo => fo.held), -1);
  let hp = M.health, minHp = M.health, deathAt = null;
  let taken = 0, healed = 0, overheal = 0, swings = 0, stunned = 0;
  const HEAL_TICK = 1;
  let healerHealed = 0, healerWasted = 0;
  let nextHeal = tank && M.healer > 0 ? HEAL_TICK : Infinity;

  /* Two reductions at once are worth the better of the two, never their sum. */
  const guardAt = tt => {
    let best = 0;
    for (const gd of guards.values()) if (gd.until > tt + EPS) best = Math.max(best, gd.amt);
    return best;
  };

  const N = M.targets || 1;
  const cdReady = new Map();          // spell id -> time it comes off cooldown
  /* Keyed by spell for an effect that covers the ground, and by spell-and-enemy
     for one that has to be applied to each in turn. */
  const live = new Map();
  const per = new Map();              // spell id -> {casts, amount}
  const log = [];
  for (const a of priority) per.set(a.id, {name: a.name, casts: 0, amount: 0, direct: 0, over: 0});
  if (M.autoOn) per.set(-1, {name: "Auto Attack", casts: 0, amount: 0, direct: 0, over: 0});

  const ampAt = tt => (tt < ampUntil ? ampAmt : 0);
  const castTimeOf = (a, tt) =>
    a.castBase ? a.castBase / (1 + Math.max(M.alacrityBonus, ampAt(tt))) : 0;
  const val = (x, amp) => {
    const v = x * (1 + amp);
    return M.round ? Math.round(v) : v;
  };
  const credit = (id, amount, at, kind, label) => {
    if (at > dur + EPS) return false;
    total += amount;
    const p = per.get(id);
    if (p) { p.amount += amount; if (kind === "tick") p.over += amount; else p.direct += amount; }
    if (keepLog) log.push({t: at, id, name: label, kind, amount});
    return true;
  };

  while (true) {
    /* Next thing to happen. Three clocks and at most a handful of periodics,
       so a scan beats a heap and cannot go stale when a dot is re-applied. */
    let tn = nextAction, kind = "act", which = null;
    if (nextAuto < tn) { tn = nextAuto; kind = "auto"; which = null; }
    for (const d of live.values())
      if (d.nextTick < tn) { tn = d.nextTick; kind = "tick"; which = d; }
    for (const fo of foes)
      if (fo.next < tn) { tn = fo.next; kind = "swing"; which = fo; }
    if (nextHeal < tn) { tn = nextHeal; kind = "healer"; which = null; }
    for (const m of mends.values())
      if (m.nextTick < tn) { tn = m.nextTick; kind = "mend"; which = m; }
    if (tn > dur - EPS) break;
    t = tn;

    if (kind === "swing") {
      const fo = which, f = fo.f;
      /* "Stun your target, preventing them from attacking you" — the catalogue's
         own wording, so a stun does not merely mitigate the hit, it postpones
         it. Overlapping stuns therefore buy nothing, which is why the list is
         told not to cast one on an enemy already held. */
      if (f.stunnable && t < fo.held - EPS) {
        stunned += Math.min(fo.held, dur) - t;
        fo.next = fo.held;
        continue;
      }
      const hit = f.raw * takenFraction(M.fortitude, guardAt(t), M.defense);
      const dealt = M.round ? Math.round(hit) : hit;
      taken += dealt;
      hp -= dealt;
      swings += 1;
      const pf = perFoe.get(f.name || "Enemy");
      if (pf) { pf.swings += 1; pf.amount += dealt; }
      if (hp < minHp) minHp = hp;
      if (hp <= 0 && deathAt == null) deathAt = t;
      if (keepLog)
        log.push({t, kind: "swing", amount: dealt, hp, id: -2,
                  name: f.name ? f.name + "'s swing" : "Enemy swing"});
      fo.next = t + f.interval;
      continue;
    }
    if (kind === "healer") {
      const amount = M.healer * HEAL_TICK;
      const room = Math.max(0, M.health - hp);
      const real = Math.min(room, amount);
      healerHealed += real; healerWasted += amount - real;
      hp += real;
      if (keepLog && real > 0)
        log.push({t, kind: "heal", amount: real, hp, id: -3, name: "Healing"});
      nextHeal = t + HEAL_TICK;
      continue;
    }
    if (kind === "mend") {
      const raw = which.base * (1 + (M.snapshot ? which.amp : ampAt(t)));
      const amount = M.round ? Math.round(raw) : raw;
      const room = Math.max(0, M.health - hp);
      const real = Math.min(room, amount);
      healed += real; overheal += amount - real;
      hp += real;
      which.left -= 1;
      if (which.left <= 0) mends.delete(which.key);
      else which.nextTick = t + which.interval;
      if (keepLog) log.push({t, kind: "mend", amount: real, hp, id: which.id, name: which.name});
      continue;
    }

    if (kind === "tick") {
      const amp = M.snapshot ? which.amp : ampAt(t);
      credit(which.id, val(which.base, amp) * which.mul, t, "tick", which.name);
      which.left -= 1;
      if (which.left <= 0) live.delete(which.key);
      else which.nextTick = t + which.interval;
      continue;
    }
    if (kind === "auto") {
      credit(-1, val(M.autoDmg, ampAt(t)), t, "auto", "Auto Attack");
      const pa = per.get(-1); if (pa) pa.casts += 1;
      nextAuto = t + M.autoInterval;
      continue;
    }

    /* An action. Walk the list and take the first thing that is allowed. */
    let pick = null, onTarget = 0;
    for (const a of priority) {
      if ((cdReady.get(a.id) || 0) > t + EPS) continue;
      if (a.cost > resource + EPS) continue;
      if (a.isBuff && ampUntil > t + EPS) continue;               // never clip your own buff
      if (tank) {
        /* Never stack a reduction on itself, never stun what is already held,
           and never spend a heal over time on health you have not lost. */
        if (a.tracksMit) {
          const gd = guards.get(a.id);
          if (gd && gd.until - t > a.refresh + EPS) continue;
          if (guardAt(t) >= a.mit - EPS) continue;
        }
        /* A single-target stun is spent on the one you are facing, so what
           matters is whether THAT one is already held — not whether anything in
           the pack is. */
        if (a.stun && (a.hitsAll ? stunUntilOf() : (foes[0] || {held: 0}).held) > t + EPS)
          continue;
        if (a.tracksHeal) {
          const md = mends.get(a.id);
          if (md && md.until - t > EPS) continue;
          if (hp > M.health - a.healTick) continue;
        }
      } else if (a.tracksMit || a.stun || a.tracksHeal) {
        if (!a.direct && !a.tracksPeriodic && !a.isBuff) continue;
      }
      if (a.tracksPeriodic) {
        if (a.hitsAll) {
          const d = live.get(String(a.id));
          if (d && d.until - t > a.refresh + EPS) continue;       // still on the pack
        } else {
          /* Applied one enemy at a time, so the one it has the least time left
             on is the one it goes on next — which is what a player reading
             "keep it up on everything" actually does. */
          let worst = Infinity, which2 = 0;
          for (let k = 0; k < N; k++) {
            const d = live.get(a.id + ":" + k);
            const rem = d ? d.until - t : -1;
            if (rem < worst) { worst = rem; which2 = k; }
          }
          if (worst > a.refresh + EPS) continue;
          onTarget = which2;
        }
      }
      pick = a; break;
    }
    if (!pick && M.generator && !priority.includes(M.generator)) pick = M.generator;
    if (!pick) {                       // cannot happen with a generator on the bar
      idle += 0.1; nextAction = t + 0.1; continue;
    }

    const cast = castTimeOf(pick, t);
    const castEnd = t + cast;
    const amp = ampAt(castEnd);
    const landAt = castEnd + pick.land;

    const energyBefore = resource;
    resource -= pick.cost;
    const before = resource;
    resource = Math.min(maxR, resource + pick.gen);
    wasted += before + pick.gen - resource;

    if (pick.cd) cdReady.set(pick.id, castEnd + pick.cd);
    if (pick.isBuff) { ampAmt = pick.buffAmt; ampUntil = castEnd + pick.buffDur; }
    if (tank) {
      if (pick.tracksMit)
        guards.set(pick.id, {amt: pick.mit, until: castEnd + pick.mitDur});
      if (pick.stun) {
        const until = landAt + pick.stun;
        const held = pick.hitsAll ? foes : foes.slice(0, 1);
        for (const fo of held)
          if (fo.f.stunnable) fo.held = Math.max(fo.held, until);
      }
      if (pick.tracksHeal)
        mends.set(pick.id, {key: pick.id, id: pick.id, name: pick.name,
                            base: pick.healTick, amp,
                            interval: pick.healInterval, left: pick.healTicks,
                            nextTick: castEnd + pick.healInterval,
                            until: castEnd + pick.healDur});
    }
    if (pick.direct) {
      /* Each landing rounds on its own, the way the game reports them, so a
         chain's 65% ricochets are not a rounded total split four ways. */
      let dealt = val(pick.direct, amp);
      if (pick.hitsAll) dealt *= N;
      else if (pick.chains)
        dealt += val(pick.direct * CHAIN_FRACTION, amp) * Math.min(CHAIN_EXTRA, N - 1);
      credit(pick.id, dealt, landAt, "hit", pick.name);
    }
    if (pick.tracksPeriodic) {
      const key = pick.hitsAll ? String(pick.id) : pick.id + ":" + onTarget;
      live.set(key, {
        key, id: pick.id, name: pick.name, base: pick.tick, amp,
        mul: pick.hitsAll ? N : 1,
        interval: pick.tickInterval, left: pick.ticks,
        nextTick: landAt + pick.tickInterval, until: landAt + pick.tickDur,
      });
    }
    const p = per.get(pick.id); if (p) p.casts += 1;
    actions += 1;
    const occupies = Math.max(cast, M.gcd);
    if (keepLog) log.push({
      t, id: pick.id, name: pick.name, kind: "cast",
      cast, occupies, end: t + occupies, landAt,
      energyBefore, resource, amp,
      cost: pick.cost, gen: pick.gen,
      buffUntil: pick.isBuff ? ampUntil : 0,
      buffAmt: pick.isBuff ? pick.buffAmt : 0,
      periodicUntil: pick.tracksPeriodic ? landAt + pick.tickDur : 0,
    });

    nextAction = t + occupies;
  }

  const breakdown = [...per.entries()]
    .map(([id, p]) => ({id, ...p, share: total ? p.amount / total : 0,
                        perSecond: p.amount / dur}))
    .filter(p => p.casts || p.amount)
    .sort((x, y) => y.amount - x.amount);

  /* What it would have put on you if you had stood there and done nothing:
     every swing it could have taken, unmitigated. Everything the rotation does
     — Fortitude aside, which is the gear's doing — is measured against this. */
  /* Counted off each attacker's own clock rather than assumed from the total,
     because they do not all start swinging at the same moment. */
  const swingsOf = fo => fo.f.first < dur
    ? Math.floor((dur - fo.f.first - EPS) / fo.f.interval) + 1 : 0;
  const potential = foes.reduce((sum, fo) => sum + fo.f.raw * swingsOf(fo), 0);
  const swingsPossible = foes.reduce((sum, fo) => sum + swingsOf(fo), 0);
  /* What YOU stopped is mitigation plus your own healing; a healer standing
     behind you is not your rotation and is counted apart, or a big enough one
     would report the tank as stopping more than the enemy ever threw. */
  const held = taken - healed;
  const net = held - healerHealed;
  /* How long the health bar lasts at this rate. When the fight ends with you
     still standing it is a projection past the end, which is the honest way to
     compare two builds that both survive. */
  const perSecond = net / dur;
  const survivalSeconds = perSecond > 0 ? M.health / perSecond : Infinity;

  return {
    total, dps: total / dur, duration: dur, actions, wasted, idle,
    breakdown, log, endResource: resource,
    apm: actions / (dur / 60),
    // the incoming half
    taken, healed, overheal, net, held, swings, stunned, potential,
    healerHealed, healerWasted, healerHps: M.healer,
    /* Who landed what, so a pack can be read creature by creature. */
    attackers: [...perFoe.values()].sort((x, y) => y.amount - x.amount),
    foeCount: foes.length, swingsPossible,
    stopped: potential > 0 ? (potential - held) / potential : 0,
    /* The healing per second it takes to hold you level: everything that landed
       less what you healed yourself, spread over the fight. Independent of the
       healer you set, which is the point — it is the bill, not the payment. */
    needed: dur > 0 ? Math.max(0, held / dur) : 0,
    dtps: perSecond, survivalSeconds,
    health: M.health, endHp: hp, minHp, deathAt,
    survived: deathAt == null,
  };
}

/* ---- what "better" means -------------------------------------------------
   For damage and for healing it is one number. For a tank it is two, in order:
   take less, and then — among the orders that take exactly as little — deal
   more. A weighted sum would have to price a point of damage against a point of
   damage taken, which is not a rate anyone can defend, so the comparison is
   lexicographic and the tie is a real tie: values are whole numbers, so a gap
   under half a point is the same answer twice.                                */
/* For a tank the figure is what the healer has to cover: everything that landed,
   less what you put back yourself. NOT what is left after the healer — a healer
   who can keep up drives that to exactly zero for every ordering, and then the
   rotation is being chosen at random among a hundred ties. With no healer the
   two are the same number, so this only changes the case it needs to. */
function objective(M, r) {
  return M.survival ? {key: -r.held, tie: r.total} : {key: r.total, tie: 0};
}
const betterThan = (a, b) =>
  a.key > b.key + 0.5 || (Math.abs(a.key - b.key) <= 0.5 && a.tie > b.tie + EPS);

/* ---- finding the order ---------------------------------------------------
   The answer has to be a priority list, so the search is over orderings of the
   available actions plus a bucket for the ones better left off the bar. Ten
   actions is 3.6 million orderings, which is not a search you run in a page,
   so it is a steepest-ascent hill climb over single moves, restarted from
   several starting points because one climb finds a local best, not the best.

   The seed is not random: ordering by what each action is worth per global
   cooldown, charged for the resource it eats, lands close enough that most
   restarts converge to the same answer, which is the signal that it is right. */
function seedOrder(M) {
  const g = M.gcd;
  const worth = a => {
    const time = Math.max(a.castBase / (1 + M.alacrityBonus), g);
    const reach = M.targets > 1 ? a.reach : 1;
    const overTime = a.ticks * a.tick * (a.hitsAll ? M.targets : 1);
    const raw = a.direct * reach + overTime;
    /* A buff has no damage of its own; value it by what it multiplies. */
    const buffed = a.isBuff ? a.buffAmt * a.buffDur * 40 : 0;
    /* Resource is the second currency: charge it at the filler's exchange rate. */
    const genRate = M.generator ? (M.generator.direct / Math.max(1, M.generator.gen)) : 0;
    const spent = a.cost * genRate;
    const cdSpread = a.cd ? Math.max(time, Math.min(a.cd, 8)) : time;
    return (raw + buffed - spent) / cdSpread;
  };
  return M.actions.slice().sort((x, y) => worth(y) - worth(x));
}

function climb(M, start, score) {
  let best = start.filter(a => !a.off), bestScore = score(best);
  const wins = sc => betterThan(sc, bestScore);
  let moved = true, guard = 0;
  while (moved && guard++ < 40) {
    moved = false;
    /* Move an action already on the bar to every other position, and try
       taking it off entirely. */
    for (let i = 0; i < best.length; i++) {
      const a = best[i];
      for (let j = 0; j <= best.length; j++) {
        if (j === i || j === i + 1) continue;
        const next = best.slice();
        next.splice(i, 1);
        next.splice(j > i ? j - 1 : j, 0, a);
        const sc = score(next);
        if (wins(sc)) { best = next; bestScore = sc; moved = true; break; }
      }
      if (moved) break;
      if (!a.locked) {
        const next = best.slice(); next.splice(i, 1);
        const sc = score(next);
        if (wins(sc)) { best = next; bestScore = sc; moved = true; break; }
      }
    }
    if (moved) continue;
    /* And bring back anything currently off the bar, at its best position. */
    for (const a of M.actions) {
      if (best.includes(a)) continue;
      for (let j = 0; j <= best.length; j++) {
        const next = best.slice(); next.splice(j, 0, a);
        const sc = score(next);
        if (wins(sc)) { best = next; bestScore = sc; moved = true; break; }
      }
      if (moved) break;
    }
  }
  return {order: best, score: bestScore};
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* A deterministic generator, so the same build always produces the same
   answer and two runs can be compared without the noise of a seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const REFRESH_STEPS = [0, 0.5, 1, 1.5, 2, 3];

function solve(M, opts) {
  opts = opts || {};
  const restarts = opts.restarts == null ? 10 : opts.restarts;
  if (M.generator) M.generator.locked = true;
  const score = order => objective(M, simulate(M, order));

  /* A warm start, when the caller has one. Sweeping a curve solves the same
     build a dozen times with one setting nudged, and neighbouring points want
     nearly the same list — starting from the last answer both converges faster
     and stops the curve reporting a change every time two equally good orders
     swap places under a random restart. */
  let best = null;
  if (opts.seed && opts.seed.length) {
    const byId = new Map(M.actions.map(a => [a.id, a]));
    const warm = [];
    for (const w of opts.seed) {
      const a = byId.get(w.id);
      if (!a) continue;
      a.refresh = w.refresh || 0;
      warm.push(a);
    }
    if (warm.length) best = climb(M, warm, score);
  }
  const heuristic = climb(M, seedOrder(M), score);
  if (!best || betterThan(heuristic.score, best.score)) best = heuristic;

  const rnd = rng(0x5eed);
  for (let k = 0; k < restarts; k++) {
    const r = climb(M, shuffle(M.actions, rnd), score);
    if (betterThan(r.score, best.score)) best = r;
  }

  /* When to re-apply a periodic. Letting it fall off wastes uptime; re-applying
     early throws away ticks already paid for. One pass per periodic, greedy,
     because the choices barely interact. */
  let order = best.order;
  for (const a of order) {
    if (a.off || !(a.tracksPeriodic || a.tracksMit)) continue;
    let bestR = a.refresh, bestS = score(order);
    for (const r of REFRESH_STEPS) {
      if (r === bestR) continue;
      const prev = a.refresh; a.refresh = r;
      const sc = score(order);
      if (betterThan(sc, bestS)) { bestS = sc; bestR = r; } else a.refresh = prev;
    }
    a.refresh = bestR;
  }
  /* One more climb now that the refresh windows have moved. */
  order = climb(M, order, score).order;

  /* An entry that never fires is noise on a priority list, and worse than
     noise: it reads as advice. Anything the fight never reached is taken off
     and reported separately with the reason it could not be afforded, which is
     the more useful fact — Hallowed Ground below a 2-second Absolution is not
     mis-ranked, it is unreachable without pooling a priority list cannot do. */
  /* A tank's list is full of long cooldowns that never contend for the same
     global cooldown, so a great many orderings play out to exactly the same two
     numbers and the search returns whichever it reached first. That is fine as
     arithmetic and poor as instructions: a reader who sees Guard ranked below
     three things that are on a minute's cooldown will conclude it is the last
     thing to press, which is not what the sim did.

     So, once the answer is settled, what keeps you alive is floated above what
     does not — accepting a swap only when BOTH objective values come back
     identical. The advice changes; the fight does not. */
  if (M.survival) {
    const keepsYouAlive = a => a.tracksMit || a.stun > 0 || a.tracksHeal;
    const settled = score(order);
    const same = sc => sc.key === settled.key && sc.tie === settled.tie;
    let shuffled = true, rounds = 0;
    while (shuffled && rounds++ < 20) {
      shuffled = false;
      for (let i = 1; i < order.length; i++) {
        if (!keepsYouAlive(order[i]) || keepsYouAlive(order[i - 1])) continue;
        const next = order.slice();
        [next[i - 1], next[i]] = [next[i], next[i - 1]];
        if (same(score(next))) { order = next; shuffled = true; }
      }
    }
  }

  const trial = simulate(M, order, {log: true});
  const cast = new Set(trial.log.filter(e => e.kind === "cast").map(e => e.id));
  const never = order.filter(a => !cast.has(a.id) && !a.locked);
  if (never.length) {
    const pruned = order.filter(a => cast.has(a.id) || a.locked);
    if (!betterThan(objective(M, trial), objective(M, simulate(M, pruned)))) order = pruned;
  }

  const result = simulate(M, order, {log: true});

  /* What a buff is worth is what the fight loses without it — it has no damage
     of its own, so a breakdown row would otherwise read zero next to the spell
     that carries a quarter of the rotation. Re-solved without it, because
     dropping a buff frees a global cooldown the rest of the list will reuse. */
  const buffGain = {};
  for (const a of order) {
    if (!a.isBuff) continue;
    /* The climb is free to put anything back that is not in its model's action
       list, so the buff has to be taken out of the MODEL and not merely out of
       the order — otherwise it re-adds itself and every buff appears to be
       worth exactly nothing. */
    const M2 = Object.assign({}, M, {actions: M.actions.filter(x => x !== a)});
    const without = climb(M2, order.filter(x => x !== a),
                          o => objective(M2, simulate(M2, o)));
    buffGain[a.id] = M.survival
      ? (without.score.key === undefined ? 0 : -without.score.key - result.held)
      : result.total - without.score.key;
  }

  /* What each entry is worth, in the currency the page is measuring. A tank's
     list is mostly things that deal nothing, so ranking them by damage prints a
     column of zeroes next to the spells doing the actual work.

     The measure is what dropping that one entry from the bar would cost you,
     played out with the rest of the order untouched — one run each rather than
     a fresh solve, because the question is "what is this line worth on my bar",
     not "what would I do instead". */
  const prevented = {};
  if (M.survival) {
    for (const a of order) {
      if (a.locked) continue;
      const without = simulate(M, order.filter(x => x !== a));
      prevented[a.id] = without.held - result.held;
    }
    if (M.generator)
      prevented[M.generator.id] = simulate(M, order.filter(x => x !== M.generator)).held
                                  - result.held;
  }

  /* Anything the search left off the bar, and anything that never fired. */
  const benched = M.actions.filter(a => !order.includes(a)).map(a => ({
    action: a,
    why: never.includes(a)
      ? (a.cost ? `never affordable — the bar never reached ${a.cost}` : "never reached")
      : "costs more in global cooldowns than it returns",
  }));

  return {order, result, model: M, buffGain, benched, prevented,
          converged: best.score.key,
          refresh: order.filter(a => a.tracksPeriodic || a.tracksMit)
            .map(a => ({name: a.name, refresh: a.refresh}))};
}

/* ---- replaying one rotation against a different build --------------------
   The gear search asks the same question a few hundred times: what would this
   rotation do if the character were slightly different? Re-solving each time
   would be honest but far too slow to hold a page open, so the order is held
   and only the build moves. The caller re-solves the winner afterwards, which
   is where the difference would show if there were one.                      */
function replay(D, cfg, order) {
  const M = model(D, cfg);
  const byId = new Map(M.actions.map(a => [a.id, a]));
  const same = [];
  for (const a of order) {
    const b = byId.get(a.id);
    if (!b) continue;
    b.refresh = a.refresh;
    same.push(b);
  }
  if (!same.length) return {model: M, result: simulate(M, M.actions.slice(0, 1))};
  return {model: M, result: simulate(M, same)};
}

/* ---- what a point of a stat is worth -------------------------------------
   Re-solved rather than re-simulated: Alacrity and Tempo change how many
   actions fit in the fight, which can change which order is best, and a weight
   measured against a rotation that is no longer the right one is worse than no
   weight at all.                                                             */
function statWeights(D, cfg, step) {
  step = step || 50;
  /* A tank is not judged on output, so the figure a weight moves is how long
     the health bar lasts — which is the only reading that lets Vitality and
     Fortitude be compared against each other at all. */
  const measure = r => cfg.survival
    ? (isFinite(r.survivalSeconds) ? r.survivalSeconds : r.duration * 1000)
    : r.total;
  const base = measure(solve(model(D, cfg), {restarts: 4}).result);
  const stats = cfg.survival
    ? ["vitality", "fortitude", "strength", "alacrity", "tempo"]
    : ["strength", "grace", "alacrity", "tempo"];
  const out = {};
  for (const k of stats) {
    if (cfg.healing && k === "strength") continue;
    if (!cfg.healing && !cfg.survival && k === "grace") continue;
    const bumped = Object.assign({}, cfg, {[k]: (cfg[k] || 0) + step});
    const got = measure(solve(model(D, bumped), {restarts: 4}).result);
    out[k] = {delta: got - base, perPoint: (got - base) / step,
              percent: base ? (got - base) / base * 100 : 0};
  }
  return {base, step, weights: out, unit: cfg.survival ? "seconds" : "damage"};
}

/* ---- how a priority entry reads -----------------------------------------
   The list is instructions, so each line is written as one: a verb, then the
   moment to do it in. The numbers behind it — cast time, cooldown, what it
   costs — are facts about the spell rather than about when to press it, and go
   on their own row where they can be scanned down the column instead of being
   re-read inside a sentence every time.                                      */
function conditionText(a, M) {
  const secs = n => (n % 1 ? n.toFixed(1) : String(n)) + "s";

  if (a === M.generator && !a.cd && !a.cost)
    return "Filler — cast this whenever nothing above is ready";

  const costs = a.cost ? ` — needs ${a.cost} energy` : "";
  if (a.tracksMit)
    return (a.refresh > 0
      ? `Recast when ${secs(a.refresh)} or less is left of it`
      : "Recast as it falls off")
      + ", and never under a stronger one" + costs;
  if (a.stun)
    return "Cast on cooldown, but never on an enemy already stunned" + costs;
  if (a.tracksHeal)
    /* Its cooldown outlasts its own duration, so there is no clipping to warn
       about — the same reason the buffs above say only when. */
    return (a.cd > a.healDur
      ? "Cast once you have lost health"
      : "Cast once you have lost health, and not while it is still ticking") + costs;

  /* Its cooldown outlasts its own duration, so it can never be clipped and
     there is nothing to warn about — which is why this says only when. */
  if (a.isBuff)
    return a.cd > a.buffDur
      ? "Cast the moment it is off cooldown"
      : "Cast on cooldown, but never while it is still running";

  const needs = a.cost ? ` if you have ${a.cost} energy` : "";
  const many = (M.targets || 1) > 1;
  if (a.tracksPeriodic) {
    const where = a.hitsAll ? "the pack" : many ? "an enemy" : "the target";
    return (a.refresh > 0
      ? `Recast when ${secs(a.refresh)} or less is left on ${where}`
      : `Recast the moment it drops off ${where}`)
      + (many && !a.hitsAll ? " — keep it running on all of them" : "")
      + (a.cost ? ` — needs ${a.cost} energy` : "");
  }
  if (a.cd) return `Cast every time it comes off cooldown${needs}`;
  if (a.cost) return `Cast whenever you have ${a.cost} energy`;
  return "Cast it whenever nothing above is ready";
}

/** The facts about the spell itself, as short chips under the instruction. */
function actionFacts(a, M) {
  const out = [];
  const cast = a.castBase ? a.castBase / (1 + M.alacrityBonus) : 0;
  out.push({k: "time", v: cast ? cast.toFixed(2) + "s cast" : "instant",
            dim: !cast});
  if (a.cd) out.push({k: "cd", v: a.cd >= 120 ? Math.round(a.cd / 60) + "m cooldown"
                                              : a.cd + "s cooldown"});
  if (a.cost) out.push({k: "cost", v: "-" + a.cost + " energy"});
  if (a.gen) out.push({k: "gen", v: "+" + a.gen + " energy"});
  if (a.tracksPeriodic)
    out.push({k: "over", v: `${a.ticks} ticks over ${a.tickDur}s`});
  if ((M.targets || 1) > 1 && (a.hitsAll || a.chains))
    out.push({k: "reach", v: a.hitsAll ? "hits all " + M.targets
                                       : `chains to ${Math.min(CHAIN_EXTRA, M.targets - 1)} more`});
  if (a.isBuff)
    out.push({k: "over", v: `+${Math.round(a.buffAmt * 100)}% for ${a.buffDur}s`});
  if (a.tracksMit)
    out.push({k: "mit", v: `-${Math.round(a.mit * 100)}% taken for ${a.mitDur}s`});
  if (a.stun)
    out.push({k: "mit", v: `stops it attacking for ${a.stun}s`});
  if (a.tracksHeal)
    out.push({k: "gen", v: `${Math.round(a.healTick)} healing x ${a.healTicks}`});
  return out;
}

return {
  FX_STUN, FX_DOT, FX_HOT, FX_REDUCE, FX_POWER, GCD_BASE, OMIT,
  ratingBonus, levelMul, effectLevelMul, talentMul, gcdFor,
  isPeriodic, healsOverTime, landDelay,
  candidates, exclusiveChoices, makeAction, model, simulate, replay,
  mitigation, maxHealth, takenFraction, enemyDamageMult, objective, betterThan,
  DEFENSE_PER_POINT,
  seedOrder, solve, statWeights, conditionText, actionFacts,
  directReach, REACHES_ALL, DLV_CHAIN, CHAIN_EXTRA, CHAIN_FRACTION,
};
}));
