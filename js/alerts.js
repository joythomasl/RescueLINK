/* ============================================================
   RescueLINK — Alerts page (control-alerts.html / view-alerts.html)

   Two feeds, side by side:
     Sensor alerts     — what the alert engine hears from IMD, CWC,
                         NCS, GSI and the satellite EO pass. These
                         reach the backend over the agencies' own
                         national telemetry, not local cell towers,
                         so they keep arriving when the sector is dark.
     Responder alerts  — what the field raises or what the platform
                         infers about the field: SOS, backup, device
                         unreachable, low battery, check-in overdue,
                         entered a CRITICAL cell, broadcast not acked.

   Coordinator can acknowledge / resolve; the viewer gets a 403 toast.
   ============================================================ */

(function (global) {
  "use strict";

  const D = global.RESCUELINK_DATA;
  const LEVELS = ["INFO", "WARNING", "CRITICAL"];
  const $ = id => document.getElementById(id);
  const state = { control: false, sensorFilter: "all", respFilter: "all", sensors: [], sensorAlerts: [], respAlerts: [], tick: 0 };

  function toast(msg, type) { RLAuth.toast(msg, { type }); }
  function can(what) { if (state.control) return true; RLAuth.denyMutation(what); return false; }
  function levelChip(l) { return '<span class="chip ' + (l === "CRITICAL" ? "chip-p0" : l === "WARNING" ? "chip-p1" : "chip-aged") + '">' + l + "</span>"; }
  function age(min) { return min < 1 ? "just now" : min < 60 ? Math.round(min) + " min ago" : (min / 60).toFixed(1) + " h ago"; }
  function fmt(v, unit) { return (unit === "g" ? v.toFixed(3) : unit === "m" ? v.toFixed(2) : Math.round(v * 10) / 10) + " " + unit; }
  const TYPE_ICON = { rain: "☂", river: "≈", seismic: "⌇", tilt: "⟋", eo: "◎" };
  const KIND_META = {
    SOS: { chip: "chip-p0", label: "SOS" }, BACKUP: { chip: "chip-p1", label: "BACKUP" }, OFFLINE: { chip: "chip-p0", label: "UNREACHABLE" },
    BATTERY: { chip: "chip-p1", label: "BATTERY" }, ZONE: { chip: "chip-p1", label: "CRITICAL CELL" }, CHECKIN: { chip: "chip-p1", label: "CHECK-IN" }, ACK: { chip: "chip-aged", label: "NO ACK" }
  };

  // ---------------- Sensor detail (modal with a readings sparkline) ----------------
  function sparkline(sensor) {
    const S = sensor.series, W = 520, H = 150, pl = 44, pr = 10, pt = 12, pb = 22;
    const vals = S.concat([sensor.thr]); const lo = Math.min(...vals), hi = Math.max(...vals); const span = (hi - lo) || 1;
    const X = i => pl + i / (S.length - 1) * (W - pl - pr), Y = v => pt + (1 - (v - lo) / span) * (H - pt - pb);
    const pts = S.map((v, i) => X(i).toFixed(1) + "," + Y(v).toFixed(1)).join(" ");
    return '<div class="chart"><svg viewBox="0 0 ' + W + " " + H + '">' +
      [lo, (lo + hi) / 2, hi].map(t => '<line class="grid" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(t) + '" y2="' + Y(t) + '"/><text class="lbl" x="' + (pl - 5) + '" y="' + (Y(t) + 3.5) + '" text-anchor="end">' + (Math.abs(t) < 1 && t !== 0 ? t.toFixed(2) : Math.round(t * 10) / 10) + "</text>").join("") +
      '<path class="area" d="M' + X(0) + "," + Y(lo) + " L" + pts.split(" ").join(" L") + " L" + X(S.length - 1) + "," + Y(lo) + ' Z"/><polyline class="line" points="' + pts + '"/>' +
      '<line class="thr" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(sensor.thr) + '" y2="' + Y(sensor.thr) + '"/><text class="thr-lbl" x="' + (W - pr) + '" y="' + (Y(sensor.thr) - 4) + '" text-anchor="end">threshold ' + fmt(sensor.thr, sensor.unit) + "</text>" +
      '<circle class="dot" cx="' + X(S.length - 1) + '" cy="' + Y(S[S.length - 1]) + '" r="4"/>' +
      '<line class="ax" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '"/>' +
      '<text class="lbl" x="' + pl + '" y="' + (H - 6) + '">−' + sensor.windowH + ' h</text><text class="lbl" x="' + (W - pr) + '" y="' + (H - 6) + '" text-anchor="end">now</text></svg></div>';
  }
  function openSensor(sn) {
    const zone = D.ZONES.find(z => z.id === sn.zone);
    RLAuth.openModal({
      title: sn.name, wide: true,
      bodyHTML: '<div class="sensor-head">' + levelChip(sn.status) + '<span class="mono">' + sn.id + "</span><span class=\"text-dim\">" + sn.source + " · " + sn.zone + " · " + (zone ? zone.name : "") + "</span></div>" +
        '<div class="sensor-big"><b>' + fmt(sn.reading, sn.unit) + "</b><span class=\"text-dim\">latest · threshold " + fmt(sn.thr, sn.unit) + " · " + age(sn.lastMin) + "</span></div>" +
        sparkline(sn) +
        '<table class="kv-table" style="margin-top:10px"><tr><td class="k">Reaches the backend via</td><td>' + sn.telemetry + "</td></tr>" +
        '<tr><td class="k">Feeds</td><td>' + sn.feeds + "</td></tr>" +
        '<tr><td class="k">Threshold basis</td><td>' + sn.basis + "</td></tr></table>",
      footerButtons: [{ label: "Close", className: "btn-secondary" }]
    });
  }

  // ---------------- Render ----------------
  function renderSummary() {
    const sOpen = state.sensorAlerts.filter(a => !a.resolved), rOpen = state.respAlerts.filter(a => !a.resolved);
    $("st-sensor").textContent = sOpen.length; $("st-sensor-crit").textContent = sOpen.filter(a => a.level === "CRITICAL").length;
    $("st-resp").textContent = rOpen.length; $("st-sos").textContent = rOpen.filter(a => a.kind === "SOS").length;
    $("st-offline").textContent = rOpen.filter(a => a.kind === "OFFLINE").length;
    $("st-stations").textContent = state.sensors.filter(s => s.status !== "OK").length + " / " + state.sensors.length;
  }
  function renderSensors() {
    $("stations").innerHTML = state.sensors.map(sn =>
      '<button class="station ' + sn.status + '" data-sn="' + sn.id + '"><span class="ic">' + TYPE_ICON[sn.type] + '</span><span class="sn"><b>' + sn.name + '</b><span class="m">' + sn.source + " · " + sn.zone + " · " + age(sn.lastMin) + "</span></span>" +
      '<span class="rd"><b>' + fmt(sn.reading, sn.unit) + '</b><span class="m">thr ' + fmt(sn.thr, sn.unit) + "</span></span>" + levelChip(sn.status) + "</button>").join("");
    $("stations").querySelectorAll("[data-sn]").forEach(b => b.addEventListener("click", () => openSensor(state.sensors.find(s => s.id === b.dataset.sn))));
  }
  function filterBar(el, current, options, onPick) {
    el.innerHTML = options.map(o => '<button class="btn-ghost btn-xs' + (current === o.v ? " active" : "") + '" data-f="' + o.v + '">' + o.l + "</button>").join("");
    el.querySelectorAll("[data-f]").forEach(b => b.addEventListener("click", () => onPick(b.dataset.f)));
  }
  function actionButtons(a, feed) {
    const lock = state.control ? "" : " locked";
    if (a.resolved) return '<span class="chip chip-ok">RESOLVED</span>';
    return '<div class="al-actions">' +
      (a.ack ? '<span class="chip chip-gold">ACK ' + a.ackBy + "</span>" : '<button class="btn-secondary btn-xs' + lock + '" data-ack="' + feed + ":" + a.id + '">Acknowledge</button>') +
      '<button class="btn-secondary btn-xs' + lock + '" data-res="' + feed + ":" + a.id + '">Resolve</button>' +
      (a.node ? '<a class="btn-secondary btn-xs" href="' + (state.control ? "control.html" : "view.html") + "?select=" + a.node + '">Open on map</a>' : "") +
      (a.sensor ? '<button class="btn-secondary btn-xs" data-sn2="' + a.sensor + '">Readings</button>' : "") + "</div>";
  }
  function renderSensorAlerts() {
    const list = state.sensorAlerts.filter(a => state.sensorFilter === "all" ? !a.resolved : state.sensorFilter === "resolved" ? a.resolved : (!a.resolved && a.level === state.sensorFilter));
    $("sensor-cnt").textContent = list.length + " shown · " + state.sensorAlerts.filter(a => !a.resolved).length + " open";
    filterBar($("sensor-filter"), state.sensorFilter, [{ v: "all", l: "Open" }, { v: "CRITICAL", l: "Critical" }, { v: "WARNING", l: "Warning" }, { v: "INFO", l: "Info" }, { v: "resolved", l: "Resolved" }], v => { state.sensorFilter = v; renderSensorAlerts(); });
    $("sensor-alerts").innerHTML = list.length ? list.map(a => {
      const sn = state.sensors.find(s => s.id === a.sensor);
      return '<div class="alert ' + a.level + (a.resolved ? " done" : "") + '"><div class="al-h">' + levelChip(a.level) + '<span class="src">' + a.source + '</span><span class="zone mono">' + a.zone + '</span><span class="t">' + age(a.min) + "</span></div>" +
        '<div class="al-title">' + a.title + "</div><div class=\"al-detail\">" + a.detail + "</div>" +
        (sn ? '<div class="al-reading"><span class="ic">' + TYPE_ICON[sn.type] + "</span>" + sn.name + " · <b>" + fmt(a.reading != null ? a.reading : sn.reading, sn.unit) + "</b> vs " + fmt(sn.thr, sn.unit) + "</div>" : "") +
        (a.engine ? '<div class="al-engine">Alert engine → ' + a.engine + "</div>" : "") + actionButtons(a, "s") + "</div>";
    }).join("") : '<div class="empty-note">Nothing here.</div>';
    bindActions($("sensor-alerts"));
  }
  function renderResponderAlerts() {
    const list = state.respAlerts.filter(a => state.respFilter === "all" ? !a.resolved : state.respFilter === "resolved" ? a.resolved : (!a.resolved && a.kind === state.respFilter));
    $("resp-cnt").textContent = list.length + " shown · " + state.respAlerts.filter(a => !a.resolved).length + " open";
    filterBar($("resp-filter"), state.respFilter, [{ v: "all", l: "Open" }, { v: "SOS", l: "SOS" }, { v: "BACKUP", l: "Backup" }, { v: "OFFLINE", l: "Unreachable" }, { v: "BATTERY", l: "Battery" }, { v: "ZONE", l: "Critical cell" }, { v: "CHECKIN", l: "Check-in" }, { v: "ACK", l: "No ack" }, { v: "resolved", l: "Resolved" }], v => { state.respFilter = v; renderResponderAlerts(); });
    $("resp-alerts").innerHTML = list.length ? list.map(a => {
      const ag = D.AGENCIES[a.node.split("-")[0]]; const k = KIND_META[a.kind];
      return '<div class="alert ' + a.level + (a.resolved ? " done" : "") + '"><div class="al-h"><span class="chip ' + k.chip + '">' + k.label + '</span><span class="src"><span class="agency-dot" style="background:' + ag.color + ';display:inline-block;width:8px;height:8px;vertical-align:0"></span> <span class="mono">' + a.node + '</span> · ' + ag.label.split(" ·")[0] + '</span><span class="zone mono">' + a.zone + '</span><span class="t">' + age(a.min) + "</span></div>" +
        '<div class="al-title">' + a.title + "</div><div class=\"al-detail\">" + a.detail + "</div>" +
        '<div class="al-engine">Arrived via ' + a.via + "</div>" + actionButtons(a, "r") + "</div>";
    }).join("") : '<div class="empty-note">Nothing here.</div>';
    bindActions($("resp-alerts"));
  }
  function bindActions(root) {
    root.querySelectorAll("[data-ack]").forEach(b => b.addEventListener("click", () => {
      if (!can("acknowledge alerts")) return; const a = find(b.dataset.ack); a.ack = true; a.ackBy = RLAuth.getName().split(" ").pop();
      toast(a.id + " acknowledged — pushed back to " + (a.node || a.source) + " as a 24 B ACK.", "success"); renderAll();
    }));
    root.querySelectorAll("[data-res]").forEach(b => b.addEventListener("click", () => {
      if (!can("resolve alerts")) return; const a = find(b.dataset.res); a.resolved = true;
      toast(a.id + " resolved.", "success"); renderAll();
    }));
    root.querySelectorAll("[data-sn2]").forEach(b => b.addEventListener("click", () => openSensor(state.sensors.find(s => s.id === b.dataset.sn2))));
  }
  function find(ref) { const [feed, id] = ref.split(":"); return (feed === "s" ? state.sensorAlerts : state.respAlerts).find(a => a.id === id); }
  function renderAll() { renderSummary(); renderSensors(); renderSensorAlerts(); renderResponderAlerts(); }

  // ---------------- Live simulation ----------------
  // Every tick: ages everything, nudges readings, and now and then raises
  // a new alert so the page feels live during a demo.
  let nextId = 300;
  function tick() {
    state.tick++;
    state.sensorAlerts.forEach(a => { a.min += 0.25; }); state.respAlerts.forEach(a => { a.min += 0.25; }); state.sensors.forEach(s => { s.lastMin += 0.25; });
    const river = state.sensors.find(s => s.id === "CWC-PK-01");
    if (state.tick % 4 === 0) {                       // river gauge reports every minute of sim time
      river.reading = Math.round((river.reading + 0.04 + Math.random() * 0.03) * 100) / 100; river.series.push(river.reading); river.series.shift(); river.lastMin = 0;
      if (river.reading >= river.thr && river.status !== "CRITICAL") {
        river.status = "CRITICAL";
        state.sensorAlerts.unshift({ id: "SA-" + nextId++, sensor: river.id, source: "CWC", zone: "Z6", level: "CRITICAL", min: 0, title: "River crossed the warning level at the bend", detail: "Gauge at " + fmt(river.reading, river.unit) + " and rising ~0.25 m/h. Lower row of Puthur Kadavu is inside the 2018 flood line.", reading: river.reading, engine: "Z6 escalated MEDIUM → HIGH; evacuation route R2 flagged (river road closes above warning level); SDRF-04/05 notified over LoRa L3." });
        toast("CWC gauge crossed the warning level — Z6 escalated to HIGH.", "error");
      }
    }
    if (state.tick === 12) {
      state.respAlerts.unshift({ id: "RA-" + nextId++, kind: "BATTERY", node: "VOL-02", zone: "Z5", level: "WARNING", min: 0, title: "Battery at 18 % — ~1.3 h of mesh relay left", detail: "VOL-02 is one of two relays between Cluster B and L2. If it drops, NDRF-04/05 fall back to 2-hop paths through FIRE-02.", via: "MESH → LoRa L2 → SAT (48 B status frame)" });
      toast("VOL-02 battery low — relay position at risk.", "warn");
    }
    if (state.tick === 28) {
      state.respAlerts.unshift({ id: "RA-" + nextId++, kind: "CHECKIN", node: "SDRF-03", zone: "Z5", level: "WARNING", min: 0, title: "Check-in overdue by 12 min", detail: "Last position frame 27 min ago from the probe line. Neighbours SDRF-02 and VOL-03 still report SDRF-03 as a live Wi-Fi Aware peer, so the phone is up — the app is not being answered.", via: "inferred by the backend from missing POS frames" });
      toast("SDRF-03 check-in overdue.", "warn");
    }
    renderAll();
  }

  function seed() {
    state.sensors = D.SENSORS.map(s => ({ ...s, series: s.series.slice() }));
    state.sensorAlerts = D.SENSOR_ALERTS.map(a => ({ ...a }));
    state.respAlerts = D.RESPONDER_ALERTS.map(a => ({ ...a }));
  }

  function mount(opts) {
    state.control = !!(opts && opts.control);
    seed(); renderAll();
    // Same rule as the dashboard: an open CRITICAL sensor alert means emergency mode.
    if (state.sensorAlerts.some(a => a.level === "CRITICAL" && !a.resolved) && !RLAuth.isEmergencyActive()) RLAuth.setEmergency(true, D.INCIDENT.impactAt);
    setInterval(tick, 15000);
  }

  global.RescueLINKAlerts = { mount };

})(window);
