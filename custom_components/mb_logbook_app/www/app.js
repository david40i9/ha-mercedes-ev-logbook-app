/* EV Logbook web app: the Android app's screens for an iPhone (or any browser),
 * served by Home Assistant. It signs in with Home Assistant's own login and then
 * sends the same mb_logbook websocket commands as the logbook's sidebar page.
 * It only talks to this Home Assistant (plus OpenStreetMap map tiles). */
"use strict";

const APP_URL = location.origin + "/mb_logbook_app/";
const KM_PER_MI = 1.609344;
const DEFAULT_LABELS = ["Business", "Personal", "Commute"];
const UNTAGGED = "\u0000untagged";
const LOCALE = "en-GB";

// ---------------------------------------------------------------- storage

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("mbl." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("mbl." + key, JSON.stringify(value));
    } catch {
      /* private mode: settings just aren't remembered */
    }
  },
  del(key) {
    try {
      localStorage.removeItem("mbl." + key);
    } catch {
      /* ignore */
    }
  },
};

// ---------------------------------------------------------------- sign in

/** Signed out, or Home Assistant no longer accepts the saved login. */
class SignedOut extends Error {}

/**
 * Home Assistant's own login (its OAuth-style auth API). The page's address is
 * the client_id and the redirect, so HA accepts it without any setup, and only
 * a refresh token for this Home Assistant is kept on the phone.
 */
const Auth = {
  tokens: store.get("tokens", null),

  login() {
    const state = Math.random().toString(36).slice(2);
    store.set("state", state);
    const q = new URLSearchParams({ response_type: "code", client_id: APP_URL, redirect_uri: APP_URL, state });
    location.href = "/auth/authorize?" + q;
  },

  /** Back from the login page with ?code=…: swap the code for tokens. */
  async finishLogin() {
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    if (!code) return;
    history.replaceState(null, "", APP_URL);
    if (q.get("state") !== store.get("state")) throw new Error("The sign-in didn't match. Please try again.");
    store.del("state");
    await this.token({ grant_type: "authorization_code", code, client_id: APP_URL });
  },

  async token(params) {
    const r = await fetch("/auth/token", { method: "POST", body: new URLSearchParams(params) });
    if (!r.ok) {
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        this.clear();
        throw new SignedOut();
      }
      throw new Error(`Home Assistant answered ${r.status}`);
    }
    const j = await r.json();
    this.tokens = {
      access: j.access_token,
      refresh: j.refresh_token || this.tokens?.refresh,
      expires: Date.now() + (j.expires_in || 1800) * 1000,
    };
    store.set("tokens", this.tokens);
  },

  /** A current access token, refreshed when it's about to run out. */
  async access() {
    if (!this.tokens?.refresh) throw new SignedOut();
    if (Date.now() > this.tokens.expires - 60000) {
      await this.token({ grant_type: "refresh_token", refresh_token: this.tokens.refresh, client_id: APP_URL });
    }
    return this.tokens.access;
  },

  async logout() {
    const refresh = this.tokens?.refresh;
    this.clear();
    if (refresh) {
      try {
        await fetch("/auth/token", { method: "POST", body: new URLSearchParams({ action: "revoke", token: refresh }) });
      } catch {
        /* signed out here anyway */
      }
    }
  },

  clear() {
    this.tokens = null;
    store.del("tokens");
  },
};

// ---------------------------------------------------------------- websocket

/** One websocket to Home Assistant; reconnects on the next call after a drop. */
const Ha = {
  ws: null,
  ready: null,
  nextId: 1,
  pending: new Map(),

  connect() {
    if (this.ready) return this.ready;
    const attempt = new Promise((resolve, reject) => {
      Auth.access().then((token) => {
        const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/api/websocket");
        const fail = (err) => {
          clearTimeout(timer);
          if (this.ws === ws) {
            this.ws = null;
            this.ready = null;
          }
          for (const p of this.pending.values()) p.reject(err);
          this.pending.clear();
          reject(err);
        };
        const timer = setTimeout(() => {
          ws.close();
          fail(new Error("Couldn't reach Home Assistant"));
        }, 20000);
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
          else if (m.type === "auth_ok") {
            clearTimeout(timer);
            resolve();
          } else if (m.type === "auth_invalid") {
            Auth.clear();
            fail(new SignedOut());
            ws.close();
          } else if (m.type === "result") {
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            if (m.success) p.resolve(m.result);
            else {
              const err = new Error(m.error?.message || "Request failed");
              err.code = m.error?.code;
              p.reject(err);
            }
          }
        };
        ws.onclose = () => fail(new Error("Connection to Home Assistant lost"));
        this.ws = ws;
      }, (err) => {
        this.ready = null;
        reject(err);
      });
    });
    this.ready = attempt;
    return attempt;
  },

  async call(type, params = {}) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Home Assistant didn't answer"));
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, type, ...params }));
    });
  },

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
    this.ready = null;
  },
};

// ---------------------------------------------------------------- formatting

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Number formatting for one car: its distance unit and currency. */
function makeFmt(car) {
  const miles = car?.unit === "mi";
  let money;
  try {
    money = new Intl.NumberFormat(LOCALE, { style: "currency", currency: car?.currency || "GBP" });
  } catch {
    money = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "GBP" });
  }
  const f = {
    distUnit: miles ? "mi" : "km",
    effUnit: miles ? "mi/kWh" : "kWh/100km",
    distNum: (km) => (miles ? km / KM_PER_MI : km),
    dist: (km, digits = 0) => f.distNum(km).toFixed(digits),
    distU: (km, digits = 0) => `${f.dist(km, digits)} ${f.distUnit}`,
    eff: (km, kwh) => (km > 0 && kwh > 0 ? (miles ? km / KM_PER_MI / kwh : (kwh / km) * 100) : null),
    money: (v) => (v == null ? "–" : money.format(v)),
  };
  return f;
}

const date = (ts) => new Date(ts * 1000);
const day = (ts) => date(ts).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });
const time = (ts) => date(ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
const pct = (v) => (v == null ? "–" : `${v.toFixed(0)}%`);
const pad = (n) => String(n).padStart(2, "0");
const monthKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthKey = (ts) => monthKeyOf(date(ts));

function monthName(key, long = false) {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString(LOCALE, long ? { month: "long", year: "numeric" } : { month: "short" });
}

function duration(seconds) {
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const hours = (h) => (h < 48 ? `${h.toFixed(0)} h` : `${(h / 24).toFixed(1)} days`);

/** The first day of the month [back] months ago, local time. */
function monthStart(back) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - back, 1);
}

function metres(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** "2.1 mi NE of Home": the closest named place or zone. Worked out here, nothing is sent. */
function nearestLabel(lat, lon, marks, fmt) {
  let best = null;
  let bestM = Infinity;
  for (const m of marks) {
    const d = metres(lat, lon, m.lat, m.lon);
    if (d < bestM) {
      best = m;
      bestM = d;
    }
  }
  if (!best) return null;
  const rad = Math.PI / 180;
  const dLon = (lon - best.lon) * rad;
  const y = Math.sin(dLon) * Math.cos(lat * rad);
  const x = Math.cos(best.lat * rad) * Math.sin(lat * rad) - Math.sin(best.lat * rad) * Math.cos(lat * rad) * Math.cos(dLon);
  const deg = ((Math.atan2(y, x) / rad) + 360) % 360;
  return `${fmt.distU(bestM / 1000, 1)} ${COMPASS[Math.round(deg / 45) % 8]} of ${best.name}`;
}

const typeName = (t) => (t == null ? "All types" : t === UNTAGGED ? "No type" : t);
const matches = (trip, type) => type == null || (type === UNTAGGED ? !trip.label : trip.label === type);

// ---------------------------------------------------------------- icons

const ICONS = {
  left: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  right: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  down: "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z",
  up: "M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z",
  drop: "M7 10l5 5 5-5z",
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  refresh:
    "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z",
  more: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  home: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  trips: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  bolt: "M7 2v11h3v9l7-12h-4l4-8z",
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

// ---------------------------------------------------------------- state

const TABS = [
  ["home", "Home", "home"],
  ["trips", "Trips", "trips"],
  ["charge", "Charge", "bolt"],
];

const S = {
  screen: "loading", // loading | signin | app
  signinError: null,
  tab: store.get("tab", "home"),
  cars: null, // Load
  car: null,
  back: 0, // trips and charge tabs: months back
  overviewBack: 0,
  type: null, // trip type filter
  stats: null,
  yearTrips: null,
  trips: null,
  charges: null,
  labels: DEFAULT_LABELS,
  landmarks: [],
  openTrip: null,
  tripPoints: null,
  folded: new Set(store.get("folded", [])),
  saving: false,
  loadedAt: 0,
};
if (!TABS.some((t) => t[0] === S.tab)) S.tab = "home";

/** Something loading: { loading }, { value } or { error }. */
const LOADING = { loading: true };
const ready = (value) => ({ value });
const failed = (e) => ({ error: e?.message || String(e) });

async function attempt(promise) {
  try {
    return ready(await promise);
  } catch (e) {
    if (e instanceof SignedOut) signedOut();
    return failed(e);
  }
}

const fmt = () => makeFmt(S.car);

// ---------------------------------------------------------------- loading

async function start() {
  try {
    await Auth.finishLogin();
  } catch (e) {
    S.screen = "signin";
    S.signinError = e instanceof SignedOut ? "Home Assistant didn't accept the sign-in. Please try again." : e.message;
    return render();
  }
  if (!Auth.tokens) {
    S.screen = "signin";
    return render();
  }
  S.screen = "app";
  refresh();
}

function signedOut() {
  Ha.close();
  Auth.clear();
  S.screen = "signin";
  S.signinError = "You've been signed out of Home Assistant. Please sign in again.";
  closeTrip(true);
  render();
}

async function refresh() {
  S.cars = LOADING;
  S.loadedAt = Date.now();
  render();
  const cars = await attempt(Ha.call("mb_logbook/cars"));
  if (S.screen !== "app") return;
  S.cars = cars;
  if (cars.value) {
    const keep = S.car?.entry_id ?? store.get("car", null);
    S.car = cars.value.find((c) => c.entry_id === keep) || cars.value[0] || null;
  }
  render();
  if (!S.car) return;
  loadStats();
  loadPeriod();
  loadLabels();
  loadLandmarks();
}

function loadStats() {
  const entry = S.car.entry_id;
  S.stats = LOADING;
  S.yearTrips = LOADING;
  attempt(Ha.call("mb_logbook/stats", { entry_id: entry, months: 12 })).then((r) => {
    if (S.car?.entry_id !== entry) return;
    S.stats = r;
    render();
  });
  const start = monthStart(11).getTime() / 1000;
  attempt(Ha.call("mb_logbook/trips", { entry_id: entry, start })).then((r) => {
    if (S.car?.entry_id !== entry) return;
    S.yearTrips = r;
    render();
  });
}

let periodSeq = 0;
function loadPeriod() {
  const entry = S.car.entry_id;
  const seq = ++periodSeq;
  const start = monthStart(S.back).getTime() / 1000;
  const end = monthStart(S.back - 1).getTime() / 1000;
  S.trips = LOADING;
  S.charges = LOADING;
  render();
  const done = Promise.all([
    attempt(Ha.call("mb_logbook/trips", { entry_id: entry, start, end })),
    attempt(Ha.call("mb_logbook/charges", { entry_id: entry, start, end })),
  ]).then(([t, c]) => {
    if (seq !== periodSeq) return;
    S.trips = t;
    S.charges = c;
    render();
  });
  return done;
}

function loadLabels() {
  Ha.call("mb_logbook/labels").then((a) => {
    if (Array.isArray(a) && a.length) {
      S.labels = a;
      render();
    }
  }, () => {});
}

/** Named places and HA zones, to say where an unnamed stop is. Either may fail quietly. */
async function loadLandmarks() {
  const marks = [];
  try {
    for (const p of await Ha.call("mb_logbook/places")) marks.push({ name: p.name, lat: p.lat, lon: p.lon });
  } catch {
    /* none */
  }
  try {
    for (const s of await Ha.call("get_states")) {
      const a = s.attributes || {};
      if (s.entity_id?.startsWith("zone.") && a.latitude != null && a.longitude != null && a.friendly_name) {
        marks.push({ name: a.friendly_name, lat: a.latitude, lon: a.longitude });
      }
    }
  } catch {
    /* none */
  }
  S.landmarks = marks;
  renderPage();
}

// ---------------------------------------------------------------- edits

let toastTimer = null;
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

/** Send an admin command, show what happened, then [done]. */
async function edit(type, params, done) {
  if (S.saving) return;
  S.saving = true;
  renderPage();
  try {
    await Ha.call(type, params);
    await done();
  } catch (e) {
    if (e instanceof SignedOut) return signedOut();
    toast(
      e.code === "unauthorized" || /unauthori[sz]ed/i.test(e.message)
        ? "Only a Home Assistant administrator can change the logbook."
        : e.message,
    );
  } finally {
    S.saving = false;
    render();
  }
}

function setTripLabel(trip, label) {
  edit("mb_logbook/trip_label", { trip_id: trip.id, label: label ?? "" }, async () => {
    if (label == null) {
      // Cleared: the place's default type may now apply, which only HA knows.
      toast("Type cleared");
      await reloadAfterEdit(trip.id);
    } else {
      if (!S.labels.includes(label)) S.labels = [...S.labels, label];
      const updated = { ...trip, label, label_auto: false };
      if (S.openTrip?.id === trip.id) S.openTrip = updated;
      if (S.trips?.value) S.trips = ready(S.trips.value.map((t) => (t.id === trip.id ? updated : t)));
      if (S.yearTrips?.value) S.yearTrips = ready(S.yearTrips.value.map((t) => (t.id === trip.id ? updated : t)));
      toast(`Marked as ${label}`);
    }
  });
}

function fixTrip(trip, what) {
  const asks = {
    split: ["mb_logbook/split_trip", "Split this trip? It's cut in two at its longest stop (20 minutes or more).", "Trip split in two"],
    merge: ["mb_logbook/merge_trips", "Merge this trip with the car's next one?", "Merged with the next trip"],
    delete: ["mb_logbook/delete_trip", "Delete this trip? This can't be undone.", "Trip deleted"],
  };
  const [type, question, done] = asks[what];
  if (!confirm(question)) return;
  edit(type, { trip_id: trip.id }, async () => {
    toast(done);
    closeTrip();
    await reloadAfterEdit(null);
  });
}

/** Reload the figures; keep [keepTrip] open with its fresh row. */
async function reloadAfterEdit(keepTrip) {
  loadStats();
  await loadPeriod();
  if (keepTrip != null && S.openTrip?.id === keepTrip) {
    S.openTrip = S.trips?.value?.find((t) => t.id === keepTrip) || S.openTrip;
    renderPage();
  }
}

// ---------------------------------------------------------------- navigation

function setTab(tab) {
  S.tab = tab;
  store.set("tab", tab);
  render();
  window.scrollTo(0, 0);
}

function shiftMonth(by) {
  const next = Math.min(59, Math.max(0, S.back + by));
  if (next === S.back) return;
  S.back = next;
  loadPeriod();
}

function showTripsOf(type, back) {
  S.type = type;
  if (back !== S.back) {
    S.back = back;
    loadPeriod();
  }
  setTab("trips");
}

function selectCar(id) {
  const car = S.cars?.value?.find((c) => c.entry_id === id);
  if (!car || car.entry_id === S.car?.entry_id) return;
  S.car = car;
  store.set("car", id);
  loadStats();
  loadPeriod();
}

function toggleFold(key) {
  if (S.folded.has(key)) S.folded.delete(key);
  else S.folded.add(key);
  store.set("folded", [...S.folded]);
  render();
}

function openTrip(id) {
  const trip = (S.trips?.value || []).find((t) => t.id === id) || (S.yearTrips?.value || []).find((t) => t.id === id);
  if (!trip) return;
  S.openTrip = trip;
  S.tripPoints = LOADING;
  history.pushState({ trip: id }, "");
  renderPage();
  attempt(Ha.call("mb_logbook/trip_points", { trip_id: id })).then((r) => {
    if (S.openTrip?.id !== id) return;
    S.tripPoints = r;
    renderPage();
  });
}

/** Close the trip page; [fromHistory] when the back gesture already popped it. */
function closeTrip(fromHistory = false) {
  if (!S.openTrip) return;
  S.openTrip = null;
  S.tripPoints = null;
  renderPage();
  if (!fromHistory && history.state?.trip) history.back();
}

window.addEventListener("popstate", () => closeTrip(true));

// ---------------------------------------------------------------- sheet (pick from a list)

let sheetActions = [];
/** A bottom sheet: [options] are { text, note?, danger?, run }. */
function sheet(title, options) {
  sheetActions = options.map((o) => o.run);
  document.getElementById("sheet").innerHTML = `<div class="scrim" data-act="sheet-close"><div class="sheet">
    ${title ? `<div class="title">${esc(title)}</div>` : ""}
    ${options
      .map(
        (o, i) =>
          `<button data-act="sheet" data-i="${i}" class="${o.danger ? "danger" : ""}"><span class="grow">${esc(o.text)}</span>${
            o.note != null ? `<span class="count">${esc(o.note)}</span>` : ""
          }</button>`,
      )
      .join("")}
    <button data-act="sheet-close" class="dim">Cancel</button>
  </div></div>`;
}

function closeSheet() {
  document.getElementById("sheet").innerHTML = "";
  sheetActions = [];
}

function typeSheet(trip) {
  const opts = S.labels.map((l) => ({
    text: trip.label === l && !trip.label_auto ? `✓ ${l}` : l,
    run: () => setTripLabel(trip, l),
  }));
  opts.push({ text: "Other…", run: () => askOtherType(trip) });
  if (trip.label && !trip.label_auto) opts.push({ text: "Clear type", run: () => setTripLabel(trip, null) });
  sheet(`${trip.start_place || "Unnamed"} → ${trip.end_place || "Unnamed"}`, opts);
}

function askOtherType(trip) {
  const text = (prompt("Trip type") || "").trim().slice(0, 30);
  if (text) setTripLabel(trip, text);
}

function filterSheet() {
  const all = S.trips?.value || [];
  const used = [...new Set(all.map((t) => t.label).filter(Boolean))];
  const options = [null, ...DEFAULT_LABELS, ...used.filter((l) => !DEFAULT_LABELS.includes(l))];
  if (all.some((t) => !t.label)) options.push(UNTAGGED);
  sheet(
    "Show",
    options.map((o) => ({
      text: typeName(o),
      note: String(o == null ? all.length : all.filter((t) => matches(t, o)).length),
      run: () => {
        S.type = o;
        render();
      },
    })),
  );
}

function menuSheet() {
  const opts = [];
  for (const c of S.cars?.value || []) {
    if ((S.cars.value || []).length > 1) {
      opts.push({ text: c.entry_id === S.car?.entry_id ? `✓ ${c.name}` : c.name, run: () => selectCar(c.entry_id) });
    }
  }
  opts.push({ text: "Reload", run: () => refresh() });
  opts.push({
    text: "Sign out",
    danger: true,
    run: async () => {
      await Auth.logout();
      Ha.close();
      S.screen = "signin";
      S.signinError = null;
      render();
    },
  });
  sheet(location.host, opts);
}

// ---------------------------------------------------------------- events

const ACTIONS = {
  tab: (el) => setTab(el.dataset.arg),
  month: (el) => shiftMonth(Number(el.dataset.arg)),
  ovmonth: (el) => {
    S.overviewBack = Number(el.dataset.arg);
    render();
  },
  fold: (el) => toggleFold(el.dataset.arg),
  pick: (el) => showTripsOf(el.dataset.arg === "" ? null : el.dataset.arg, S.overviewBack),
  bar: (el) => {
    S.overviewBack = Number(el.dataset.arg);
    render();
  },
  filter: () => filterSheet(),
  menu: () => menuSheet(),
  refresh: () => refresh(),
  signin: () => Auth.login(),
  trip: (el) => openTrip(Number(el.dataset.arg)),
  "trip-close": () => closeTrip(),
  label: (el) => {
    const t = S.openTrip;
    if (!t) return;
    const l = el.dataset.arg;
    if (t.label !== l || t.label_auto) setTripLabel(t, l);
  },
  "label-other": () => S.openTrip && askOtherType(S.openTrip),
  "label-clear": () => S.openTrip && setTripLabel(S.openTrip, null),
  fix: (el) => S.openTrip && fixTrip(S.openTrip, el.dataset.arg),
  sheet: (el) => {
    const run = sheetActions[Number(el.dataset.i)];
    closeSheet();
    run?.();
  },
  "sheet-close": (el, ev) => {
    if (ev.target === el || el.tagName === "BUTTON") closeSheet();
  },
};

// Hold a trip row to set its type (as on Android). The click that ends a hold is ignored.
let hold = null;
document.addEventListener(
  "touchstart",
  (ev) => {
    const row = ev.target.closest("[data-hold]");
    if (!row) return;
    const t = ev.touches[0];
    const id = Number(row.dataset.hold);
    hold = {
      x: t.clientX,
      y: t.clientY,
      fired: false,
      timer: setTimeout(() => {
        hold.fired = true;
        const trip = (S.trips?.value || []).find((x) => x.id === id);
        if (trip) typeSheet(trip);
      }, 500),
    };
  },
  { passive: true },
);
document.addEventListener(
  "touchmove",
  (ev) => {
    if (!hold) return;
    const t = ev.touches[0];
    if (Math.abs(t.clientX - hold.x) > 10 || Math.abs(t.clientY - hold.y) > 10) clearTimeout(hold.timer);
  },
  { passive: true },
);
document.addEventListener("touchend", () => hold && clearTimeout(hold.timer), { passive: true });
document.addEventListener("contextmenu", (ev) => {
  // Right-click on a computer does the same as a hold.
  const row = ev.target.closest("[data-hold]");
  if (!row) return;
  ev.preventDefault();
  const trip = (S.trips?.value || []).find((x) => x.id === Number(row.dataset.hold));
  if (trip) typeSheet(trip);
});

document.addEventListener("click", (ev) => {
  if (hold?.fired) {
    hold = null;
    ev.preventDefault();
    return;
  }
  hold = null;
  const el = ev.target.closest("[data-act]");
  if (!el || el.disabled) return;
  ACTIONS[el.dataset.act]?.(el, ev);
});

// Back after a while away: the figures may have moved on.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.screen === "app" && Date.now() - S.loadedAt > 10 * 60 * 1000) refresh();
});

// ---------------------------------------------------------------- views

function spinner() {
  return `<div class="spinner"></div>`;
}

function message(text, retry = false) {
  return `<div class="message">${esc(text)}${retry ? `<p><button class="btn" data-act="refresh">Try again</button></p>` : ""}</div>`;
}

/** Spinner, error with a retry, or [view] of the value. */
function loaded(load, view) {
  if (!load || load.loading) return spinner();
  if (load.error) return message(load.error, true);
  return view(load.value);
}

function tile(k, v, note = null, reserve = true) {
  return `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${
    note != null || reserve ? `<div class="n">${esc(note ?? "")}</div>` : ""
  }</div>`;
}

function monthBar(key, act, back, canBack, suffix = "") {
  return `<div class="month">
    <button class="iconbtn" data-act="${act}" data-arg="${back + 1}" ${canBack ? "" : "disabled"} aria-label="Previous month">${icon("left")}</button>
    <div class="name">${esc(monthName(key, true) + suffix)}</div>
    <button class="iconbtn" data-act="${act}" data-arg="${back - 1}" ${back > 0 ? "" : "disabled"} aria-label="Next month">${icon("right")}</button>
  </div>`;
}

function section(title, key, body) {
  const folded = S.folded.has(key);
  return `<div class="section">
    <button class="head" data-act="fold" data-arg="${esc(key)}"><span class="grow one">${esc(title)}</span>${icon(folded ? "down" : "up")}</button>
    ${folded ? "" : body}
  </div>`;
}

/** One bar per month; tapping a bar shows that month. */
function barChart(title, labels, values, colour, selected, format) {
  const max = Math.max(...values, 0) || 1;
  const n = values.length || 1;
  const bars = values
    .map((v, i) => {
      const h = Math.max(0, (v / max) * 100);
      return `<rect x="${i * 10 + 1.5}" y="${100 - h}" width="7" height="${h}" fill="${colour}" opacity="${selected == null || selected === i ? 1 : 0.35}"/>
        <rect x="${i * 10}" y="0" width="10" height="100" fill="transparent" data-act="bar" data-arg="${n - 1 - i}"/>`;
    })
    .join("");
  return `<div class="chart">
    <div class="title"><span class="grow one">${esc(title)}</span><span class="bold">${
      selected != null ? esc(`${labels[selected]}: ${format(values[selected])}`) : ""
    }</span></div>
    <svg viewBox="0 0 ${n * 10} 100" preserveAspectRatio="none">${bars}</svg>
    <div class="labels">${labels.map((l, i) => `<span class="${i === selected ? "on" : ""}">${esc(l)}</span>`).join("")}</div>
  </div>`;
}

function overview(stats) {
  const f = fmt();
  const months = stats.months || [];
  if (!months.length) return message("No figures yet.");
  const back = Math.min(Math.max(S.overviewBack, 0), months.length - 1);
  const idx = months.length - 1 - back;
  const cur = months[idx];
  const prev = months[idx - 1];
  const vs = (a, b, show) => {
    if (b == null || b === 0 || !prev) return null;
    const d = a - b;
    return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${show(Math.abs(d))} vs ${monthName(prev.month)}`;
  };
  const eff = (m) => f.eff(m.km_with_kwh || 0, m.kwh_used || 0);
  const drain = (m) => (m.idle_hours > 0 ? (m.idle_drop / m.idle_hours) * 24 : null);
  const kwh = (v) => `${v.toFixed(0)} kWh`;
  const e = eff(cur);
  const pe = prev ? eff(prev) : null;
  const tiles = [
    tile("Trips", String(cur.trips), vs(cur.trips, prev?.trips, (v) => v.toFixed(0))),
    tile("Distance", f.distU(cur.distance_km || 0), vs(cur.distance_km || 0, prev?.distance_km, (v) => f.distU(v))),
    tile("Energy used", kwh(cur.kwh_used || 0), vs(cur.kwh_used || 0, prev?.kwh_used, kwh)),
    tile("Efficiency", e != null ? e.toFixed(2) : "–", e != null && pe != null ? vs(e, pe, (v) => v.toFixed(2)) : f.effUnit),
    tile("Charged", kwh(cur.charged_kwh || 0), vs(cur.charged_kwh || 0, prev?.charged_kwh, kwh)),
    tile("Charging cost", f.money(cur.cost || 0), vs(cur.cost || 0, prev?.cost, (v) => f.money(v))),
    tile("Idle drain", drain(cur) != null ? `${drain(cur).toFixed(2)} %/day` : "–"),
    tile("Range at 100%", cur.range100_km != null ? f.distU(cur.range100_km) : "–"),
  ];

  let types;
  const yt = S.yearTrips;
  if (!yt || yt.loading) types = `<div class="dim">Loading…</div>`;
  else if (yt.error) types = `<div>Couldn't load the trips: ${esc(yt.error)}</div>`;
  else types = tripTypes(yt.value.filter((t) => monthKey(t.start_ts) === cur.month), f);

  const labels = months.map((m) => monthName(m.month));
  const charts = [
    barChart(`Distance (${f.distUnit})`, labels, months.map((m) => f.distNum(m.distance_km || 0)), "#89B4FA", idx, (v) => v.toFixed(0)),
    barChart("Energy charged (kWh)", labels, months.map((m) => m.charged_kwh || 0), "#A6E3A1", idx, (v) => v.toFixed(0)),
    barChart("Charging cost", labels, months.map((m) => m.cost || 0), "#F9E2AF", idx, (v) => f.money(v)),
    barChart(`Efficiency (${f.effUnit})`, labels, months.map((m) => eff(m) || 0), "#CBA6F7", idx, (v) => v.toFixed(2)),
  ];

  const places = (stats.top_places || [])
    .map((p) => `<div class="list-row"><span class="grow one">${esc(p.name)}</span><span class="dim">${p.count} visits</span></div>`)
    .join("");

  return [
    section(
      "Overview",
      "Overview",
      monthBar(cur.month, "ovmonth", back, back < months.length - 1, back === 0 ? " so far" : "") +
        `<div class="tiles">${tiles.join("")}</div>`,
    ),
    section(`Trip types · ${monthName(cur.month, true)}`, "Trip types", types),
    section("Last 12 months", "Last 12 months", `<div class="dim small">Tap a bar to see that month.</div>${charts.join("")}`),
    places ? section("Favourite places · 12 months", "Favourite places", places) : "",
  ].join("");
}

/** Distance and count per trip type for one month, Business first. Tap a type to list its trips. */
function tripTypes(trips, f) {
  if (!trips.length) return `<div class="dim">No trips this month.</div>`;
  const total = trips.reduce((s, t) => s + (t.distance_km || 0), 0) || 1;
  const groups = new Map();
  for (const t of trips) {
    const k = t.label || null;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const km = (list) => list.reduce((s, t) => s + (t.distance_km || 0), 0);
  const sorted = [...groups.entries()].sort(
    (a, b) => (a[0] !== "Business") - (b[0] !== "Business") || (a[0] == null) - (b[0] == null) || km(b[1]) - km(a[1]),
  );
  return `<div class="bars">${sorted
    .map(
      ([label, list]) => `<div class="bar" data-act="pick" data-arg="${esc(label ?? UNTAGGED)}">
        <div class="row"><span class="grow one ${label === "Business" ? "bold" : ""}">${esc(label ?? "No type")}</span>
        <span class="dim">${list.length} trips ·</span><span class="bold">${esc(f.distU(km(list), 1))}</span></div>
        <div class="meter"><div style="width:${((km(list) / total) * 100).toFixed(1)}%"></div></div>
      </div>`,
    )
    .join("")}</div><div class="dim small">Tap a type to list its trips.</div>`;
}

const place = (name) => name || "Unknown";

function tripsView(all) {
  const f = fmt();
  const key = monthKeyOf(monthStart(S.back));
  const head = monthBar(key, "month", S.back, S.back < 59);
  if (!all.length) return head + message("No trips this month.");
  const trips = all.filter((t) => matches(t, S.type));
  const days = new Map();
  for (const t of trips) {
    const d = day(t.start_ts);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(t);
  }
  const sum = (list) => list.reduce((s, t) => s + (t.distance_km || 0), 0);
  return `${head}
    <div class="row">
      <button class="chip filter" data-act="filter">${esc(typeName(S.type))}${icon("drop")}</button>
      <span class="dim small one grow">Hold a trip to set its type</span>
    </div>
    <div class="tiles">${tile(S.type == null ? "Trips" : `${typeName(S.type)} trips`, String(trips.length), null, false)}${tile(
      "Distance",
      f.distU(sum(trips)),
      null,
      false,
    )}</div>
    ${trips.length ? "" : `<div class="message">No ${esc(typeName(S.type))} trips this month.</div>`}
    ${[...days.entries()]
      .map(
        ([d, list]) => `<div class="day"><span class="d">${esc(d)}</span><span class="km">${esc(f.distU(sum(list), 1))}</span></div>
        ${list.map((t) => tripRow(t, f)).join("")}`,
      )
      .join("")}`;
}

function tripRow(t, f) {
  return `<div class="trip" data-act="trip" data-arg="${t.id}" data-hold="${t.id}">
    <div class="grow">
      <div class="one">${esc(place(t.start_place))} → ${esc(place(t.end_place))}</div>
      <div class="dim small">${time(t.start_ts)}–${time(t.end_ts)}</div>
    </div>
    <div class="end">
      <span class="bold">${esc(f.distU(t.distance_km || 0, 1))}</span>
      ${t.label ? `<span class="label ${t.label_auto ? "auto" : ""}">${esc(t.label)}</span>` : ""}
    </div>
  </div>`;
}

const PASTELS = ["#B5D8F7", "#C8EBC1", "#FCE1A8", "#F5C6D6", "#D9C8F2", "#B8E6E1", "#FFCFB0", "#E3E8A8"];
const UNNAMED_SITE = "#D5D5D5";
const siteOf = (c) => c.place || (c.at_home ? "Home" : null);

/** A pastel at 13% over graphite, as on Android. */
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c, g) => Math.round(c * 0.13 + g * 0.87);
  return `rgb(${mix(n >> 16, 0x16)},${mix((n >> 8) & 255, 0x18)},${mix(n & 255, 0x1c)})`;
}

function chargeView(charges) {
  const f = fmt();
  const key = monthKeyOf(monthStart(S.back));
  const head = monthBar(key, "month", S.back, S.back < 59);
  if (!charges.length) return head + message("No charging this month.");
  const kwh = charges.reduce((s, c) => s + (c.kwh || 0), 0);
  const cost = charges.reduce((s, c) => s + (c.cost || 0), 0);
  const counts = new Map();
  for (const c of charges) {
    const s = siteOf(c);
    if (s) counts.set(s, (counts.get(s) || 0) + 1);
  }
  const colour = new Map([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s], i) => [s, PASTELS[i % PASTELS.length]]));
  return `${head}
    <div class="tiles three">${tile("Sessions", String(charges.length), null, false)}${tile("Energy", `${kwh.toFixed(0)} kWh`, null, false)}${tile(
      "Cost",
      f.money(cost),
      null,
      false,
    )}</div>
    ${charges
      .map((c) => {
        const site = colour.get(siteOf(c)) || UNNAMED_SITE;
        const price = c.cost == null ? "No price" : c.cost === 0 ? "Free" : f.money(c.cost);
        const extra = [duration(c.end_ts - c.start_ts), c.max_power_kw != null ? `${c.max_power_kw.toFixed(1)} kW` : null]
          .filter(Boolean)
          .join("  ·  ");
        return `<div class="charge" style="--site:${site};background:${tint(site)}">
          <div class="row"><span class="grow one">${esc(c.place || (c.at_home ? "Home" : "Unnamed place"))}</span>
            <span class="bold ${c.cost == null ? "dim" : ""}">${esc(price)}</span></div>
          <div class="row small"><span class="grow one dim">${esc(day(c.start_ts))}  ${time(c.start_ts)}–${time(c.end_ts)}</span>
            <span class="bold">${c.kwh != null ? `${c.kwh.toFixed(1)} kWh` : "– kWh"}</span></div>
          <div class="row small dim"><span class="grow one">${pct(c.soc_start)} → ${pct(c.soc_end)}</span><span class="one">${esc(extra)}</span></div>
        </div>`;
      })
      .join("")}`;
}

function signinView() {
  return `<div class="signin">
    <img src="icon-180.png" alt="">
    <h1>EV Logbook</h1>
    <div class="dim">Sign in with your Home Assistant account at ${esc(location.host)}.</div>
    ${S.signinError ? `<div style="color:var(--error)">${esc(S.signinError)}</div>` : ""}
    <button class="btn primary" data-act="signin">Sign in</button>
  </div>`;
}

function render() {
  const app = document.getElementById("app");
  if (S.screen === "loading") {
    app.innerHTML = spinner();
    return;
  }
  if (S.screen === "signin") {
    app.innerHTML = signinView();
    renderPage();
    return;
  }
  const cars = S.cars;
  let body;
  if (!cars || cars.loading) body = spinner();
  else if (cars.error) body = message(`Couldn't load the logbook: ${cars.error}`, true);
  else if (!S.car) body = message("No cars in the logbook yet. Add one in Home Assistant under Settings, Devices & services.");
  else if (S.tab === "home") body = loaded(S.stats, overview);
  else if (S.tab === "trips") body = loaded(S.trips, tripsView);
  else body = loaded(S.charges, chargeView);

  app.innerHTML = `<header class="top">
      <h1 class="grow one">${esc(S.car?.name || "EV Logbook")}</h1>
      <button class="iconbtn" data-act="refresh" aria-label="Reload">${icon("refresh")}</button>
      <button class="iconbtn" data-act="menu" aria-label="Menu">${icon("more")}</button>
    </header>
    <main>${body}</main>
    <nav class="tabs">${TABS.map(
      ([key, title, ic]) =>
        `<button class="${S.tab === key ? "on" : ""}" data-act="tab" data-arg="${key}"><span class="pill">${icon(ic)}</span>${title}</button>`,
    ).join("")}</nav>`;
  renderPage();
}

// ---------------------------------------------------------------- trip page

let map = null;
let mapTrip = null;

function renderPage() {
  const page = document.getElementById("page");
  const trip = S.openTrip;
  if (!trip || S.screen !== "app") {
    if (map) {
      map.remove();
      map = null;
      mapTrip = null;
    }
    page.innerHTML = "";
    return;
  }
  if (mapTrip !== trip.id || !page.querySelector(".map")) {
    if (map) map.remove();
    map = null;
    mapTrip = trip.id;
    page.innerHTML = `<div class="page">
      <header class="top">
        <button class="iconbtn" data-act="trip-close" aria-label="Back">${icon("back")}</button>
        <h1 class="grow one">Trip</h1>
      </header>
      <div class="map" id="tripmap"></div>
      <div class="body" id="tripbody"></div>
    </div>`;
  }
  drawMap();
  document.getElementById("tripbody").innerHTML = tripBody(trip);
}

let mapDrawn = null;
function drawMap() {
  const el = document.getElementById("tripmap");
  const pts = S.tripPoints;
  if (!pts || pts.loading) {
    if (!map) el.innerHTML = spinner();
    return;
  }
  if (pts.error) {
    el.innerHTML = message(pts.error);
    return;
  }
  const line = (pts.value || []).filter((p) => Array.isArray(p) && p[1] != null && p[2] != null).map((p) => [p[1], p[2]]);
  if (line.length < 2) {
    el.innerHTML = message("No route was recorded for this trip.");
    return;
  }
  if (map && mapDrawn === pts) return; // already drawn: keep the user's pan and zoom
  if (!window.L) {
    el.innerHTML = message("The map couldn't load.");
    return;
  }
  el.innerHTML = "";
  map = L.map(el, { zoomControl: false, attributionControl: true });
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const route = L.polyline(line, { color: "#1E66F5", weight: 5, lineCap: "round", lineJoin: "round" }).addTo(map);
  L.circleMarker(line[0], { radius: 7, color: "#fff", weight: 2, fillColor: "#40A02B", fillOpacity: 1 }).addTo(map).bindTooltip("Start");
  L.circleMarker(line[line.length - 1], { radius: 7, color: "#fff", weight: 2, fillColor: "#D20F39", fillOpacity: 1 })
    .addTo(map)
    .bindTooltip("End");
  map.fitBounds(route.getBounds(), { padding: [24, 24] });
  mapDrawn = pts;
}

function placeLine(what, name, lat, lon) {
  const f = fmt();
  const near = !name && lat != null && lon != null ? nearestLabel(lat, lon, S.landmarks, f) : null;
  return `<div class="place-line"><span class="what">${what}</span><div class="grow">
    <div class="name one">${esc(name || "Unnamed place")}</div>
    ${near ? `<div class="dim small">${esc(near)}</div>` : ""}
  </div></div>`;
}

function tripBody(t) {
  const f = fmt();
  const off = S.saving ? "disabled" : "";
  const chips = S.labels
    .map((l) => `<button class="chip ${t.label === l && !t.label_auto ? "on" : ""}" data-act="label" data-arg="${esc(l)}" ${off}>${esc(l)}</button>`)
    .join("");
  const figures = [
    tile("Distance", f.distU(t.distance_km || 0, 1)),
    tile("Time", duration(t.end_ts - t.start_ts)),
    tile("Battery", `${pct(t.soc_start)} → ${pct(t.soc_end)}`),
    tile("Range", t.range_start_km != null && t.range_end_km != null ? `${f.dist(t.range_start_km)} → ${f.distU(t.range_end_km)}` : "–"),
    tile("Outside", t.temp_c != null ? `${t.temp_c.toFixed(0)} °C` : "–"),
    tile(
      "Parked after",
      t.park_hours != null ? hours(t.park_hours) : "–",
      t.park_charged ? "charged" : t.park_soc_drop != null ? `−${t.park_soc_drop.toFixed(0)}%` : null,
    ),
  ];
  return `${placeLine("From", t.start_place, t.start_lat, t.start_lon)}
    ${placeLine("To", t.end_place, t.end_lat, t.end_lon)}
    <div class="dim">${esc(day(t.start_ts))}  ${time(t.start_ts)}–${time(t.end_ts)}</div>
    <h3>Type</h3>
    ${t.label_auto && t.label ? `<div class="dim small">${esc(t.label)} comes from the place's default. Pick one to set it for this trip.</div>` : ""}
    <div class="scrollrow">${chips}
      <button class="chip" data-act="label-other" ${off}>Other…</button>
      ${t.label && !t.label_auto ? `<button class="chip" data-act="label-clear" ${off}>Clear</button>` : ""}
    </div>
    <h3>Fix the trip</h3>
    <div class="scrollrow">
      <button class="btn" data-act="fix" data-arg="split" ${off}>Split</button>
      <button class="btn" data-act="fix" data-arg="merge" ${off}>Merge with next</button>
      <button class="btn danger" data-act="fix" data-arg="delete" ${off}>Delete</button>
    </div>
    <h3>Figures</h3>
    <div class="tiles">${figures.join("")}</div>`;
}

start();
