/* Shared helpers for the Elegon database pages. */

const D = window.ELEGON || {items: [], monsters: [], stats: [], slots: [], subs: [], cats: []};

/* ---- scaling -------------------------------------------------------------
   Mirrors the client exactly (ItemTooltipFormatter.ApplyItemPower):
   quality is applied and ROUNDED first, then instability is applied to that
   rounded result. A single combined multiply disagrees about a quarter of the
   time, so the two steps must stay separate.                                */

/* ItemQuality.StatMultiplier. Cut hard in v3492098 - Fine 1.6 -> 1.15, Superior 2.6 -> 1.3,
   Flawless 4.0 -> 1.5 - so a Flawless item is now half again its base rather than four times
   it. The shape of the calculation did not move, only these three numbers, and they are the
   same three the item level uses. */
const QUALITY = {1: {n: "Normal", m: 1.0}, 3: {n: "Fine", m: 1.15},
                 2: {n: "Superior", m: 1.3}, 4: {n: "Flawless", m: 1.5}};
const RARITY_ORDER = [1, 3, 2, 4];

/* ItemQuality.GetColor, converted from the game's float colours. */
const QUALITY_HEX = {1: "#dbdbdb", 3: "#54a6e8", 2: "#b56bff", 4: "#f0b529"};

/* The game does this arithmetic in 32-bit float; JavaScript numbers are 64-bit doubles.
   That only matters when a product lands exactly on .5, but then it decides the rounding -
   a product of 1066.5 in double is 1066.49988 in float, and the game shows 1066. Math.fround
   reproduces each intermediate step at the game's precision, so the two never disagree. */
const f32 = Math.fround;

function instabilityMult(t) {
  if (!t || t <= 0) return 1;
  const capped = Math.min(t, 10);              // soft cap at tier 10
  // BreachInstability.ItemPowerMultiplier: 1f + 0.08f*capped + 0.03f*beyond, left to right.
  return f32(f32(f32(1) + f32(f32(0.08) * capped)) + f32(f32(0.03) * (t - capped)));
}
const round = v => Math.sign(v) * Math.round(Math.abs(v));   // away from zero

/* Monster scaling, which is NOT the item curve and no longer a plain exponential.
   BreachInstability.GrowthMultiplier compounds at the full rate up to the soft cap at tier
   10, then at a much gentler rate for every tier past it:

       health  1.15^min(t,10) x 1.04^max(0,t-10)
       damage  1.10^min(t,10) x 1.03^max(0,t-10)

   The client used bare 1.15^t and 1.10^t until the soft cap arrived, and the two only agree
   through tier 10 - by tier 40 the old curve claims twenty times the health the game gives.
   MathF.Pow is float32 either side of the multiply, so the steps are rounded like the game's. */
const GROWTH_SOFT_CAP = 10;
function growthMult(tier, perTier, beyond) {
  if (!tier || tier <= 0) return 1;
  const capped = Math.min(tier, GROWTH_SOFT_CAP);
  return f32(f32(Math.pow(perTier, capped)) * f32(Math.pow(beyond, tier - capped)));
}
const enemyHealthMult = t => growthMult(t, 1.15, 1.04);
const enemyDamageMult = t => growthMult(t, 1.10, 1.03);

/* Quality pressure: instability also bends what drops. QualityPressure is t^2/(t^2 + m^2)
   for a midpoint m, and each quality threshold is lerped along it from a tier-0 value to a
   saturated one, so a tier-0 measurement of the drop table cannot be reused higher up.

   Every one of these numbers was retuned downward in v3492098, and hard: the midpoint moved
   from 10 to 20, so the curve now takes twice the tier to go half as far, and the thresholds
   themselves were cut to roughly a quarter. Flawless ran 1%-10% and now runs 0.5%-2%.
   Anything measured before that build describes a game that no longer exists. */
const QUALITY_MIDPOINT = 20;                                    // BreachInstability, v3492098
const QUALITY_THRESHOLDS = {flawless: [0.5, 2], superior: [4, 12], fine: [25, 55]};
const qualityPressure = t =>
  (!t || t <= 0) ? 0 : f32((t * t) / (t * t + QUALITY_MIDPOINT * QUALITY_MIDPOINT));

/* ---- the game's own formulas ---------------------------------------------
   None of these are computed by the client. The server sends max health and the calculated
   spell values and the UI only prints them, so each was measured by watching those values
   move against the inputs that produced them, then checked against every recorded sample.

   Pure functions of their inputs, and they live here rather than in a page because two
   pages now draw the same curves. The planner used to own them as closures over its own
   `level`, which meant the scaling page could only have had a second copy - and a second
   copy is the bug that hides for a month, because both look right in isolation. */
const GAME = {
  /* Fortitude: a saturating curve with a HARD cap, not a soft one. 500 is the half-point
     and 750 Fortitude is where the cap binds - past that the stat does nothing for
     mitigation at all, which is the single most useful thing this page can say. */
  MITIGATION_HALF: 500,
  MITIGATION_CAP: 0.60,
  mitigation: f => Math.min(0.60, Math.max(0, f) / (Math.max(0, f) + 500)),
  /** Where Fortitude stops paying: cap/(1-cap) x half. */
  mitigationCapAt: () => Math.round(0.60 / (1 - 0.60) * 500),   // 750, exactly

  /* Alacrity: the same shape, but the denominator carries the character's level, so the
     same stat is worth steadily less as you level. Capped at 40%. */
  ALACRITY_CAP: 0.4,
  castSpeed: (alacrity, level) =>
    0.4 * Math.max(0, alacrity) / (Math.max(0, alacrity) + 20 + level),

  levelMul: level => 1 + 0.04 * (level - 1),
  EFFECT_PER_LEVEL: 0.024,
  effectLevelMul: level => 1 + 0.024 * (level - 1),
  /** Rank 0 and rank 1 both multiply by 1 - the first rank is the spell, not a bonus. */
  talentMul: rank => 1 + 0.2 * Math.max(0, rank - 1),

  HEALTH_PER_LEVEL: 8,
  HEALTH_PER_VITALITY: 10,
  maxHealth: (base, level, vitality) => base + 8 * (level - 1) + 10 * vitality,

  /* One point every two levels since v3489988, which halved it. Fitted to what the game
     shows rather than read from a file - see the planner. */
  attributePoints: level => Math.max(0, Math.floor((level - 1) / 2)),
  STAT_PER_POINT: 2,
  MAX_PER_ATTR: 25,

  /* SkillCatalog.XpForNextLevel, the branch taken when a skill ships xp_per_level 0. */
  profXpForLevel: L => Math.ceil((D.skillXp || {base: 3}).base + Math.max(0, L)
                                 * (D.skillXp || {per: 0.12}).per),
};


const lerpThreshold = (atTier0, saturated, t) =>
  f32(atTier0 + (saturated - atTier0) * qualityPressure(t));
const thresholdPercent = (name, t) =>
  lerpThreshold(QUALITY_THRESHOLDS[name][0], QUALITY_THRESHOLDS[name][1], t);
const flawlessChancePercent = t => thresholdPercent("flawless", t);
const superiorThresholdPercent = t => thresholdPercent("superior", t);
const fineThresholdPercent = t => thresholdPercent("fine", t);

/* The roll, as bands rather than cumulative cuts. One roll on 0..100: under the Flawless
   threshold is Flawless, under Superior is Superior, and so on. A boss cannot roll Normal -
   0 of 415 recorded, and confirmed by the developer - so its Normal share folds into Fine.
   Keys are the game's quality ids: 1 Normal, 3 Fine, 2 Superior, 4 Flawless. */
function qualityBands(tier, boss) {
  const f = thresholdPercent("flawless", tier);
  const s = thresholdPercent("superior", tier);
  const n = thresholdPercent("fine", tier);
  const normal = boss ? 0 : 100 - n;
  return {4: f / 100, 2: (s - f) / 100, 3: ((boss ? 100 : n) - s) / 100, 1: normal / 100};
}

function scaleStat(base, quality, tier) {
  if (!base || base <= 0) return 0;
  // ItemTooltipFormatter.ApplyQuality, then BreachInstability.ApplyToStat - both float32.
  const q = Math.max(1, round(f32(f32(base) * f32((QUALITY[quality] || QUALITY[1]).m))));
  if (!tier || tier <= 0) return q;
  return Math.max(1, round(f32(f32(q) * instabilityMult(tier))));
}
/* EquippedItemLevelCalculator.CalculateItemLevel:
     round(levelRequirement x ITEM_LEVEL_PER_REQ x qualityMult x instabilityMult)

   Every term here has moved at least once, which is the point of writing them down:

     the multiplier  was 10 until build 3498872 and is now 4, so the whole scale shifted by
                     2.5x in a single patch
     quality         had a gentle curve of its own until v3489988 - 1.05 / 1.1 / 1.15 - and
                     is now whatever the stats use, ItemQuality.StatMultiplier, which
                     v3492098 then cut to 1.15 / 1.3 / 1.5

   Three patches between them, so an item level from before any of them is not comparable
   with one from now - and that applies to the item_level column in our own damage and
   progress logs as much as to anything on screen. The whole product is float32 in the
   client and rounds away from zero, and both are reproduced here. */
const ITEM_LEVEL_PER_REQ = 4;
function itemLevelOf(item, quality, tier) {
  const lvl = Math.max(0, (item && item.lvl) || 0);
  if (!lvl) return 0;
  const q = (QUALITY[quality] || QUALITY[1]).m;
  return Math.max(0, round(f32(f32(f32(lvl * ITEM_LEVEL_PER_REQ) * f32(q))
                               * instabilityMult(tier))));
}

const scaled = (item, stat, q, t) => scaleStat(item[stat] || 0, q, t);
const itemTotal = (item, q, t) => D.stats.reduce((s, k) => s + scaled(item, k, q, t), 0);

/* ---- small dom helpers --------------------------------------------------- */

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined) n.textContent = txt;
  return n;
};

function icon(kind, id, has, size) {
  const mon = kind === "monsters";
  if (has) {
    const i = el("img", "ico" + (mon ? " mon" : ""));
    i.src = `icons/${kind}/${id}.png`;
    i.loading = "lazy";
    i.decoding = "async";
    i.alt = "";
    if (size) { i.style.width = size + "px"; i.style.height = size + "px"; }
    return i;
  }
  const s = el("span", "ico ph", mon ? "○" : "▢");
  if (size) { s.style.width = size + "px"; s.style.height = size + "px"; s.style.lineHeight = (size - 2) + "px"; }
  return s;
}

/* The root carries a `zoom`, so getBoundingClientRect returns PAINTED pixels while any
   left/top written back is a CSS length that gets scaled again. Anything positioning a
   fixed element from a measured rect has to divide by this once, at the end. Shared, because
   the map page and the quest page both learned it the hard way. */
/**
 * The `zoom` the stylesheet applies to the root above 2200px, cached.
 *
 * getComputedStyle makes the browser settle every pending style change before it can
 * answer. That is nothing on a quiet page and very expensive on a busy one: the map carries
 * 1,555 markers, and a single one of these reads cost 87ms once their styles were dirty.
 * The pointer handlers called it on every wheel tick and every drag frame, which is what
 * made panning and zooming the overworld crawl.
 *
 * It only changes when the viewport crosses that width, so it is read once and thrown away
 * on resize.
 */
let zoomCache = null;
const pageZoom = () => {
  if (zoomCache === null)
    zoomCache = Number(getComputedStyle(document.documentElement).zoom) || 1;
  return zoomCache;
};
addEventListener("resize", () => { zoomCache = null; });

/** Name cell: icon and label kept on one baseline regardless of icon size. */
function nameCell(kind, id, hasIcon, label, labelCls, size, frameQuality) {
  const td = el("td", "l");
  const box = el("span", "nmcell");
  box.appendChild(frameQuality
    ? framedIcon(id, hasIcon, frameQuality, size)
    : icon(kind, id, hasIcon, size));
  box.appendChild(el("span", labelCls || null, label));
  td.appendChild(box);
  return td;
}

/* Bump when the slot capture's geometry changes (the exporter's padding, say). The suffix
   keeps a browser from pairing a freshly exported image with a cached stylesheet that
   expects the old proportions — which shows up as icons clipping through the frame. */
const ASSET_V = "16";
const slotFrameUrl = q => `icons/ui/slot_q${q || 1}.png?v=${ASSET_V}`;

/* Are the in-engine slot captures present? Probed once and shared by every page; until the
   UI export has been run they are absent and icons stay unframed rather than showing an
   empty box. Pages listen for "slotframes" to redraw. */
let SLOT_FRAMES = false;
(function probeSlotFrames() {
  const probe = new Image();
  probe.onload = () => {
    SLOT_FRAMES = true;
    document.dispatchEvent(new Event("slotframes"));
  };
  probe.src = slotFrameUrl(1);
})();

/**
 * An item icon inside the character panel's own slot frame, tinted for the rarity — the
 * same in-engine capture the planner's paperdoll uses, so lists match the panel.
 */
function framedIcon(id, hasIcon, quality, px) {
  if (!SLOT_FRAMES) return icon("items", id, hasIcon, px);
  const box = el("span", "framed");
  box.style.backgroundImage = `url("${slotFrameUrl(quality)}")`;
  if (px) { box.style.width = px + "px"; box.style.height = px + "px"; }
  const img = icon("items", id, hasIcon);
  img.classList.add("slotimg");
  box.appendChild(img);
  return box;
}

/* The game's own frame box, the one the character panel draws an empty slot with. Items have
   the slot capture; a creature or a person had a flat dark square with a CSS corner radius,
   which is the one place the site still looked like a web page rather than like the game. */
let FRAME_BOX = false;
const FRAME_BOX_BG = `icons/ui/spr_dark_fantasy_frame_box_medium_23_background_1_2.png?v=${ASSET_V}`;
(function probeFrameBox() {
  const probe = new Image();
  probe.onload = () => { FRAME_BOX = true; document.dispatchEvent(new Event("framebox")); };
  probe.src = FRAME_BOX_BG;
})();

/** A portrait inside that frame. Falls back to the plain icon until the capture is present. */
function portraitIcon(kind, id, has, px) {
  if (!FRAME_BOX) return icon(kind, id, has, px);
  const box = el("span", "portrait");
  if (px) { box.style.width = px + "px"; box.style.height = px + "px"; }
  // No size on the icon itself: the frame bounds it, the same way the slot frame does.
  const art = icon(kind, id, has);
  art.classList.add("portraitimg");
  box.appendChild(art);
  return box;
}

/** Single full-width row explaining why a table is empty. */
function emptyRow(body, colspan, msg) {
  const tr = el("tr");
  const td = el("td", "empty", msg);
  td.colSpan = colspan;
  tr.appendChild(td);
  body.appendChild(tr);
}

const fmtNum = n => (n >= 1000 ? n.toLocaleString() : String(n));

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/** A number cell that dims zeros, so real values stand out in a wide table. */
function statCell(v) {
  const td = el("td", v ? "" : "z", v ? String(v) : "·");
  return td;
}

/** Wires click-to-sort on a table head. cols: [{key,label,left,fmt}] */
function sortableTable(head, cols, state, redraw) {
  head.replaceChildren();
  for (const c of cols) {
    const th = el("th", c.left ? "l" : "", c.label);
    const on = state.key === c.key;
    if (on) th.classList.add("sorted");
    // The arrow is always present so the header text never shifts when sorting changes.
    th.appendChild(el("span", "arrow", on && !state.desc ? "▲" : "▼"));
    th.title = "Sort by " + c.label;
    th.onclick = () => {
      if (state.key === c.key) state.desc = !state.desc;
      else { state.key = c.key; state.desc = true; }
      redraw();
    };
    head.appendChild(th);
  }
}

function applySort(rows, state) {
  const k = state.key;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    const c = (typeof x === "string" || typeof y === "string")
      ? String(x).localeCompare(String(y))
      : (x || 0) - (y || 0);
    return state.desc ? -c : c;
  });
  return rows;
}

/**
 * Rarity as four buttons in the game's own quality colours, rather than a dropdown —
 * the choice is visual, so it should look like the thing it selects.
 * Returns the container; call `.setValue(q)` to sync it from outside.
 */
function rarityButtons(value, onChange) {
  const box = el("span", "rarityset");
  const btns = {};
  for (const q of RARITY_ORDER) {
    const b = el("button", "rbtn r" + q, QUALITY[q].n);
    b.type = "button";
    b.dataset.q = q;
    b.onclick = () => { box.setValue(q); onChange(q); };
    btns[q] = b;
    box.appendChild(b);
  }
  box.setValue = q => {
    for (const k of RARITY_ORDER) btns[k].classList.toggle("on", Number(k) === Number(q));
  };
  box.setValue(value);
  return box;
}

/** Rarity <select>, in ascending power order rather than raw id order. */
function raritySelect(value, onChange) {
  const s = el("select");
  for (const q of RARITY_ORDER) {
    const o = el("option", null, QUALITY[q].n);
    o.value = q;
    if (q === value) o.selected = true;
    s.appendChild(o);
  }
  s.onchange = () => onChange(Number(s.value));
  return s;
}

/* The game caps instability nowhere. What you can SELECT at a portal is your highest
   cleared tier on that map (+1 with an attuned Breach Catalyst), so the ceiling is your own
   progress rather than a number in a table — and the value goes to the server as a plain
   uint. The 2000 here is not a game rule: past roughly tier 2240 the client's own float32
   growth multiplier overflows to Infinity, so this keeps the arithmetic finite and says so.
   Recorded play has reached 50. */
const INSTABILITY_UI_LIMIT = 2000;

function instabilityInput(value, onChange) {
  const i = el("input");
  i.type = "number";
  i.min = 0; i.max = INSTABILITY_UI_LIMIT; i.step = 1; i.value = value;
  i.title = "No cap in the game — a portal offers your highest cleared tier, +1 with a "
          + "Breach Catalyst. This field stops at " + INSTABILITY_UI_LIMIT
          + ", where the client's own float maths overflows.";
  i.oninput = () =>
    onChange(Math.min(INSTABILITY_UI_LIMIT, Math.max(0, Number(i.value) || 0)));
  return i;
}

/**
 * Wraps every number input in a pair of stepper buttons.
 *
 * A number field's native spinners cannot be styled — they stay the browser's own tiny
 * light-on-light arrows on a dark page — so they are hidden in CSS and replaced here.
 * Idempotent, so pages can call it again after adding controls.
 */
function enhanceNumberInputs(root) {
  (root || document).querySelectorAll("input[type=number]:not([data-stepped])")
    .forEach(inp => {
      inp.dataset.stepped = "1";

      const wrap = el("span", "numfield");
      inp.parentNode.insertBefore(wrap, inp);

      const step = delta => {
        const min = inp.min !== "" ? Number(inp.min) : -Infinity;
        const max = inp.max !== "" ? Number(inp.max) : Infinity;
        const next = Math.min(max, Math.max(min, (Number(inp.value) || 0) + delta));
        if (String(next) === inp.value) return;
        inp.value = String(next);
        // Fire both, so listeners bound to either see the change.
        inp.dispatchEvent(new Event("input", {bubbles: true}));
        inp.dispatchEvent(new Event("change", {bubbles: true}));
      };

      const dec = el("button", null, "−");
      const inc = el("button", null, "+");
      for (const [b, d] of [[dec, -1], [inc, 1]]) {
        b.type = "button";
        b.tabIndex = -1;                 // the field itself is the tab stop
        b.setAttribute("aria-hidden", "true");
        // Shift jumps by ten, so a range like instability 0-100 is a few clicks
        // rather than a hundred.
        b.title = (d > 0 ? "Increase" : "Decrease") + " (hold Shift for ×10)";
        b.onclick = e => step(d * (e.shiftKey ? 10 : 1));
      }
      wrap.append(dec, inp, inc);
    });
}

/* Run once the page's own script has built its controls. */
document.addEventListener("DOMContentLoaded", () => enhanceNumberInputs());

/* ---- loot tables ---------------------------------------------------------
   D.drops holds the game's own loot_table_entries: a list of sources, a flat list of
   [sourceIndex, itemId, chance, minQty, maxQty, rolls] tuples, and metadata for the items
   that are not equipment. Both directions are wanted - "what does this drop" and "where
   does this come from" - so it is indexed once here and shared by every page.            */

const ITEM_BY_ID = new Map(D.items.map(i => [i.id, i]));

const DROP = {sources: [], bySource: new Map(), byItem: new Map(), ready: false};

(function indexDrops() {
  const d = D.drops;
  if (!d || !d.entries || !d.entries.length) return;

  DROP.sources = d.sources;
  d.sources.forEach((s, i) => { s.i = i; });

  const push = (map, key, v) => {
    const list = map.get(key);
    if (list) list.push(v); else map.set(key, [v]);
  };
  for (const [si, item, chance, minQ, maxQ, rolls] of d.entries) {
    const e = {src: d.sources[si], item, chance, minQ, maxQ, rolls};
    push(DROP.bySource, si, e);
    push(DROP.byItem, item, e);
  }
  DROP.ready = true;
})();

const dropsOf = src => DROP.bySource.get(src.i) || [];
const sourcesOf = itemId => DROP.byItem.get(itemId) || [];

/* Merchant stock, indexed the way it is asked about: "where do I buy this". Absent until
   the shop export has been run, in which case every lookup is simply empty. */
const SOLD_BY = new Map();
for (const shop of D.shops || [])
  for (const [itemId, price] of shop.items) {
    const list = SOLD_BY.get(itemId);
    if (list) list.push({shop, price}); else SOLD_BY.set(itemId, [{shop, price}]);
  }
const vendorsOf = itemId => SOLD_BY.get(itemId) || [];

/**
 * Anything a loot table can yield, resolved against the item list — which covers every
 * type, not only equipment. `equip` is the record when the item is equippable and null
 * otherwise, so callers can decide whether stats and a slot frame apply.
 */
function lootItem(id) {
  const it = ITEM_BY_ID.get(id);
  if (!it) return {id, name: "Item " + id, type: "", sub: "", kind: "", slot: "",
                   lvl: 0, icon: false, equip: null};
  return {...it, equip: it.type === "Equipment" ? it : null};
}

/**
 * The site shows the game's own listed drop chances.
 *
 * It did not always. Across 2,695 recorded kills in the level 80 rift, 3,197 items dropped
 * where the listed rates predicted 6,369 - a factor of 0.502, 95% interval 0.490 to 0.514,
 * and flat across the whole range rather than concentrated anywhere: entries listed at 100%
 * came out at 0.483, at 35-80% at 0.496, at 10-15% at 0.544, under 10% at 0.501. Even the
 * "guaranteed" boss materials dropped about half the time. Nor was it the log missing drops:
 * every kill row carries the server's own count of what that kill produced, and the recorded
 * rows matched it on 2,675 of 2,695. So the site halved what it displayed.
 *
 * That measurement is no longer about this game. Every one of those kills was recorded
 * between 9 and 15 August; v3492098 landed on the 22nd and replaced rift loot outright -
 * the gear moved to a per-map reward table and each rift enemy kept a single 2.5% row for a
 * caster weapon. The rates that were halved are among the 407 rows build_site now holds back
 * as retired. Applying a factor measured on a system the game has removed, in caves it has
 * since rebuilt, is the same mistake as quoting those retired rates.
 *
 * So dropFactor is 1 and the listed number is what you see. It can be settled again whenever
 * it matters: turn LogKills on, kill things on the current build, and compare. The factor
 * and the measurement that produced it are kept in build_site rather than deleted, so
 * re-applying is a one-line change and not a re-derivation.
 */
const DROP_RATE = {factor: D.dropFactor === undefined ? 1 : D.dropFactor};

const dropFactorFor = e => (e.src && e.src.node) ? 1 : DROP_RATE.factor;

/* Rolls are independent tests, not a shared pool: two rolls at 50% is 75% overall, not
   100%. Everything the site shows and sorts on is this combined figure, so a two-roll
   entry cannot look rarer than it is; the per-roll number stays visible in the tooltip. */
function effChance(e) {
  // A breach pool entry has no rate at all - see spreadBreachPools. Null rather than 0:
  // "we do not know" and "it never drops" are opposite claims and must not share a number.
  if (e.chance === null || e.chance === undefined) return null;
  const p = e.chance * dropFactorFor(e);
  return e.rolls > 1 ? (1 - Math.pow(1 - p / 100, e.rolls)) * 100 : p;
}

/** Compact, for axis ticks: 141 billion wants three characters, not twelve. */
function short(v) {
  if (!isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return +(v / 1e12).toFixed(a >= 1e13 ? 0 : 1) + "T";
  if (a >= 1e9) return +(v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return +(v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return +(v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(v * 100) / 100);
}
/* A multiplier can be 1.15 or 3×10³⁴ on the same axis once the range is opened up, so the
   formatter has to degrade rather than pick one shape: two decimals while that is a
   sensible thing to read, then k/M/B/T, then a proper power of ten. Without the last step
   a tier-2000 reading printed as ×3.1865710564281674e+34. */
const SUPER = {"-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
               "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹"};
function big(v) {
  if (!isFinite(v)) return "∞";
  const a = Math.abs(v);
  if (a < 1000) return (Math.round(v * 100) / 100).toFixed(2);
  if (a < 1e15) return short(v);
  const parts = v.toExponential(1).split("e");
  const exp = String(Number(parts[1])).split("").map(c => SUPER[c] || c).join("");
  // An exact power of ten is "10³⁴", not "1.0×10³⁴" - the mantissa is noise on a log axis.
  return (parts[0] === "1.0" ? "" : parts[0] + "×") + "10" + exp;
}

const fmtPct = p => (p === null || p === undefined) ? "?"
  : p >= 99.95 ? "100%"
  : p >= 10 ? Math.round(p) + "%"
  : (Math.round(p * 10) / 10).toString().replace(/\.0$/, "") + "%";

const qtyLabel = e => e.maxQ > 1 ? "×" + e.minQ + "–" + e.maxQ
  : e.minQ > 1 ? "×" + e.minQ : "";

/**
 * Drop chance as a number over a proportional bar.
 *
 * Banded by how notable the chance is rather than by item quality, and deliberately not in
 * the quality palette: a blue bar next to a Fine item would read as the item's rarity
 * rather than the drop's. Green is routine, plain is ordinary, gold is worth camping for.
 */
/**
 * A drop chance: the figure, and a rule under it for the shape of the column.
 *
 * The bar used to be a tinted block filling the cell behind the number, with the number
 * itself coloured by how likely it was — two loud signals for one small fact, in a table
 * whose other colours already mean item quality. Now the figure is plain and the bar is a
 * 3px rule beneath it, so a column of them reads as a profile you can scan down and nothing
 * competes with the names beside it.
 */
function chanceCell(e) {
  const p = effChance(e);
  if (p === null) {
    /* An empty track, not a missing one: the column still has to line up, and a bar of
       zero width would read as "never" - which is the one thing it does not mean. */
    const td = el("td", "chance c-unknown");
    const cell = el("span", "cwrap");
    cell.appendChild(el("b", "cval", "?"));
    cell.appendChild(el("span", "cmeter"));
    td.appendChild(cell);
    const where = (D.mapNames || {})[e.breach] || "The breach";
    td.title = `${where} names this in its reward table, which carries no rate and no `
             + `creature. Nothing in the client publishes one, so this is unmeasured `
             + `rather than rare.`;
    return td;
  }
  const td = el("td", "chance " + (p >= 50 ? "c-often" : p >= 15 ? "c-mid" : "c-rare"));

  const cell = el("span", "cwrap");
  cell.appendChild(el("b", "cval", fmtPct(p)));
  const meter = cell.appendChild(el("span", "cmeter"));
  const bar = meter.appendChild(el("span", "cbar"));
  // A floor, so a 1-in-500 entry still shows something rather than an empty track.
  bar.style.width = Math.max(2, Math.min(100, p)) + "%";
  td.appendChild(cell);

  // The game's own figure, kept within reach: what is shown is what it measures out at.
  const factor = dropFactorFor(e);
  const per = factor === 1 ? `${e.chance}% listed`
            : `${fmtPct(e.chance * factor)} measured, ${e.chance}% listed`;
  const each = e.src && e.src.node ? "per gather" : "per kill";
  td.title = e.rolls > 1
    ? `${per} per roll, ${e.rolls} rolls — ${fmtPct(p)} for at least one`
    : `${per}, ${each}`;
  return td;
}

const round1 = n => Math.round(n * 10) / 10;

/* ---- spawn maps ----------------------------------------------------------
   D.maps holds one exported area image per map, each with the affine transform the game's
   own map panel uses to place a marker, sampled from it rather than reconstructed:

       imagePixel = origin + worldX * perWorldX + worldZ * perWorldZ

   D.spawns holds the spawn points recorded while playing, per map. Both are absent until
   the exports have been run, and every map without a transform is dropped at build time,
   so there is no path here that guesses at a position.                                   */

/* spawns.csv entity_type, as build_site codes it. The index below is keyed on all three,
   so a gathering node and an NPC are located exactly the way a monster is. */
const SPAWN_ENEMY = 0, SPAWN_OBJECT = 1, SPAWN_NPC = 2;

/* Points standing on ground a player cannot reach.
 *
 * build_site marks them with a fifth element, from the terrain reachability model in
 * tools/pck/reachmap.py: a cliff face nobody can stand on, or standable ground with no
 * route in. 264 of the overworld's 1,714 recorded points are on ground like that - the
 * server places a spawner wherever a designer put it, without asking whether anyone can
 * follow - and a marker you can see and never walk to is worse than no marker.
 *
 * Hidden everywhere by default. The staging map has a switch to bring them back, because
 * "is that thing really unreachable" is a question worth being able to ask; a release has
 * no switch at all, and the flag simply stays off.
 */
let SHOW_UNREACHABLE = false;

const SPAWN_POINTS = new Map();
for (const [mapId, points] of Object.entries(D.spawns || {}))
  for (const [type, dataId, x, z, unreachable] of points) {
    const key = mapId + "|" + type + "|" + dataId;
    const list = SPAWN_POINTS.get(key);
    // The flag rides with the point rather than filtering here: the switch can flip after
    // load, and rebuilding this index on every flip would be silly.
    if (list) list.push([x, z, !!unreachable]); else SPAWN_POINTS.set(key, [[x, z, !!unreachable]]);
  }

/** Points worth drawing: everything, or only what a player can actually get to. */
const shown = pts => SHOW_UNREACHABLE ? pts : pts.filter(p => !p[2]);

/** The same, for the {map,x,z,out} shape the by-id indexes use. */
const here = pts => SHOW_UNREACHABLE ? pts : (pts || []).filter(p => !p.out);

/* ---- the breach pools, spread over the creatures that stand in them --------
 * D.riftDrops is the game's own per-map reward table, and it names what a breach can give
 * and nothing else: no rate, no creature. The server rolls it against the MAP rather than
 * off any loot table, which is why the whole equipment pool of five breaches - a hundred
 * and eighty-eight items that plainly drop somewhere - had no route back to a creature you
 * could go and kill.
 *
 * So the pool is hung on the creatures of the breach that names it. The equipment pool goes
 * on every creature in it; the three boss materials go on its bosses, which is as far as
 * the table's own two buckets let us say. It is deliberately no finer than that: two of
 * Ashenroot's three materials are named after the boss that presumably carries them
 * - Vulkara, Obsidian Broodqueen and "Broodqueen Obsidian" - but the third is not, and
 * assigning it by elimination would be a guess printed as a fact.
 *
 * The rate is left UNKNOWN rather than invented. It is in no table the client subscribes
 * to, measuring one is a few thousand kills per item, and a number we made up would sit in
 * the same column, in the same type, as the ones we measured. It reads as "?" everywhere a
 * rate would be.
 */
(function spreadBreachPools() {
  const pools = D.riftDrops || {};
  if (!Object.keys(pools).length) return;

  const monsters = new Map((D.monsters || []).map(m => [m.id, m]));
  const byId = new Map();
  for (const src of DROP.sources) if (!src.node) byId.set(src.id, src);

  const push = (map, key, v) => {
    const list = map.get(key);
    if (list) list.push(v); else map.set(key, [v]);
  };

  for (const [mapId, sets] of Object.entries(pools)) {
    const rows = (D.spawns || {})[mapId] || [];
    const here = [...new Set(rows.filter(r => r[0] === SPAWN_ENEMY).map(r => r[1]))]
      .map(id => monsters.get(id)).filter(Boolean);
    if (!here.length) continue;                 // a breach nobody has walked yet
    const bosses = here.filter(m => m.boss);

    for (const [bucket, ids] of Object.entries(sets)) {
      // If a breach has no boss recorded, the materials go on the whole roster rather
      // than nowhere - the item still has to be reachable from something.
      const targets = bucket === "boss" && bosses.length ? bosses : here;
      for (const m of targets) {
        let src = byId.get(m.id);
        if (!src) {
          /* A creature with no measured loot of its own still needs a row to hang on - and
             the row has to look like the ones the builder makes, not just carry an id and a
             name. Leaving off icon, lvl and boss cost every such creature its portrait, its
             level and its boss styling in the item sheet, and it showed up worst exactly
             where the synthesis does the most work: Ashenroot's seven creatures share three
             loot_table_entries between them, so almost every source in the newest rift was
             one of these, and almost every one of them drew the empty circle. */
          src = {i: DROP.sources.length, id: m.id, name: m.name, node: false,
                 lvl: m.lvl, boss: !!m.boss, icon: !!m.icon};
          DROP.sources.push(src);
          byId.set(m.id, src);
        }
        for (const item of ids) {
          const e = {src, item, chance: null, minQ: 1, maxQ: 1, rolls: 1, breach: mapId};
          push(DROP.bySource, src.i, e);
          push(DROP.byItem, item, e);
        }
      }
    }
  }
})();

/** Every exported map that has recorded spawns for this thing, with the points. */
function spawnsFor(type, dataId) {
  const out = [];
  for (const map of D.maps || []) {
    const points = shown(SPAWN_POINTS.get(map.id + "|" + type + "|" + dataId) || []);
    if (points.length) out.push({map, points});
  }
  return out;
}

/** Every point, reachable or not - for the few places that need the honest total. */
function allSpawnsFor(type, dataId) {
  const out = [];
  for (const map of D.maps || []) {
    const points = SPAWN_POINTS.get(map.id + "|" + type + "|" + dataId);
    if (points && points.length) out.push({map, points});
  }
  return out;
}

const worldToPixel = (m, x, z) =>
  [m.o[0] + x * m.px[0] + z * m.pz[0], m.o[1] + x * m.px[1] + z * m.pz[1]];

/* The captures are whole areas and the spawns of one creature occupy a corner of that, so
   the panel shows a window onto the image rather than the whole thing. Kept to one shape so
   every monster's map reads the same, and never smaller than this, so a lone spawn point
   does not zoom to a patch of dirt.

   Both sizes are in WORLD units, not pixels, because the two are not proportional across
   maps: the overworld renders at 1.31 px per world unit and a breach at 7.09, so a window
   fixed in pixels would show 400 units of countryside and 70 units of cave floor. Fixing it
   in world units means the same amount of ground on every map. */
const MAP_ASPECT = 1.6;
const MAP_MIN_WORLD = 260;
const MAP_MARGIN_WORLD = 55;

/* A second floor, as a share of the picture rather than of the world, because the first one
   alone is not a limit on how far in the view can go. 260 world units is 45% of a breach and
   only 12.7% of the overworld, so a creature that keeps to one clearing filled the panel
   with an unrecognisable patch of ground: correct, and useless for telling where it is.
   Whichever floor is larger wins, which leaves the breaches exactly as they were. */
const MAP_MIN_FRACTION = 0.28;

/* Below this, the window is small enough against the whole area that it needs saying where
   it sits; at or above it, the surroundings are their own answer and an inset is clutter. */
const MAP_LOCATOR_BELOW = 0.7;

/** A round grid interval giving roughly six squares across the window. */
function gridSpacing(worldWide) {
  const target = worldWide / 6;
  const steps = [5, 10, 25, 50, 100, 250, 500, 1000];
  return steps.find(s => s >= target) || steps[steps.length - 1];
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/* A background-position percentage is a share of the LEEWAY, not of the image: 100% means
   the far edge flush with the far edge. With no leeway the ratio is 0/0, hence the guard. */
const pct = (offset, leeway) => (leeway > 0.0001 ? (offset / leeway) * 100 : 0) + "%";

/** A cropped view of one map with a dot on every recorded spawn. */
/* How far in the sheet map will go: the window never shows less ground than this. Small
   enough that a 10-unit aggro circle is most of the frame, which is the point of zooming. */
const MAP_ZOOM_MIN_WORLD = 26;

/* ---- the hillshade, on every map the site draws ---------------------------
 * The Maps page has shown the terrain relief over the overworld for a while; the sheets did
 * not, so the same ground looked flat in a monster's spawn map and modelled on the page next
 * to it.
 *
 * Layered as a second BACKGROUND rather than an overlay element, because these renders are
 * crops: one background-size and one background-position then crop both images identically.
 * A separate <img> would have to reproduce the crop arithmetic, and would drift apart from
 * it the first time either was touched.
 *
 * Only the overworld has one. depthmap.py derives the relief from that zone's Terrain3D
 * heights, and a breach is a repeating texture with no terrain under it to read - which is
 * also why those maps are drawn as plans rather than photographs.
 */
const MAP_RELIEF = "terrain-relief.png";
const hasRelief = map => !!map && !map.plan && map.img === "overworld.jpg";

/** Paint a map into `box`, hillshade included where there is one. */
function paintMapBg(box, map, size, pos) {
  const base = `url("maps/${map.img}")`;
  const lit = hasRelief(map);
  box.style.backgroundImage = lit ? `url("maps/${MAP_RELIEF}"), ${base}` : base;
  /* One value per LAYER, and the second one matters: a bare "soft-light" applies to every
     layer including the bottom one, which then blends with the element's own
     background-color - and both of these boxes set that to var(--bg), the page ground.
     Soft-light against a near-black ground is what turned every map on the site to mud.
     The relief blends onto the photograph; the photograph sits on the ground normally. */
  box.style.backgroundBlendMode = lit ? "soft-light, normal" : "";
  if (size) box.style.backgroundSize = size;
  if (pos) box.style.backgroundPosition = pos;
}

function spawnMap(entry, radiusWorld) {
  const {map, points} = entry;
  const pixels = points.map(([x, z]) => worldToPixel(map, x, z));

  // Pixels per world unit, taken from the transform itself so each map zooms the same.
  const perUnit = Math.hypot(map.pz[0], map.pz[1]) || 1;
  const margin = MAP_MARGIN_WORLD * perUnit;
  const minWide = MAP_MIN_WORLD * perUnit;

  let lox = Math.min(...pixels.map(p => p[0])) - margin;
  let hix = Math.max(...pixels.map(p => p[0])) + margin;
  let loy = Math.min(...pixels.map(p => p[1])) - margin;
  let hiy = Math.max(...pixels.map(p => p[1])) + margin;

  const floor = Math.max(minWide, map.w * MAP_MIN_FRACTION);
  let fitW = Math.max(hix - lox, floor);
  let fitH = Math.max(hiy - loy, floor / MAP_ASPECT);
  // Grow whichever axis is short until the window has the panel's shape, so the art is
  // never stretched.
  if (fitW / fitH < MAP_ASPECT) fitW = fitH * MAP_ASPECT; else fitH = fitW / MAP_ASPECT;
  fitW = Math.min(fitW, map.w);
  fitH = Math.min(fitH, map.h);

  const ratio = fitW / fitH;
  const minW = Math.min(fitW, MAP_ZOOM_MIN_WORLD * perUnit);

  /* Everything below is drawn from one rectangle - which part of the image is on screen.
     Zoom shrinks it, panning slides it, and both just re-run the same render, so the dots,
     the aggro rings, the grid and the locator frame cannot drift out of agreement. */
  const V = {w: fitW, h: fitH, x: 0, y: 0};
  V.x = clamp((lox + hix) / 2 - V.w / 2, 0, map.w - V.w);
  V.y = clamp((loy + hiy) / 2 - V.h / 2, 0, map.h - V.h);

  const box = el("div", "spawnmap");
  // Take the shape from the window actually used, not from the target: a window clamped to
  // the edges of the image cannot keep the target ratio, and a fixed box would stretch it.
  box.style.aspectRatio = ratio.toFixed(4);
  if (!map.img) box.classList.add("schematic");

  const schemaNote = map.img ? null : el("span", "schemanote", "");
  const rings = [], dots = [];
  if (radiusWorld > 0)
    for (let i = 0; i < pixels.length; i++) rings.push(el("span", "spawnring"));
  for (let i = 0; i < pixels.length; i++) dots.push(el("span", "spawndot"));
  box.append(...rings, ...dots);
  if (schemaNote) box.appendChild(schemaNote);

  // The whole area at a glance, with the window drawn on it. A close view answers "what is
  // it near"; only this answers "where is that".
  let frame = null;
  if (map.img) {
    const loc = el("div", "spawnloc");
    paintMapBg(loc, map);
    loc.style.aspectRatio = (map.w / map.h).toFixed(4);
    loc.title = "Where this view sits in " + map.name;
    frame = el("span", "spawnframe");
    loc.appendChild(frame);
    box.appendChild(loc);
  }

  function render() {
    if (map.img) {
      // Scale the whole image up so the window fills the box, then slide it into view.
      paintMapBg(box, map,
        `${(map.w / V.w) * 100}% ${(map.h / V.h) * 100}%`,
        `${pct(V.x, map.w - V.w)} ${pct(V.y, map.h - V.h)}`);
    } else {
      // The breaches have no terrain for the map camera to draw - the render is one
      // repeating texture - so there is no picture to show. A ruled grid is honest about
      // that and still conveys how the points sit relative to each other.
      const spacing = gridSpacing(V.w / perUnit) * perUnit;
      box.style.backgroundSize = `${(spacing / V.w) * 100}% ${(spacing / V.h) * 100}%`;
      // Line the grid up with round world coordinates rather than the window's edge.
      box.style.backgroundPosition =
        `${(-V.x % spacing) / V.w * 100}% ${(-V.y % spacing) / V.h * 100}%`;
      schemaNote.textContent = `${Math.round(spacing / perUnit)} units per square`;
    }

    /* The aggro range, at the same scale as the ground it covers. A number on its own says
       nothing - "aggro range 14" only means something once you can see it against the gap
       between two spawn points and decide whether you can walk between them. */
    const d = radiusWorld > 0 ? ((2 * radiusWorld * perUnit) / V.w) * 100 : 0;
    for (let i = 0; i < pixels.length; i++) {
      const [px, py] = pixels[i];
      const left = ((px - V.x) / V.w) * 100 + "%";
      const top = ((py - V.y) / V.h) * 100 + "%";
      if (rings[i]) {
        rings[i].style.left = left;
        rings[i].style.top = top;
        rings[i].style.width = d + "%";
        // Height in per cent of a shorter box has to be scaled by the box's own ratio, or
        // the circle comes out an ellipse.
        rings[i].style.height = (d * ratio) + "%";
      }
      dots[i].style.left = left;
      dots[i].style.top = top;
    }

    if (frame) {
      frame.parentElement.hidden = V.w >= map.w * MAP_LOCATOR_BELOW;
      frame.style.left = (V.x / map.w) * 100 + "%";
      frame.style.top = (V.y / map.h) * 100 + "%";
      frame.style.width = (V.w / map.w) * 100 + "%";
      frame.style.height = (V.h / map.h) * 100 + "%";
    }
    box.classList.toggle("zoomed", V.w < fitW - 0.5);
  }

  /** Resizes the window about a point given as a fraction of the box, then re-clamps. */
  function zoomTo(width, fx, fy) {
    if (fx === undefined) fx = 0.5;
    if (fy === undefined) fy = 0.5;
    const next = clamp(width, minW, fitW);
    const worldX = V.x + fx * V.w, worldY = V.y + fy * V.h;
    V.w = next;
    V.h = next / ratio;
    V.x = clamp(worldX - fx * V.w, 0, Math.max(0, map.w - V.w));
    V.y = clamp(worldY - fy * V.h, 0, Math.max(0, map.h - V.h));
    render();
  }

  box.addEventListener("wheel", e => {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoomTo(V.w * Math.exp(e.deltaY * 0.0016),
           (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, {passive: false});

  // Drag to pan, in the window's own units rather than screen pixels, so it tracks the
  // cursor at every zoom level.
  let drag = null;
  box.addEventListener("pointerdown", e => {
    if (e.target.closest(".spawnzoom, .spawnloc")) return;
    const r = box.getBoundingClientRect();
    drag = {x: e.clientX, y: e.clientY, sx: V.x, sy: V.y,
            kx: V.w / r.width, ky: V.h / r.height};
    box.setPointerCapture(e.pointerId);
    box.classList.add("dragging");
  });
  box.addEventListener("pointermove", e => {
    if (!drag) return;
    V.x = clamp(drag.sx - (e.clientX - drag.x) * drag.kx, 0, Math.max(0, map.w - V.w));
    V.y = clamp(drag.sy - (e.clientY - drag.y) * drag.ky, 0, Math.max(0, map.h - V.h));
    render();
  });
  const endDrag = e => {
    if (!drag) return;
    drag = null;
    box.releasePointerCapture(e.pointerId);
    box.classList.remove("dragging");
  };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  const zoomBar = el("div", "spawnzoom");
  for (const [label, act, title] of [
    ["+", () => zoomTo(V.w / 1.6), "Zoom in"],
    ["−", () => zoomTo(V.w * 1.6), "Zoom out"],
    ["Fit", () => zoomTo(fitW), "Back to the whole range"],
  ]) {
    const b = el("button", null, label);
    b.type = "button";
    b.title = title;
    b.onclick = act;
    zoomBar.appendChild(b);
  }
  box.appendChild(zoomBar);

  render();

  const wrap = el("div", "spawnwrap");
  const head = el("div", "spawnhead");
  head.appendChild(el("span", "spawnarea", map.name));
  wrap.append(head, box);
  return wrap;
}

/* ---- detail sheet --------------------------------------------------------
   One dialog, shared by the monster and item views, so a drop table always looks and
   behaves the same however you reached it. Views are pushed as factories rather than as
   built DOM: a factory keeps its own sort and filter state in a closure, which survives
   both a redraw and a step back through the stack.                                       */

const SHEET = {stack: [], dlg: null};

/** Scaling context for item sheets. Pages that offer rarity controls keep this in sync. */
const SCALE = {quality: 1, tier: 0};

function sheetDialog() {
  if (SHEET.dlg) return SHEET.dlg;

  const dlg = el("dialog", "sheet");
  dlg.innerHTML =
    '<div class="dhead">' +
      '<div class="dtop">' +
        '<button class="sback" hidden>‹ Back</button>' +
        '<b class="stitle"></b><span class="ssub"></span>' +
        '<span class="spacer"></span>' +
        '<button class="gold sclose">Close</button>' +
      '</div>' +
      // The subject of the sheet — portrait, icon, key numbers — sits above the tabs,
      // because it is what the sheet is ABOUT and does not change when you switch tab.
      '<div class="dhero"></div>' +
      '<div class="dfilters sfilters"></div>' +
    '</div>' +
    '<div class="dbody sbody"></div>';

  dlg.querySelector(".sclose").onclick = () => dlg.close();
  dlg.querySelector(".sback").onclick = () => { SHEET.stack.pop(); paintSheet(); };
  // Escape closes the dialog itself, so the stack is cleared here rather than per-button.
  dlg.addEventListener("close", () => { SHEET.stack.length = 0; });
  // A click on the backdrop lands on the dialog element itself, never on its content.
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });

  document.body.appendChild(dlg);
  SHEET.dlg = dlg;
  return dlg;
}

/** Renders the view on top of the stack. Call after changing a view's own state. */
function paintSheet() {
  const dlg = sheetDialog();
  if (!SHEET.stack.length) { dlg.close(); return; }

  const view = SHEET.stack[SHEET.stack.length - 1]();
  const q = s => dlg.querySelector(s);

  const title = q(".stitle");
  title.textContent = view.title;
  title.className = "stitle" + (view.titleCls ? " " + view.titleCls : "");
  q(".ssub").textContent = view.sub || "";
  q(".sback").hidden = SHEET.stack.length < 2;

  const hero = q(".dhero");
  hero.replaceChildren();
  if (view.hero) hero.appendChild(view.hero);
  hero.hidden = !view.hero;

  const filters = q(".sfilters");
  filters.replaceChildren();
  if (view.filters) filters.appendChild(view.filters);
  filters.hidden = !view.filters;

  // Sorting or filtering redraws the same view, and yanking a long table back to the top
  // each time loses the reader's place; a different subject starts at the top.
  const body = q(".sbody");
  const keep = view.key === SHEET.key ? body.scrollTop : 0;
  body.replaceChildren(view.body);
  body.scrollTop = keep;
  SHEET.key = view.key;

  if (!dlg.open) dlg.showModal();

  /* Anything that had to measure itself gets its chance now. A closed dialog has no
     layout, so a canvas built inside one is sized 300x150 - its default - and a
     ResizeObserver is no help either: those deliver before a paint, and a background tab
     never paints. Asking the sheet's own drawables to redraw once it is on screen is the
     only order that always holds. */
  for (const box of dlg.querySelectorAll(".qmap"))
    if (typeof box.redraw === "function") box.redraw();
}

/** Opens a view, replacing anything already open. */
function openSheet(factory) {
  SHEET.stack.length = 0;
  SHEET.stack.push(factory);
  paintSheet();
}

/** Opens a view from inside another, keeping a way back. */
function pushSheet(factory) {
  if (!SHEET.stack.length) return openSheet(factory);
  SHEET.stack.push(factory);
  paintSheet();
}

/** Builds the table shell used by every sheet: sortable head, rows, empty state. */
function sheetTable(cols, rows, state, drawRow, emptyMsg) {
  const table = el("table");
  const head = el("tr");
  table.appendChild(el("thead")).appendChild(head);
  sortableTable(head, cols, state, paintSheet);

  const body = table.appendChild(el("tbody"));
  if (!rows.length) emptyRow(body, cols.length, emptyMsg);
  for (const r of rows) body.appendChild(drawRow(r));
  return table;
}

/** Makes a row behave like a button without losing table layout. */
function clickableRow(tr, label, onOpen) {
  tr.tabIndex = 0;
  tr.setAttribute("role", "button");
  tr.title = label;
  tr.onclick = onOpen;
  tr.onkeydown = e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
  };
  return tr;
}

/* ---- monster sheet: everything one source drops --------------------------- */

const TYPE_ORDER = ["Equipment", "Material", "Consumable", "Quest"];

function monsterSheet(src) {
  // Where it stands answers "can I go and kill it", which is the first question; the loot
  // table answers "is it worth it". So the map leads, when there is one.
  const st = {type: "", sort: {key: "chance", desc: true}, tab: "map"};

  return () => {
    const all = dropsOf(src).map(e => {
      const it = lootItem(e.item);
      // `type` is what the chips filter on; `kind` is what the column shows - the weapon
      // or armour kind for equipment, the item type for everything else. Printing
      // "Equipment" against every piece of gear would waste the column.
      return {e, it, name: it.name, type: it.type, slot: it.slot || "",
              kind: it.kind || it.type, chance: effChance(e), qty: e.maxQ};
    });
    const types = TYPE_ORDER.filter(t => all.some(r => r.type === t))
      .concat([...new Set(all.map(r => r.type))].filter(t => t && !TYPE_ORDER.includes(t)));
    const rows = applySort(all.filter(r => !st.type || r.type === st.type), st.sort);

    const cols = [
      {key: "name", label: "Item", left: true},
      {key: "kind", label: "Type", left: true},
      {key: "qty", label: "Qty"},
      {key: "chance", label: "Chance"},
    ];

    const table = sheetTable(cols, rows, st, r => {
      const tr = el("tr");
      tr.appendChild(nameCell("items", r.it.id, r.it.icon, r.name,
                              r.it.equip ? "iname" : "iname muted", 0,
                              r.it.equip ? SCALE.quality : 1));
      tr.appendChild(el("td", "l muted", r.kind || "·"));
      tr.appendChild(el("td", "muted", qtyLabel(r.e) || "·"));
      tr.appendChild(chanceCell(r.e));
      return clickableRow(tr, "Where else " + r.name + " drops",
                          () => pushSheet(itemSheet(r.it.id)));
    }, "Nothing of this kind in this loot table.");

    // No recorded spawns means no map worth a tab, so the loot table stands alone.
    const areas = src.node ? [] : spawnsFor(SPAWN_ENEMY, src.id);
    /* Offered for every creature, recorded or not: "nothing known yet" is information, and
       hiding the tab would make an unrecorded creature look like one with no abilities. */
    const casts = !src.node;
    if (!areas.length) st.tab = "loot";
    // ...and no loot table means the reverse: the map is the whole sheet, with no tab row
    // offering a second view that would open on an empty table.
    if (!DROP.ready && areas.length) st.tab = "map";
    if (!areas.length && !DROP.ready && casts) st.tab = "abil";

    const filters = el("span", "sfilterrow");
    if ((areas.length && DROP.ready) || casts) {
      const tabs = el("span", "tabstrip");
      const tabList = [["map", "Map"], ["loot", "Loot"]];
      if (casts) tabList.push(["abil", "Abilities"]);
      for (const [key, label] of tabList) {
        const tab = el("button", "tab" + (st.tab === key ? " on" : ""), label);
        tab.type = "button";
        tab.onclick = () => { st.tab = key; paintSheet(); };
        tabs.appendChild(tab);
      }
      filters.appendChild(tabs);
    }
    // The kind chips belong to the loot table, so they only appear alongside it.
    if (st.tab === "loot" && types.length > 1) {
      const chips = el("span", "chipset");
      for (const t of ["All", ...types]) {
        const value = t === "All" ? "" : t;
        const chip = el("span", "chip" + (st.type === value ? " on" : ""), t);
        chip.onclick = () => { st.type = value; paintSheet(); };
        chips.appendChild(chip);
      }
      filters.appendChild(chips);
    }
    // Only the loot table needs a count here: each area's map carries its own, so putting
    // one in the tab row as well said the same thing twice.
    if (st.tab !== "map" && st.tab !== "abil" && DROP.ready)
      filters.appendChild(el("span", "count", `${rows.length} of ${all.length} entries`));

    // Each tab carries only its own explanation. The loot note used to sit above both,
    // telling you how drop chances work while you were looking at a map.
    //
    // A paragraph of the NPC sheet had been pasted in here - `const errands = gives.map(...)`
    // against a `gives` that only exists over there - so every monster sheet threw on render
    // and opened as a panel containing a Back button. Silent, because the throw happened
    // inside the sheet builder and the shell had already drawn its chrome.
    const wrap = el("div");
    if (st.tab === "abil") {
      wrap.appendChild(abilityPanel(src));
    } else if (st.tab === "map") {
      const monster = asOf("monsters", D.monsters.find(m => m.id === src.id));
      for (const area of areas)
        wrap.appendChild(spawnMap(area, monster ? monster.aggro : 0));
    } else if (DROP.ready) {
      wrap.appendChild(table);
      wrap.appendChild(el("p", "note", lootNote(src)));
    }

    // Level moved into the stats, where it sits beside the numbers it governs; the drop
    // count is the length of the list already on screen.
    const sub = src.node ? "Gathering node" : (src.boss ? "Boss" : "");

    return {key: "m" + src.i, title: src.name, sub, hero: sourceHero(src),
            filters, body: wrap};
  };
}

/* What an effect does, in the game's own words.
 *
 * Not paraphrased and not inferred: this is SpellTooltipFormatter.FormatMonsterActiveEffectText
 * from the client, which exists precisely because a monster's effect reads differently from a
 * player's. Taking the wording from there rather than writing our own means the site cannot
 * drift from what the tooltip in front of you says, and it settled the one type nothing else
 * could - effect 10 never lands on a player, so it never appears in the recorded effects and
 * has no name there. The client calls it increased damage dealt.
 *
 * The amounts are the catalogue's, which is why a damage-over-time reads without a number:
 * the game computes those server-side and stores 0. What it does not state, the combat log
 * measured - see the damage line above this one.
 */
function monsterEffectLine(sp) {
  if (!sp || !sp.fx) return null;
  const dur = fmtNum(sp.fxDur) + "s";
  const tick = fmtNum(sp.fxTick);
  const pct = v => fmtNum(Math.round(v * 1000) / 10) + "%";
  switch (sp.fx) {
    case 1:  return "Stuns for " + dur;
    case 2:  return "Deals damage every " + tick + "s for " + dur;
    case 3:  return "Restores health every " + tick + "s for " + dur;
    case 4:  return "Reduces damage taken by " + pct(sp.fxAmt) + " for " + dur;
    case 5:  return "Increases cast speed and spell damage by " + pct(sp.fxAmt)
                    + " for " + dur;
    case 10: return "Increases damage dealt by " + pct(sp.fxAmt) + " for " + dur;
    default: return "Effect lasts " + dur;
  }
}

/* ---- what a creature casts -------------------------------------------------
 * Three states, and telling them apart is the whole job.
 *
 * NOTHING RECORDED is not "this creature has no abilities". Since the patch that gave them
 * abilities there is no roster anywhere in the game's data - eighty-nine tables and not one
 * says which spell belongs to which enemy - so every line here was recovered by watching a
 * creature actually cast. A blank means nobody has fought it while recording, and saying
 * "none" would be inventing a fact out of our own idleness.
 *
 * KNOWN INCOMPLETE is the normal state even when there IS a list. Nothing states how many
 * abilities a creature has, so "we have seen two" never becomes "it has two". The panel says
 * "at least", every time, because that is the only claim the evidence supports.
 *
 * MEASURED numbers are marked apart from catalogue ones. A duration comes from the spell
 * row; an amount and a tick interval come from a cast that actually landed, and only the
 * second kind can be wrong in an interesting way.
 */
function abilityPanel(src) {
  const list = ((D.abilities || {})[src.id] || []).slice();
  const wrap = el("div", "abil");

  if (!list.length) {
    const m = (D.monsters || []).find(x => x.id === src.id) || {};
    const none = el("div", "abilnone");
    if (m.absent) {
      /* Nothing to record, rather than nothing recorded. Saying "nobody has watched this
         cast" about a creature that is not in the world blames the recording for the
         game's own leftovers. */
      none.appendChild(el("b", null, "Not in the world"));
      none.appendChild(el("p", "note",
        "The client's enemy table still declares this creature, but it has never had a "
        + "spawn point on any build recorded here, has never been killed, and is in "
        + "nobody's compendium. It is an old asset the game has moved past — so there is "
        + "nothing to watch it cast."));
    } else {
      none.appendChild(el("b", null, "No abilities recorded yet"));
      none.appendChild(el("p", "note",
        "Not the same as having none. The game publishes no list of which creature casts "
        + "what, so every ability on this site was recovered by watching one land. Nobody "
        + "has recorded this creature casting yet."));
    }
    wrap.appendChild(none);
    return wrap;
  }

  const byId = new Map((D.spells || []).map(sp => [sp.id, sp]));
  /* Basics first, then the rest by cooldown: that is the order a fight happens in. */
  list.sort((a, b) => ((byId.get(a.id) || {}).cd || 0) - ((byId.get(b.id) || {}).cd || 0));

  for (const a of list) {
    const sp = byId.get(a.id) || {};
    const row = el("div", "abilrow");
    row.appendChild(icon("spells", a.id, !!sp.icon, 34));

    const mid = el("div", "abilmid");
    const head = el("div");
    head.appendChild(el("b", null, a.name || sp.name || ("Spell " + a.id)));
    /* The tick the whole fight runs on: creatures act every 3s, so a stated cooldown
       resolves to the first boundary at or after it. 11 fires at 12. */
    const cd = sp.cd || 0;
    head.appendChild(el("span", "abilcd", cd > 0
      ? "every " + (Math.ceil(cd / 3) * 3) + "s"
      : "every 3s"));
    if (cd > 0 && Math.ceil(cd / 3) * 3 !== cd)
      head.appendChild(el("span", "abilnote", "listed " + cd + "s"));
    mid.appendChild(head);

    /* What it hits for, given the top billing it deserves - it is the first thing anyone
       reading this asks. Measured off the combat log, which is the only place the game ever
       says: the spell row's own damage column reads 0 on all forty-two of them. */
    if (a.hit || a.dot) {
        const hit = el("div", "abildmg");
        if (a.hit) {
            hit.appendChild(el("b", null, fmtNum(Math.round(a.hit))));
            hit.appendChild(el("span", null, "on impact"));
        }
        if (a.dot) {
            if (a.hit) hit.appendChild(el("span", "abilthen", "then"));
            hit.appendChild(el("b", null, fmtNum(Math.round(a.dot))));
            /* Interval measured, duration stated. The game says how long its effect runs and
               computes the damage server-side; we have it the other way round, so the line
               takes each from whichever knows. */
            hit.appendChild(el("span", null,
                (a.tick ? "every " + (a.tick / 1000) + "s"
                        : sp.fxTick ? "every " + fmtNum(sp.fxTick) + "s" : "a tick")
                + (sp.fxDur ? " for " + fmtNum(sp.fxDur) + "s" : "")));
        }
        /* The sample, on hover rather than on the line: it decides how much to trust the
           number and almost nobody wants it in the way while reading the number itself. */
        const n = (a.casts || 0) + (a.dots || 0);
        hit.title = "Median of " + fmtNum(n) + " recorded landing"
          + (n === 1 ? "" : "s")
          + ", as the damage ARRIVED — after the defences of whoever recorded it. "
          + "Comparable with the other abilities here, which were all measured through the "
          + "same armour; not a figure to expect on your own character.";
        mid.appendChild(hit);
    }

    /* What it leaves behind, if anything. A damage-over-time is left to the measured line
       above - the game's sentence for one carries no number and ours does - but everything
       else lands here in the client's own words, with the one thing the wording leaves out:
       whether it is happening to you or to the creature. */
    const line = sp.fx === 2 && (a.dot || a.amount) ? null : monsterEffectLine(sp);
    if (line) {
      const fx = el("div", "abilfx" + (sp.fxTgt === 1 ? " self" : ""));
      fx.appendChild(el("span", "abilwho", sp.fxTgt === 1 ? "on itself" : "on you"));
      fx.appendChild(document.createTextNode(line));
      mid.appendChild(fx);
    }

    const bits = [];
    // Only when neither line above already said how long it runs for.
    if (line === null && !a.dot && sp.fxDur) bits.push(fmtNum(sp.fxDur) + "s effect");
    if (a.tick && !a.dot) bits.push("ticks every " + (a.tick / 1000) + "s");
    // The effect row's own amount, kept only when the combat log had too few landings to
    // measure - otherwise the same fact would be stated twice with two different numbers.
    if (a.amount && !a.dot) bits.push("measured " + fmtNum(Math.round(a.amount)) + " a tick");
    if (bits.length) mid.appendChild(el("span", "abilsub", bits.join(" · ")));
    if (sp.desc) mid.appendChild(el("span", "abildesc", sp.desc));
    row.appendChild(mid);

    /* Which of the two recorders saw it is carried in the data and deliberately not drawn:
       it answers a question about our method, not about the creature. Nor is the "at least
       N" caveat repeated under every list - it is a fact about the whole roster, and the one
       page whose subject IS the roster states it once at the top. */
    wrap.appendChild(row);
  }
  return wrap;
}

/** How this source's chances behave, said once, on the tab that shows them. */
function lootNote(src) {
  const drops = dropsOf(src);
  // Listed at 100% and still only landing half the time is the clearest case of the gap
  // between the table and the game, so it is said here rather than left to a tooltip.
  const guaranteed = drops.filter(e => e.chance >= 100).length;
  const parts = [src.node
    ? "Harvested from the world rather than killed, so chances are per harvest."
    : "Chances are per kill, and every entry is rolled independently."];
  // Only says anything when a factor is actually being applied. With none, every figure on
  // the page is the game's own and there is nothing to explain.
  if (src.node && DROP_RATE.factor !== 1) {
    parts.push("Shown as the game's table lists them: the measured drop rate applied to "
             + "the rest of the site comes from kills, and gathering was not part of it.");
  } else if (DROP_RATE.factor !== 1) {
    parts.push("These are the rates measured in play, which come out at "
             + `${Math.round(DROP_RATE.factor * 100)}% of what the game's table lists.`);
    if (guaranteed) parts.push(guaranteed > 1
      ? `${guaranteed} of them are listed as certain and still drop about half the time.`
      : "One is listed as certain and still drops about half the time.");
  } else if (guaranteed) {
    parts.push(guaranteed > 1 ? `${guaranteed} of them are listed as certain.`
                              : "One of them is listed as certain.");
  }
  return parts.join(" ");
}

/** A labelled number, the unit the sheets state facts in.
 *
 * When the sheet was opened from the changelog, a chip whose number the patch moved says so
 * and carries the other build's value. The mark is applied here rather than in each sheet:
 * the label already names the field, so one lookup covers every sheet that draws chips.
 */
function statChip(label, value, cls) {
  const chip = el("span", "sstat" + (cls ? " " + cls : ""));
  chip.append(el("span", "sk", label), el("b", null, value));

  const d = diffField(label);
  if (d) {
    const ctx = DIFF.on;
    const other = ctx.old ? d.to : d.from;
    chip.classList.add("sdiff");
    chip.appendChild(el("span", "swas",
      (ctx.old ? "now " : "was ") + (diffText(ctx.cat, d.field, other) || "nothing")));
    chip.title = ctx.old ? `v${ctx.version} has ${d.to || "nothing"}`
                         : `v${ctx.from} had ${d.from || "nothing"}`;
  }
  return chip;
}

/**
 * The subject of a monster sheet: its portrait and the numbers that decide whether you can
 * fight it. These used to be missing entirely — you could open a creature and not learn its
 * health — and the portrait used to sit below the tabs, as though it belonged to one of them.
 */
/* ---- what a kill is worth, at your level ----------------------------------
   The whole rule, from the client's own CompendiumPanel.TryGetLocalXpReward. The reward
   moves 10% per level between you and the creature, pays nothing once you are ten levels
   above it, and is floored — when the creature is ABOVE you — at a twentieth of what your
   own level costs, so something far too big for you is still worth a fixed something.

   Confirmed against a play session: fourteen kills of a level 8 creature between levels 1
   and 10, every one exactly what this predicts.                                          */

const LEVEL_XP = D.levelXp || {};
const MAX_LEVEL = Math.max(1, ...Object.keys(LEVEL_XP).map(Number));

/** The reader's own level, remembered across pages and visits. Null means "not stated". */
const LEVEL = {value: null};
try {
  const saved = Number(localStorage.getItem("elegon-level"));
  if (saved >= 1 && saved <= MAX_LEVEL) LEVEL.value = saved;
} catch (e) { /* private mode */ }

/** Sets it everywhere: pages listen for levelchange, and an open sheet repaints itself. */
function setLevel(value) {
  const v = (value === null || value === "" || !isFinite(value))
    ? null : clamp(Math.round(Number(value)), 1, MAX_LEVEL);
  if (v === LEVEL.value) return;
  LEVEL.value = v;
  try {
    if (v === null) localStorage.removeItem("elegon-level");
    else localStorage.setItem("elegon-level", String(v));
  } catch (e) { /* private mode */ }
  document.dispatchEvent(new Event("levelchange"));
  if (SHEET.stack.length) paintSheet();
}

/** What one kill gives a character of this level. Undecided level means the base number. */
function xpAt(monster, level = LEVEL.value) {
  const base = monster.xp || 0;
  if (level === null) return base;
  if (!base || level >= MAX_LEVEL) return 0;      // the curve stops, so the reward does too

  const d = monster.lvl - level;
  if (d < (D.xpIgnoreBelow === undefined ? -10 : D.xpIgnoreBelow)) return 0;
  // The floor only applies upwards: nothing beneath you is worth a minimum.
  const floor = d > 0 ? Math.ceil((LEVEL_XP[level] || 1) / (D.xpFloorDiv || 20)) : 0;
  if (d > 10) return floor;

  // Single precision, the same as the client: 1f + d * 0.1f is not 1 + d/10, and at exactly
  // ten levels below it lands a hair under zero rather than on it — which is what makes that
  // case pay nothing. Rounding half away from zero is Math.round for a positive number.
  const mult = f32(1 + f32(d * f32(D.xpStep === undefined ? 0.1 : D.xpStep)));
  if (mult <= 0) return 0;
  return Math.max(Math.round(f32(base * mult)), floor);
}

/** Big numbers, short. A level's worth of XP runs to eleven digits by level 80. */
function abbrevNum(n) {
  // Three significant figures, then any zeros the rounding left behind. String(), not the
  // bare Math.round — a number has no .replace, and the trim turned every value of a hundred
  // units or more into a thrown TypeError.
  const round = (v, unit) => {
    const s = v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s) + unit;
  };
  // The thresholds sit just under the next unit, so 999,999 rounds up into 1M rather than
  // being shown as 1000K.
  if (n >= 999.5e6) return round(n / 1e9, "B");
  if (n >= 999.5e3) return round(n / 1e6, "M");
  if (n >= 9999.5) return round(n / 1e3, "K");
  return fmtNum(Math.round(n));
}

/**
 * What a reward is worth as a share of levelling, from where this character stands.
 *
 * Not simply reward ÷ this level's requirement: a kill can be worth more than the level it
 * is earned in, and the next level costs more than the last. So it is spent down the curve
 * level by level, which is what makes "1.4 levels" mean what it says.
 */
function levelsWorth(reward, level) {
  let left = reward, at = level, levels = 0;
  while (at <= MAX_LEVEL) {
    const need = LEVEL_XP[at];
    if (!need) break;
    if (left < need) return levels + left / need;
    left -= need;
    levels += 1;
    at += 1;
  }
  return levels;
}

/** That share, said the way its size deserves. */
function levelShare(reward, level) {
  const levels = levelsWorth(reward, level);
  if (levels >= 1) return "×" + (levels >= 10 ? Math.round(levels) : levels.toFixed(1)) + " lv";
  const pct = levels * 100;
  if (pct >= 10) return Math.round(pct) + "%";
  if (pct >= 1) return pct.toFixed(1) + "%";
  if (pct >= 0.01) return pct.toFixed(2) + "%";
  return "<0.01%";
}

/** How many of them a level costs, at whatever level is being asked about. */
function killsPerLevel(monster, level = LEVEL.value) {
  const at = level === null ? monster.lvl : level;
  const reward = xpAt(monster, at);
  const need = LEVEL_XP[at];
  return (reward > 0 && need) ? Math.ceil(need / reward) : null;
}

/**
 * What killing it is worth, and how many it takes.
 *
 * With no level stated the base number is shown — what you get fighting one at its own level
 * — because that is the only figure true of everybody. Once a level is given, both chips
 * answer for that character instead.
 */
function xpChips(monster) {
  const step = Math.round((D.xpStep || 0.1) * 100);
  const lvl = LEVEL.value;
  const reward = xpAt(monster);

  const xp = statChip("XP", fmtNum(reward), lvl !== null && reward === 0 ? "bad" : null);
  xp.title = lvl === null
    ? `At its own level. ${step}% more per level it is above you, ${step}% less per level `
      + `below, and nothing once you are ${-(D.xpIgnoreBelow || -10)} levels above it`
    : reward === 0
      ? (lvl >= MAX_LEVEL ? `Level ${MAX_LEVEL} is the cap — nothing gives XP any more`
                          : `You are too far above it: ${fmtNum(monster.xp)} at its own level`)
      : `At level ${lvl}. ${fmtNum(monster.xp)} at its own level, ${step}% per level between`;
  const out = [xp];

  /* Only once a level has actually been chosen. With none set it silently assumed you were
     the creature's own level, which made it a fact about an imaginary character - and it sat
     there on every sheet on every page looking like a fact about the creature. */
  const kills = lvl === null ? null : killsPerLevel(monster);
  if (kills !== null) {
    const chip = statChip("Kills per level", fmtNum(kills));
    chip.title = `${fmtNum(LEVEL_XP[lvl])} XP finishes level ${lvl}, at `
               + `${fmtNum(xpAt(monster, lvl))} a kill`;
    out.push(chip);
  }
  return out;
}

/**
 * The control both pages carry, in the shape each one needs.
 *
 * `slider` adds a range beside the number, for the map — where the question is "what does
 * this area give me" and dragging through the levels answers it faster than typing does.
 * Empty means undecided, and both halves stay in step whichever one is used.
 */
function levelPicker({slider = false} = {}) {
  const box = el("span", "lvlpick" + (slider ? " wide" : ""));

  const num = el("input");
  num.type = "number";
  num.min = 1; num.max = MAX_LEVEL;
  num.placeholder = "—";
  num.title = "Your character's level";
  num.value = LEVEL.value === null ? "" : LEVEL.value;
  // No stepper buttons on this one: beside a slider they are a third way to do the same
  // thing, and the pair of them squeezed the field down to two digits' worth of room.
  num.dataset.stepped = "1";

  let range = null;
  let dragging = false;
  if (slider) {
    range = el("input");
    range.type = "range";
    range.min = 1; range.max = MAX_LEVEL;
    range.value = LEVEL.value === null ? 1 : LEVEL.value;
    range.title = "Your character's level";
    /* `dragging` guards the write-back below. Assigning to a range's value while the browser
       is running its own drag on it resets the drag's anchor: the thumb jumps away from the
       pointer, and the events that follow describe a position the reader never asked for. */
    range.oninput = () => {
      dragging = true;
      try { setLevel(range.value); } finally { dragging = false; }
    };
    box.appendChild(range);
  }

  num.oninput = () => setLevel(num.value === "" ? null : num.value);
  box.appendChild(num);

  const clear = el("button", "lvlclear", "×");
  clear.type = "button";
  clear.title = "Show the base number instead";
  clear.onclick = () => setLevel(null);
  box.appendChild(clear);

  // Whoever changed it, everything showing the level follows. The clear button is hidden by
  // visibility rather than removed, because taking it out of the row resized the slider by
  // 14px at the very moment the first drag put a value in it.
  const sync = () => {
    num.value = LEVEL.value === null ? "" : LEVEL.value;
    if (range && !dragging && LEVEL.value !== null) range.value = LEVEL.value;
    clear.style.visibility = LEVEL.value === null ? "hidden" : "visible";
  };
  document.addEventListener("levelchange", sync);
  sync();
  return box;
}

/**
 * How fast it is, and how far it will follow — the two halves of "can I get away".
 *
 * The catalogue's own move_speed is not the answer and used to be shown as though it were.
 * Nothing in the client reads that column, every creature in the game carries the same
 * value, and the number the client actually moves a chasing creature at is fixed: 7.875,
 * exactly 1.5x the player's 5.25. So a chase is always faster than running away, and what
 * ends it is the leash — max_distance_from_spawn, which does differ from creature to
 * creature. That is what these two chips say instead.
 */
function chaseChips(monster) {
  const out = [];
  const mine = D.playerSpeed || 0;
  const chase = D.chaseSpeed || 0;

  // If a patch ever gives creatures different speeds, the per-creature number starts
  // meaning something again and is worth showing on its own.
  if (D.speedVaries) out.push(statChip("Speed", String(monster.speed)));

  if (mine && chase && monster.aggressive) {
    const chip = statChip("Chase", `${Math.round((chase / mine) * 100)}% of your speed`, "bad");
    chip.title = `It closes at ${chase} against your ${mine} — you cannot outrun it, `
               + "only outlast it";
    out.push(chip);
  }
  if (monster.leash) {
    const chip = statChip("Gives up at", monster.leash + "m", "good");
    chip.title = "How far it will follow you from its spawn before turning back";
    out.push(chip);
  }
  return out;
}

function sourceHero(src) {
  const box = el("div", "hero");
  const monster = asOf("monsters", D.monsters.find(m => m.id === src.id));

  if (!src.node) box.appendChild(icon("monsters", src.id, src.icon, 96));

  const facts = el("div", "herofacts");
  if (monster) {
    // Level leads: it is the first thing that decides whether the rest is worth reading.
    facts.append(statChip("Level", String(monster.lvl)),
                 statChip("Health", fmtNum(monster.hp)),
                 statChip("Attack", fmtNum(monster.dmg)),
                 ...xpChips(monster),
                 statChip("Respawn", monster.respawn + "s"),
                 statChip("Aggro range", monster.aggro + "m"),
                 ...chaseChips(monster));
    if (monster.aggressive) facts.appendChild(el("span", "tag", "aggressive"));
  }
  box.appendChild(facts);
  return box;
}

/* Who may actually equip a thing.
   Two rules, and neither was shown anywhere: an item can name a class outright (37 do), and
   a WEAPON is restricted by its type regardless - a greatsword is Knight-only because no
   other class may hold that type at all. Shields and tomes are off-hands and belong to
   everyone, which is why the type test comes first. */
const CLASS_WEAPONS = D.classWeapons || {};
const ANY_WEAPON = new Set([].concat(...Object.values(CLASS_WEAPONS)));
const CLASS_NAME = id => ((D.classes || {})[String(id)] || {}).name || "";
const CLASS_IDS = Object.keys(D.classes || {}).sort((a, b) => a - b);

/**
 * May this class equip this item? The client's ClassWeaponRestrictions.CanUse, plus the
 * item's own class flag.
 *
 * Lives here rather than in a page because three of them ask now - the planner filters its
 * picker with it, the items list filters on it, and the item sheet words it - and three
 * copies of a rule is three places to miss when a weapon type is added or cut.
 */
function usableBy(item, cls) {
  if (!item) return false;
  if (item.cls && String(item.cls) !== String(cls)) return false;
  if (!item.sub || !ANY_WEAPON.has(item.sub)) return true;    // not a weapon: anyone may
  return (CLASS_WEAPONS[String(cls)] || []).includes(item.sub);
}

/** The same rule as a phrase, or "" when nothing is actually restricted. */
function classNote(item) {
  if (!item) return "";
  if (item.cls) return CLASS_NAME(item.cls) + " only";
  if (!item.sub || !ANY_WEAPON.has(item.sub)) return "";
  const who = CLASS_IDS.filter(c => (CLASS_WEAPONS[c] || []).includes(item.sub))
                       .map(CLASS_NAME).filter(Boolean);
  // Every class can hold it: not a restriction, so not worth a word.
  return who.length && who.length < CLASS_IDS.length ? who.join(" and ") + " only" : "";
}


/* ---- item sheet: every source that yields one item ------------------------ */

/**
 * The rifts whose reward table names this item, with whether it is a boss material.
 *
 * D.riftDrops is the game's own per-map table: reward_kind 1 is the three materials named
 * after that rift's bosses, kind 2 the equipment pool. It has no chance column - which is
 * the whole reason it can be shown in every build where the measured drop rates are not.
 */
/* "Ashenroot Grotto" -> "AG". Articles are dropped, so "The First Breach" is FB rather than
   TFB - the T carries nothing and the column is two characters wide by design. */
const RIFT_STOPWORDS = new Set(["the", "of", "and"]);
function riftInitials(name) {
  const parts = String(name || "").split(/[\s-]+/)
    .filter(w => w && !RIFT_STOPWORDS.has(w.toLowerCase()));
  const letters = parts.map(w => w[0].toUpperCase()).join("");
  return letters || String(name || "?").slice(0, 2).toUpperCase();
}

let RIFT_SOURCE = null;
function riftsDropping(itemId) {
  if (!RIFT_SOURCE) {
    RIFT_SOURCE = new Map();
    const names = D.mapNames || {};
    for (const [mapId, sets] of Object.entries(D.riftDrops || {}))
      for (const [bucket, ids] of Object.entries(sets))
        for (const id of ids) {
          if (!RIFT_SOURCE.has(id)) RIFT_SOURCE.set(id, []);
          RIFT_SOURCE.get(id).push({id: mapId, name: names[mapId] || mapId,
                                    boss: bucket === "boss"});
        }
  }
  return RIFT_SOURCE.get(itemId) || [];
}


function itemSheet(itemId) {
  const st = {sort: {key: "chance", desc: true}};

  return () => {
    const it = asOf("items", lootItem(itemId));
    const vendors = vendorsOf(itemId);
    const rows = applySort(sourcesOf(itemId).map(e => ({
      e, src: e.src, name: e.src.name, lvl: e.src.lvl,
      chance: effChance(e), qty: e.maxQ,
    })), st.sort);

    const cols = [
      {key: "name", label: "Source", left: true},
      {key: "lvl", label: "Level"},
      {key: "qty", label: "Qty"},
      {key: "chance", label: "Chance"},
    ];

    const table = sheetTable(cols, rows, st, r => {
      const tr = el("tr");
      const td = nameCell("monsters", r.src.id, r.src.icon, r.name,
                          r.src.boss ? "mname boss" : "mname", 52);
      if (r.src.node) td.firstChild.appendChild(el("span", "tag", "gathering"));
      tr.appendChild(td);
      tr.appendChild(el("td", "muted", r.src.node ? "·" : r.lvl));
      tr.appendChild(el("td", "muted", qtyLabel(r.e) || "·"));
      tr.appendChild(chanceCell(r.e));
      // A node goes to its map, a creature to its loot table — see gatherSheet.
      const go = r.src.node ? nodeSheetFor(r.src.name) : null;
      return clickableRow(tr,
        go ? "Where " + r.name + " stands" : "Everything " + r.name + " drops",
        () => pushSheet(go || monsterSheet(r.src)));
    }, vendors.length
        ? "Nothing drops it — the merchant above is the only source."
        : "No loot table lists this item — it comes from somewhere else, such as a vendor, "
          + "a quest reward or crafting.");

    const wrap = el("div");

    // Vendors first when there are any: buying is the certain route, killing is the gamble.
    if (vendors.length) {
      wrap.appendChild(el("h4", "ssection", "Sold by"));
      const list = el("div", "vendors");
      for (const v of vendors) {
        const row = el("div", "vendor");
        const who = el("span", "vname", v.shop.name);
        if (v.shop.role) who.appendChild(el("span", "tag", v.shop.role));
        row.append(who, el("span", "vprice", fmtNum(v.price) + " copper"));
        list.appendChild(row);
      }
      wrap.appendChild(list);
    }

    const fromQuests = QUEST_REWARDS.get(itemId) || [];
    if (fromQuests.length)
      wrap.appendChild(questChips(fromQuests, "Given by " + (fromQuests.length === 1
        ? "a quest" : fromQuests.length + " quests")));

    /* What wants it. Not a source — it says what the item is FOR — so it does not belong in
       the items list's From column, but for a material it is the whole reason to keep one. */
    const wantedBy = QUEST_WANTS.get(itemId) || [];
    if (wantedBy.length)
      wrap.appendChild(questChips(wantedBy, "Asked for by " + (wantedBy.length === 1
        ? "a quest" : wantedBy.length + " quests")));

    /* Which rift gives it, from the game's own per-map reward table. Kept apart from the
       drop table above and shown in every build: that table is a list of enemies with a
       chance beside each, and this is neither - the reward table names the item and carries
       no probability at all, so the line says where and stops. For Ashenroot it is the only
       source there is: its seven creatures have three loot_table_entries between them. */
    const fromRifts = riftsDropping(itemId);
    if (fromRifts.length) {
      const line = el("p", "riftsource");
      line.append(el("span", "riftsourcelabel", "Drops in"));
      for (const r of fromRifts) {
        const chip = el("span", "chip riftchip" + (r.boss ? " boss" : ""), r.name);
        chip.title = r.boss
          ? `A boss material in ${r.name}. The game lists one per boss and gives no chance.`
          : `In ${r.name}'s reward pool. The game's table names the item and not how often `
            + `it comes, so the rate is not known.`;
        line.appendChild(chip);
      }
      wrap.appendChild(line);
    }

    /* The drop table only when the build carries one. Without it the section still built
       itself - a "Sources" heading over a Source/Level/Qty/Chance table with nothing in it -
       which advertises the very thing the build set out to leave behind, and reads as a
       page that failed to load rather than one that was never going to show it. */
    if (DROP.ready)
      wrap.append(el("h4", "ssection", rows.length
                    ? `Dropped by ${rows.length} source${rows.length > 1 ? "s" : ""}`
                    : "Sources"),
                  table);

    const eq = it.equip;
    return {
      key: "i" + itemId,
      title: it.name,
      titleCls: eq ? "r" + SCALE.quality : null,
      sub: eq ? [eq.sub, eq.slot, eq.lvl ? "level " + eq.lvl : "", classNote(eq)]
                  .filter(Boolean).join(" · ")
              : it.type,
      hero: itemHeadline(it),
      filters: null,
      body: wrap,
    };
  };
}

/* ---- npc sheet: who they are and what they sell --------------------------- */

const NPC_BY_ID = new Map(Object.entries(D.npcs || {}).map(([id, n]) => [Number(id), n]));
const SHOP_BY_NPC = new Map((D.shops || []).map(s => [s.id, s]));

function npcSheet(npcId) {
  // Same shape as a monster's sheet: where they are and what they have, one tab each. The
  // two used to be stacked, so a merchant with a full stock pushed their own position off
  // the bottom of the sheet — and "where do I find them" is the more common question.
  const st = {sort: {key: "price", desc: false}, tab: "map"};

  return () => {
    const npc = asOf("npcs", NPC_BY_ID.get(npcId) || {name: "NPC " + npcId, role: ""});
    const shop = SHOP_BY_NPC.get(npcId);

    const rows = applySort((shop ? shop.items : []).map(([itemId, price]) => {
      const it = lootItem(itemId);
      return {it, id: itemId, name: it.name, kind: it.kind || it.type,
              lvl: it.lvl || 0, price};
    }), st.sort);

    const cols = [
      {key: "name", label: "Item", left: true},
      {key: "kind", label: "Type", left: true},
      {key: "lvl", label: "Lvl"},
      {key: "price", label: "Price"},
    ];

    const table = sheetTable(cols, rows, st, r => {
      const tr = el("tr");
      tr.appendChild(nameCell("items", r.id, r.it.icon, r.name,
                              r.it.equip ? "iname" : "iname muted", 0,
                              r.it.equip ? SCALE.quality : 1));
      tr.appendChild(el("td", "l muted", r.kind || "·"));
      tr.appendChild(el("td", "muted", r.lvl || "·"));
      const price = el("td", "vprice", fmtNum(r.price));
      tr.appendChild(price);
      return clickableRow(tr, "Where " + r.name + " comes from",
                          () => pushSheet(itemSheet(r.id)));
    }, "This one sells nothing — they are here for something else.");

    // Same hero block as the other sheets, so an NPC reads like a monster or an item.
    const hero = el("div", "hero");
    hero.appendChild(icon("npcs", npcId, !!npc.icon, 96));
    const facts = el("div", "herofacts");
    if (npc.role) facts.appendChild(statChip("Role", npc.role));
    facts.appendChild(statChip("Sells", shop ? String(shop.items.length) + " items" : "nothing"));
    const gives = QUESTS_BY_GIVER.get(npcId) || [];
    if (gives.length) facts.appendChild(statChip("Quests", String(gives.length), "good"));
    if (npc.at) {
      const where = statChip("Found in", mapName(npc.at.map));
      where.title = `${Math.round(npc.at.x)}, ${Math.round(npc.at.z)}`;
      facts.appendChild(where);
    }
    hero.appendChild(facts);

    /* Their own position is not a tab any more. You reach this sheet by clicking the person
       on the map, or from a quest that names them - either way you already know where they
       are, and a map with one dot on it answered a question nobody had asked. What is worth
       drawing is where their WORK sends you, which is the same map the quest pages use. */
    const areas = gives.length ? questPlacesMerged(gives) : [];
    if (!areas.length) st.tab = "stock";
    else if (!shop) st.tab = "map";

    const filters = areas.length && shop ? el("span", "sfilterrow") : null;
    if (filters) {
      const tabs = el("span", "tabstrip");
      for (const [key, label] of [["map", "Quests"], ["stock", "Stock"]]) {
        const tab = el("button", "tab" + (st.tab === key ? " on" : ""), label);
        tab.type = "button";
        tab.onclick = () => { st.tab = key; paintSheet(); };
        tabs.appendChild(tab);
      }
      filters.appendChild(tabs);
      if (st.tab === "stock")
        filters.appendChild(el("span", "count", countLabel(rows.length, "item")));
    }

    /* What this person GIVES you, and nothing else. Quests they merely take in were in here
       too, which meant a giver's list was padded with other people's errands and their map
       lit up ground that had nothing to do with them. */
    const errands = gives.map(quest => ({quest, role: "gives"}));

    const wrap = el("div");
    /* The quest list lives inside the work panel now, because it IS the map's control.
       It used to be prepended to the sheet and shown on both tabs, which is how the page
       ended up naming the same eight quests twice. */
    let ownsRoster = false;
    if (st.tab === "map") {
      if (errands.length > 1) { wrap.appendChild(questWorkPanel(errands, areas)); ownsRoster = true; }
      else wrap.appendChild(questMap(areas[0]));
      const inside = areas[0].inside || [];
      if (inside.length)
        wrap.appendChild(el("p", "note",
          `Some of it is inside ${inside.join(" and ")} — the marked entrance is the way in.`));
      // Only the maps the entrance note has not already accounted for, or a breach gets
      // named twice in two sentences that say the same thing.
      const rest = areas.slice(1).map(g => g.map.name).filter(n => !inside.includes(n));
      if (rest.length)
        wrap.appendChild(el("p", "note", "Also sends you to " + rest.join(", ") + "."));
    } else {
      if (!filters) wrap.appendChild(el("h4", "ssection", shop ? "Stock" : "Nothing for sale"));
      wrap.appendChild(table);
    }

    // An NPC who hands out work is worth as much as one who sells things, and until now the
    // link only ran the other way: a quest named its giver, but a giver named no quests.
    // They belong to the person rather than to either tab, so they sit above both.
    /* Only on the quest tab. The stock tab is what they sell, and a list of errands above it
       was the sheet answering a question the reader had just navigated away from. */
    if (errands.length && !ownsRoster && st.tab === "map")
      wrap.prepend(questRoster(errands));

    /* Their own words go with the facts about them, above the tabs — it is who they are
       rather than something under one tab or the other. Stacked below the portrait row
       rather than beside it, so a long greeting wraps across the full width. */
    let head = hero;
    if (npc.says) {
      head = el("div", "herostack");
      head.append(hero, el("p", "npcsays", npc.says));
    }

    return {
      key: "n" + npcId,
      title: npc.name,
      sub: npc.role || "NPC",
      hero: head,
      filters,
      body: wrap,
    };
  };
}

/* ---- quest sheet ---------------------------------------------------------- */

const QUEST_BY_ID = new Map((D.quests || []).map(q => [q.id, q]));

/* QuestObjective.ObjectiveType. Not guessed — settled by resolving every exported
   objective's targets against both catalogues and seeing which one reads as its own
   description. Type 0's ids give "Slay 3 Wolves" -> Hostile Wolf, Young Wolf, Timber Wolf,
   Grimclaw; type 1's give "Collect 5 Frog Legs" -> Frog Leg. All 32 resolve cleanly.
   Type 2 carries no objective rows at all and is a quest whose task is reaching someone;
   type 3 carries no targets and is an interaction, like taking weapons from a box. */
/* The names are the client's own now, from QuestHelpers: KillObjectiveType 0,
   CollectObjectiveType 1, StarterWeaponObjectiveType 3, MiningObjectiveType 4. Type 3 was
   read here as a general "interact" and is specifically the starter weapon box; type 4 did
   not exist until the mining patch and its targets are WORLD OBJECT ids, not items. */
const OBJ_SLAY = 0, OBJ_COLLECT = 1, OBJ_TALK = 2, OBJ_STARTER = 3, OBJ_MINE = 4;

/* The starter objective carries no targets, because the thing it means is fixed:
   QuestHelpers.StarterWeaponBoxWorldObjectId = 2. That used to be inferred here - "the only
   quest prop, if it has exactly one spawn and it is within 60 units of the giver" - which
   was a good guess in the absence of the constant and is simply the constant now. */
const STARTER_BOX_OBJECT = 2;

const OBJ_KINDS = {
  [OBJ_SLAY]: {label: "Slay", cls: "objslay"},
  [OBJ_COLLECT]: {label: "Collect", cls: "objcollect"},
  [OBJ_TALK]: {label: "Talk to", cls: "objtalk"},
  [OBJ_STARTER]: {label: "Interact", cls: "objuse"},
  [OBJ_MINE]: {label: "Mine", cls: "objmine"},
};

/** Quests that hand out a given item, which is what makes an item's origin complete. */
const QUEST_REWARDS = new Map();
for (const q of D.quests || [])
  for (const id of q.rewards) {
    const list = QUEST_REWARDS.get(id);
    if (list) list.push(q); else QUEST_REWARDS.set(id, [q]);
  }

/** Quests that ask for a given item, so a material can say what wants it. */
const QUEST_WANTS = new Map();
for (const q of D.quests || [])
  for (const o of q.obj)
    if (o.type === OBJ_COLLECT)
      for (const id of o.targets) {
        const list = QUEST_WANTS.get(id);
        if (list) list.push(q); else QUEST_WANTS.set(id, [q]);
      }

const QUESTS_BY_GIVER = new Map(), QUESTS_BY_TURNIN = new Map();
for (const q of D.quests || []) {
  for (const [map, key] of [[QUESTS_BY_GIVER, q.from], [QUESTS_BY_TURNIN, q.to]]) {
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(q); else map.set(key, [q]);
  }
}

/* Chains, from quest_required. Each quest names at most one prerequisite, so the quests
   form a tree — and in this game a single one: "Answering the Call" is the only quest
   without a prerequisite, and all 39 hang off it, 33 deep, branching in exactly three
   places and ending in five leaves.
   That shape rules out "step 3 of 39": 39 is the size of the tree, not the length of any
   route through it. What can be said is how far in a quest sits, which is the length of
   the one path leading to it, and what it opens up next. */
const QUEST_NEXT = new Map();
for (const q of D.quests || [])
  if (q.needs) {
    const list = QUEST_NEXT.get(q.needs);
    if (list) list.push(q); else QUEST_NEXT.set(q.needs, [q]);
  }

/** Every quest that must be finished first, oldest first, ending with this one. */
const PATH_TO = new Map();
function pathTo(q) {
  const found = PATH_TO.get(q.id);
  if (found) return found;
  const path = [];
  const guard = new Set();
  for (let step = q; step && !guard.has(step.id); step = QUEST_BY_ID.get(step.needs)) {
    guard.add(step.id);                    // a cycle would otherwise never terminate
    path.unshift(step);
  }
  PATH_TO.set(q.id, path);
  return path;
}

/** How far into the storyline a quest sits: 1 is the very first. */
const questDepth = q => pathTo(q).length;

/** The deepest route anywhere, so a step can be given a scale. */
const QUEST_MAX_DEPTH = (D.quests || []).reduce((n, q) => Math.max(n, questDepth(q)), 0);

const opensBranch = q => (QUEST_NEXT.get(q.id) || []).length > 1;
const endsBranch = q => !QUEST_NEXT.has(q.id);

/** Map display name from its id, so a position can be said in words. */
const MAP_BY_ID = new Map((D.maps || []).map(m => [m.id, m]));
const mapName = id => (MAP_BY_ID.get(id) || {}).name || "the world";

const countLabel = (n, word) => n + " " + word + (n === 1 ? "" : "s");

/** Where a monster has been seen, across every map. Answers "where do I go for this".
    Filter with `here()` so unreachable points are left out unless staging asks for them. */
const SPAWNS_BY_ENEMY = new Map();
for (const [mapId, list] of Object.entries(D.spawns || {}))
  for (const [code, id, x, z, unreachable] of list) {
    if (code !== 0) continue;
    const at = SPAWNS_BY_ENEMY.get(id) || [];
    at.push({map: mapId, x, z, out: !!unreachable});
    SPAWNS_BY_ENEMY.set(id, at);
  }

/* ---- gathering nodes, and what they have to do with quests ------------------
   WorldObject.LootTableName names a real loot table, and that table's items are exactly
   what a collect objective asks for, so "Collect 4 Amber Sap Samples" resolves to the Amber
   Sap node and its four spots on the map with nothing guessed on the way. This is the join
   that turns "find four of these somewhere" into a place to walk to. */

const OBJECT_BY_ID = new Map(Object.entries(D.objects || {}).map(([id, o]) => [Number(id), o]));

/* The gathering skills, for the node sheets. Named apart from the map page's own copy
   because both files are loaded together and a bare SKILL_BY_ID would collide. */
const SKILL_BY_ID_APP = new Map((D.skills || []).map(s => [s.id, s]));

/** Seconds as a span a reader thinks in: 600 is ten minutes, not six hundred seconds. */
function fmtDuration(secs) {
  if (!secs) return "—";
  if (secs < 60) return secs + "s";
  const m = Math.round(secs / 60);
  return m < 60 ? m + " min" : (Math.round(secs / 360) / 10) + " h";
}

const GATHER_BY_ITEM = new Map();
for (const [id, o] of OBJECT_BY_ID)
  for (const item of o.items || []) {
    const list = GATHER_BY_ITEM.get(item);
    if (list) list.push({id, ...o}); else GATHER_BY_ITEM.set(item, [{id, ...o}]);
  }

/** Where a world object has been seen, across every map. */
const SPAWNS_BY_OBJECT = new Map();
for (const [mapId, list] of Object.entries(D.spawns || {}))
  for (const [code, id, x, z, unreachable] of list) {
    if (code !== 1) continue;
    const at = SPAWNS_BY_OBJECT.get(id) || [];
    at.push({map: mapId, x, z, out: !!unreachable});
    SPAWNS_BY_OBJECT.set(id, at);
  }

/** Objects that are not gathering nodes: no loot table, so they are one-off quest props. */
const QUEST_PROPS = [...OBJECT_BY_ID].filter(([, o]) => !o.node && o.items.length === 0)
                                     .map(([id, o]) => ({id, ...o}));

/**
 * The prop an "interact" objective means.
 *
 * Nothing in the data says so outright: the objective carries no target ids, Quest's
 * PickupItemName is empty on all 39, and QuestObjective has no world-object field. What can
 * be checked is that there is exactly one object in the game that is not a gathering node —
 * the Weapon Box, no loot table, one single spawn in the whole world — and that it stands
 * 10 units from the giver of the one quest that asks you to interact with something.
 *
 * So this returns a match only when it is unambiguous: one prop, one spawn, and close to
 * the person handing out the quest. Anything less and it says nothing, because a plausible
 * label on a map is worse than a blank one.
 */
const PROP_NEAR_GIVER = 60;          // world units; the camp, not the county

function questProp(q) {
  if (QUEST_PROPS.length !== 1) return null;
  const prop = QUEST_PROPS[0];
  const at = here(SPAWNS_BY_OBJECT.get(prop.id));
  if (at.length !== 1) return null;

  const giver = NPC_BY_ID.get(q.from);
  if (!giver || !giver.at || giver.at.map !== at[0].map) return null;
  const d = Math.hypot(giver.at.x - at[0].x, giver.at.z - at[0].z);
  if (d > PROP_NEAR_GIVER) return null;
  return {...prop, at: at[0], distance: d};
}

/** "12 spots in the Overworld", or the two areas it straddles. */
function whereSeen(list) {
  if (!list || !list.length) return null;
  const byMap = new Map();
  for (const p of list) byMap.set(p.map, (byMap.get(p.map) || 0) + 1);
  return [...byMap].map(([id, n]) => `${n} spot${n === 1 ? "" : "s"} in ${mapName(id)}`)
                   .join(", ");
}

/**
 * Everywhere one person's work sends you, on a single map.
 *
 * A giver with seven quests would otherwise be seven maps of the same valley, six of them
 * repeating the same wolves. Merged and de-duplicated instead, so it answers the question
 * the sheet is actually asked - "what is there to do around this person" - in one picture.
 */
function questPlacesMerged(quests) {
  const byMap = new Map();
  const seen = new Map();
  const inside = new Set();
  for (const q of quests)
    for (const g of questPlaces(q)) {
      for (const n of g.inside || []) inside.add(n);
      const dest = byMap.get(g.map.id) || {map: g.map, marks: []};
      for (const m of g.marks) {
        /* Several quests routinely point at the same creatures, so one dot is one place -
           but it has to remember every quest that wanted it, or filtering to one quest
           would hide the wolves it shares with the next. */
        const key = `${g.map.id}|${m.kind}|${m.name}|${m.x}|${m.z}`;
        const had = seen.get(key);
        if (had) { had.quests.add(q.id); continue; }
        const mark = {...m, quests: new Set([q.id])};
        seen.set(key, mark);
        dest.marks.push(mark);
      }
      byMap.set(g.map.id, dest);
    }
  const out = [...byMap.values()];
  out.forEach(g => { g.inside = [...inside]; });
  return out.sort((a, b) => b.marks.length - a.marks.length);
}

/**
 * One person's work: which quest, on the map, with the rest kept as context.
 *
 * The merged map alone was 390 dots with nothing to separate them - honest about where the
 * work is and useless for deciding what to do next. So the quests become a filter over it.
 * Choosing one lights its own places and dims the others rather than hiding them, because
 * "these six wolves, in the middle of that whole field" is the useful shape of the answer.
 */
function questWorkPanel(entries, areas) {
  const group = areas[0];
  const wrap = el("div", "qwork");
  const map = questMap(group);
  const box = map.querySelector(".qmap");
  const tally = el("div", "qtally");
  let active = null;

  /* What you would be looking for, named and counted. The legend it replaced only ever
     managed "kill or loot", which is a category rather than an answer. */
  const paintTally = id => {
    const seen = new Map();
    for (const m of group.marks) {
      if (m.kind === "giver" || m.kind === "turnin") continue;
      if (id != null && !m.quests.has(id)) continue;
      seen.set(m.name, (seen.get(m.name) || 0) + 1);
    }
    const list = [...seen].sort((a, b) => b[1] - a[1]);
    tally.replaceChildren();
    for (const [name, n] of list.slice(0, 6)) {
      const kind = group.marks.find(m => m.name === name).kind;
      const chip = el("span", "qtarget");
      chip.append(el("i", "qmk qmk-" + kind), el("span", null, name), el("b", null, String(n)));
      tally.appendChild(chip);
    }
    if (list.length > 6)
      tally.appendChild(el("span", "qtarget more", `+${list.length - 6} more`));
    if (!list.length)
      tally.appendChild(el("span", "qtarget more",
        id == null ? "Nothing to hunt down" : "Just the people — nothing to fight or gather"));
  };

  const show = id => { box.focusQuest(id); paintTally(id); };

  const roster = questRoster(entries, {
    // Clicking the row you already picked clears it, so "show me everything again" is the
    // same gesture as choosing - no extra control for the empty state.
    onSelect: id => {
      active = (active === id ? null : id);
      roster.markSelected(active);
      show(active);
    },
    // Hover previews without committing, so a list of eight reads by sweeping it.
    onPreview: id => show(id ?? active),
  });

  /* List first. You arrive at this sheet wanting to know what work the person has, and the
     map is the answer to whichever one you pick - so the question goes above the answer. */
  wrap.append(roster, map, tally);
  show(null);
  return wrap;
}

/** A labelled row of quest chips, used by the NPC and item sheets alike. */
function questChips(quests, heading) {
  const box = el("div");
  box.appendChild(el("h4", "ssection", heading));
  const list = el("div", "objtargets");
  for (const q of quests) {
    const chip = el("span", "chip", q.name + (q.lvl ? " · level " + q.lvl : ""));
    chip.onclick = () => pushSheet(questSheet(q.id));
    list.appendChild(chip);
  }
  box.appendChild(list);
  return box;
}

/**
 * The quests an NPC is part of, as a list rather than a heap of pills.
 *
 * Two headings each followed by a wrapped row of chips was three lines of chrome around four
 * quest names, and it never said which way round the errand ran without reading the heading
 * above it. A row per quest carries its own direction, and puts the level and the reward
 * where they can be compared down the column.
 */
/**
 * One person's quests.
 *
 * With `opts.onSelect` the rows also drive a map, and then they are the ONLY list - there
 * was a version of this with a strip of filter chips above the map and this list below it,
 * naming the same eight quests twice and doing something different with each. A row selects;
 * the chevron on it opens. One list, two verbs, neither hidden.
 */
function questRoster(entries, opts) {
  const {onSelect, onPreview} = opts || {};
  const mixed = new Set(entries.map(e => e.role)).size > 1;
  const box = el("div");
  const head = el("h4", "ssection");
  head.append(el("span", null, countLabel(entries.length, "quest")));
  if (onSelect) head.appendChild(el("span", "sshint", "Pick one to find it on the map"));
  box.appendChild(head);

  const list = el("div", "qlist");
  const rows = [];
  // Story order, so a chain of errands from one person reads the way it is played.
  for (const {quest, role} of entries.slice().sort((a, b) =>
      questDepth(a.quest) - questDepth(b.quest) || a.quest.name.localeCompare(b.quest.name))) {
    const row = el(onSelect ? "div" : "button", "qrow" + (onSelect ? " pick" : ""));
    if (!onSelect) row.type = "button";
    row.dataset.quest = quest.id;
    // The badge only earns its place when the list actually holds both kinds.
    if (mixed)
      row.appendChild(el("span", "qrole " + (role === "gives" ? "give" : "take"),
                         role === "gives" ? "Gives" : "Turn in"));
    row.appendChild(el("span", "qname", quest.name));
    if (quest.lvl) row.appendChild(el("span", "qlvl", "L" + quest.lvl));
    row.appendChild(quest.xp ? el("span", "qxp", fmtNum(quest.xp) + " xp")
                             : el("span", "qxp nil", "·"));

    if (onSelect) {
      row.tabIndex = 0;
      row.title = (role === "gives" ? "Picked up here" : "Handed in here")
                + " — click to see it on the map";
      const open = el("button", "qopen", "›");
      open.type = "button";
      open.title = "Open " + quest.name;
      open.onclick = e => { e.stopPropagation(); pushSheet(questSheet(quest.id)); };
      row.appendChild(open);
      row.onclick = () => onSelect(quest.id);
      row.onkeydown = e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(quest.id); }
      };
      row.onmouseenter = () => onPreview && onPreview(quest.id);
      row.onmouseleave = () => onPreview && onPreview(null);
    } else {
      row.title = (role === "gives" ? "Picked up here" : "Handed in here") + " — open the quest";
      row.onclick = () => pushSheet(questSheet(quest.id));
    }
    rows.push(row);
    list.appendChild(row);
  }
  box.appendChild(list);
  box.markSelected = id => rows.forEach(r =>
    r.classList.toggle("on", String(r.dataset.quest) === String(id ?? "")));
  return box;
}

/** One person in a quest: portrait, name, role and where they stand. */
function personCard(npcId, name, label) {
  const npc = NPC_BY_ID.get(npcId);
  const card = el("div", "person");
  /* 52px and round, framed on the head and shoulders. icon() writes the size inline, so
     this is the only place it can be set - a stylesheet cannot reach past it. */
  card.appendChild(icon("npcs", npcId, !!(npc && npc.icon), 52));
  const text = el("div", "persontext");
  text.appendChild(el("span", "personrole", label));
  text.appendChild(el("b", null, (npc && npc.name) || name || "Unknown"));
  const at = npc && npc.at;
  text.appendChild(el("span", "personwhere", at
    ? `${mapName(at.map)} · ${Math.round(at.x)}, ${Math.round(at.z)}`
    : "location unknown"));
  card.appendChild(text);
  if (npc) {
    card.tabIndex = 0;
    card.classList.add("clickable");
    card.onclick = () => pushSheet(npcSheet(npcId));
  }
  return card;
}

/** What one objective actually asks of you, with its targets resolved and located. */
/* ---- the quest map -------------------------------------------------------
   Where a quest actually sends you. The pieces were all already here - the giver's
   position, the spawn points of whatever it wants killed, the veins it wants mined - but
   only ever one source at a time, so a quest was a list of names and no route.

   Objective types are the client's own (QuestHelpers): 0 kill, 1 collect, 3 starter weapon,
   4 mine. Their targets are NOT the same kind of id, which is the whole difficulty - a kill
   objective names enemies, a mining objective names world objects, and a collect objective
   names an ITEM, which has to be resolved back to whatever drops or grows it. */
/* Which portal leads into each instanced map. The breaches are not walkable ground - you
   reach them through a rift entrance on the overworld - so a quest whose target lives inside
   one has to point at the door, not at a map the reader cannot travel to. */
const PORTAL_TO = new Map();
for (const [fromMap, list] of Object.entries(D.portals || {}))
  for (const p of list || []) if (p.mapId) PORTAL_TO.set(p.mapId, {...p, fromMap});

/** Every place a quest points at, grouped by map, the one you start from first. */
function questPlaces(q) {
  const byMap = new Map();
  const add = (map, kind, name, x, z) => {
    if (!map) return;
    const g = byMap.get(map.id) || {map, marks: []};
    g.marks.push({kind, name, x, z});
    byMap.set(map.id, g);
  };
  const mapById = id => (D.maps || []).find(m => m.id === id);

  const person = (npcId, kind) => {
    const n = NPC_BY_ID.get(npcId);
    if (n && n.at) add(mapById(n.at.map), kind, n.name, n.at.x, n.at.z);
  };
  person(q.from, "giver");
  // Only when it is somebody else: a "?" over the head you just took it from says nothing.
  if (q.to && q.to !== q.from) person(q.to, "turnin");

  const spread = (type, id, kind, name) => {
    for (const {map, points} of spawnsFor(type, id))
      for (const [x, z] of points) add(map, kind, name, x, z);
  };

  for (const o of q.obj || []) {
    if (o.type === OBJ_SLAY)
      for (const id of o.targets || [])
        spread(SPAWN_ENEMY, id, "kill", (MONSTER_BY_ID_Q.get(id) || {}).name || "Enemy " + id);
    else if (o.type === OBJ_STARTER)
      // No targets: the box is a fixed world object, so it is named rather than looked up.
      spread(SPAWN_OBJECT, STARTER_BOX_OBJECT, "gather",
             (OBJECT_BY_ID.get(STARTER_BOX_OBJECT) || {}).name || "Weapon box");
    else if (o.type === OBJ_MINE)
      for (const id of o.targets || [])
        spread(SPAWN_OBJECT, id, "gather", (OBJECT_BY_ID.get(id) || {}).name || "Object " + id);
    else if (o.type === OBJ_COLLECT)
      // An item, so follow it back to its sources - a pelt comes off a wolf, a wood pile
      // out of the ground, and the two want different colours on the map.
      for (const id of o.targets || []) {
        for (const e of sourcesOf(id))
          if (!e.src.node) spread(SPAWN_ENEMY, e.src.id, "kill", e.src.name);
        for (const node of GATHER_BY_ITEM.get(id) || [])
          spread(SPAWN_OBJECT, node.id, "gather", node.name);
      }
  }
  /* Anything inside a breach is unreachable on foot, so the door goes on the map you are
     actually standing on. Without this, "Slay Embermaw in the Embermaw Caverns" drew a
     dungeon the reader has no way to walk to and left the entrance off entirely. */
  const inside = [];
  for (const g of byMap.values()) {
    const door = PORTAL_TO.get(g.map.id);
    if (!door) continue;
    inside.push(g.map.name);
    add(mapById(door.fromMap), "portal", door.name + " entrance", door.x, door.z);
  }

  /* The map you START on leads, not the one with the most dots. A boss quest has one mark
     where the giver stands and ninety inside the dungeon, and sorting by count put the
     reader in a place they cannot reach without first being told how. */
  const startMap = (NPC_BY_ID.get(q.from) || {}).at;
  const out = [...byMap.values()];
  out.forEach(g => { g.inside = inside; });
  return out.sort((a, b) =>
    (b.map.id === (startMap || {}).map) - (a.map.id === (startMap || {}).map)
    || b.marks.length - a.marks.length);
}

/* A quest's own marker. The two people are WoW's punctuation because that is the one
   convention every reader of a quest map already has; the things you go and do are plain
   discs, since there can be ninety of them and ninety glyphs would be a texture, not a map. */
const QUEST_MARK = {
  giver:  {glyph: "!", label: "Quest giver"},
  turnin: {glyph: "?", label: "Turn in"},
  portal: {glyph: "",  label: "Enter here"},
  kill:   {glyph: "",  label: "Kill or loot"},
  gather: {glyph: "",  label: "Gather"},
};

/**
 * A quest's places drawn on the area's own art.
 *
 * Deliberately not spawnMap: that one zooms, pans and carries a locator inset for studying a
 * single creature's spawns. This is a glance - fit everything, draw it, stop - and it has to
 * survive being built inside a hover tooltip that may be thrown away a moment later.
 */
function questMap(group, opts) {
  const {map, marks} = group;
  const compact = !!(opts && opts.compact);
  const pixels = marks.map(m => worldToPixel(map, m.x, m.z));

  const perUnit = Math.hypot(map.pz[0], map.pz[1]) || 1;
  const margin = 40 * perUnit;
  let lox = Math.min(...pixels.map(p => p[0])) - margin;
  let hix = Math.max(...pixels.map(p => p[0])) + margin;
  let loy = Math.min(...pixels.map(p => p[1])) - margin;
  let hiy = Math.max(...pixels.map(p => p[1])) + margin;

  // One shape for every quest, so two maps side by side are comparable, and never so tight
  // that a giver and a turn-in in the same hut fill the frame.
  const ASPECT = compact ? 1.5 : 1.7;
  let w = Math.max(hix - lox, 160 * perUnit);
  let h = Math.max(hiy - loy, (160 * perUnit) / ASPECT);
  if (w / h < ASPECT) w = h * ASPECT; else h = w / ASPECT;
  w = Math.min(w, map.w); h = Math.min(h, map.h);
  const x = clamp((lox + hix) / 2 - w / 2, 0, map.w - w);
  const y = clamp((loy + hiy) / 2 - h / 2, 0, map.h - h);

  const box = el("div", "qmap" + (compact ? " compact" : "") + (map.img ? "" : " schematic"));
  box.style.aspectRatio = (w / h).toFixed(4);
  if (map.img) {
    /* background-position in percent does NOT offset the image - it aligns the image's P%
       point with the container's P% point, so the divisor is the LEEWAY (how much bigger
       the scaled image is than the box), not the window. Dividing by the window instead
       slid every map to the wrong ground. pct() is the same helper spawnMap uses. */
    paintMapBg(box, map,
      `${(map.w / w) * 100}% ${(map.h / h) * 100}%`,
      `${pct(x, map.w - w)} ${pct(y, map.h - h)}`);
  }

  /* ---- the objectives, on a canvas ----------------------------------------
     A person's whole map is 633 marks for a busy warden - 593 of them wolf spawns - and as
     633 absolutely positioned elements that is 85% of the dialog's nodes, each one laid
     out, styled and painted over a 4096x3072 photograph every time anything in the sheet
     moves. The marks are 9px flat discs; nothing about them needs an element.

     So the small ones are drawn, and the few that are not small stay as elements: a giver,
     a turn-in and a portal carry gradients, a glyph and a shadow, there are never more than
     a handful, and they are the marks the eye is looking for. Fidelity where it is seen,
     one node where it is not.                                                            */
  const DOT_KINDS = new Set(["kill", "gather"]);
  const DOT_STYLE = {
    kill:   {fill: "#c0392b", r: compact ? 3.5 : 4.5},
    gather: {fill: "#3f9c5a", r: compact ? 3.5 : 4.5},
  };
  /* The CSS dims what is not lit with opacity .16 and saturate(.35); a canvas has to do
     both itself, so the desaturation is worked out here rather than approximated. */
  const desaturate = (hex, s) => {
    const n = parseInt(hex.slice(1), 16);
    const R = (n >> 16) & 255, G = (n >> 8) & 255, B = n & 255;
    const m = (a, b, c) => Math.max(0, Math.min(255, Math.round(a * R + b * G + c * B)));
    return `rgb(${m(.213 + .787 * s, .715 - .715 * s, .072 - .072 * s)},`
         + `${m(.213 - .213 * s, .715 + .285 * s, .072 - .072 * s)},`
         + `${m(.213 - .213 * s, .715 - .715 * s, .072 + .928 * s)})`;
  };

  const order = {kill: 0, gather: 1, portal: 2, turnin: 3, giver: 4};
  const placed = marks.map((m, i) => ({m, p: pixels[i]}))
                      .sort((a, b) => order[a.m.kind] - order[b.m.kind]);

  // Where each drawn mark sits, as a fraction of the box, so a resize needs no recompute.
  const dots = placed.filter(({m}) => DOT_KINDS.has(m.kind)).map(({m, p}) => ({
    fx: (p[0] - x) / w, fy: (p[1] - y) / h, kind: m.kind, name: m.name,
    quests: m.quests ? [...m.quests].map(String) : [],
  }));

  const canvas = el("canvas", "qmkdots");
  box.appendChild(canvas);
  let focusId = null;

  function drawDots() {
    const bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    // The backing store carries the page zoom as well as the device ratio, or the discs are
    // drawn at 1/zoom of the resolution they are shown at - the same correction the
    // optimizer's strip makes for the same reason.
    const dpr = Math.min(4, (window.devicePixelRatio || 1) * (pageZoom() || 1));
    if (canvas.width !== Math.round(bw * dpr) || canvas.height !== Math.round(bh * dpr)) {
      canvas.width = Math.round(bw * dpr);
      canvas.height = Math.round(bh * dpr);
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, bw, bh);
    g.lineWidth = 1;
    for (const d of dots) {
      const lit = focusId == null || d.quests.includes(String(focusId));
      const st = DOT_STYLE[d.kind];
      g.globalAlpha = lit ? 1 : .16;
      g.fillStyle = lit ? st.fill : desaturate(st.fill, .35);
      g.strokeStyle = "rgba(0,0,0,.55)";
      g.beginPath();
      g.arc(d.fx * bw, d.fy * bh, st.r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /* A drawn disc has no title of its own, so the canvas carries whichever one the pointer
     is over. Nearest within its own radius, so a cloud of spawns still names the one being
     pointed at rather than the first in the list. */
  canvas.addEventListener("pointermove", e => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    let best = null, bestD = Infinity;
    for (const d of dots) {
      const dx = (d.fx - px) * r.width, dy = (d.fy - py) * r.height;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    const reach = (DOT_STYLE.kill.r + 2) ** 2;
    canvas.title = (best && bestD <= reach)
      ? `${best.name} — ${QUEST_MARK[best.kind].label}` : "";
  });

  // The people and the portals, which are few and are worth their elements.
  for (const {m, p} of placed) {
    if (DOT_KINDS.has(m.kind)) continue;
    const dot = el("span", "qmk qmk-" + m.kind, QUEST_MARK[m.kind].glyph || "");
    dot.style.left = (((p[0] - x) / w) * 100).toFixed(3) + "%";
    dot.style.top = (((p[1] - y) / h) * 100).toFixed(3) + "%";
    dot.title = `${m.name} — ${QUEST_MARK[m.kind].label}`;
    if (m.quests) dot.dataset.q = [...m.quests].join(" ");
    dot.dataset.target = m.name;
    box.appendChild(dot);
  }

  /* Focusing dims rather than removes: a quest's own places mean more when you can still
     see the rest of the person's work behind them. */
  box.focusQuest = id => {
    focusId = id;
    box.classList.toggle("focused", id != null);
    for (const dot of box.querySelectorAll(".qmk"))
      dot.classList.toggle("lit", id == null
        || (dot.dataset.q || "").split(" ").includes(String(id)));
    drawDots();
  };

  /* The box is sized by its aspect ratio against whatever width it is given, so its pixel
     size is not known until it is laid out - and changes with the dialog. */
  /* Drawn once now for anything already on screen, again when the sheet is shown - see
     paintSheet - and again whenever the box is resized. */
  box.redraw = drawDots;
  drawDots();
  if (window.ResizeObserver) new ResizeObserver(() => drawDots()).observe(box);

  const wrap = el("div", "qmapwrap");
  wrap.appendChild(box);
  if (!compact) {
    const legend = el("div", "qmaplegend");
    const seen = new Set(marks.map(m => m.kind));
    for (const k of ["giver", "turnin", "portal", "kill", "gather"]) {
      if (!seen.has(k)) continue;
      const n = marks.filter(m => m.kind === k).length;
      const item = el("span", "qmleg");
      item.append(el("i", "qmk qmk-" + k, QUEST_MARK[k].glyph || ""),
                  el("span", null, QUEST_MARK[k].label + (n > 1 ? ` (${n})` : "")));
      legend.appendChild(item);
    }
    legend.appendChild(el("span", "qmapname", map.name));
    wrap.appendChild(legend);
  }
  return wrap;
}

function objectiveBlock(o, index, quest) {
  const kind = OBJ_KINDS[o.type] || {label: "Objective", cls: ""};
  const block = el("div", "objblock");

  const head = el("div", "objrow");
  head.appendChild(el("span", "objstep", String(index + 1)));
  head.appendChild(el("span", "objwhat", o.desc || kind.label));
  head.appendChild(el("span", "objkind " + kind.cls, kind.label));
  if (o.need > 1) head.appendChild(el("span", "count", "×" + o.need));
  block.appendChild(head);

  const targets = el("div", "objtargets");
  for (const id of o.targets) {
    if (o.type === OBJ_SLAY) {
      const monster = MONSTER_BY_ID_Q.get(id);
      if (!monster) continue;
      const src = DROP.sources.find(s => !s.node && s.id === id);
      const seen = whereSeen(here(SPAWNS_BY_ENEMY.get(id)));
      const chip = el("span", "chip targetchip");
      chip.append(icon("monsters", id, !!monster.icon, 22),
                  el("span", null, monster.name),
                  el("i", null, "L" + monster.lvl));
      chip.title = seen ? monster.name + " — " + seen : monster.name;
      if (src) chip.onclick = () => pushSheet(monsterSheet(src));
      targets.appendChild(chip);
    } else if (o.type === OBJ_COLLECT) {
      const item = ITEM_BY_ID.get(id);
      if (!item) continue;
      // Where it comes from matters more than the item itself here: the objective is
      // really "kill whatever drops this", and the drop list is the only thing that says
      // what that is.
      const from = sourcesOf(id);
      const chip = el("span", "chip targetchip");
      chip.append(icon("items", id, !!item.icon, 22), el("span", null, item.name));
      chip.title = from.length
        ? "From " + from.slice(0, 4).map(e => e.src.name).join(", ")
          + (from.length > 4 ? ` and ${from.length - 4} more` : "")
        : "No source recorded";
      chip.onclick = () => pushSheet(itemSheet(id));
      targets.appendChild(chip);
    }
  }
  if (targets.children.length) block.appendChild(targets);

  /* An interact objective carries no target ids at all, so the thing it means has to be
     worked out. Shown as a likelihood rather than a fact — see questProp. */
  if (o.type === OBJ_STARTER && quest) {
    const prop = questProp(quest);
    if (prop)
      block.appendChild(objectLine(prop.id,
        `${mapName(prop.at.map)} · ${Math.round(prop.at.x)}, ${Math.round(prop.at.z)}`
        + ` — ${Math.round(prop.distance)} units from ${quest.fromName || "the giver"}`));
  }

  // For a collect objective, naming where it comes from is the actual answer to "where do
  // I go". Gathered and killed for are different errands, so they are two separate lines:
  // a node is a fixed place you walk to, a monster is something you hunt.
  if (o.type === OBJ_COLLECT) {
    const nodes = new Map(), droppers = new Map();
    for (const id of o.targets) {
      for (const g of GATHER_BY_ITEM.get(id) || []) nodes.set(g.id, g);
      for (const e of sourcesOf(id)) if (!e.src.node) droppers.set(e.src.id, e.src);
    }

    for (const g of nodes.values()) block.appendChild(gatherLine(g));

    if (droppers.size) {
      const line = el("div", "objfrom");
      line.appendChild(el("span", "objfromlabel", "Dropped by"));
      for (const src of [...droppers.values()].slice(0, 8)) {
        const chip = el("span", "chip", src.name);
        chip.onclick = () => pushSheet(monsterSheet(src));
        line.appendChild(chip);
      }
      block.appendChild(line);
    }
  }
  return block;
}

/**
 * A world object on an objective: its art, one line about it, and a way to its map.
 *
 * Shared by both kinds of objective that name one — a gathering node to collect from and
 * the prop an interact objective means — so neither can end up looking clickable without
 * being it, or the reverse.
 */
function objectLine(id, subtitle) {
  const o = OBJECT_BY_ID.get(id) || {};
  const line = el("div", "gatherline clickable");
  line.tabIndex = 0;
  line.appendChild(icon("objects", id, !!o.icon, 34));
  const text = el("div", "gathertext");
  text.appendChild(el("b", null, o.name || "Object " + id));
  text.appendChild(el("span", "gatherwhere", subtitle));
  line.appendChild(text);

  // Opens the map, not a loot table. A node's table is one item at 100% — the question
  // being asked when you click one of these is where it is.
  const open = () => pushSheet(gatherSheet(id));
  line.onclick = open;
  line.onkeydown = e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  };
  return line;
}

/** A gathering node, described by every place it has been seen standing. */
function gatherLine(g) {
  const at = here(SPAWNS_BY_OBJECT.get(g.id));
  return objectLine(g.id, at.length ? whereSeen(at) : "location unknown");
}

/* Gathering-node loot tables, keyed by name. A node's loot table is named after the object
   itself, which is the same string the world-object catalogue carries. */
const NODE_SOURCE_BY_NAME = new Map(DROP.sources.filter(s => s.node).map(s => [s.name, s]));

/* The other direction: a loot-table source name back to the world object it belongs to, so
   every route into a gathering node — the quest sheet, the map marker, an item's source
   list — lands on the same place rather than two different sheets for the same thing. */
const OBJECT_ID_BY_NAME = new Map([...OBJECT_BY_ID].map(([id, o]) => [o.name, id]));

/** The sheet a gathering node should open, wherever it was clicked from. */
function nodeSheetFor(name) {
  const id = OBJECT_ID_BY_NAME.get(name);
  return id === undefined ? null : gatherSheet(id);
}

/**
 * A gathering node: where it stands, and nothing else.
 *
 * It used to open the loot-table sheet a monster gets, which for a node is one row at 100%
 * — the table restates the node's own name and answers a question nobody asked. What you
 * want from a thing you have to walk to is the walk.
 */
function gatherSheet(objectId) {
  return () => {
    const o = asOf("objects", OBJECT_BY_ID.get(objectId)
                              || {name: "Object " + objectId, items: []});
    const areas = spawnsFor(SPAWN_OBJECT, objectId);

    const body = el("div");
    if (areas.length) {
      for (const entry of areas) body.appendChild(spawnMap(entry));
    } else {
      body.appendChild(el("p", "note", "No known location."));
    }

    const hero = el("div", "hero");
    hero.appendChild(icon("objects", objectId, !!o.icon, 78));
    const facts = el("div", "herofacts");
    const total = areas.reduce((n, a) => n + a.points.length, 0);
    facts.appendChild(statChip("Spots seen", String(total)));

    // What it takes to work it, and what it gives back. The skill line comes from the
    // catalogue; everything under it was measured, so it carries its sample size.
    const skill = o.skill ? (SKILL_BY_ID_APP.get(o.skill) || {name: "Mining"}) : null;
    const meas = (D.mining && D.mining.nodes) ? D.mining.nodes[objectId] : null;
    if (skill) {
      facts.appendChild(statChip(skill.name, o.req ? "Level " + fmtNum(o.req) : "Any level"));
      if (o.dur) facts.appendChild(statChip("Gather", o.dur + "s"));
      const xp = D.mining && D.mining.xp;
      if (xp && xp.each) {
        const chip = statChip("Skill XP", fmtNum(xp.each), "good");
        chip.title = `${fmtNum(xp.each)} XP per completed gather, identical across all `
                   + `${xp.n} measured gathers. ${skill.name} needs ${fmtNum(skill.per || 5)}`
                   + ` XP per level, so that is ${(xp.each / (skill.per || 5)).toFixed(1)} levels a node.`;
        facts.appendChild(chip);
      }
    }
    if (meas && meas.qty) {
      const [lo, hi, avg, n] = meas.qty;
      const chip = statChip("Ore per node", lo === hi ? String(lo) : `${lo}–${hi}`);
      chip.title = `${avg} on average over ${n} gather${n === 1 ? "" : "s"}`;
      facts.appendChild(chip);
    }
    if (o.respawn) facts.appendChild(statChip("Respawn", fmtDuration(o.respawn)));

    for (const itemId of o.items || []) {
      const it = lootItem(itemId);
      const chip = statChip("Yields", it.name, "good");
      chip.style.cursor = "pointer";
      chip.onclick = () => pushSheet(itemSheet(itemId));
      facts.appendChild(chip);
    }
    hero.appendChild(facts);

    // The one question the catalogue cannot answer: does levelling the skill make it
    // faster? Only worth printing where the samples actually span a range of levels.
    if (meas && meas.n && meas.lvl && meas.lvl[1] > meas.lvl[0]) {
      const flat = Math.abs(meas.secs - meas.listed) < 0.5;
      body.insertBefore(el("p", "note",
        `Timed at ${meas.secs}s over ${meas.n} gather${meas.n === 1 ? "" : "s"} between `
        + `${skill ? skill.name : "skill"} ${meas.lvl[0]} and ${meas.lvl[1]}, against `
        + `${meas.listed}s listed — ${flat ? "levelling the skill does not make it faster"
                                           : "which is not the listed figure"}.`),
        body.firstChild);
    }

    return {key: "g" + objectId, title: o.name,
            sub: o.node ? (skill ? skill.name + " node" : "Gathering node") : "Quest object",
            hero, filters: null, body};
  };
}

/* The monster lookup the objective blocks need. Defined here rather than reusing a page's
   own copy, because app.js is shared by pages that never build one. */
const MONSTER_BY_ID_Q = new Map((D.monsters || []).map(m => [m.id, m]));

/** One button in the storyline strip. */
function chainNode(step, current) {
  const node = el("button", "chainstep" + (step.id === current ? " on" : ""));
  node.type = "button";
  node.append(el("span", "chainn", String(questDepth(step))),
              el("span", "chainname", step.name));
  if (step.lvl) node.appendChild(el("span", "chainlvl", "L" + step.lvl));
  node.onclick = () => { if (step.id !== current) pushSheet(questSheet(step.id)); };
  return node;
}

/* The storyline around a quest: the steps immediately before it and whatever it opens up.
   Not the whole tree — it is 33 deep, and the two questions worth answering are "what do I
   need first" and "what does this lead to". */
const CHAIN_LOOKBACK = 3;

function chainStrip(q) {
  const path = pathTo(q);
  const next = QUEST_NEXT.get(q.id) || [];
  if (path.length < 2 && !next.length) return null;

  const box = el("div");
  const depth = questDepth(q);
  box.appendChild(el("h4", "ssection",
    `Storyline — step ${depth} of ${QUEST_MAX_DEPTH}`));

  const before = path.slice(Math.max(0, path.length - 1 - CHAIN_LOOKBACK), path.length - 1);
  const strip = el("div", "chain");
  if (before.length && path.length - 1 > before.length)
    strip.appendChild(el("span", "chaingap", `+${path.length - 1 - before.length} earlier`));
  for (const step of before) strip.appendChild(chainNode(step, q.id));
  strip.appendChild(chainNode(q, q.id));
  box.appendChild(strip);

  if (next.length) {
    box.appendChild(el("p", "chainlead", next.length > 1
      ? "Finishing it opens both of these:" : "Then:"));
    const after = el("div", "chain");
    for (const step of next) after.appendChild(chainNode(step, q.id));
    box.appendChild(after);
  } else {
    box.appendChild(el("p", "note", "Nothing follows this one — it ends its branch."));
  }
  return box;
}

function questSheet(questId) {
  return () => {
    const q = asOf("quests", QUEST_BY_ID.get(questId));
    if (!q) return {key: "q" + questId, title: "Quest " + questId, body: el("div")};

    const wrap = el("div");
    if (q.desc) wrap.appendChild(el("p", "flavour", q.desc));

    // Who to ask and who to return to, side by side, because that is the shape of a quest.
    const people = el("div", "people");
    people.appendChild(personCard(q.from, q.fromName, "Given by"));
    if (q.to && q.to !== q.from)
      people.appendChild(personCard(q.to, q.toName, "Turn in to"));
    else
      people.appendChild(el("div", "person hintonly", "Return to the same person."));
    wrap.appendChild(people);

    wrap.appendChild(el("h4", "ssection", q.obj.length
      ? countLabel(q.obj.length, "objective") : "Objective"));
    if (!q.obj.length) {
      // Types 2 and 3 carry no objective rows; the short description is the whole task.
      wrap.appendChild(el("p", "note", q.short || "No objectives."));
    } else {
      // Where it all is, above the list of what it is: the map answers "can I do this from
      // here" before any of the wording does.
      const places = questPlaces(q);
      if (places.length) {
        wrap.appendChild(questMap(places[0]));
        const inside = places[0].inside || [];
        if (inside.length)
          wrap.appendChild(el("p", "note",
            `What this asks for is inside ${inside.join(" and ")} — go in through the `
            + `marked entrance. The map below is the way there, not the fight.`));
        else if (places.length > 1) {
          const rest = places.slice(1).map(g => g.map.name).filter(n => !inside.includes(n));
          if (rest.length)
            wrap.appendChild(el("p", "note", "Also sends you to " + rest.join(", ") + "."));
        }
      }
      const list = el("div", "objlist");
      q.obj.forEach((o, i) => list.appendChild(objectiveBlock(o, i, q)));
      wrap.appendChild(list);
    }

    if (q.rewards.length) {
      wrap.appendChild(el("h4", "ssection",
        q.anyReward ? "Rewards — choose one" : "Rewards — all of them"));
      const rewards = el("div", "rewardgrid");
      for (const id of q.rewards) {
        const it = lootItem(id);
        const card = el("button", "rewardcard");
        card.type = "button";
        card.appendChild(framedIcon(id, it.icon, it.equip ? SCALE.quality : 1, 46));
        const text = el("div", "rewardtext");
        text.appendChild(el("b", null, it.name));
        const sub = [it.equip ? it.equip.slot : it.type,
                     it.equip && it.equip.lvl ? "level " + it.equip.lvl : ""].filter(Boolean);
        text.appendChild(el("span", "rewardsub", sub.join(" · ")));
        card.appendChild(text);
        card.onclick = () => pushSheet(itemSheet(id));
        rewards.appendChild(card);
      }
      wrap.appendChild(rewards);
      if (q.anyReward) wrap.appendChild(el("p", "note",
        "Only one of these is handed over — the others are the alternatives."));
    }

    const chain = chainStrip(q);
    if (chain) wrap.appendChild(chain);

    const hero = el("div", "hero");
    const facts = el("div", "herofacts");
    if (q.lvl) facts.appendChild(statChip("Level", String(q.lvl)));
    if (q.xp) facts.appendChild(statChip("XP", fmtNum(q.xp), "good"));
    if (q.rewards.length)
      facts.appendChild(statChip(q.anyReward ? "Choice of" : "Items",
                                 String(q.rewards.length)));
    facts.appendChild(statChip("Step", `${questDepth(q)} of ${QUEST_MAX_DEPTH}`));
    const at = (NPC_BY_ID.get(q.from) || {}).at;
    if (at) facts.appendChild(statChip("Starts in", mapName(at.map)));
    hero.appendChild(facts);

    return {key: "q" + questId, title: q.name, sub: "",
            hero, filters: null, body: wrap};
  };
}

/** The same hero block as a monster's, for an item: icon, its numbers, its flavour. */
function itemHeadline(it) {
  const box = el("div", "hero");
  const eq = it.equip;
  // Framed either way, so a material's sheet is laid out like a helmet's.
  box.appendChild(framedIcon(it.id, it.icon, eq ? SCALE.quality : 1, 78));

  const text = el("div", "herotext");
  const facts = el("div", "herofacts");
  if (eq) {
    let any = false;
    for (const s of D.stats) {
      const v = scaled(eq, s, SCALE.quality, SCALE.tier);
      if (!v) continue;
      any = true;
      facts.appendChild(statChip(cap(s), fmtNum(v), "good"));
    }
    if (!any) facts.appendChild(el("span", "muted", "No attributes."));
    if (it.sell) facts.appendChild(statChip("Sells for", fmtNum(it.sell)));
  } else {
    if (it.stack > 1) facts.appendChild(statChip("Stacks to", String(it.stack)));
    if (it.sell) facts.appendChild(statChip("Sells for", fmtNum(it.sell)));
    if (!it.stack && !it.sell) facts.appendChild(el("span", "muted", "Carries no attributes."));
  }
  text.appendChild(facts);

  if (eq) text.appendChild(el("p", "note",
    QUALITY[SCALE.quality].n
    + (SCALE.tier ? `, instability ${SCALE.tier}` : ", no instability")
    + (eq.hand ? ` · ${eq.hand}` : "")));
  if (it.desc) text.appendChild(el("p", "flavour", it.desc));
  box.appendChild(text);
  return box;
}

/* ---- a change, opened as the thing it happened to --------------------------
   A line in the changelog is a creature, an item, a quest — not a row of numbers — so it
   opens the same sheet the rest of the site opens, with the fields the patch touched marked
   and the older build one click away.

   Those sheets read the current catalogues, which describe the newest build and no other.
   So a sheet opened from the log is the live record with the build's own snapshot laid back
   over it — either side of the step, whichever is being read — while the rest of the sheet,
   the loot and the map and the storyline, stands as it is. Only the fields the changelog
   watches can be restored, which is exactly the set it claims to know about, and the panel
   at the top of the sheet names every one of them.                                         */

/** The change being shown, for the length of one render. Cleared the moment the sheet is
    built, so a sheet pushed from inside it is an ordinary sheet again. */
const DIFF = {on: null};

/** Where each watched catalogue column lands in the site's own records, and the stat chip
    it is drawn as. A column with no `label` has no chip; it still appears in the panel. */
const DIFF_FIELDS = {
  monsters: {
    level:           {label: "Level",       prop: "lvl",        num: true},
    max_health:      {label: "Health",      prop: "hp",         num: true},
    attack_damage:   {label: "Attack",      prop: "dmg",        num: true},
    xp_reward:       {label: "XP",          prop: "xp",         num: true},
    respawn_seconds: {label: "Respawn",     prop: "respawn",    num: true,
                      fmt: v => v + "s"},
    aggro_range:     {label: "Aggro range", prop: "aggro",      num: true},
    move_speed:      {label: "Speed",       prop: "speed",      num: true},
    is_aggressive:   {label: "Aggressive",  prop: "aggressive", cast: v => v === "true",
                      fmt: v => v === "true" ? "yes" : "no"},
  },
  items: {
    item_type:         {prop: "type"},
    sub_type:          {prop: "sub"},
    slot:              {prop: "slot"},
    level_requirement: {prop: "lvl", num: true},
    sell_price:        {label: "Sells for", prop: "sell", num: true},
    // the six attributes are added below, from the stat list the build already carries
  },
  quests: {
    level_required:    {label: "Level", prop: "lvl", num: true},
    xp_reward:         {label: "XP",    prop: "xp",  num: true},
    quest_required:    {prop: "needs", num: true,
                        fmt: v => (QUEST_BY_ID.get(Number(v)) || {}).name || ""},
    pickup_npc_name:   {prop: "fromName"},
    dropoff_npc_name:  {prop: "toName"},
    reward_item_ids:   {prop: "rewards",
                        cast: v => v.split(/\s+/).filter(Boolean).map(Number),
                        fmt: v => v.split(/\s+/).filter(Boolean)
                                   .map(id => lootItem(Number(id)).name).join(", ")},
    short_description: {prop: "short"},
  },
  npcs: {
    role: {label: "Role", prop: "role"},
  },
  objects: {
    loot_table_name: {label: "Yields"},
    respawn_seconds: {label: "Respawn", fmt: v => v + "s"},
  },
};

for (const s of D.stats || [])
  DIFF_FIELDS.items[s] = {label: cap(s), prop: s, num: true};

const changeLabel = key => (D.changeLabels || {})[key] || key;

/** A watched column named for a reader, whether or not a sheet draws it. */
function diffName(cat, field) {
  const spec = (DIFF_FIELDS[cat] || {})[field];
  if (spec && spec.label) return spec.label;
  return cap(field.replace(/_/g, " ").replace(/^is /, "").replace(/ percent$/, " %"));
}

/** One of a column's values, spelled the way the sheets spell it. */
function diffText(cat, field, raw) {
  const spec = (DIFF_FIELDS[cat] || {})[field] || {};
  const v = (raw === null || raw === undefined) ? "" : String(raw);
  if (!v) return "";
  return spec.fmt ? spec.fmt(v) : v;
}

/** The change to the field a chip with this label draws, if the patch touched it. */
function diffField(label) {
  const ctx = DIFF.on;
  if (!ctx || ctx.kind !== "changed") return null;
  const spec = DIFF_FIELDS[ctx.cat] || {};
  for (const f of ctx.entry.fields || [])
    if (spec[f.field] && spec[f.field].label === label) return f;
  return null;
}

/**
 * A record as the build being shown had it.
 *
 * Both sides are rebuilt, not just the older one: the current catalogues describe the newest
 * build, and a step from two patches ago is neither of the builds it compares. Where the
 * step IS the newest, the snapshot and the live record agree and this changes nothing.
 */
function asOf(cat, rec) {
  const ctx = DIFF.on;
  if (!ctx || ctx.cat !== cat || !rec) return rec;

  const patch = ctx.old ? ctx.was : ctx.now;
  if (!patch || !Object.keys(patch).length) return rec;

  const spec = DIFF_FIELDS[cat] || {};
  const out = {...rec};
  for (const [field, raw] of Object.entries(patch)) {
    const s = spec[field];
    if (!s || !s.prop) continue;
    out[s.prop] = s.cast ? s.cast(raw) : s.num ? (Number(raw) || 0) : raw;
  }
  // An item sheet reads its attributes through `equip`, which points back at the record it
  // came from; leaving it pointing at the live one would show old and new numbers at once.
  if ("equip" in rec) out.equip = out.type === "Equipment" ? out : null;
  return out;
}

/* ---- what the patch did to this one thing --------------------------------- */

/* A table with no name column still has rows. Everything that shows one goes through here,
   so a sheet can never open with an empty title bar. */
const changeName = entry => (entry && entry.name) || "(unnamed)";

const DIFF_KINDS = {
  added:   {sign: "+", cls: "k-add", verb: "Added in"},
  removed: {sign: "−", cls: "k-del", verb: "Removed in"},
  changed: {sign: "·", cls: "k-mod", verb: "Changed in"},
};

/** The panel's rows: what moved, or — for a thing that arrived or left — what it carried. */
function diffRows(ctx) {
  const e = ctx.entry;
  if (ctx.kind === "changed") return e.fields || [];
  const snap = (ctx.kind === "added" ? e.now : e.was) || {};
  return Object.keys(snap).map(field => ctx.kind === "added"
    ? {field, from: "", to: snap[field]}
    : {field, from: snap[field], to: ""});
}

/**
 * What the patch did, at the top of the sheet.
 *
 * `full` asks for every field the diff recorded. A sheet that has the thing itself already
 * draws those numbers a line below, so there it lists only what actually moved — a creature
 * that was added does not need its health stated twice, one above the other.
 */
function diffPanel(ctx, full) {
  const kind = DIFF_KINDS[ctx.kind] || DIFF_KINDS.changed;
  const box = el("div", "dchg " + kind.cls);

  const head = el("div", "dchghead");
  head.append(el("span", "mark " + kind.cls, kind.sign),
              el("span", null, ctx.old ? "As it stood in" : kind.verb),
              el("b", null, "v" + (ctx.old ? ctx.from : ctx.version)));
  if (!ctx.old && ctx.kind !== "added")
    head.appendChild(el("span", "dchgfrom", "from v" + ctx.from));
  box.appendChild(head);

  const rows = (full || ctx.kind === "changed") ? diffRows(ctx) : [];
  if (rows.length) {
    const list = el("div", "dchgrows");
    for (const f of rows) {
      const row = el("div", "dchgrow");
      row.appendChild(el("span", "dchgf", diffName(ctx.cat, f.field)));

      const before = diffText(ctx.cat, f.field, f.from);
      const after = diffText(ctx.cat, f.field, f.to);

      if (ctx.kind === "changed") {
        // Whichever build is not on screen is the one worth clicking — going the other way
        // is what Back is for, so only one side of a row is ever a control.
        let older;
        if (ctx.old) {
          older = el("b", "dchgnew", before || "nothing");
        } else {
          older = el("button", "dchgold", before || "nothing");
          older.type = "button";
          older.title = `See ${changeName(ctx.entry)} as it was in v${ctx.from}`;
          older.onclick = () => pushSheet(changeSheetFor({...ctx, old: true}));
        }
        row.append(older, el("span", "dchgarrow", "→"),
                   el(ctx.old ? "span" : "b", ctx.old ? "dchggone" : "dchgnew",
                      after || "nothing"));
      } else {
        row.appendChild(el("b", "dchgnew", (after || before) || "nothing"));
      }
      list.appendChild(row);
    }
    box.appendChild(list);
  }

  if (ctx.kind === "removed")
    box.appendChild(el("p", "dchgnote", `It is not in v${ctx.version}.`));
  return box;
}

/* ---- routing -------------------------------------------------------------- */

/** The sheet a changed thing has on this site, or null if it has none.
 *
 * Routed on the kind the build works out from the table's own columns, not on the category's
 * name: those names come from the archived filenames, so a table renamed upstream would
 * quietly stop opening anything. A category with no kind — talents, the XP curve — has no
 * page of its own and falls back to the change itself. */
function diffRoute(cat, id) {
  if (id === null || id === undefined) return null;
  switch ((D.changeKinds || {})[cat]) {
    case "monsters": {
      const m = MONSTER_BY_ID_Q.get(id);
      const src = DROP.sources.find(s => !s.node && s.id === id);
      if (!m && !src) return null;
      // A creature with no loot table has no source row; the sheet still holds its map and
      // its numbers, which is most of what it is.
      return monsterSheet(src || {i: -1, id, name: m.name, icon: m.icon,
                                  node: false, boss: false, lvl: m.lvl});
    }
    // A price or a drop chance belongs to an item, and the item's sheet is where both are
    // read anyway — merchants above, sources below.
    case "items":
      return ITEM_BY_ID.has(id) ? itemSheet(id) : null;
    case "quests":  return QUEST_BY_ID.has(id) ? questSheet(id) : null;
    case "npcs":    return NPC_BY_ID.has(id) ? npcSheet(id) : null;
    case "objects": return OBJECT_BY_ID.has(id) ? gatherSheet(id) : null;
    default: return null;                       // no page of its own
  }
}

/** Everything the site knows about a thing, with the patch marked on it. */
function changeSheetFor(ctx) {
  const inner = diffRoute(ctx.cat, ctx.entry.id);
  if (!inner) return diffOnlySheet(ctx);

  return () => {
    DIFF.on = ctx;
    let view;
    try { view = inner(); } finally { DIFF.on = null; }

    const body = el("div");
    body.append(diffPanel(ctx), view.body);
    return {...view,
            key: "d" + ctx.version + ctx.cat + ctx.entry.id + (ctx.old ? "o" : ""),
            sub: ctx.old ? `v${ctx.from}` : view.sub,
            body};
  };
}

/** For a thing the site has no sheet for, or one the current build no longer has: the
    change itself, and nothing invented around it. */
function diffOnlySheet(ctx) {
  return () => {
    const body = el("div");
    body.appendChild(diffPanel(ctx, true));
    if (!diffRows(ctx).length)
      body.appendChild(el("p", "note", "No details were recorded for it."));
    return {key: "x" + ctx.version + ctx.cat + changeName(ctx.entry) + (ctx.old ? "o" : ""),
            title: changeName(ctx.entry), sub: changeLabel(ctx.cat),
            hero: null, filters: null, body};
  };
}

/** Opens one changelog entry. `kind` is added, removed or changed; `old` asks for the
    build before the change, which is what clicking a struck-through value means. */
function openChange(entry, cat, kind, e, old) {
  const fields = e.fields || [];
  const side = pick => Object.fromEntries(fields.map(f => [f.field, f[pick]]));
  // The snapshot covers every watched field; the moved ones are merged over it so an entry
  // written before snapshots were carried still restores what it does know.
  const was = {...(e.was || {}), ...side("from")};
  const now = {...(e.now || {}), ...side("to")};

  // Nothing preceded an addition, so there is no older build of it to show.
  const asWas = kind === "added" ? false : (old === undefined ? kind === "removed" : !!old);
  pushSheet(changeSheetFor({version: entry.version, from: entry.from,
                            cat, kind, entry: e, was, now, old: asWas}));
}

/* ---- theme switch ---------------------------------------------------------
   The <head> script has already resolved and applied a theme before first paint; this only
   has to flip it and remember the choice. Every page carries the same button, so wiring it
   here means it works everywhere without five copies. */

(function themeSwitch() {
  const btn = document.getElementById("themebtn");
  if (!btn) return;
  const label = () =>
    btn.title = document.documentElement.dataset.theme === "light"
      ? "Switch to dark" : "Switch to light";
  label();
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("elegon-theme", next); } catch (e) { /* private mode */ }
    label();
    // Anything drawn into a canvas rather than styled has to be repainted by hand.
    document.dispatchEvent(new Event("themechange"));
  };
})();


/* ---- things the planner and the optimizer both do --------------------------
 * These lived twice, once in each page, and the copies drifted. The tooltip placement is
 * the cautionary tale: the zoom correction below was written into the optimizer's copy and
 * not the planner's, so for weeks the planner put its card a whole panel away from the
 * cursor on any screen wide enough to trigger the page zoom. Nobody could see that from
 * either file alone.
 *
 * Anything both pages do to the same model belongs here.
 */

/** Where a hovering card goes, in the one frame of reference that works. */
function placeTipAt(tip, e) {
  /* clientX and getBoundingClientRect are PAINTED pixels; `left` and `top` are CSS lengths,
     which the root zoom (1.15 past 1700px, 1.35 past 2200) scales again. Writing a painted
     number into a CSS length puts the card zoom-times further from the cursor than it
     should be. So the sums are done in painted pixels, including the viewport they are
     clamped against, and divided once at the end. */
  const pad = 14, z = pageZoom(), r = tip.getBoundingClientRect();
  const vw = document.documentElement.clientWidth * z;
  const vh = document.documentElement.clientHeight * z;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > vw - 8) x = e.clientX - r.width - pad;
  if (y + r.height > vh - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) / z + "px";
  tip.style.top = Math.max(8, y) / z + "px";
}

/**
 * Show `html` (a string or a built node) in `tip` while the pointer is over `node`.
 * Returns the node, so it can be used inline.
 */
function attachTipTo(tip, node, html) {
  node.classList.add("hastip");
  const show = e => {
    // Callers pass a string or a built node; a structured tooltip builds its own rather
    // than concatenating markup.
    if (html instanceof Node) tip.replaceChildren(html.cloneNode(true));
    else tip.innerHTML = html;
    tip.hidden = false;
    placeTipAt(tip, e);
  };
  node.addEventListener("mouseenter", show);
  node.addEventListener("mousemove", e => placeTipAt(tip, e));
  node.addEventListener("mouseleave", () => { tip.hidden = true; });
  return node;
}

/* ---- attribute points ------------------------------------------------------
   One point every two levels since v3489988, two stat points each, twenty-five to a stat.
   The same numbers both pages spend, so a build carries across. */
const ATTR_KEYS = ["vitality", "fortitude", "strength", "grace", "alacrity", "tempo",
                   "accuracy"];
const attrPointsTotal = level => GAME.attributePoints(level);
const attrPointsSpent = alloc => ATTR_KEYS.reduce((t, k) => t + ((alloc || {})[k] | 0), 0);
const attrPointsLeft = (level, alloc) =>
  Math.max(0, attrPointsTotal(level) - attrPointsSpent(alloc));

/**
 * The seven +/- rows, into `host`.
 *
 * cfg: {alloc, level, step(key, by), bulk}
 *   alloc  the object being spent from
 *   step   what to call when a button is pressed; the caller owns clamping and redrawing
 *   bulk   how many a held Shift moves - the planner walks in tens because a single
 *          attribute takes twenty-five, the optimizer in fives
 */
function allocRows(host, cfg) {
  host.replaceChildren();
  const alloc = cfg.alloc || {};
  const left = attrPointsLeft(cfg.level, alloc);
  const bulk = cfg.bulk || 5;
  for (const k of ATTR_KEYS) {
    const have = alloc[k] | 0;
    const row = el("div", "allocrow");
    row.appendChild(el("span", "an", cap(k)));

    const minus = el("button", null, "−");
    minus.type = "button";
    minus.disabled = have <= 0;
    minus.title = `Remove a point — hold Shift for ${bulk}`;
    minus.onclick = e => cfg.step(k, -(e.shiftKey ? bulk : 1));

    const val = el("span", "av", String(have));
    if (have >= GAME.MAX_PER_ATTR) val.classList.add("maxed");
    val.title = `${have} point${have === 1 ? "" : "s"} = `
              + `+${have * GAME.STAT_PER_POINT} ${cap(k)}`;

    const plus = el("button", null, "+");
    plus.type = "button";
    plus.disabled = have >= GAME.MAX_PER_ATTR || left <= 0;
    plus.title = `Add a point — hold Shift for ${bulk}`;
    plus.onclick = e => cfg.step(k, e.shiftKey ? bulk : 1);

    row.append(minus, val, plus);
    row.appendChild(el("span", "amax",
      (have >= GAME.MAX_PER_ATTR ? "max" : `/ ${GAME.MAX_PER_ATTR}`)
      + (have ? `  +${have * GAME.STAT_PER_POINT}` : "")));
    host.appendChild(row);
  }
}

/* ---- the talent tree -------------------------------------------------------
 * The rules and the drawing, once, because two pages want them: the planner's own panel
 * and the standalone tree. Everything here is read out of the decompiled client rather
 * than invented - TalentClientLogic for the states, TalentPanel for the measurements,
 * TalentNodeButton for the colours - so a tree drawn from it is the panel the game shows,
 * at the same size, with the same things lit.
 *
 * The caller owns the ranks: a plain {nodeId: rank} object it can save, load and hand
 * back. Nothing is stored here.
 */
const TALENT = (() => {
  const ST = {PLACEHOLDER: 0, LEVEL: 1, PREREQ: 2, RIVAL: 3, NOPOINTS: 4,
              AVAILABLE: 5, MAXED: 6};
  const POWER_PER_RANK = 0.2;                     // TalentClientLogic.SpellPowerPerRank

  /* TalentPanel: TreeLeftMargin, TreeTopMargin, ColumnSpacing, RowSpacing, NodeSize, and
     the 380px canvas that follows from three columns. */
  const GRID = {left: 24, top: 16, colGap: 140, rowGap: 104, size: 52, width: 380};
  const CONNECT_ON = "rgba(217,179,77,.9)";       // Color(0.85, 0.7, 0.3, 0.9)
  const CONNECT_OFF = "rgba(255,255,255,.14)";

  /* No file holds the point budgets - the server sends them in talent_points_state and the
     client only prints them. Fitted to the characters the mod has read: at level 80 a
     character has 39 attribute points and 40 spell points. */
  const spellPointsAt = level => Math.max(0, Math.floor(level / 2));
  const attrPointsAt = level => Math.max(0, Math.floor((level - 1) / 2));

  const nodes = () => D.talents || [];
  const forClass = cls => nodes().filter(n => n.cls === Number(cls));
  const attrs = () => nodes().filter(n => n.cls === 0);
  const spellOf = n => (D.spells || []).find(s => s.id === n.spell);

  const rank = (ranks, id) => ranks[id] || 0;

  /* A rival is the other half of a choice pair that already HAS a rank - not one that was
     intended. Spend a point in the left half and the right half shuts. */
  const rivalOf = (node, ranks) => !node.choice ? null
    : forClass(node.cls).find(o => o.choice === node.choice && o.id !== node.id
                                   && rank(ranks, o.id) >= 1);

  /* One named node, or any node of a group - which is how a tier hangs off whichever half
     of the pair above it was taken. An opening node hangs off nothing. */
  function prereqMet(node, ranks) {
    if (node.needs) return rank(ranks, node.needs) >= 1;
    if (node.needsGroup)
      return forClass(node.cls).some(o => o.choice === node.needsGroup
                                          && rank(ranks, o.id) >= 1);
    return true;
  }

  /* is_free_unlock is a GRANT: the opening spell is already at rank 1 when the character
     is made, costs no point and cannot be given back. The Cleric is granted two. */
  function grantFree(cls, level, ranks) {
    for (const n of forClass(cls))
      if (n.free && level >= n.lvl && rank(ranks, n.id) < 1) ranks[n.id] = 1;
    return ranks;
  }
  const spent = (cls, ranks) => forClass(cls).reduce(
    (t, n) => t + rank(ranks, n.id) - (n.free ? Math.min(1, rank(ranks, n.id)) : 0), 0);
  const attrSpent = ranks => attrs().reduce((t, n) => t + rank(ranks, n.id), 0);

  function stateOf(node, ranks, level, pointsLeft) {
    const r = rank(ranks, node.id);
    if (r >= node.max) return ST.MAXED;
    if (level < node.lvl) return ST.LEVEL;
    if (!prereqMet(node, ranks)) return ST.PREREQ;
    if (rivalOf(node, ranks)) return ST.RIVAL;
    if (pointsLeft <= 0) return ST.NOPOINTS;
    return ST.AVAILABLE;
  }

  /** The parents TalentPanel draws a line from: the named node, and every node of the group. */
  function parentsOf(node) {
    const out = [];
    if (node.needs) {
      const p = nodes().find(n => n.id === node.needs);
      if (p) out.push(p);
    }
    if (node.needsGroup)
      out.push(...forClass(node.cls).filter(o => o.choice === node.needsGroup));
    return out;
  }

  const at = n => ({x: GRID.left + n.col * GRID.colGap,
                    y: GRID.top + (n.row - 1) * GRID.rowGap});

  /** Spend one point, or as many as the budget allows. Returns whether anything moved. */
  function add(node, ranks, level, all) {
    let moved = false;
    for (let guard = 0; guard < 64; guard++) {
      const left = spellPointsAt(level) - spent(node.cls, ranks);
      if (rank(ranks, node.id) >= node.max) break;
      if (stateOf(node, ranks, level, left) !== ST.AVAILABLE) break;
      ranks[node.id] = rank(ranks, node.id) + 1;
      moved = true;
      if (!all) break;
    }
    return moved;
  }

  /** Give one back, and anything downstream that now has nothing holding it up. */
  function remove(node, ranks) {
    if (rank(ranks, node.id) <= (node.free ? 1 : 0)) return false;
    ranks[node.id] = rank(ranks, node.id) - 1;
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of forClass(node.cls))
        if (rank(ranks, n.id) > 0 && !prereqMet(n, ranks)) { ranks[n.id] = 0; changed = true; }
    }
    return true;
  }

  /** Hand back whatever this level can no longer pay for or reach. */
  function reconcile(cls, level, ranks) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of forClass(cls))
        if (rank(ranks, n.id) > 0 && (level < n.lvl || !prereqMet(n, ranks))) {
          ranks[n.id] = 0; changed = true;
        }
      while (spellPointsAt(level) - spent(cls, ranks) < 0) {
        const deepest = forClass(cls).filter(n => rank(ranks, n.id) > (n.free ? 1 : 0))
          .sort((a, b) => b.row - a.row)[0];
        if (!deepest) break;
        ranks[deepest.id] = rank(ranks, deepest.id) - 1;
        changed = true;
      }
    }
    grantFree(cls, level, ranks);
    return ranks;
  }

  /** TalentClientLogic.DescribeRankScaling, which is not the same answer for every spell. */
  function rankScaling(spell) {
    if (!spell) return "";
    const pct = Math.round(POWER_PER_RANK * 100);
    // Power for anything that deals a number or ticks; DURATION for a stun and the two buffs.
    const power = spell.base > 0 || [2, 3, 8].includes(spell.fx);
    const duration = [1, 4, 5].includes(spell.fx);
    if (power && duration)
      return `Each rank increases this spell's power and effect duration by ${pct}%.`;
    if (duration) return `Each rank increases this spell's effect duration by ${pct}%.`;
    if (power) return `Each rank increases this spell's power by ${pct}%.`;
    return "This spell has no per-rank scaling.";
  }

  /**
   * Draw a class's tree into a host element.
   * opts: {cls, level, ranks, onChange, onTip, onLeave}
   */
  function draw(host, opts) {
    const cls = Number(opts.cls);
    const list = forClass(cls);
    if (!list.length) { host.replaceChildren(); return; }
    const rows = Math.max(...list.map(n => n.row), 1);
    const height = GRID.top + rows * GRID.rowGap;
    /* Always at 1:1. These are the sizes the client draws the panel at and they are not
       ours to change - a tree that has been magnified is no longer the panel a player is
       looking at in the game. Room around it is the modal's job, not the tree's. */
    host.style.width = GRID.width + "px";
    host.style.height = height + "px";
    host.replaceChildren();

    const left = spellPointsAt(opts.level) - spent(cls, opts.ranks);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${GRID.width} ${height}`);
    for (const n of list) {
      const to = at(n);
      for (const p of parentsOf(n)) {
        const from = at(p);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", from.x + 26); line.setAttribute("y1", from.y + GRID.size);
        line.setAttribute("x2", to.x + 26);   line.setAttribute("y2", to.y);
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke", rank(opts.ranks, p.id) >= 1 ? CONNECT_ON : CONNECT_OFF);
        svg.appendChild(line);
      }
    }
    host.appendChild(svg);

    for (const n of list) {
      const pos = at(n), r = rank(opts.ranks, n.id);
      const state = stateOf(n, opts.ranks, opts.level, left);
      const spell = spellOf(n);

      const btn = el("button", "tnode");
      btn.type = "button";
      btn.style.left = pos.x + "px";
      btn.style.top = pos.y + "px";
      /* TalentNodeButton.ApplyState: the Available border wins over the ranked one, which
         is why a granted node still shows gold while it can take another rank. */
      if (state === ST.AVAILABLE) btn.classList.add("available");
      else if (r > 0) btn.classList.add("ranked");
      if (state === ST.LEVEL || state === ST.PREREQ || (state === ST.NOPOINTS && r === 0))
        btn.classList.add("locked");
      if (state === ST.RIVAL) btn.classList.add("lockedout");
      if (spell && spell.icon) {
        const img = el("img");
        img.src = `icons/spells/${spell.id}.png`;
        img.loading = "lazy"; img.alt = "";
        btn.appendChild(img);
      } else {
        btn.appendChild(el("span", null, (spell ? spell.name : "?").slice(0, 2)));
      }
      btn.onclick = e => {
        if (add(n, opts.ranks, opts.level, e.shiftKey) && opts.onChange) opts.onChange();
      };
      btn.oncontextmenu = e => {
        e.preventDefault();
        if (remove(n, opts.ranks) && opts.onChange) opts.onChange();
      };
      if (opts.onTip) {
        const info = () => ({node: n, spell, state, rank: rank(opts.ranks, n.id)});
        btn.onmouseenter = e => opts.onTip(e, info());
        btn.onmousemove = e => opts.onTip(e, info());
        btn.onmouseleave = () => opts.onLeave && opts.onLeave();
      }
      host.appendChild(btn);

      const cap = el("div", "trank" + (r > 0 ? " has" : ""), `${r}/${n.max}`);
      cap.style.left = (pos.x - 30) + "px";
      cap.style.top = (pos.y + GRID.size + 2) + "px";
      host.appendChild(cap);

      const name = el("div", "tname", spell ? spell.name : "");
      name.style.left = (pos.x - 30) + "px";
      name.style.top = (pos.y + GRID.size + 20) + "px";
      host.appendChild(name);
    }
  }

  /** Per-spell ranks, the shape the planner and the simulator already speak. */
  function spellRanksOf(cls, ranks) {
    const out = {};
    for (const n of forClass(cls))
      if (n.spell && rank(ranks, n.id) > 0) out[n.spell] = rank(ranks, n.id);
    return out;
  }

  /** The reverse: seed a tree from an imported character's spell ranks. */
  function fromSpellRanks(cls, bySpell, level) {
    const ranks = {};
    for (const n of forClass(cls))
      if (n.spell && (bySpell || {})[n.spell]) ranks[n.id] = bySpell[n.spell];
    grantFree(cls, level, ranks);
    return ranks;
  }

  return {ST, POWER_PER_RANK, GRID, spellPointsAt, attrPointsAt, forClass, attrs, spellOf,
          rivalOf, prereqMet, grantFree, spent, attrSpent, stateOf, parentsOf, at,
          add, remove, reconcile, rankScaling, draw, spellRanksOf, fromSpellRanks};
})();

/* ---- the footer ----------------------------------------------------------
   Who made it. The build number used to live here too, and it has moved to the masthead's
   own line of figures on the Items page - said once, where a reader is already reading
   counts, rather than twice in two voices.

   Put here rather than in each page's markup so it cannot drift between them: seven copies
   of a footer is seven chances for one to say something different. */
(function siteFooter() {
  const foot = el("footer", "sitever");
  foot.appendChild(el("span", null, "Created by "));
  foot.appendChild(el("b", null, "Terek"));
  document.body.appendChild(foot);
})();

/* ---- search, from the header ------------------------------------------------
 * One index over everything the payload knows, built the first time somebody types and
 * then kept - it costs nothing on a page nobody searches from, and building it per
 * keystroke over a thousand rows would be felt.
 *
 * It lives here rather than on a search page because a lookup is not a destination. Wanting
 * to know what Emberite Ore is should not cost a navigation, lose the page you were on, and
 * make you come back. Enter still opens the full page for the times when it is a destination
 * after all - a long list worth scrolling, or a link worth sending.
 */
const SEARCH_KINDS = [
  {key: "item", label: "Items", icons: "items"},
  {key: "creature", label: "Creatures", icons: "monsters"},
  {key: "spell", label: "Spells", icons: "spells"},
  {key: "quest", label: "Quests", icons: null},
  {key: "npc", label: "People", icons: "npcs"},
  {key: "object", label: "World objects", icons: "objects"},
];

/* A quest has no art anywhere in the export - it is a task, not a thing - so the mark is
 * drawn rather than fetched. That is the same call the maps legend makes for a person, and
 * for the same reasons: nothing to ship, no licence to carry on a public site, no second
 * request to fail over file://, and it takes the theme's colour for free by being stroked in
 * currentColor. A written page with a folded corner, which is what a quest is.
 *
 * Not an exclamation mark, though that is the genre's usual sign: the maps legend already
 * spends one on NPCs, and two different things wearing one mark is worse than a plainer mark.
 */
const SEARCH_GLYPHS = {
  quest: ["M7 3.5h7l4.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5z",
          "M14 3.5V8h4.5",
          "M9 12.5h6M9 16h4"],
};

/* The mark for a search hit.
 *
 * Three treatments, because the site already has three and a search result is not a special
 * kind of thing - it is the same item, creature or quest the rest of the pages show, and it
 * should arrive wearing what it wears everywhere else.
 *
 *   an item      the character panel's own slot frame, tinted for the rarity, which is what
 *                the planner, the optimizer and every table put an item in
 *   a creature   its portrait, cropped in. The export leaves a great deal of air around the
 *                model, so at thirty pixels the animal is a smudge in the middle of an empty
 *                square; the map markers have always shown these at 152% and let the frame
 *                do the cropping, and this is the same number for the same reason
 *   anything else its own art, or a drawn glyph where the export has none
 */
function searchIcon(kind, id, has, size) {
  const k = SEARCH_KINDS.find(x => x.key === kind);
  if (kind === "item") {
    const it = ITEM_BY_ID.get(id);
    // Equipment carries the rarity tint the rest of the site gives it; a material or a quest
    // item has no rarity, so it takes the plain frame rather than a borrowed colour.
    return framedIcon(id, has, it && it.type === "Equipment" ? SCALE.quality : 1, size);
  }
  if (kind === "creature" && has) {
    const box = el("span", "hsart");
    if (size) { box.style.width = size + "px"; box.style.height = size + "px"; }
    box.appendChild(icon("monsters", id, has));
    return box;
  }
  if (k && k.icons) return icon(k.icons, id, has, size);
  const paths = SEARCH_GLYPHS[kind];
  if (!paths) return el("span", "hsdot");
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "hsglyph");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

let _searchIndex = null;

function searchIndex() {
  if (_searchIndex) return _searchIndex;
  const out = [];
  const push = (kind, id, name, meta, extra, ico) => {
    /* Guarded because a payload shape can change under us: D.objects went from id -> name
       to id -> record, and an unguarded toLowerCase threw during construction, which killed
       the page rather than one group of results. */
    if (typeof name !== "string" || !name) return;
    out.push({kind, id, name, meta: meta || "", icon: !!ico,
              lower: name.toLowerCase(),
              hay: (name + " " + (extra || "")).toLowerCase()});
  };

  for (const i of D.items || [])
    push("item", i.id, i.name,
         [i.type, i.kind, i.slot, i.lvl ? "level " + i.lvl : ""].filter(Boolean).join(" · "),
         i.desc, i.icon);
  for (const m of D.monsters || [])
    push("creature", m.id, m.name,
         `Level ${m.lvl} · ${fmtNum(m.hp)} hp` + (m.boss ? " · boss" : ""),
         ((D.abilities || {})[m.id] || []).map(a => a.name).join(" "), m.icon);
  for (const s of D.spells || []) {
    if (s.cls === -1) continue;          // a creature ability: found through its creature
    push("spell", s.id, s.name,
         [s.clsName, s.lvl ? "level " + s.lvl : ""].filter(Boolean).join(" · "),
         s.desc, s.icon);
  }
  for (const q of D.quests || [])
    push("quest", q.id, q.name,
         [q.fromName, q.lvl ? "level " + q.lvl : ""].filter(Boolean).join(" · "),
         (q.short || "") + " " + (q.desc || ""), false);
  for (const [id, n] of Object.entries(D.npcs || {}))
    push("npc", Number(id), n.name, n.role || "", n.says, n.icon);
  for (const [id, o] of Object.entries(D.objects || {}))
    push("object", Number(id), o.name, o.node ? "Gathering node" : "World object", "", o.icon);

  _searchIndex = out;
  return out;
}

/* Ranked, not merely filtered. An exact name beats a prefix beats a word start beats a
   substring beats a hit that only appears in the description - which is what puts Ember Bite
   above the eighteen quests whose flavour text mentions embers. */
function searchRank(e, q) {
  if (e.lower === q) return 0;
  if (e.lower.startsWith(q)) return 1;
  if (e.lower.includes(" " + q)) return 2;
  if (e.lower.includes(q)) return 3;
  if (e.hay.includes(q)) return 4;
  return -1;
}

function searchHits(q) {
  q = (q || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const e of searchIndex()) {
    const r = searchRank(e, q);
    if (r >= 0) hits.push({e, r});
  }
  hits.sort((a, b) => a.r - b.r || a.e.name.length - b.e.name.length
                   || a.e.name.localeCompare(b.e.name));
  return hits;
}

/** The matched run, marked, so the eye can see why a row is in the list. */
function searchMark(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode(text.slice(0, i)));
  frag.appendChild(el("mark", null, text.slice(i, i + q.length)));
  frag.appendChild(document.createTextNode(text.slice(i + q.length)));
  return frag;
}

/* monsterSheet wants the loot-table SOURCE, not an id - and a creature with no recorded loot
   has no source row, so one is synthesised. Without it every unlooted creature opened an
   empty panel. */
function monsterSheetFor(id) {
  const src = (DROP.sources || []).find(x => !x.node && x.id === id);
  const m = (D.monsters || []).find(x => x.id === id) || {};
  return monsterSheet(src || {i: -1, id, name: m.name || "Creature " + id,
                              lvl: m.lvl, boss: !!m.boss, icon: !!m.icon, node: false});
}

const SEARCH_SHEETS = {
  item: id => itemSheet(id),
  creature: id => monsterSheetFor(id),
  npc: id => npcSheet(id),
  quest: id => questSheet(id),
  object: id => (OBJECT_BY_ID.get(id) || {}).node ? gatherSheet(id) : null,
  // Spells have no sheet of their own anywhere on the site, so a spell row states what it
  // knows and stays put rather than pretending to lead somewhere.
};

/** The factory for a hit, or null when this kind has nowhere to go. */
function searchSheetFor(kind, id) {
  const make = SEARCH_SHEETS[kind];
  if (!make) return null;
  try { return make(id); } catch { return null; }
}

/* ---- how tall the chrome actually is -----------------------------------------
 * --header-h is what every sticky table heading, character doll and map max-height on the
 * site is positioned from, and it was a declared constant: 57px, with a second value for
 * phones. Both were guesses, and both were wrong - the real header is 61px on a desktop and
 * 191px on a 375px screen, where eight nav links wrap to three lines. A media query cannot
 * know how many lines the links wrapped to, so it can never get this right; measuring can.
 *
 * offsetHeight, not a bounding rect: the root carries a `zoom` past 2200px, which scales
 * rects but not offsets, and this number is consumed next to `100vh / var(--zoom)` - so it
 * has to be stated in the same unzoomed units the stylesheet is doing that division to get.
 */
(function trackHeaderHeight() {
  const header = document.querySelector("header");
  if (!header) return;
  const apply = () => {
    const de = document.documentElement;
    de.style.setProperty("--header-h", header.offsetHeight + "px");
    /* And the scrollbar, while we are measuring: the full-bleed masthead is sized from 50vw,
       which counts the scrollbar the document does not have, and CSS cannot subtract what it
       cannot measure. Ten pixels of horizontal scroll on every page without it. */
    de.style.setProperty("--sbw", Math.max(0, window.innerWidth - de.clientWidth) + "px");
  };
  apply();
  if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(header);
  addEventListener("resize", apply);      // belt and braces; both are cheap
  /* And again once the webfonts land. Measured against the fallback face the nav is
     narrower, wraps to fewer lines, and the first reading comes out short - 147px for a
     header that settles at 191. */
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply);
})();

(function headerSearch() {
  const header = document.querySelector("header");
  const nav = header && header.querySelector("nav");
  if (!header || !nav) return;

  const box = el("div", "hsearch");
  const input = el("input");
  input.type = "search";
  input.placeholder = "Search";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Search everything");
  box.appendChild(input);

  const panel = el("div", "hsres");
  panel.hidden = true;
  box.appendChild(panel);
  header.insertBefore(box, nav);

  let rows = [], cursor = -1;

  const close = () => { panel.hidden = true; cursor = -1; };

  const move = d => {
    if (panel.hidden || !rows.length) return;
    cursor = (cursor + d + rows.length) % rows.length;
    rows.forEach((r, i) => r.el.classList.toggle("on", i === cursor));
    rows[cursor].el.scrollIntoView({block: "nearest"});
  };

  const open = hit => {
    const make = searchSheetFor(hit.kind, hit.id);
    if (!make) return;                       // a kind with no page: the row is the answer
    close();
    input.blur();
    openSheet(make);
  };

  function draw() {
    const q = input.value.trim().toLowerCase();
    panel.replaceChildren();
    rows = [];
    cursor = -1;
    if (q.length < 2) { close(); return; }

    const hits = searchHits(q);
    if (!hits.length) {
      panel.appendChild(el("div", "hsnone", "Nothing matches that."));
      panel.hidden = false;
      return;
    }

    /* Grouped, but shallow: the header is for finding one thing, so each kind shows only
       its best few and the count says what is being held back. The full page is one Enter
       away for when the whole list is the point. */
    const byKind = {};
    for (const h of hits) (byKind[h.e.kind] = byKind[h.e.kind] || []).push(h);
    const PER_KIND = 5;

    for (const k of SEARCH_KINDS) {
      const list = byKind[k.key];
      if (!list) continue;
      const head = el("div", "hshead");
      head.appendChild(el("span", null, k.label));
      head.appendChild(el("b", null, String(list.length)));
      panel.appendChild(head);

      for (const {e} of list.slice(0, PER_KIND)) {
        const sheet = searchSheetFor(k.key, e.id);
        const row = el("div", "hsrow" + (sheet ? "" : " flat"));
        row.appendChild(searchIcon(k.key, e.id, e.icon, 30));
        const mid = el("div", "hsmid");
        const nm = el("div", "hsn");
        nm.appendChild(searchMark(e.name, q));
        mid.appendChild(nm);
        if (e.meta) mid.appendChild(el("span", "hsm", e.meta));
        row.appendChild(mid);
        row.onmousedown = ev => { ev.preventDefault(); open(e); };
        row.onmouseenter = () => {
          cursor = rows.findIndex(r => r.el === row);
          rows.forEach((r, i) => r.el.classList.toggle("on", i === cursor));
        };
        panel.appendChild(row);
        rows.push({el: row, hit: e});
      }
      if (list.length > PER_KIND)
        panel.appendChild(el("div", "hsmore",
          `and ${list.length - PER_KIND} more ${k.label.toLowerCase()}`));
    }

    const all = el("div", "hsall", `See all ${fmtNum(hits.length)} results  ⏎`);
    all.onmousedown = ev => {
      ev.preventDefault();
      location.href = "search.html?q=" + encodeURIComponent(input.value.trim());
    };
    panel.appendChild(all);
    panel.hidden = false;
  }

  let timer = null;
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(draw, 90); };
  input.onfocus = () => { if (input.value.trim().length >= 2) draw(); };
  input.onblur = () => setTimeout(close, 120);   // let a mousedown on a row land first

  input.onkeydown = e => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Escape") { close(); input.blur(); }
    else if (e.key === "Enter") {
      if (cursor >= 0 && rows[cursor]) { e.preventDefault(); open(rows[cursor].hit); }
      else if (input.value.trim().length >= 2)
        location.href = "search.html?q=" + encodeURIComponent(input.value.trim());
    }
  };

  /* "/" focuses the field, the way every search field on the web does - but not while you
     are typing into something else. */
  document.addEventListener("keydown", e => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
})();

/* ---- walking, as a graph -----------------------------------------------------
 * Everything below exists because the crow's line is a lie on this map. Only a fifth of the
 * world is ground you can stand on and get back from, so "nearest" by straight line routinely
 * means across a lake, through a cliff, or into a pocket with no way in. A route built that
 * way looks tidy and cannot be walked.
 *
 * One graph per map, in data.js, a bit a cell: 14 KB for all six. The overworld is coarse on
 * purpose at 16 world units - it decides the shape of a trip, not where to put your feet -
 * and a full sweep of its 27,648 cells costs about three milliseconds, which is what makes
 * the rest of this affordable. The breaches are 4 units, because they are corridors: at
 * sixteen a passage would be a cell wide and the router would call it a wall.
 *
 * The two are built from different evidence and the difference is worth knowing. The
 * overworld's comes from the reachability model over Terrain3D heights - an inference, and
 * wrong often enough that the coverage layer refuses to trust it. A breach's is read straight
 * off the alpha of its floor plan, which is drawn from the collision mesh's own ground
 * triangles: not a model of where you can stand, but the polygons you stand on. All 217
 * recorded breach spawn points land on it.
 *
 * The ORDERING that uses all this lives with its only caller, in unrecorded.html. A generic
 * copy sat here for a while with no callers at all, quietly claiming in its own comment to
 * land within a few per cent of optimal - which measured out at fifteen.
 */
const NAVS = new Map();

(function loadNav() {
  const all = (typeof D !== "undefined" && D.nav) || null;
  if (!all) return;
  for (const [mapId, n] of Object.entries(all)) {
    if (!n || !n.bits) continue;
    let raw;
    try { raw = atob(n.bits); } catch (e) { continue; }
    const walk = new Uint8Array(n.w * n.h);
    for (let i = 0; i < walk.length; i++)
      walk[i] = (raw.charCodeAt(i >> 3) & (0x80 >> (i & 7))) ? 1 : 0;
    NAVS.set(mapId, Object.assign({}, n, {walk, ok: true, mapId}));
  }
})();

/** The walking graph for a map, or null where there is none. */
const navFor = mapId => NAVS.get(mapId || "") || null;

/** World point -> cell index, or -1 outside the grid. No walkability test. */
function navCellAt(g, x, z) {
  if (!g) return -1;
  const ix = Math.floor((x - g.x0) / g.cell), iz = Math.floor((z - g.z0) / g.cell);
  if (ix < 0 || iz < 0 || ix >= g.w || iz >= g.h) return -1;
  return iz * g.w + ix;
}

const navCentre = (g, i) =>
  [g.x0 + (i % g.w + 0.5) * g.cell, g.z0 + ((i / g.w | 0) + 0.5) * g.cell];

/* A spawn point does not have to sit on walkable ground, and 7% of them do not - a creature
   on a ledge, or a point recorded through a wall. Snapping to the nearest walkable cell is
   what keeps those in the route instead of silently dropping them; the ring search stops at
   six cells, about a hundred units, past which "nearest walkable" stops meaning anything. */
function navSnap(g, x, z, maxRings = 6) {
  if (!g) return -1;
  const at = navCellAt(g, x, z);
  if (at < 0) return -1;
  if (g.walk[at]) return at;
  const cx = at % g.w, cz = at / g.w | 0;
  for (let r = 1; r <= maxRings; r++) {
    let best = -1, bd = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // the ring, not the disc
        const ix = cx + dx, iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= g.w || iz >= g.h) continue;
        const i = iz * g.w + ix;
        if (!g.walk[i]) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/* One sweep answers every question at once, which is the whole reason this is affordable: a
   route over thirty stops needs thirty of these for a complete distance matrix, not nine
   hundred point-to-point searches.
   Distances come back in WORLD UNITS. Diagonals cost sqrt(2), so this is really a Dijkstra
   over two edge weights - a plain BFS would make a staircase 40% shorter than the straight
   it approximates, and every diagonal shore would read as a shortcut. */
const NAV_STEP = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
                  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2],
                  [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

function navSweep(g, from) {
  const n = g.w * g.h;
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  if (from < 0 || !g.walk[from]) return {dist, prev};
  dist[from] = 0;

  /* A bucket queue rather than a binary heap. With two edge weights the frontier only ever
     spans a narrow band of distances, so bucketing by distance/cell is O(1) per push and pop
     and there is no heap to maintain. */
  const step = g.cell, buckets = [[from]];
  for (let b = 0; b < buckets.length; b++) {
    const list = buckets[b];
    if (!list) continue;
    for (let k = 0; k < list.length; k++) {
      const cur = list[k];
      /* Stale entry: this cell was queued here, then found again more cheaply and queued
         lower. It cannot have got MORE expensive, so a bucket below this one means the
         shorter find already ran. (Comparing dist to b+0.5 instead, as this first did, threw
         away every genuine node whose diagonal steps put it past the half-cell mark - a
         sweep reached 120 cells of 5,952.) */
      if (Math.floor(dist[cur] / step) < b) continue;
      const cx = cur % g.w, cz = cur / g.w | 0;
      for (const [dx, dz, cost] of NAV_STEP) {
        const ix = cx + dx, iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= g.w || iz >= g.h) continue;
        const nx = iz * g.w + ix;
        if (!g.walk[nx]) continue;
        /* No cutting a corner between two blocked cells: without this the path slips
           diagonally through the gap where two cliffs meet, which is exactly the kind of
           impossible shortcut this whole file exists to stop. */
        if (dx && dz && !(g.walk[cz * g.w + ix] && g.walk[iz * g.w + cx])) continue;
        const nd = dist[cur] + cost * step;
        if (nd >= dist[nx]) continue;
        dist[nx] = nd;
        prev[nx] = cur;
        const nb = Math.floor(nd / step);
        (buckets[nb] || (buckets[nb] = [])).push(nx);
      }
    }
    buckets[b] = null;                                  // let the row go
  }
  return {dist, prev};
}

/* The cells walked from a sweep's origin to `to`, origin first. The origin has no
   predecessor and neither does an unreachable cell, so this cannot tell them apart on its
   own - callers check the distance is finite first, which is the only place that knows. */
function navTrace(prev, to) {
  const out = [];
  for (let cur = to; cur >= 0; cur = prev[cur]) out.push(cur);
  return out.reverse();
}

/* Is the straight line between two world points walkable the whole way?
 *
 * Rasterised, not sampled. Point sampling along the segment - which is what this did first,
 * at four-tenths of a cell - cannot answer the question at all: a line clips the CORNER of a
 * blocked cell over a chord shorter than the sample spacing, and both bracketing samples land
 * outside it. On the real grid that let 39% of smoothed legs graze blocked ground. Cutting
 * the step only shrinks the chord it misses; it never closes the hole, because there is no
 * spacing small enough that a line cannot enter and leave a convex cell between two samples.
 *
 * So this walks the grid instead, boundary by boundary, and sees every cell the segment
 * actually enters. Where the segment passes exactly through a lattice corner it applies the
 * same rule navSweep does - both shoulders walkable, or no passage - because otherwise the
 * smoothing quietly hands back the diagonal squeeze the sweep refused to take, and draws a
 * line through the tip of a lake inlet that costs 96 units to walk round.
 */
function navClear(g, ax, az, bx, bz) {
  if (!g) return false;
  const cs = g.cell;
  const okCell = (x, z) =>
    x >= 0 && z >= 0 && x < g.w && z < g.h && !!g.walk[z * g.w + x];

  let ix = Math.floor((ax - g.x0) / cs), iz = Math.floor((az - g.z0) / cs);
  const ex = Math.floor((bx - g.x0) / cs), ez = Math.floor((bz - g.z0) / cs);
  if (!okCell(ix, iz) || !okCell(ex, ez)) return false;

  const dx = bx - ax, dz = bz - az;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  // How far along the segment (0..1) the next boundary lies on each axis, and how far apart
  // successive boundaries are.
  let tX = sx ? (g.x0 + (ix + (sx > 0 ? 1 : 0)) * cs - ax) / dx : Infinity;
  let tZ = sz ? (g.z0 + (iz + (sz > 0 ? 1 : 0)) * cs - az) / dz : Infinity;
  const stepX = sx ? cs / Math.abs(dx) : Infinity;
  const stepZ = sz ? cs / Math.abs(dz) : Infinity;

  const EPS = 1e-9;
  let guard = g.w + g.h + 4;
  while ((ix !== ex || iz !== ez) && guard-- > 0) {
    if (Math.abs(tX - tZ) < EPS) {
      // Exactly through the corner. Both shoulders, or nothing - the sweep's own rule.
      if (!okCell(ix + sx, iz) || !okCell(ix, iz + sz)) return false;
      ix += sx; iz += sz; tX += stepX; tZ += stepZ;
    } else if (tX < tZ) {
      ix += sx; tX += stepX;
    } else {
      iz += sz; tZ += stepZ;
    }
    if (!okCell(ix, iz)) return false;
  }
  return guard > 0;                       // ran out of steps: refuse rather than guess
}

/* Pull the grid path taut.
 *
 * A shortest path over an eight-way grid is not a shortest path over the ground. Movement is
 * quantised to eight directions, so a diagonal run across open field comes out as a
 * staircase, and where the strict no-corner-cutting rule bites - anywhere a shoreline runs
 * diagonally - it comes out as a long L. Both are artefacts of the lattice, and drawing them
 * would claim the terrain forces a detour it does not.
 *
 * So: keep a point only when the straight line to the next one would leave walkable ground.
 * What survives is the taut line an actual walk takes, and its length is shorter and truer
 * than the lattice's - which is why the distances quoted come from here rather than from the
 * sweep that chose the order.
 */
function navSmooth(g, cells) {
  const pts = cells.map(c => navCentre(g, c));
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !navClear(g, pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** How far the taut path actually is, in world units. */
function navLength(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++)
    t += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return t;
}
