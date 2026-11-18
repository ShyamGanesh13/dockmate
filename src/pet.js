// pet.js — what the pet does.
//
// character.js knows how to move a drawing; this file decides when: where
// the pet stands, when it wanders or dozes, how it reacts to a click, a drag,
// a reminder, and the chat box. Rust owns the clock and the system queries;
// this owns everything you can see.
//
// Every routine is an async chain gated on `epoch`. Anything that grabs the
// pet (a drag, a click, the chat box) bumps it, and whatever was running
// unwinds on its next check instead of fighting the new behaviour.

import { invoke, listen, emit, inTauri, loadCharacterSvg } from "./lib/bridge.js";
import { Character, drawsSomething } from "./lib/character.js";
import { chime } from "./lib/chime.js";

const $ = (id) => document.getElementById(id);
const petEl = $("pet"), rigEl = $("rig"), artEl = $("art");
const bubbleEl = $("bubble"), badgeEl = $("badge"), fxEl = $("fx");
const chatEl = $("chat"), chatLog = $("chatLog"), chatInput = $("chatInput");
const chatHint = $("chatHint"), chatSend = $("chatSend"), menuEl = $("menu");
const signEl = $("sign"), signMain = signEl.querySelector(".sign-main"), signSub = signEl.querySelector(".sign-sub");

if (!inTauri) $("previewDesk").hidden = false;

const log = (...a) => console.log("[pet]", ...a);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let cfg = await invoke("get_config");
let char = null;

// ------------------------------------------------------------ geometry
const BASE_H = 140;
let W = BASE_H, H = BASE_H;
let x = 120;          // left edge, CSS px
let lift = 0;         // px above the floor (the Dock line)
let facing = 1;       // 1 = right, -1 = left
let mode = "idle";    // idle | walk | sleep | drag | fall | chat
let bob = 0, tilt = 0, phase = 0;
let sx = 1, sy = 1;   // art squash/stretch while walking
let vx = 0, vy = 0;

const floorY = () => window.innerHeight;
const maxX = () => Math.max(0, window.innerWidth - W);

// Home: "dock" (bottom-right corner, walks the Dock line) or "top" (perched at
// the top-centre, under the notch on notched Macs — no floor, no gravity).
// `lift` means px ABOVE the floor in dock mode, px BELOW the top edge in top.
const TOP_GAP = 8;
const topMode = () => cfg.pet.home === "top";
const petTop = () => topMode() ? (TOP_GAP + lift) : (floorY() - H - lift);

// The pet lives in the bottom-right corner and only strolls within a small
// zone there — a few steps, not the whole bar. Dragging can still take it
// anywhere; it walks back into the zone when you let go. In top mode it just
// perches at centre.
const EDGE_GAP = 16;
const roamMax = () => Math.max(0, maxX() - EDGE_GAP);
const roamMin = () => Math.max(0, roamMax() - 3.0 * W);
const homeX = () => topMode() ? (maxX() / 2) : clamp(x, roamMin(), roamMax());

// ------------------------------------------------------------ peek mode
// When on, the pet rests hidden just below the bottom edge and only slides up
// for a nudge (reminder/routine/water/timer), the chat, or the menu — then
// slides away. `shown` eases 0 (tucked away) → 1 (standing in the corner).
let peekMode = !!cfg.pet.peek;
let shown = peekMode ? 0 : 1;
let peekUntil = 0; // performance.now() timestamp to stay out until
const PEEK = { nudge: 9000, long: 12000, quick: 1400 };
function peekFor(ms) {
  if (peekMode) peekUntil = Math.max(peekUntil, performance.now() + ms);
}
function wantShown() {
  if (!peekMode) return 1;
  if (sessionActive) return 1;                 // stay out through a focus session (timer visible)
  if (!chatEl.hidden || !menuEl.hidden) return 1;
  if (awaitingAnswer()) return 1;               // a nudge with buttons waits for your choice
  return performance.now() < peekUntil ? 1 : 0;
}

function applySize() {
  const s = clamp(Number(cfg.pet.scale) || 1, 0.4, 3);
  H = BASE_H * s;
  W = H * (char ? char.aspect : 1);
  petEl.style.width = W + "px";
  petEl.style.height = H + "px";
  artEl.style.transformOrigin = "50% 100%"; // bounce/squash pivots on the feet
  // keep it parked in the corner zone unless it's being handled
  if (mode === "drag" || mode === "fall") {
    x = clamp(x, 0, maxX());
  } else {
    x = topMode() ? (maxX() / 2) : clamp(x, roamMin(), roamMax());
  }
}

function place() {
  // In top mode the pet hangs from the ceiling, so bubbles/arrows flip to open
  // downward (see #pet.top rules in pet.css).
  petEl.classList.toggle("top", topMode());
  // Hidden slides off the nearest edge: down in dock mode, up in top mode.
  const drop = (1 - shown) * (H + 60) * (topMode() ? -1 : 1);
  petEl.style.transform = `translate(${x}px, ${petTop() + drop}px)`;
  artEl.style.transform = `translateY(${-bob}px) rotate(${tilt}deg) scaleX(${facing * sx}) scaleY(${sy})`;
}

function setBreathe(on) {
  petEl.classList.toggle("breathe", on);
}

// ------------------------------------------------------------ notch sign
// In "Notch sign" home the puppet is replaced by a hanging wooden sign that
// shows live status: the focus countdown while a session runs, otherwise the
// clock and streak. Nudges (reminder/water/routine/session) flash their text
// across it for a few seconds — the actionable buttons stay on the OS banner.
const signMode = () => cfg.pet.home === "sign";
let sessionLeft = null;            // seconds, mirrored from the tick heartbeat
let signFlashUntil = 0, signFlashMain = "", signFlashSub = "";

// With "only appear for reminders" on, the sign tucks away and drops down only
// for a nudge, during a focus session, or while you're interacting with it.
function signWantsShow() {
  if (!peekMode) return true;
  if (performance.now() < signFlashUntil) return true;
  if (sessionActive) return true;
  if (!menuEl.hidden || !chatEl.hidden) return true;
  return false;
}

function updateSign() {
  if (!signMode()) return;
  const wasTucked = signEl.classList.contains("tuck");
  const tuck = !signWantsShow();
  signEl.classList.toggle("tuck", tuck);
  if (tuck !== wasTucked) sendHit(true);   // clickable area changed
  if (performance.now() < signFlashUntil) {
    signMain.textContent = signFlashMain;
    signSub.textContent = signFlashSub;
    signEl.classList.add("alert");
    return;
  }
  signEl.classList.remove("alert");
  if (sessionActive && sessionLeft != null) {
    signMain.textContent = (sessionPaused ? "❚❚ " : "") + fmt(sessionLeft);
    signSub.textContent = sessionPaused ? "focus · paused" : "focus";
  } else {
    // Idle: just the time and date.
    const d = new Date();
    signMain.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    signSub.textContent = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
}

function signFlash(main, sub = "") {
  if (!signMode()) return;
  signFlashMain = main; signFlashSub = sub;
  signFlashUntil = performance.now() + 9000;
  updateSign();
}

function applySignMode() {
  const on = signMode();
  signEl.hidden = !on;
  petEl.style.display = on ? "none" : "";
  if (on) updateSign();
  sendHit(true);
}

// Clicking the sign opens the pet menu (Talk / Focus / Settings / …) just below it.
function openSignMenu() {
  menuEl.hidden = false;
  const m = menuEl.getBoundingClientRect(), s = signEl.getBoundingClientRect();
  menuEl.style.left = clamp(s.left + s.width / 2 - m.width / 2, 4, window.innerWidth - m.width - 4) + "px";
  menuEl.style.top = clamp(s.bottom + 8, 4, window.innerHeight - m.height - 4) + "px";
  sendHit(true);
}
signEl.addEventListener("click", (e) => { e.stopPropagation(); menuEl.hidden ? openSignMenu() : closeMenu(); });
signEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSignMenu(); } });

// ------------------------------------------------------------ hit testing
// The overlay is click-through except over these rectangles.
let hold = false;
let lastHit = "";
function hitRects() {
  const pad = 6;
  // Notch-sign mode: only the sign (and any open chat/menu) catch clicks.
  if (signMode()) {
    const rects = [];
    for (const el of [signEl, chatEl, menuEl]) {
      if (!el || el.hidden) continue;
      if (el === signEl && signEl.classList.contains("tuck")) continue; // tucked = not clickable
      const r = el.getBoundingClientRect();
      rects.push({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    }
    return rects;
  }
  // While tucked away (peek mode), the pet catches no clicks — the whole
  // overlay stays click-through so nothing underneath is blocked.
  const rects = shown > 0.6 ? [{ x: x - pad, y: petTop() - pad, w: W + pad * 2, h: H + pad * 2 }] : [];
  for (const el of [chatEl, menuEl, badgeEl.hidden ? null : badgeEl, bubbleEl.classList.contains("clickable") ? bubbleEl : null]) {
    if (el && !el.hidden) {
      const r = el.getBoundingClientRect();
      rects.push({ x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    }
  }
  return rects;
}
function sendHit(force = false) {
  const rects = hitRects();
  const key = JSON.stringify(rects.map((r) => [Math.round(r.x / 3), Math.round(r.y / 3), Math.round(r.w), Math.round(r.h)])) + hold;
  if (!force && key === lastHit) return;
  lastHit = key;
  invoke("set_hitbox", { rects, hold }).catch(() => {});
}

// ------------------------------------------------------------ interruptible routines
let epoch = 0;
let walkTarget = null;
let onArrive = null;
function interrupt() {
  epoch++;
  walkTarget = null;
  onArrive = null;
  if (mode === "walk") mode = "idle";
  return epoch;
}
const stale = (mine) => mine !== epoch;

function pause(ms, mine) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (stale(mine) || performance.now() - t0 >= ms) { clearInterval(iv); resolve(); }
    }, 60);
  });
}

function walkTo(tx, mine) {
  return new Promise((resolve) => {
    if (stale(mine)) return resolve();
    mode = "walk";
    setBreathe(false);
    walkTarget = clamp(tx, 0, maxX());
    onArrive = () => { mode = "idle"; resolve(); };
    const iv = setInterval(() => { if (stale(mine)) { clearInterval(iv); resolve(); } else if (walkTarget === null) clearInterval(iv); }, 100);
  });
}

// ------------------------------------------------------------ the frame loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const speed = 70 * clamp(Number(cfg.pet.speed) || 1, 0.3, 3) * (H / BASE_H);

  if (mode === "walk" && walkTarget !== null) {
    const dir = Math.sign(walkTarget - x);
    if (dir !== 0) facing = dir;
    x += dir * speed * dt;
    phase += dt * 8 * clamp(Number(cfg.pet.speed) || 1, 0.3, 3);
    const step = Math.abs(Math.sin(phase));   // 0 at footfall, 1 mid-stride
    bob = step * 7 * (H / BASE_H);             // bounce up each step
    tilt = Math.sin(phase * 0.5) * 5;          // slow left/right waddle
    sy = 1 - 0.05 * step;                      // stretch up as it rises
    sx = 1 + 0.035 * step;
    char && char.swing(phase);                 // (moves arms if the SVG has them)
    if (dir === 0 || (dir > 0 && x >= walkTarget) || (dir < 0 && x <= walkTarget)) {
      x = walkTarget;
      walkTarget = null;
      bob = 0; tilt = 0; sx = 1; sy = 1;
      char && char.restArms();
      const done = onArrive; onArrive = null; done && done();
    }
  } else if (mode === "fall") {
    vy += 2600 * dt;
    lift -= vy * dt;
    x = clamp(x + vx * dt, 0, maxX());
    vx *= 0.985;
    tilt += (clamp(vx * 0.02, -15, 15) - tilt) * 0.2;
    if (lift <= 0) { lift = 0; land(); }
  } else if (mode === "drag") {
    tilt += (clamp(-vx * 0.03, -28, 28) - tilt) * 0.25;
    vx *= 0.9;
  } else {
    bob *= 0.8;
    tilt *= 0.8;
    sx += (1 - sx) * 0.2;
    sy += (1 - sy) * 0.2;
    if (topMode()) lift += (0 - lift) * 0.2;   // ease back up to the perch
  }

  // Peek: ease toward hidden/shown, and clear a lingering bubble as it leaves.
  const target = wantShown();
  shown += (target - shown) * clamp(dt * 9, 0, 1);
  if (Math.abs(shown - target) < 0.002) shown = target;
  if (peekMode && target === 0 && chatEl.hidden && !bubbleEl.hidden) hush();

  place();
  sendHit();
  // Tucked away (peek mode) nothing on screen changes, so tick 4×/s instead of
  // 60 — the difference between ~9% and ~1% idle CPU on battery. A nudge still
  // slides the pet out within 250 ms, and the slide itself runs at full rate.
  if (peekMode && shown === 0 && target === 0 && !press) setTimeout(() => requestAnimationFrame(frame), 250);
  else requestAnimationFrame(frame);
}

// ------------------------------------------------------------ speech + effects
let bubbleTimer = null;
// `actions`: [{label, act}] renders small buttons inside the bubble.
function say(text, { ms = 3800, small = "", alert = false, clickable = false, force = false, actions = null } = {}) {
  char && char.talk(Math.min(1600, 400 + text.length * 30));
  // Normally the open chat shows messages instead of a bubble, but an alert
  // (reminder / water / session) must show even while the chat is open.
  if (!chatEl.hidden && !alert && !force && !actions) return;
  // Don't let small talk (a tap, a greeting) wipe out a nudge still waiting for an answer.
  if (awaitingAnswer() && !actions) return;
  clearTimeout(bubbleTimer);
  bubbleEl.textContent = "";
  const line = document.createElement("div");
  line.textContent = text;
  bubbleEl.appendChild(line);
  if (small) { const s = document.createElement("small"); s.textContent = small; bubbleEl.appendChild(s); }
  const hasBtns = actions && actions.length;
  if (hasBtns) {
    const row = document.createElement("div");
    row.className = "bub-actions";
    actions.forEach((a) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = a.label;
      b.addEventListener("click", (e) => { e.stopPropagation(); try { a.act(); } catch (_) {} dismissEverywhere(); });
      row.appendChild(b);
    });
    bubbleEl.appendChild(row);
  }
  bubbleEl.classList.toggle("alert", alert);
  bubbleEl.classList.toggle("clickable", clickable || hasBtns);
  bubbleEl.hidden = false;
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(hush, ms);
  sendHit(true);
}
function awaitingAnswer() {
  return !bubbleEl.hidden && !!bubbleEl.querySelector(".bub-actions");
}
function hush() {
  bubbleEl.hidden = true;
  bubbleEl.classList.remove("clickable", "alert");
  sendHit(true);
}
// Clicking the bubble dismisses it only when it has no action buttons.
bubbleEl.addEventListener("click", () => { if (!bubbleEl.querySelector(".bub-actions")) dismissEverywhere(); });

// Every monitor's pet shows the same nudge, so answering it on one dismisses it on all.
function dismissEverywhere() {
  emit("nudge-dismissed").catch(() => dismissed());
}
function dismissed() {
  hush();
  if (peekMode) peekUntil = performance.now() + PEEK.quick;
}
listen("nudge-dismissed", dismissed);

function spawn(kind, text) {
  const s = document.createElement("span");
  s.className = "fx " + kind;
  s.textContent = text;
  s.style.left = x + W * (facing > 0 ? 0.62 : 0.38) + "px";
  s.style.top = petTop() + H * 0.12 + "px";
  s.style.setProperty("--dx", rand(-18, 22) + "px");
  fxEl.appendChild(s);
  s.addEventListener("animationend", () => s.remove());
}

// ------------------------------------------------------------ idle life
let lastInteract = performance.now();
let bedtime = false;
let forcedSleep = false;
const touched = () => { lastInteract = performance.now(); };

function shouldSleep() {
  if (forcedSleep || bedtime) return true;
  return cfg.pet.sleepy && performance.now() - lastInteract > 5 * 60 * 1000;
}

async function doze(mine) {
  mode = "sleep";
  setBreathe(false);
  petEl.classList.add("sleeping");
  char && char.setEyes(0);
  while (!stale(mine) && shouldSleep()) {
    spawn("z", "z");
    await pause(1500, mine);
  }
  petEl.classList.remove("sleeping");
  char && char.setEyes(1);
  if (!stale(mine)) { mode = "idle"; setBreathe(true); }
}

async function brain() {
  const mine = interrupt();
  mode = "idle";
  setBreathe(true);
  if (topMode()) x = maxX() / 2;   // perch at centre
  // Peek mode: no wandering or dozing — rest tucked away until a nudge.
  if (peekMode) { x = homeX(); return; }
  await pause(400, mine);
  // Dock mode: if a drag left the pet outside its corner zone, amble back in.
  if (!topMode() && (x < roamMin() - 2 || x > roamMax() + 2)) {
    await walkTo(clamp(x, roamMin(), roamMax()), mine);
    setBreathe(true);
  }
  while (!stale(mine)) {
    if (shouldSleep()) { await doze(mine); continue; }
    const r = Math.random();
    if (cfg.pet.wander && !topMode() && r < 0.34) {
      // a step or two within the bottom-right zone
      const lo = roamMin(), hi = roamMax();
      const step = Math.min(Math.max(0, hi - lo), 1.2 * W);
      await walkTo(clamp(x + rand(-step, step), lo, hi), mine);
      setBreathe(true);
    } else if (r < 0.50) {
      char && char.tilt(rand(-9, 9));
    } else if (r < 0.66) {
      await glance(mine);
    } else if (r < 0.80) {
      hop();
    } else if (r < 0.85) {
      char && (await char.wave(2));
    }
    await pause(rand(2600, 7000), mine);
  }
}

(function blinkLoop() {
  if (char && mode !== "sleep") char.blink();
  setTimeout(blinkLoop, rand(2400, 6200));
})();

// ------------------------------------------------------------ eyes follow the pointer
function onCursor(p) {
  const near = Math.hypot(p.x - (x + W / 2), p.y - (petTop() + H / 2)) < Math.max(W, H) * 0.9;
  if (near && !forcedSleep && !bedtime) touched();
  if (!char || !cfg.pet.follow || mode === "sleep") return;
  const ex = x + W / 2, ey = petTop() + H * 0.45;
  char.look(((p.x - ex) / 260) * facing, (p.y - ey) / 220);
}

// ------------------------------------------------------------ grab, drop, pat
let press = null;
let clickTimer = null, taps = 0;

artEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  closeMenu();
  artEl.setPointerCapture(e.pointerId);
  press = { sx: e.clientX, sy: e.clientY, ox: e.clientX - x, oy: e.clientY - petTop(), lx: e.clientX, lt: performance.now(), dragging: false };
  hold = true;
  sendHit(true);
});

artEl.addEventListener("pointermove", (e) => {
  if (!press) return;
  if (!press.dragging && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > 5) {
    press.dragging = true;
    interrupt();
    if (!chatEl.hidden) closeChat(false);
    hush();
    mode = "drag";
    setBreathe(false);
    petEl.classList.remove("sleeping");
    forcedSleep = false;
    char && char.setEyes(1);
    touched();
  }
  if (press.dragging) {
    const now = performance.now();
    const dt = Math.max(1, now - press.lt) / 1000;
    vx = vx * 0.6 + ((e.clientX - press.lx) / dt) * 0.4;
    press.lx = e.clientX; press.lt = now;
    x = clamp(e.clientX - press.ox, 0, maxX());
    lift = topMode()
      ? Math.max(0, (e.clientY - press.oy) - TOP_GAP)        // px below the top edge
      : Math.max(0, floorY() - H - (e.clientY - press.oy));  // px above the floor
  }
});

function endPress(e) {
  if (!press) return;
  const wasDrag = press.dragging;
  press = null;
  hold = false;
  sendHit(true);
  if (wasDrag) {
    if (topMode()) { mode = "idle"; tilt = 0; setTimeout(brain, 350); } // ease back to the perch
    else if (lift > 2) { mode = "fall"; vy = 0; vx = clamp(vx, -900, 900); }
    else land();
  } else if (e.type === "pointerup") {
    // 1 tap = 😎, 2 = hello, 3 = chat. Wait briefly to see if more taps follow.
    clearTimeout(clickTimer);
    if (++taps >= 3) { taps = 0; openChat(); return; }
    clickTimer = setTimeout(() => { const n = taps; taps = 0; n === 1 ? pat() : greet(); }, 280);
  }
}
artEl.addEventListener("pointerup", endPress);
artEl.addEventListener("pointercancel", endPress);

artEl.addEventListener("dblclick", (e) => e.preventDefault());

function greet() {
  pat(false);
  const name = (cfg.pet.userName || "").trim();
  say(`Hello${name ? " " + name : ""}! Have a good day ☀️`, { ms: 3000 });
  char && char.wave(2);
}

function land() {
  mode = "idle";
  tilt = 0;
  rigEl.animate(
    [{ transform: "scale(1.16, 0.8)" }, { transform: "scale(0.94, 1.07)" }, { transform: "scale(1, 1)" }],
    { duration: 420, easing: "ease-out" }
  );
  setTimeout(brain, 450);
}

// A quick in-place hop with squash-and-stretch — the pet's little "I'm alive"
// beat. Reused for celebratory reactions (session done, streak) in phase 2.
function hop(height = 13) {
  rigEl.animate(
    [
      { transform: "translateY(0) scale(1,1)" },
      { transform: "translateY(0) scale(1.09,0.9)" },                 // crouch
      { transform: `translateY(${-height}px) scale(0.95,1.08)` },     // leap
      { transform: "translateY(0) scale(1.08,0.9)" },                 // land squash
      { transform: "translateY(0) scale(1,1)" },
    ],
    { duration: 520, easing: "ease-out" }
  );
}

// A confetti burst — a few emotes popping up, staggered. Pairs with a hop for
// a celebratory reaction (e.g. a finished focus session).
function celebrate(emoji = "🎉", n = 4) {
  for (let i = 0; i < n; i++) setTimeout(() => spawn("party", emoji), i * 110);
}

// Glance left, then right, then recenter — a cheap "looking around" idle beat.
// Only runs if the artwork has pupils; cursor-follow takes back over on move.
async function glance(mine) {
  if (!char || !char.pupils.length) return;
  const dir = Math.random() < 0.5 ? -1 : 1;
  char.look(dir, -0.15);
  await pause(650, mine);
  if (stale(mine)) return;
  char.look(-dir * 0.7, 0.1);
  await pause(650, mine);
  if (!stale(mine)) char.look(0, 0);
}

async function pat(cool = true) {
  const wasSleeping = mode === "sleep";
  interrupt();
  forcedSleep = false;
  touched();
  petEl.classList.remove("sleeping");
  char && char.setEyes(1);
  if (cool) spawn("cool", "😎");
  rigEl.animate(
    [{ transform: "translateY(0)" }, { transform: "translateY(-16px) scale(0.98,1.03)" }, { transform: "translateY(0) scale(1.06,0.94)" }, { transform: "translateY(0)" }],
    { duration: 480, easing: "ease-out" }
  );
  if (wasSleeping && cool) say("Oh! I'm up, I'm up.");
  setTimeout(brain, 600);
}

// ------------------------------------------------------------ chat
function shapeOf(t) {
  t = t.trim();
  if (t.startsWith("/")) return "do";
  if (t.endsWith("?") || /^(hi|hello|hey|hiya|yo|help)\b/i.test(t)) return "ask";
  return "note";
}
// Autocomplete: "/" lists commands, "?" lists questions. [label, example args, what it does]
// Keep in sync with ask.rs (`command`, `intent`, `help`).
const COMMANDS = [
  ["/timer", "25", "Start a focus session (minutes)"],
  ["/stop", "", "End the focus session"],
  ["/remind", "call Kavi at 5pm", "Remind me once"],
  ["/daily", "11:30 chia seeds", "Remind me at the same time every day"],
  ["/every", "2h stand and stretch", "Repeat on an interval"],
  ["/water", "30", "Drink-water nudge every N min (or off)"],
  ["/note", "buy milk", "Save a note"],
  ["/sleep", "", "Take a nap"],
  ["/hide", "", "Hide the pet"],
  ["/settings", "", "Open Settings"],
  ["/help", "", "Everything I understand"],
  ["/quit", "", "Quit Dockmate"],
];
const QUESTIONS = [
  ["battery?", "Charge and power"],
  ["memory?", "RAM use and top apps"],
  ["cpu?", "Processor load"],
  ["disk?", "Free storage"],
  ["weather?", "Weather where you are"],
  ["weather in ?", "Weather somewhere else"],
  ["internet?", "Am I online?"],
  ["uptime?", "Time since restart"],
  ["time?", "Current time"],
  ["timer?", "Focus session left"],
  ["reminders?", "Upcoming reminders"],
  ["notes?", "Recent notes"],
];
const suggestEl = $("suggest");
let sugg = [], suggAt = 0;

function suggestions(t) {
  if (t.startsWith("/") && !t.includes(" ")) {
    const q = t.toLowerCase();
    return COMMANDS.filter(([c]) => c.startsWith(q)).map(([c, ex, d]) => ({ label: c, desc: d, kind: "do", fill: ex ? c + " " : null, run: ex ? null : c }));
  }
  if (t.startsWith("?")) {
    const q = t.slice(1).trim().toLowerCase();
    return QUESTIONS.filter(([l]) => l.includes(q)).map(([l, d]) =>
      l.includes(" ?") ? { label: "weather in …?", desc: d, kind: "ask", fill: "weather in ?", caret: 11 } : { label: l, desc: d, kind: "ask", run: l });
  }
  return [];
}

function renderSuggest() {
  const was = !suggestEl.hidden;
  sugg = suggestions(chatInput.value);
  suggAt = Math.min(suggAt, Math.max(sugg.length - 1, 0));
  suggestEl.textContent = "";
  sugg.forEach((s, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    if (i === suggAt) { li.className = "on"; li.setAttribute("aria-selected", "true"); }
    const b = document.createElement("b");
    b.className = s.kind;
    b.textContent = s.label;
    const d = document.createElement("span");
    d.textContent = s.desc;
    li.append(b, d);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); pickSuggest(i); });
    suggestEl.appendChild(li);
  });
  suggestEl.hidden = sugg.length === 0;
  $("chips").hidden = !suggestEl.hidden;
  suggestEl.children[suggAt]?.scrollIntoView({ block: "nearest" });
  if (was !== !suggestEl.hidden) sendHit(true);
}

function pickSuggest(i) {
  const s = sugg[i];
  if (!s) return;
  if (s.run) { submit(s.run); return; }
  chatInput.value = s.fill;
  const at = s.caret ?? s.fill.length;
  chatInput.setSelectionRange(at, at);
  chatInput.focus();
  reflect();
}

function reflect() {
  const t = chatInput.value;
  const k = t.trim() ? shapeOf(t) : "note";
  renderSuggest();
  const cmd = k === "do" && COMMANDS.find(([c, ex]) => ex && t.trim() === c);
  if (cmd) { chatHint.textContent = `e.g. ${cmd[0]} ${cmd[1]}`; chatHint.className = k; chatSend.textContent = "Run"; chatSend.className = k; return; }
  chatHint.textContent = { do: "Enter runs the command", ask: "Enter asks", note: "Enter saves a note" }[k];
  chatHint.className = k === "note" ? "" : k;
  chatSend.textContent = { do: "Run", ask: "Ask", note: "Save" }[k];
  chatSend.className = k === "note" ? "" : k;
}

function positionChat() {
  const w = 320;
  if (signMode()) {
    const s = signEl.getBoundingClientRect();
    chatEl.style.left = clamp(s.left + s.width / 2 - w / 2, 8, window.innerWidth - w - 8) + "px";
    chatEl.style.bottom = "auto";
    chatEl.style.top = s.bottom + 10 + "px";
    return;
  }
  chatEl.style.left = clamp(x + W / 2 - w / 2, 8, window.innerWidth - w - 8) + "px";
  if (topMode()) {
    // Pet hangs from the top, so the chat drops down from under its feet.
    chatEl.style.bottom = "auto";
    chatEl.style.top = petTop() + H + 12 + "px";
  } else {
    chatEl.style.top = "auto";
    chatEl.style.bottom = window.innerHeight - petTop() + (badgeEl.hidden ? 14 : 34) + "px";
  }
}

function openChat() {
  interrupt();
  forcedSleep = false;
  touched();
  hush();
  closeMenu();
  petEl.classList.remove("sleeping");
  char && char.setEyes(1);
  mode = "chat";
  setBreathe(true);
  positionChat();
  chatEl.hidden = false;
  $("chatClear").hidden = chatLog.children.length === 0;
  reflect();
  invoke("focus_pet").catch(() => {});
  setTimeout(() => chatInput.focus(), 30);
  sendHit(true);
}

function closeChat(resume = true) {
  chatEl.hidden = true;
  chatInput.blur();
  if (peekMode) peekUntil = performance.now() + 500; // slide away shortly after
  sendHit(true);
  if (resume) brain();
}

function clearChat() {
  chatLog.textContent = "";
  $("chatClear").hidden = true;
  chatInput.focus();
  sendHit(true);
}
$("chatClear").addEventListener("click", (e) => { e.stopPropagation(); clearChat(); });

function addTurn(q, ans) {
  const p = document.createElement("p");
  p.className = "q";
  p.textContent = q;
  const a = document.createElement("div");
  a.className = "a pending";
  a.textContent = "…";
  chatLog.append(p, a);
  while (chatLog.children.length > 8) chatLog.firstChild.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
  $("chatClear").hidden = false;
  return (res) => {
    a.className = "a " + (res.kind || "answer");
    a.textContent = "";
    const b = document.createElement("b");
    b.textContent = res.title;
    a.appendChild(b);
    if (res.lines && res.lines.length) {
      const ul = document.createElement("ul");
      res.lines.forEach((l) => { const li = document.createElement("li"); li.textContent = l; ul.appendChild(li); });
      a.appendChild(ul);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
    sendHit(true);
  };
}

async function submit(text) {
  text = text.trim();
  if (!text) return;
  chatInput.value = "";
  reflect();
  const finish = addTurn(text);
  let res;
  try {
    res = await invoke("ask", { text });
  } catch (e) {
    res = { kind: "error", title: "Something went wrong.", lines: [String(e)] };
  }
  finish(res);
  char && char.talk(900);
  act(res.action);
}

function act(action) {
  if (!action) return;
  if (action === "wave") char && char.wave(3);
  if (action === "sleep") { forcedSleep = true; closeChat(); }
  if (action === "hide") setTimeout(() => { closeChat(false); invoke("set_pet_visible", { visible: false }); }, 900);
  if (action === "quit") setTimeout(() => invoke("quit_app"), 900);
}

chatInput.addEventListener("input", () => { suggAt = 0; reflect(); });
chatInput.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (!suggestEl.hidden) {
    const n = sugg.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      suggAt = (suggAt + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderSuggest();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSuggest(suggAt); return; }
    if (e.key === "Escape") { e.stopPropagation(); chatInput.value = ""; reflect(); return; }
  }
  if (e.key === "Enter") { e.preventDefault(); submit(chatInput.value); }
});
chatSend.addEventListener("click", () => submit(chatInput.value));
$("chips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-q]");
  if (b) submit(b.dataset.q);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!menuEl.hidden) closeMenu(); else if (!chatEl.hidden) closeChat(); }
});
window.addEventListener("blur", () => {
  if (!chatEl.hidden && !chatInput.value.trim()) closeChat();
});

// ------------------------------------------------------------ right-click menu
artEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = clamp(e.clientX, 4, window.innerWidth - r.width - 4) + "px";
  menuEl.style.top = clamp(e.clientY - r.height, 4, window.innerHeight - r.height - 4) + "px";
  sendHit(true);
});
function closeMenu() {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  sendHit(true);
}
menuEl.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  closeMenu();
  const a = b.dataset.act;
  if (a === "chat") openChat();
  if (a === "focus") invoke("start_session", {});
  if (a === "sleep") { forcedSleep = true; brain(); }
  if (a === "settings") invoke("open_settings");
  if (a === "hide") invoke("set_pet_visible", { visible: false });
  if (a === "quit") invoke("quit_app");
});
document.addEventListener("pointerdown", (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
});

// ------------------------------------------------------------ events from Rust
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

let sessionPaused = false;
let sessionActive = false;
listen("tick", ({ payload: p }) => {
  bedtime = !!p.bedtime;
  sessionPaused = !!p.sessionPaused;
  sessionActive = p.sessionLeft != null;
  sessionLeft = p.sessionLeft;
  if (sessionActive) {
    badgeEl.textContent = (sessionPaused ? "❚❚ " : "") + fmt(p.sessionLeft);
    badgeEl.classList.toggle("paused", sessionPaused);
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }
  updateSign();   // keeps the notch sign's clock/countdown live (no-op otherwise)
});
// Click the countdown badge for quick focus controls.
badgeEl.style.pointerEvents = "auto";
badgeEl.style.cursor = "pointer";
badgeEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!sessionActive) return;
  say(sessionPaused ? "Focus paused" : "Focus running", {
    ms: 0, alert: true,
    actions: sessionPaused
      ? [
          { label: "Resume", act: () => invoke("resume_session") },
          { label: "End", act: () => invoke("stop_session") },
        ]
      : [
          { label: "Pause", act: () => invoke("pause_session") },
          { label: "End", act: () => invoke("stop_session") },
        ],
  });
});
listen("session-started", ({ payload: m }) => {
  touched();
  peekFor(5000);
  say(`Focus time — ${m} min. I'll keep watch.`);
});
listen("session-stopped", () => { badgeEl.hidden = true; });
listen("session-busy", () => {
  touched();
  peekFor(PEEK.nudge);
  say("You're already in a focus session.", {
    ms: 0, alert: true,
    actions: [
      { label: "Keep going", act: () => {} },
      { label: "End it", act: () => invoke("stop_session") },
    ],
  });
});
listen("session-paused", () => { peekFor(3000); say("Focus paused.", { ms: 2500 }); });
listen("session-resumed", () => { peekFor(2500); say("Back to it.", { ms: 2000 }); });
listen("session-done", ({ payload }) => {
  // Payload is { minutes, today, streak } (older/preview builds send a number).
  const p = (payload && typeof payload === "object") ? payload : { minutes: payload };
  const today = p.today || 0, streak = p.streak || 0;
  const big = streak >= 2;            // a running day-streak → a bigger party
  badgeEl.hidden = true;
  if (cfg.session.chime) chime("done");
  forcedSleep = false;
  touched();
  // Stop whatever it was doing and throw a little party.
  interrupt();
  mode = "idle";
  petEl.classList.remove("sleeping");
  char && char.setEyes(1);
  hop(19);
  setTimeout(() => hop(13), 240);
  celebrate(big ? "🔥" : "🎉", big ? 5 : 4);
  const tally = today > 0
    ? (big ? `That's ${today} today · ${streak}-day streak 🔥` : `That's ${today} today 🎉`)
    : "Nice work.";
  signFlash(big ? "Done 🔥" : "Done 🎉", tally);
  setTimeout(() => { peekFor(PEEK.long); say(`Session done! ${tally} Take a short break.`, {
    ms: 0, alert: true,
    actions: [
      { label: "Another " + (cfg.session.minutes || 25), act: () => invoke("start_session", {}) },
      { label: "Done", act: () => {} },
    ],
  }); }, 720);
  setTimeout(brain, 1100);           // resume idle life after the celebration
});
listen("reminder", ({ payload: r }) => {
  chime("remind");
  forcedSleep = false;
  touched();
  peekFor(PEEK.nudge);
  brain();
  signFlash(r.text, "Reminder");
  say(r.text, {
    ms: 0, alert: true, small: "Reminder",
    actions: [
      { label: "Snooze 10m", act: () => invoke("ask", { text: `/remind ${r.text} in 10 min` }) },
      { label: "Dismiss", act: () => {} },
    ],
  });
});
listen("water", () => {
  touched();
  peekFor(PEEK.nudge);
  char && char.wave(1);
  signFlash("Time for water 💧", "Wellbeing");
  say("Time for a sip of water 💧", {
    ms: 0, alert: true,
    actions: [
      { label: "Done", act: () => {} },
      { label: "Snooze 10m", act: () => invoke("snooze_water", { minutes: 10 }) },
      { label: "Turn off", act: () => invoke("ask", { text: "/water off" }) },
    ],
  });
});
listen("routine", ({ payload: r }) => {
  chime("remind");
  forcedSleep = false;
  touched();
  peekFor(PEEK.nudge);
  brain();
  signFlash(r.label, "Routine");
  say(r.label, {
    ms: 0, alert: true, small: "Routine",
    actions: [
      { label: "Done", act: () => {} },
      { label: "Snooze 10m", act: () => invoke("snooze_routine", { id: r.id, minutes: 10 }) },
      { label: "Stop", act: () => invoke("set_routine_enabled", { id: r.id, enabled: false }) },
    ],
  });
});
listen("update-available", ({ payload: u }) => {
  touched();
  peekFor(PEEK.nudge);
  say(`Dockmate ${u.version} is out!`, {
    ms: 0, alert: true, small: "Update",
    actions: [
      { label: "Download", act: () => invoke("open_release", { url: u.url }) },
      { label: "Later", act: () => {} },
    ],
  });
});
listen("bedtime", () => {
  peekFor(6500);
  say("It's getting late. Goodnight!", { ms: 6000 });
});
listen("cursor", ({ payload }) => onCursor(payload));
listen("open-chat", () => openChat());
listen("config-changed", ({ payload }) => {
  const wasHome = cfg.pet.home;
  cfg = payload;
  const wasPeek = peekMode;
  peekMode = !!cfg.pet.peek;
  applySize();
  const homeChanged = (cfg.pet.home || "dock") !== (wasHome || "dock");
  if (homeChanged) { lift = 0; bob = 0; tilt = 0; sx = 1; sy = 1; x = homeX(); applySignMode(); }
  if (peekMode !== wasPeek || homeChanged) { peekUntil = 0; brain(); } // re-home / resume
  updateSign(); // refresh the sign's streak/clock after any config change
});
listen("character-changed", () => mountCharacter());
listen("pet-visible", ({ payload: v }) => { if (v) brain(); });

if (!inTauri) window.addEventListener("mousemove", (e) => onCursor({ x: e.clientX, y: e.clientY }));
window.addEventListener("resize", () => { applySize(); if (!chatEl.hidden) positionChat(); });

// ------------------------------------------------------------ start
async function mountCharacter() {
  const svg = await loadCharacterSvg();
  char && char.destroy();
  try {
    char = new Character(artEl, svg);
    if (!(await drawsSomething(char.svg))) throw new Error("it draws nothing visible");
  } catch (e) {
    log("custom character failed, using default:", e.message);
    char && char.destroy();
    char = new Character(artEl, await (await fetch("characters/default.svg")).text());
  }
  applySize();
}

await mountCharacter();
// Start grounded at centre so the pet is exactly where you'd look, just
// above the Dock. (The drop-in entrance is nice but can park it mid-screen
// if the window is still resizing to the work area on first paint.)
x = roamMax(); // start tucked in the bottom-right
lift = 0;
mode = "idle";
setBreathe(true);
place();
applySignMode();
log("pet mounted", { W, H, x, innerW: window.innerWidth, innerH: window.innerHeight });
invoke("pet_ready", { w: window.innerWidth, h: window.innerHeight }).catch(() => {});
requestAnimationFrame(frame);
// In peek mode the pet stays tucked away until a nudge; no launch greeting.
if (signMode()) {
  setTimeout(() => signFlash("Hi — tap me for options", ""), 900);
} else if (!peekMode) {
  setTimeout(() => {
    const name = (cfg.pet.userName || "").trim();
    say(name ? `Hi ${name}! Triple-tap me to chat.` : "Hi! Triple-tap me to chat.", { ms: 5000 });
  }, 900);
}
