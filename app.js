/* ==========================================================================
   PICAS — Telegram Mini App logic

   How identity works here (read this before changing anything):
   Telegram signs every Mini App session with "initData" — a string that
   proves which Telegram user opened the app, signed with YOUR bot token.
   We send initData with every request; the backend re-verifies the
   signature itself (see backend/routes/auth.js). We never trust a
   telegram_id the client sends on its own — only one that comes wrapped
   inside a valid, signed initData string.

   A user only has to bind an email/Google account ONCE. After that,
   their telegram_id already matches a saved user record, so opening the
   Mini App from Telegram is enough — no separate login step.
   ========================================================================== */

const API_BASE = "https://euphemism-uninstall-unmixable.ngrok-free.dev/"; // <-- replace after deploying backend

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const initData = tg?.initData || "";

// ----- DOM refs ------------------------------------------------------------
const authScreen = document.getElementById("auth-screen");
const mainScreen = document.getElementById("main-screen");

const googleBtn = document.getElementById("google-signin-btn");
const emailForm = document.getElementById("email-form");
const emailInput = document.getElementById("email-input");
const otpForm = document.getElementById("otp-form");
const otpInput = document.getElementById("otp-input");
const otpEmailEcho = document.getElementById("otp-email-echo");
const authError = document.getElementById("auth-error");

const userLabel = document.getElementById("user-label");
const pointsValue = document.getElementById("points-value");
const rateHint = document.getElementById("rate-hint");
const todayTaps = document.getElementById("today-taps");
const timeLeftEl = document.getElementById("time-left");
const tapOrb = document.getElementById("tap-orb");
const boostRing = document.getElementById("boost-ring");
const floatLayer = document.getElementById("float-layer");
const watchAdBtn = document.getElementById("watch-ad-btn");
const boostTimerEl = document.getElementById("boost-timer");
const capBanner = document.getElementById("cap-banner");

// ----- Local session state (server is always the source of truth) --------
let state = {
  points: 0,
  todayTapsCount: 0,
  dailySecondsUsed: 0,
  dailySecondsCap: 5 * 60 * 60, // 5 hours — mirrors backend config
  boostExpiresAt: null,
  capped: false,
};

let pendingEmail = null;

// ==========================================================================
// API helper — every call carries initData so the backend can verify it
// ==========================================================================

async function api(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Something went wrong. Try again.");
  }
  return data;
}

// ==========================================================================
// Boot sequence
// ==========================================================================

async function boot() {
  if (!initData) {
    showAuthError("Open PICAS from the Telegram bot, not a regular browser.");
    return;
  }

  try {
    const res = await api("/api/session", {});
    if (res.bound) {
      enterApp(res.user);
    } else {
      authScreen.classList.remove("hidden");
    }
  } catch (err) {
    showAuthError(err.message);
  }
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}

// ==========================================================================
// Auth — email OTP path
// ==========================================================================

emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.classList.add("hidden");
  const email = emailInput.value.trim();
  try {
    await api("/api/auth/email/request-otp", { email });
    pendingEmail = email;
    otpEmailEcho.textContent = email;
    otpForm.classList.remove("hidden");
  } catch (err) {
    showAuthError(err.message);
  }
});

otpForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.classList.add("hidden");
  try {
    const res = await api("/api/auth/email/verify-otp", {
      email: pendingEmail,
      otp: otpInput.value.trim(),
    });
    enterApp(res.user);
  } catch (err) {
    showAuthError(err.message);
  }
});

// ==========================================================================
// Auth — Google path
// Uses Google Identity Services. Loaded lazily so the page stays light
// if someone only ever uses the email path.
// ==========================================================================

googleBtn.addEventListener("click", () => {
  if (!window.google?.accounts?.id) {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = startGoogleFlow;
    document.head.appendChild(script);
  } else {
    startGoogleFlow();
  }
});

function startGoogleFlow() {
  google.accounts.id.initialize({
    client_id: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com", // <-- replace
    callback: async (response) => {
      try {
        const res = await api("/api/auth/google", { idToken: response.credential });
        enterApp(res.user);
      } catch (err) {
        showAuthError(err.message);
      }
    },
  });
  google.accounts.id.prompt();
}

// ==========================================================================
// Entering the app after a successful bind / returning session
// ==========================================================================

function enterApp(user) {
  authScreen.classList.add("hidden");
  mainScreen.classList.remove("hidden");

  userLabel.textContent = user.displayName || "Miner";
  state.points = user.points;
  state.todayTapsCount = user.todayTaps;
  state.dailySecondsUsed = user.dailySecondsUsed;
  state.dailySecondsCap = user.dailySecondsCap;
  state.boostExpiresAt = user.boostExpiresAt ? new Date(user.boostExpiresAt) : null;
  state.capped = user.dailySecondsUsed >= user.dailySecondsCap;

  renderAll();
  tickClock();
  setInterval(tickClock, 1000);
}

// ==========================================================================
// Tapping
// ==========================================================================

let tapInFlight = false;

tapOrb.addEventListener("click", async () => {
  if (state.capped || tapInFlight) return;

  // Optimistic UI: show the points we *expect*, then reconcile with the
  // server's response — the server always has the final word.
  const boosted = state.boostExpiresAt && state.boostExpiresAt > new Date();
  const optimisticGain = boosted ? 40 : 10;
  spawnFloatingGain(optimisticGain, boosted);
  pulseOrb();
  tg?.HapticFeedback?.impactOccurred?.("light");

  tapInFlight = true;
  try {
    const res = await api("/api/tap", {});
    state.points = res.points;
    state.todayTapsCount = res.todayTaps;
    state.dailySecondsUsed = res.dailySecondsUsed;
    state.capped = res.capped;
    renderAll();
  } catch (err) {
    // Roll back silently — a failed tap just doesn't count.
    console.warn("Tap failed:", err.message);
  } finally {
    tapInFlight = false;
  }
});

function pulseOrb() {
  tapOrb.style.transform = "scale(0.92)";
  requestAnimationFrame(() => {
    setTimeout(() => (tapOrb.style.transform = ""), 90);
  });
}

function spawnFloatingGain(amount, boosted) {
  const el = document.createElement("span");
  el.className = "float-pop" + (boosted ? " boosted" : "");
  el.textContent = `+${amount}`;
  el.style.left = `${46 + Math.random() * 8}%`;
  floatLayer.appendChild(el);
  setTimeout(() => el.remove(), 700);
}

// ==========================================================================
// Watching an ad to unlock the boosted rate
//
// Wire this to your ad network's rewarded-ad callback (Adsgram / Monetag
// are the two most commonly used for Telegram Mini Apps and are free to
// integrate). Only call /api/ad/complete once the network confirms the
// ad was actually watched to completion — never on click alone.
// ==========================================================================

watchAdBtn.addEventListener("click", async () => {
  watchAdBtn.disabled = true;
  try {
    // Placeholder: replace this block with your ad SDK's "show rewarded ad"
    // call. It should resolve only after the ad finishes playing.
    await showRewardedAdPlaceholder();

    const res = await api("/api/ad/complete", {});
    state.boostExpiresAt = new Date(res.boostExpiresAt);
    renderAll();
  } catch (err) {
    showAuthError(err.message);
  } finally {
    watchAdBtn.disabled = false;
  }
});

function showRewardedAdPlaceholder() {
  // Replace with: return window.Adsgram.init({ blockId: "..." }).show();
  return new Promise((resolve) => setTimeout(resolve, 1200));
}

// ==========================================================================
// Rendering
// ==========================================================================

function renderAll() {
  pointsValue.textContent = state.points.toLocaleString();
  todayTaps.textContent = state.todayTapsCount.toLocaleString();

  const boosted = state.boostExpiresAt && state.boostExpiresAt > new Date();
  rateHint.textContent = boosted ? "Earning 40 pts / tap" : "Earning 10 pts / tap";
  rateHint.classList.toggle("boosted", boosted);
  boostRing.classList.toggle("hidden", !boosted);
  watchAdBtn.classList.toggle("hidden", boosted);

  tapOrb.disabled = state.capped;
  capBanner.classList.toggle("hidden", !state.capped);
}

function tickClock() {
  const remaining = Math.max(0, state.dailySecondsCap - state.dailySecondsUsed);
  timeLeftEl.textContent = formatHMS(remaining);

  if (state.boostExpiresAt) {
    const boostRemaining = Math.max(0, Math.floor((state.boostExpiresAt - new Date()) / 1000));
    if (boostRemaining > 0) {
      boostTimerEl.textContent = formatHMS(boostRemaining);
      boostTimerEl.classList.remove("hidden");
    } else {
      boostTimerEl.classList.add("hidden");
      boostRing.classList.add("hidden");
      watchAdBtn.classList.remove("hidden");
    }
  }
}

function formatHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

boot();
