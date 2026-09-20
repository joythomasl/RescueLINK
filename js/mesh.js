/* ============================================================
   RescueLINK — Command dashboard engine (shared by control + view)

   Simulates the four-tier network for one incident sector:
     Tier 1  Wi-Fi Aware clusters (phone ↔ phone, managed flooding)
     Tier 2  ESP32 + LoRa bridges between clusters (Meshtastic)
     Tier 3  Iridium SBD at the staging bridge (340 B, simulated)
     Tier 4  Adaptive online transition — any phone that regains
             internet auto-promotes to gateway; queued traffic flushes

   Every message picks the first rung that can carry it:
     DIRECT → GATEWAY (peer with internet) → MESH → LORA → SAT → QUEUED
   The per-message log is kept in memory (RescueLINK.log) for the
   "which rung did it take" story, but is not shown on the dashboard.

   Role gating: RescueLINK.mount({ control: true|false }). The viewer
   page keeps every control visible but each action returns a 403 —
   the point being that authority lives server-side, not in the UI.
   ============================================================ */

(function (global) {
  "use strict";

  const D = global.RESCUELINK_DATA;
  const M = global.SMMap;
  const AG = D.AGENCIES;
  const ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

  // ---------------- State ----------------
  const nodes = D.ROSTER.map(r => ({
    id: r[0], ag: r[1], x: r[2], y: r[3], status: r[4], task: r[5] || null,
    batt: 62 + Math.floor(Math.random() * 33), internet: false, queue: [],
    lastTier: null, lastAt: Date.now() - Math.random() * 90000, target: null,
    sosText: D.SOS_TEXT[r[0]] || null, cellFringe: r[0] === "NDRF-03"
  }));
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  Object.keys(D.PENDING_QUEUES).forEach(id => { byId[id].queue = D.PENDING_QUEUES[id].map(m => ({ ...m })); });

  const esps = D.BRIDGES.map(e => ({ ...e }));
  const zones = D.ZONES.map(z => ({ ...z, override: null }));
  const requests = D.REQUESTS.map(r => ({ ...r, done: false }));
  const tasks = [];
  const log = [];
  const photos = D.PHOTOS.map(ph => ({ ...ph }));
  let view = null;               // zoom/pan controller from SMMap.createView
  let topo = M.computeTopology(nodes, esps);

  const ui = {
    control: false, selected: null, selLock: false, selZone: "Z4", assigning: false,
    showZones: true, relayDeployed: false, bcCount: 0, rTick: 0, roster: "agency", photoFilter: "all"
  };

  function combine(z) {
    if (z.override) return z.override;
    let i = ORDER.indexOf(z.base);
    if (z.trig >= 0.8) i += 1; else if (z.trig < 0.3) i -= 1;
    return ORDER[Math.max(0, Math.min(3, i))];
  }
  zones.forEach(z => { z.level = combine(z); });
  function topZone() { return zones.reduce((m, z) => ORDER.indexOf(z.level) > ORDER.indexOf(m.level) ? z : m, zones[0]); }

  // ---------------- Helpers ----------------
  const $ = id => document.getElementById(id);
  function fmtB(b) { return b >= 1024 ? (b / 1024).toFixed(1) + " KB" : b + " B"; }
  function fmtLat(s) { return s == null ? "—" : s < 1 ? Math.round(s * 1000) + " ms" : s.toFixed(1) + " s"; }
  function fmtAge(ms) { const m = Math.round(ms / 60000); return m < 1 ? "just now" : m + " min ago"; }
  function nowStr() { return new Date().toTimeString().slice(0, 8); }
  function addLog(e) { e.t = nowStr(); log.unshift(e); if (log.length > 160) log.length = 160; }
  function statusChip(n) {
    const cls = n.status === "sos" ? "chip-p0" : n.status === "available" ? "chip-p3" : n.status === "enroute" ? "chip-p1" : "chip-gold";
    return '<span class="chip ' + cls + '">' + (n.status === "enroute" ? "EN ROUTE" : n.status.toUpperCase()) + "</span>";
  }
  function levelColor(l) { return l === "LOW" ? "var(--p3)" : l === "CRITICAL" ? "var(--p0)" : "var(--p1)"; }
  function toast(msg, type) { RLAuth.toast(msg, { type: type }); }
  function can(what) {
    if (ui.control) return true;
    toast("403 — Viewer role cannot " + what + ". Enforced server-side, not just hidden in the UI.", "error");
    return false;
  }

  // ---------------- Transport ladder ----------------
  function route(n, msg) {
    const c = topo.nodeCluster[n.id]; const big = msg.bytes > 340;
    if (n.internet) return { tier: "DIRECT", path: n.id + " → cloud", lat: 0.25 + Math.random() * 0.2 };
    if (c.reach === "GATEWAY") { const h = M.hops(topo.links, n, c.internetNode) || 1; return { tier: "GATEWAY", path: h + " hop → " + c.internetNode.id + " → cloud", lat: 0.3 + 0.12 * h }; }
    if (c.reach === "LORA") {
      if (big) return { tier: "QUEUED", path: "LoRa cannot carry " + fmtB(msg.bytes) + " — held for gateway", lat: null };
      const h = M.hops(topo.links, n, c.esp.lead) || 1;
      return { tier: "LORA", path: h + " hop → " + c.esp.id + " ⇢ " + c.reachVia.split("→")[1].trim() + " → cloud", lat: 0.12 * h + 1.4 + Math.random() * 1.5 };
    }
    if (c.reach === "SAT") {
      if (big) return { tier: "QUEUED", path: "exceeds 340 B SBD cap — held for gateway", lat: null };
      const h = M.hops(topo.links, n, c.esp.lead) || 1; const lh = c.esp.sat ? 0 : 1;
      return { tier: "SAT", path: h + " hop → " + c.esp.id + (lh ? " ⇢ L1" : "") + " → Iridium → EOC", lat: 0.12 * h + lh * 2 + 25 + Math.random() * 40 };
    }
    return { tier: "QUEUED", path: "no rung available — store & forward", lat: null };
  }

  // ---------------- Simulation tick ----------------
  let tick = 0;
  const MSG_TYPES = [["POS", 48, 0.5], ["TXT", 90, 0.2], ["PTT", 2400, 0.15], ["IMG", 38000, 0.1], ["ACK", 24, 0.05]];
  function pickType() { let r = Math.random(); for (const m of MSG_TYPES) { r -= m[2]; if (r <= 0) return m; } return MSG_TYPES[0]; }

  function step() {
    tick++;
    nodes.forEach(n => {
      if (n.target) {
        const d = M.dist(n, n.target);
        if (d < 4) {
          n.x = n.target.x; n.y = n.target.y; n.target = null; n.status = "engaged";
          toast(n.id + " on site — " + n.task, "success");
          if (n.sosFor && byId[n.sosFor].status === "sos") { byId[n.sosFor].status = "engaged"; toast("SOS cleared — " + n.id + " reached " + n.sosFor + ".", "success"); requests.forEach(r => { if (r.kind === "sos" && r.from === n.sosFor && r.done) r.done += " · resolved"; }); renderRequests(); }
          n.sosFor = null;
        }
        else { n.x += (n.target.x - n.x) / d * 5; n.y += (n.target.y - n.y) / d * 5; }
      } else if (n.status === "engaged" && tick % 3 === 0) { n.x += (Math.random() - 0.5) * 1.6; n.y += (Math.random() - 0.5) * 1.6; }
    });

    // Tier 4: NDRF-03 sits on the cell fringe — internet validates ~25 s of every ~60 s.
    const gw = byId["NDRF-03"]; const ph = tick % 68; const wantNet = ph >= 20 && ph < 45;
    if (wantNet !== gw.internet) {
      gw.internet = wantNet;
      addLog({ node: gw.id, msg: "BEACON", bytes: 32, tier: wantNet ? "DIRECT" : "MESH", sys: true, lat: 0.05,
        path: wantNet ? 'NET_CAPABILITY_VALIDATED → "I have internet" flood' : "internet lost → beacon withdrawn, peers fall one rung" });
      toast(wantNet ? "NDRF-03 regained internet — auto-promoted to gateway. Cloud-bound traffic re-routes through it."
                    : "NDRF-03 lost internet. Clusters fall back to LoRa → SAT for command traffic.", wantNet ? "success" : "warn");
    }

    topo = M.computeTopology(nodes, esps);

    // Reconciliation sync: flush store-and-forward queues where a rung now exists.
    nodes.forEach(n => {
      if (!n.queue.length) return; const c = topo.nodeCluster[n.id]; if (c.reach === "none") return;
      const keep = []; let flushed = 0, bytes = 0;
      n.queue.forEach(m => {
        const r = route(n, m); if (r.tier === "QUEUED") { keep.push(m); return; }
        flushed++; bytes += m.bytes;
        if (m.type === "IMG") { const ph = photos.find(x => x.from === n.id && x.status !== "delivered"); if (ph) { ph.received = ph.chunks; ph.status = "delivered"; ph.via = r.path; toast("Photo " + ph.id + " from " + n.id + " arrived — " + ph.chunks + " chunks reassembled.", "success"); renderPhotos(); } }
        if (m.req) { requests.unshift({ ...m.req, via: r.path, done: false, late: true }); toast("Backup request from " + n.id + " delivered " + m.req.age + " min after it was sent — carried by the new rung", "warn"); }
        addLog({ node: n.id, msg: m.type + " ⤴", bytes: m.bytes, tier: r.tier, path: r.path, lat: r.lat, sys: m.type === "REQ" });
        n.lastTier = r.tier; n.lastAt = Date.now();
      });
      n.queue = keep;
      if (flushed) { addLog({ node: n.id, msg: "SYNC", bytes, tier: "MESH", path: "reconciliation: " + flushed + " queued items flushed in one batch", lat: 0.4, sys: true }); renderRequests(); }
    });

    // Background traffic
    nodes.filter(() => Math.random() < 0.09).forEach(n => {
      const [type, base] = pickType(); const bytes = Math.round(base * (0.7 + Math.random() * 0.6));
      const c = topo.nodeCluster[n.id];
      if (type === "PTT" || type === "ACK") {
        const peers = c.members.filter(p => p !== n); if (!peers.length) return;
        const p = peers[Math.floor(Math.random() * peers.length)]; const h = M.hops(topo.links, n, p) || 1;
        addLog({ node: n.id, msg: type, bytes, tier: "MESH", path: (type === "PTT" ? "PTT (Codec 2, 2.4 kb/s)" : "ack") + " → " + p.id + ", " + h + " hop", lat: 0.08 * h });
        n.lastTier = "MESH"; n.lastAt = Date.now(); return;
      }
      const r = route(n, { bytes });
      if (r.tier === "QUEUED") { n.queue.push({ type, bytes }); addLog({ node: n.id, msg: type, bytes, tier: "QUEUED", path: r.path, lat: null }); return; }
      addLog({ node: n.id, msg: type, bytes, tier: r.tier, path: r.path, lat: r.lat }); n.lastTier = r.tier; n.lastAt = Date.now();
    });
    render();
  }

  // ---------------- Render: map + HQ ----------------
  function renderMap() {
    M.renderMap($("map"), { nodes, esps, topo, tasks, zones, byId, selected: ui.selected, showZones: ui.showZones, selZone: ui.selZone });
  }
  function renderHQ() {
    const withNet = topo.clusters.some(c => c.reach === "GATEWAY" || c.reach === "LORA");
    const reach = topo.clusters.filter(c => c.reach !== "none").length;
    const queued = nodes.reduce((s, n) => s + n.queue.length, 0);
    const up = $("uplink"); if (up) {
      up.classList.toggle("sat", !withNet);
      $("uplink-txt").innerHTML = withNet ? "<b>INTERNET</b> · via gateway NDRF-03 · full payload" : "<b>SAT</b> · Iridium SBD (sim) · 340 B cap";
    }
    $("hq-link").textContent = withNet ? "Cellular via NDRF-03" : "SAT via L1";
    $("hq-rtt").textContent = withNet ? "~0.4 s" : "~48 s";
    $("hq-clusters").textContent = reach + " / " + topo.clusters.length;
    $("hq-queued").textContent = queued + " item" + (queued === 1 ? "" : "s");
  }
  function zoomToCluster(c) { if (!c) return; view.zoomTo(c.cx, c.cy, c.r || 80); }
  function clusterOf(n) { return topo.nodeCluster[n.id]; }

  // ---------------- Render: alert engine ----------------
  function renderAlerts() {
    const top = topZone();
    $("level-box").className = "level-box " + top.level; $("level-big").textContent = top.level;
    $("level-desc").innerHTML = "<b>" + top.id + " · " + top.name + "</b> — " + (top.override ? "set manually by coordinator." : "auto-escalated; all agencies notified.");
    $("zlist").innerHTML = zones.map(z =>
      '<div class="zrow' + (z.id === ui.selZone ? " sel" : "") + '" data-z="' + z.id + '" tabindex="0" role="button">' +
      '<span class="bar ' + z.level + '"></span><div><div class="n">' + z.id + " · " + z.name + '</div><div class="s">' + z.sub + (z.override ? " · manual override" : "") + "</div></div>" +
      '<span class="lv" style="color:' + levelColor(z.level) + '">' + z.level + "</span></div>").join("");
    const z = zones.find(x => x.id === ui.selZone); const auto = combine({ ...z, override: null });
    $("explain").innerHTML =
      '<div class="h"><b>' + z.id + " · " + z.name + '</b><span class="text-dim">why it\'s ' + z.level + "</span></div>" +
      '<div class="layer"><span class="lt">Layer 1 · static</span><span class="lv">' + z.base + " · p=" + z.baseP.toFixed(2) + '</span><span class="ld">Gradient-boosted baseline (XGBoost), pre-computed offline</span></div>' +
      '<ul class="factors"><li><span>Slope (SRTM DEM)</span><span>' + z.slope + '°</span></li><li><span>GSI landslide susceptibility</span><span>' + z.gsi + "</span></li><li><span>Historical record</span><span>" + z.hist + "</span></li>" +
      (z.cwc ? "<li><span>CWC river gauge</span><span>" + z.cwc + "</span></li>" : "") + "</ul>" +
      '<div class="layer"><span class="lt">Layer 2 · dynamic</span><span class="lv">' + z.rain3h + " / " + z.thr + " mm · " + (z.trig * 100).toFixed(0) + '%</span><span class="ld">IMD 3 h rainfall vs zone threshold (2005–2025 record)</span></div>' +
      '<div class="layer"><span class="lt">Combined</span><span class="lv">' + z.level + '</span><span class="ld">' + (z.override ? "Coordinator override (engine would say " + auto + ")" : "f(baseline, trigger) → alert engine → apps + dashboard") + "</span></div>" +
      '<div class="inline-form"><select id="ovr" class="sm-input" aria-label="Override zone level">' +
      ORDER.map(l => '<option value="' + l + '"' + (z.override === l ? " selected" : "") + ">" + l + "</option>").join("") +
      '<option value="AUTO"' + (!z.override ? " selected" : "") + '>AUTO (engine)</option></select>' +
      '<button class="btn-secondary btn-sm' + (ui.control ? "" : " locked") + '" id="btn-ovr">Set</button></div>';
    $("btn-ovr").addEventListener("click", () => {
      if (!can("override the alert level")) return;
      const v = $("ovr").value; z.override = v === "AUTO" ? null : v; z.level = combine(z);
      toast(z.id + " set to " + z.level + (z.override ? " (manual)" : " (engine)") + " — pushed to all apps as a broadcast packet", "success");
      addLog({ node: "EOC", msg: "ALERT", bytes: 118, tier: "SAT", path: "broadcast type · flood via L1 → all LoRa comps → each cluster", lat: 31, sys: true });
      syncEmergency(); renderAlerts(); renderMap();
    });
    renderRain(z);
  }
  function syncEmergency() {
    const top = topZone();
    const shouldBe = top.level === "CRITICAL";
    if (shouldBe !== RLAuth.isEmergencyActive()) RLAuth.setEmergency(shouldBe, D.INCIDENT.impactAt);
  }

  // 72 h of hourly rainfall for a cell; the burst in the last 12 h is scaled to its 3 h total.
  function rainSeries(z) {
    const s = []; let seed = z.id.charCodeAt(1) * 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let h = 0; h < 72; h++) {
      let v = 2 + rnd() * 6; if (h > 40 && h < 52) v += 8 + rnd() * 10;
      if (h >= 60) { const k = (h - 60) / 11; v += z.rain3h / 3 * (0.5 + 1.1 * k) * (0.7 + rnd() * 0.6); }
      s.push(Math.round(v));
    }
    return s;
  }
  function renderRain(z) {
    const S = rainSeries(z), W = 268, H = 96, pl = 26, pr = 6, pt = 14, pb = 18;
    const max = Math.max(60, Math.ceil(Math.max(...S) / 20) * 20), thrH = Math.round(z.thr / 3);
    const X = i => pl + (i / 71) * (W - pl - pr), Y = v => pt + (1 - v / max) * (H - pt - pb);
    const pts = S.map((v, i) => X(i).toFixed(1) + "," + Y(v).toFixed(1)).join(" ");
    const area = "M" + X(0) + "," + Y(0) + " L" + pts.split(" ").join(" L") + " L" + X(71) + "," + Y(0) + " Z";
    const flagAt = S.findIndex((v, i) => S.slice(Math.max(0, i - 2), i + 1).reduce((a, b) => a + b, 0) >= z.thr);
    const ticks = [0, max / 2, max];
    $("rain-chart").innerHTML =
      '<div class="chart-title">IMD hourly rainfall · 72 h · ' + z.id + "</div>" +
      '<svg viewBox="0 0 ' + W + " " + H + '" id="rain-svg">' +
      ticks.map(t => '<line class="grid" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(t) + '" y2="' + Y(t) + '"/><text class="lbl" x="' + (pl - 4) + '" y="' + (Y(t) + 3.5) + '" text-anchor="end">' + t + "</text>").join("") +
      '<path class="area" d="' + area + '"/><polyline class="line" points="' + pts + '"/>' +
      '<line class="thr" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(thrH) + '" y2="' + Y(thrH) + '"/><text class="thr-lbl" x="' + (W - pr) + '" y="' + (Y(thrH) - 3) + '" text-anchor="end">threshold ' + thrH + " mm/h</text>" +
      (flagAt >= 0 ? '<line class="flag" x1="' + X(flagAt) + '" x2="' + X(flagAt) + '" y1="' + pt + '" y2="' + (H - pb) + '"/><text class="flag-lbl" x="' + (X(flagAt) - 4) + '" y="' + (pt + 8) + '" text-anchor="end">FLAGGED T−' + (72 - flagAt) + "h</text>" : "") +
      '<line class="ax" x1="' + pl + '" x2="' + (W - pr) + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '"/>' +
      '<text class="lbl" x="' + pl + '" y="' + (H - 4) + '">−72 h</text><text class="lbl" x="' + X(36) + '" y="' + (H - 4) + '" text-anchor="middle">−36 h</text><text class="lbl" x="' + (W - pr) + '" y="' + (H - 4) + '" text-anchor="end">now</text>' +
      '<g id="rain-hover" hidden><line class="cross" y1="' + pt + '" y2="' + (H - pb) + '"/><circle class="dot" r="3.5"/></g>' +
      '<rect x="' + pl + '" y="' + pt + '" width="' + (W - pl - pr) + '" height="' + (H - pt - pb) + '" fill="transparent" id="rain-hit"/></svg>' +
      '<div class="chart-cap">mm per hour · thresholds derived from the 2005–2025 station record</div>';
    const svg = $("rain-svg"), hv = $("rain-hover"), hit = $("rain-hit");
    hit.addEventListener("mousemove", ev => {
      const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) / r.width * W; const i = Math.max(0, Math.min(71, Math.round((px - pl) / (W - pl - pr) * 71)));
      hv.hidden = false; const ln = hv.querySelector("line"), dot = hv.querySelector("circle");
      ln.setAttribute("x1", X(i)); ln.setAttribute("x2", X(i)); dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(S[i]));
      M.showTip(ev, "T−" + (72 - i) + " h", S[i] + " mm/h · 3 h total " + S.slice(Math.max(0, i - 2), i + 1).reduce((a, b) => a + b, 0) + " mm");
    });
    hit.addEventListener("mouseleave", () => { hv.hidden = true; M.hideTip(); });
  }

  // ---------------- Render: forces ----------------
  function renderForces() {
    $("force-cnt").textContent = nodes.length + " responders · " + topo.clusters.length + " groups";
    $("roster-agency").classList.toggle("active", ui.roster === "agency");
    $("roster-group").classList.toggle("active", ui.roster === "group");
    if (ui.roster === "group") { renderGroups(); return; }
    const groups = {}; nodes.forEach(n => { (groups[n.ag] = groups[n.ag] || []).push(n); });
    $("forces").innerHTML = Object.keys(AG).map(ag =>
      '<div class="agency"><div class="ah"><span class="agency-dot" style="background:' + AG[ag].color + '"></span>' + AG[ag].label + '<span class="n">' + (groups[ag] || []).length + "</span></div>" +
      (groups[ag] || []).map(n => {
        const c = topo.nodeCluster[n.id];
        const via = n.queue.length && c.reach === "none" ? "<b>unreachable</b> · " + n.queue.length + " queued · last heard " + fmtAge(Date.now() - n.lastAt)
                                                       : "via <b>" + (n.lastTier || c.reach) + "</b> · " + fmtAge(Date.now() - n.lastAt) + " · " + c.name;
        return '<div class="frow' + (n === ui.selected ? " sel" : "") + '" data-n="' + n.id + '" tabindex="0" role="button">' +
          '<span class="id"><span class="stat ' + (c.reach === "none" ? "dark" : n.status) + '"></span>' + n.id + "</span>" + statusChip(n) + '<span class="via">' + via + "</span></div>";
      }).join("") + "</div>").join("");
  }

  // Groups = live Wi-Fi Aware clusters. Membership changes as people move.
  function renderGroups() {
    $("forces").innerHTML = topo.clusters.map(c => {
      const nPhotos = photos.filter(ph => c.members.some(m => m.id === ph.from)).length;
      const up = c.reach === "none" ? '<span class="chip chip-p0">NO LINK</span>' : c.reach === "GATEWAY" ? '<span class="chip chip-ok">INTERNET</span>' : c.reach === "SAT" ? '<span class="chip chip-p1">SATELLITE</span>' : '<span class="chip chip-p1">LORA → NET</span>';
      const via = c.reach === "none" ? "store & forward" : c.reach === "GATEWAY" ? "via " + c.reachVia : c.reachVia;
      return '<div class="group' + (ui.selected && c.members.includes(ui.selected) ? " sel" : "") + '">' +
        '<div class="gh"><b>' + c.name + '</b><span class="n">' + c.members.length + " · " + (c.esp ? c.esp.id : "no bridge") + "</span>" + up + "</div>" +
        '<div class="gv">' + via + "</div>" +
        '<div class="gm">' + c.members.map(n => '<span class="gmember" data-n="' + n.id + '" tabindex="0" role="button" title="' + AG[n.ag].label + '"><span class="stat ' + n.status + '"></span><span class="agency-dot" style="background:' + AG[n.ag].color + ';width:8px;height:8px"></span>' + n.id + "</span>").join("") + "</div>" +
        '<div class="ga"><button class="btn-secondary btn-xs" data-zoom="' + c.name + '">⌕ Zoom in</button>' +
        (nPhotos ? '<button class="btn-secondary btn-xs" data-photos="' + c.name + '">▣ ' + nPhotos + " photo" + (nPhotos > 1 ? "s" : "") + "</button>" : "") + "</div></div>";
    }).join("");
    $("forces").querySelectorAll("[data-zoom]").forEach(b => b.addEventListener("click", ev => { ev.stopPropagation(); zoomToCluster(topo.clusters.find(c => c.name === b.dataset.zoom)); }));
    $("forces").querySelectorAll("[data-photos]").forEach(b => b.addEventListener("click", ev => { ev.stopPropagation(); ui.photoFilter = "group:" + b.dataset.photos; renderPhotos(); $("photos-panel").scrollIntoView({ behavior: "smooth", block: "start" }); }));
  }

  // ---------------- Render: photos ----------------
  function photoCtx(ph) {
    const n = byId[ph.from]; const c = n && clusterOf(n); const z = zones.find(z => z.id === ph.zone);
    return { agency: n ? AG[n.ag].label : "", group: c ? c.name : "", zoneName: z ? z.name : "" };
  }
  function renderPhotos() {
    let list = photos.slice();
    let label = "all responders";
    if (ui.photoFilter.startsWith("group:")) { const g = ui.photoFilter.slice(6); list = list.filter(ph => { const n = byId[ph.from]; return n && clusterOf(n).name === g; }); label = g; }
    else if (ui.photoFilter.startsWith("node:")) { const id = ui.photoFilter.slice(5); list = list.filter(ph => ph.from === id); label = id; }
    list.sort((a, b) => a.ageMin - b.ageMin);
    $("photo-cnt").textContent = list.length + " · " + label;
    $("photo-filter").innerHTML = '<button class="btn-ghost btn-xs' + (ui.photoFilter === "all" ? " active" : "") + '" data-pf="all">All</button>' +
      topo.clusters.filter(c => photos.some(ph => c.members.some(m => m.id === ph.from))).map(c => '<button class="btn-ghost btn-xs' + (ui.photoFilter === "group:" + c.name ? " active" : "") + '" data-pf="group:' + c.name + '">' + c.name.replace("Cluster ", "Grp ") + "</button>").join("") +
      (ui.photoFilter.startsWith("node:") ? '<button class="btn-ghost btn-xs active" data-pf="' + ui.photoFilter + '">' + ui.photoFilter.slice(5) + "</button>" : "");
    $("photo-filter").querySelectorAll("[data-pf]").forEach(b => b.addEventListener("click", () => { ui.photoFilter = b.dataset.pf; renderPhotos(); }));
    $("photos").innerHTML = list.length ? list.map(ph =>
      '<button class="photo-tile" data-ph="' + ph.id + '" title="' + ph.caption + '">' + RLAuth.photoFigure(ph, "thumb") +
      '<div class="pt-meta"><span class="mono">' + ph.from + "</span><span>" + ph.ageMin + " min</span></div>" +
      (ph.status !== "delivered" ? '<div class="pt-bar"><i style="width:' + Math.round(ph.received / ph.chunks * 100) + '%"></i></div>' : "") + "</button>").join("")
      : '<div class="empty-note">No photos from ' + label + " yet.</div>";
    $("photos").querySelectorAll("[data-ph]").forEach(b => b.addEventListener("click", () => { const ph = photos.find(x => x.id === b.dataset.ph); RLAuth.openPhotoViewer(ph, photoCtx(ph)); }));
  }

  // ---------------- Render: selected responder ----------------
  function renderSelected() {
    const box = $("selected");
    if (!ui.selected) { box.innerHTML = '<div class="empty-note">Select a responder on the map or in the roster to see link quality, last report path, and available actions.</div>'; $("sel-hint").textContent = "click a node"; return; }
    const n = ui.selected, c = topo.nodeCluster[n.id], ll = M.latLon(n);
    const nb = topo.links.filter(l => l.a === n || l.b === n).map(l => ({ o: l.a === n ? l.b : l.a, q: l.q, rssi: l.rssi, d: l.d })).sort((p, q) => q.q - p.q);
    const lock = ui.control ? "" : " locked";
    const myPhotos = photos.filter(ph => ph.from === n.id);
    $("sel-hint").innerHTML = c.name + ' · <button class="btn-ghost btn-xs" id="sel-zoom">⌕ zoom</button>';
    $("sel-zoom").addEventListener("click", () => view.zoomTo(n.x, n.y, 70));
    box.innerHTML =
      '<div class="sel-head"><div class="av" style="background:' + AG[n.ag].color + '">' + AG[n.ag].short + '</div><div><div class="id">' + n.id + '</div><div class="ag">' + AG[n.ag].label + "</div></div>" + statusChip(n) + "</div>" +
      (n.status === "sos" ? '<div class="sos-note">⚠ ' + n.sosText + "</div>" +
        '<div class="sos-assign"><div class="sub-title" style="margin-top:8px">Send someone to ' + n.id + '</div>' +
        '<div class="inline-form" style="margin-top:0"><select id="sos-sel" class="sm-input" aria-label="Responder to send">' + candOptions(n) + '</select>' +
        '<button class="btn-danger btn-sm' + (ui.control ? "" : " locked") + '" id="sos-go">Send help</button></div>' +
        '<div class="sim-note">Nearest first · SOS jumps the queue on every tier</div></div>' : "") +
      '<div class="kv"><span class="k">Task</span><span class="v">' + (n.task || "— unassigned") + '</span>' +
      '<span class="k">Position</span><span class="v">' + ll.lat + " N, " + ll.lon + " E · " + M.altitudeM(n.x, n.y) + ' m</span>' +
      '<span class="k">Uplink</span><span class="v">' + (c.reach === "none" ? "none — " + n.queue.length + " queued (DTN)" : c.reach + " · " + c.reachVia) + "</span>" +
      '<span class="k">Last report</span><span class="v">' + (n.lastTier || "—") + " · " + fmtAge(Date.now() - n.lastAt) + "</span>" +
      '<span class="k">Battery</span><span class="v">' + n.batt + "% · ~" + (n.batt / 100 * 7.2).toFixed(1) + " h at duty</span>" +
      (n.internet ? '<span class="k">Role</span><span class="v" style="color:var(--p3)">INTERNET GATEWAY (auto-promoted)</span>' : "") + "</div>" +
      (myPhotos.length ? '<div class="sub-title">Photos uploaded · ' + myPhotos.length + '</div><div class="sel-photos">' + myPhotos.map(ph => '<button class="photo-tile small" data-ph="' + ph.id + '" title="' + ph.caption + '">' + RLAuth.photoFigure(ph, "thumb") + "</button>").join("") + "</div>" : "") +
      '<div class="sub-title">Wi-Fi Aware neighbours · ' + nb.length + "</div>" +
      '<div class="nbrs">' + (nb.length ? nb.map(x => '<div class="nbr"><span class="id">' + x.o.id + '</span><span class="bar"><i style="width:' + Math.round(x.q * 100) + '%"></i></span><span class="db">' + x.rssi + " dBm · " + Math.round(x.d * M.UNIT_M) + " m</span></div>").join("") : '<div class="text-dim" style="font-size:12px">No peers in range — isolated node.</div>') + "</div>" +
      '<div class="actions">' +
      '<button class="btn-secondary btn-sm' + (ui.assigning ? " active" : "") + lock + '" id="a-task">⌖ Assign task</button>' +
      '<button class="btn-secondary btn-sm' + lock + '" id="a-high">▲ Direct to high ground</button>' +
      '<button class="btn-secondary btn-sm' + lock + '" id="a-ptt">◉ Targeted PTT</button>' +
      '<button class="btn-secondary btn-sm' + lock + '" id="a-disp">⇄ Displace to…</button></div>' +
      '<div class="ptt" id="ptt"><span class="mono">TX</span><div class="vu"><i id="vu"></i></div><span class="mono" id="ptt-t">0.0 s</span></div>' +
      '<div class="inline-form" id="disp-row" style="display:none"><select id="disp-sel" class="sm-input" aria-label="Displace to cluster">' +
      topo.clusters.filter(x => x !== c).map(x => '<option value="' + x.name + '">' + x.name + " · " + x.members.length + " · " + (x.reach === "none" ? "no uplink" : x.reach) + "</option>").join("") +
      '</select><button class="btn-primary btn-sm" id="disp-go">Go</button></div>';

    box.querySelectorAll("[data-ph]").forEach(b => b.addEventListener("click", () => { const ph = photos.find(x => x.id === b.dataset.ph); RLAuth.openPhotoViewer(ph, photoCtx(ph)); }));
    if ($("sos-go")) $("sos-go").addEventListener("click", () => {
      if (!can("send help")) return;
      const m = byId[$("sos-sel").value]; if (!m) { toast("No responder can be sent right now.", "warn"); return; }
      let r = requests.find(x => x.kind === "sos" && x.from === n.id && !x.done);
      if (!r) { r = { id: "REQ-" + (10 + requests.length), kind: "sos", need: "SOS", from: n.id, text: n.sosText || "SOS raised from responder app", age: 0, via: "MESH", done: false }; requests.unshift(r); }
      dispatch(r, m);
    });
    $("a-task").addEventListener("click", () => {
      if (!can("assign tasks")) return;
      ui.assigning = !ui.assigning; $("mapbox").classList.toggle("assigning", ui.assigning); $("a-task").classList.toggle("active", ui.assigning);
      if (ui.assigning) toast("Click a point on the map to assign " + n.id + " there.");
    });
    $("a-high").addEventListener("click", () => { if (!can("direct responders")) return; highGround(n); });
    $("a-ptt").addEventListener("click", () => { if (!can("open PTT")) return; ptt(n); });
    $("a-disp").addEventListener("click", () => {
      if (!can("displace forces")) return;
      const r = $("disp-row"); r.style.display = r.style.display === "none" ? "flex" : "none"; ui.selLock = r.style.display === "flex";
    });
    $("disp-go").addEventListener("click", () => {
      const t = topo.clusters.find(x => x.name === $("disp-sel").value); if (!t) return;
      n.target = { x: t.cx + (Math.random() - 0.5) * 30, y: t.cy + (Math.random() - 0.5) * 30 }; n.status = "enroute"; n.task = "Reinforce " + t.name; ui.selLock = false;
      const rt = route(n, { bytes: 72 });
      toast(n.id + " displaced to " + t.name + " — moving without returning to staging", "success");
      addLog({ node: "EOC", msg: "TASK", bytes: 72, tier: rt.tier, path: "displacement order → " + n.id, lat: rt.lat, sys: true });
      render();
    });
  }

  function highGround(n) {
    const e0 = M.elev(n.x, n.y), p = M.highGroundFrom(n), e1 = M.elev(p.x, p.y);
    if (e1 - e0 < 0.02) { toast(n.id + " is already on the local high point.", "warn"); return; }
    n.target = p; n.status = "enroute"; n.task = n.task || "Bridge position";
    const before = topo.clusters.length; const c = topo.nodeCluster[n.id];
    toast(n.id + " directed uphill (+" + Math.round((e1 - e0) * 220) + " m). Range grows with elevation — watch the gap close.", "success");
    addLog({ node: "EOC", msg: "TASK", bytes: 64, tier: c.reach === "none" ? "QUEUED" : "SAT", path: '"move to high ground" → ' + n.id + " (radio power is fixed; elevation is the lever)", lat: c.reach === "none" ? null : 29, sys: true });
    const check = setInterval(() => {
      if (n.target) return; clearInterval(check); topo = M.computeTopology(nodes, esps);
      const nc = topo.nodeCluster[n.id];
      if (topo.clusters.length < before) toast("Gap bridged — " + n.id + " now relays " + nc.name + " (" + nc.members.length + " nodes) via " + nc.reach + ".", "success");
      render();
    }, 300);
  }

  function ptt(n) {
    const box = $("ptt"), vu = $("vu"), tt = $("ptt-t"); box.classList.add("live"); ui.selLock = true; const t0 = Date.now();
    const iv = setInterval(() => {
      const s = (Date.now() - t0) / 1000; vu.style.width = (30 + Math.random() * 60) + "%"; tt.textContent = s.toFixed(1) + " s";
      if (s < 3) return;
      clearInterval(iv); box.classList.remove("live"); vu.style.width = "0"; ui.selLock = false;
      const c = topo.nodeCluster[n.id];
      const r = (c.reach === "GATEWAY" || c.reach === "LORA") ? { tier: "DIRECT", path: "EOC → server-relayed voice channel → " + n.id, lat: 0.35 }
                                                              : { tier: "QUEUED", path: "no voice-capable rung to " + n.id + " (LoRa/SAT carry text only) — text fallback sent", lat: null };
      addLog({ node: "EOC", msg: "PTT", bytes: 900, tier: r.tier, path: r.path, lat: r.lat, sys: true });
      toast(r.tier === "QUEUED" ? "No voice rung to that cluster: PTT downgraded to text over LoRa/SAT." : "PTT delivered — 3.0 s, Codec 2 @ 2.4 kb/s = 900 B", "warn");
    }, 90);
  }

  // Send responder m to the person who raised request r (SOS or backup).
  function dispatch(r, m) {
    const dst = byId[r.from];
    m.target = { x: dst.x + (Math.random() - 0.5) * 24, y: dst.y + 18 }; m.status = "enroute";
    m.task = (r.kind === "sos" ? "Extract " : "Support ") + r.from; m.sosFor = r.kind === "sos" ? r.from : null;
    r.done = "dispatched " + m.id;
    tasks.push({ node: m.id, x: m.target.x, y: m.target.y, label: m.task });
    const rt = route(m, { bytes: 72 });
    addLog({ node: "EOC", msg: "TASK", bytes: 72, tier: rt.tier, path: "dispatch → " + m.id + " for " + r.id, lat: rt.lat, sys: true });
    toast(m.id + " sent to " + r.from + " — task pushed to their app over " + rt.tier + (rt.tier === "QUEUED" ? " (delivers when a link appears)" : ""), rt.tier === "QUEUED" ? "warn" : "success");
    renderRequests(); render();
  }
  // Anyone can be sent: nearest first, available before engaged, never another SOS.
  function candidatesFor(target) {
    return nodes.filter(x => x !== target && x.status !== "sos" && !x.target)
      .sort((p, q) => (p.status === "available" ? 0 : 1) - (q.status === "available" ? 0 : 1) || M.dist(p, target) - M.dist(q, target));
  }
  function candOptions(target) {
    return candidatesFor(target).slice(0, 8).map(x => '<option value="' + x.id + '">' + x.id + " · " + Math.round(M.dist(x, target) * M.UNIT_M) + " m · " + (x.status === "enroute" ? "en route" : x.status) + "</option>").join("");
  }

  // ---------------- Render: requests ----------------
  function renderRequests() {
    $("req-cnt").textContent = requests.filter(r => !r.done).length + " open";
    $("requests").innerHTML = requests.map(r => {
      const n = byId[r.from];
      return '<div class="req' + (r.kind === "sos" ? " sos" : "") + (r.done ? " done" : "") + '"><div class="rh"><span class="chip ' + (r.kind === "sos" ? "chip-p0" : "chip-p1") + '">' + (r.kind === "sos" ? "⚠ " : "✚ ") + r.need + "</span>" +
        (r.late ? '<span class="chip chip-aged">delivered late</span>' : "") + '<span class="id">' + r.from + '</span></div><div class="txt">' + r.text + '</div>' +
        '<div class="rm">' + r.age + " min ago · via <b>" + r.via + "</b>" + (r.done ? " · <b>" + r.done + "</b>" : "") + "</div>" +
        (r.done ? "" : '<div class="inline-form"><select class="sm-input" aria-label="Send responder" data-r="' + r.id + '">' + candOptions(n) +
          '</select><button class="btn-primary btn-sm' + (ui.control ? "" : " locked") + '" data-resp="' + r.id + '">' + (r.kind === "sos" ? "Send help" : "Dispatch") + '</button></div>') + "</div>";
    }).join("");
    $("requests").querySelectorAll("[data-resp]").forEach(b => b.addEventListener("click", () => {
      if (!can("dispatch")) return;
      const r = requests.find(x => x.id === b.dataset.resp); const sel = $("requests").querySelector('select[data-r="' + r.id + '"]');
      const m = byId[sel && sel.value];
      if (!m) { toast("No responder can be sent right now.", "warn"); return; }
      dispatch(r, m);
    }));
  }

  // ---------------- Render: broadcast ----------------
  function renderBroadcastBytes() {
    const b = new TextEncoder().encode($("bc-text").value).length;
    $("bc-lora").textContent = b + "/237 B"; $("bc-lora").className = b > 237 ? "over" : "";
    $("bc-sat").textContent = b + "/340 B"; $("bc-sat").className = b > 340 ? "over" : "";
    $("btn-bc").disabled = b > 340;
  }
  function sendBroadcast() {
    if (!can("broadcast")) return; const t = $("bc-text").value.trim(); if (!t) return;
    const b = new TextEncoder().encode(t).length; ui.bcCount++;
    const rows = topo.clusters.map(c => {
      let via, lat;
      if (c.reach === "GATEWAY") { via = "cloud → " + c.internetNode.id + " → mesh flood"; lat = 0.4 + Math.random() * 0.3; }
      else if (c.reach === "LORA" || c.reach === "SAT") {
        const comp = topo.loraComp[c.esp.id];
        const entry = esps.find(e => e.on && topo.loraComp[e.id] === comp && (e.sat || (e.lead && e.lead.internet)));
        const lh = entry && entry !== c.esp ? 1 : 0;
        via = (entry && entry.sat ? "SAT → L1" : "cloud → " + entry.lead.id) + (lh ? " ⇢ " + c.esp.id : "") + " → mesh flood";
        lat = (entry && entry.sat ? 26 + Math.random() * 20 : 0.5) + lh * 2.2 + 0.3;
      } else { via = "unreachable — held at EOC until a rung appears"; lat = null; }
      return { c, via, lat };
    });
    $("deliv").innerHTML = '<div class="sub-title">Delivery · BC-' + String(ui.bcCount).padStart(3, "0") + " · " + b + " B · TTL 8</div>" +
      rows.map(r => '<div class="d"><span class="chip ' + (r.lat == null ? "chip-p0" : "chip-p3") + '">' + (r.lat == null ? "✕" : "✓") + "</span><span><b>" + r.c.name + "</b> · " + r.c.members.length + ' nodes <span class="via">' + r.via + '</span></span><span class="t">' + fmtLat(r.lat) + "</span></div>").join("");
    rows.forEach(r => addLog({ node: "EOC", msg: "BCAST", bytes: b, tier: r.lat == null ? "QUEUED" : r.c.reach === "GATEWAY" ? "DIRECT" : r.c.reach, path: r.c.name + " · " + r.via, lat: r.lat, sys: true }));
    toast("Broadcast sent — " + rows.filter(r => r.lat != null).length + "/" + rows.length + " clusters reachable now; the rest deliver on reconnect.", "success");
  }

  // ---------------- Render: clocks ----------------
  function renderClocks() {
    $("clk-elapsed").textContent = "T+" + RLAuth.fmtElapsed(Date.now() - D.INCIDENT.impactAt);
  }
  function render() {
    renderMap(); renderHQ();
    if (ui.rTick++ % 2 === 0) { renderForces(); if (!ui.selLock) renderSelected(); }
    if (ui.rTick % 8 === 0) renderPhotos();
  }
  function select(n) { ui.selected = n; ui.selLock = false; ui.assigning = false; $("mapbox").classList.remove("assigning"); renderMap(); renderForces(); renderSelected(); }

  // ---------------- Wiring ----------------
  function wire() {
    const map = $("map");
    map.addEventListener("click", ev => {
      if (view.consumeDrag()) return;
      const g = ev.target.closest("[data-n]"); if (g) { select(byId[g.dataset.n]); return; }
      const cl = ev.target.closest("[data-c]"); if (cl && !ui.assigning) { zoomToCluster(topo.clusters.find(c => c.name === cl.dataset.c)); return; }
      const z = ev.target.closest("[data-z]"); if (z) { ui.selZone = z.dataset.z; renderAlerts(); renderMap(); return; }
      const e = ev.target.closest("[data-e]");
      if (e) {
        const esp = esps.find(x => x.id === e.dataset.e); if (!can("toggle relays")) return;
        esp.on = !esp.on; toast(esp.id + (esp.on ? " powered on" : " powered off") + " — LoRa component recomputed", esp.on ? "success" : "warn");
        topo = M.computeTopology(nodes, esps); render(); return;
      }
      if (ui.assigning && ui.selected) {
        const p = M.svgPoint(map, ev), n = ui.selected;
        n.target = { x: p.x, y: p.y }; n.status = "enroute";
        const zone = zones.find(z => p.x >= z.x && p.x < z.x + z.w && p.y >= z.y && p.y < z.y + z.h);
        n.task = "Task at " + (zone ? zone.name : "sector"); tasks.push({ node: n.id, x: p.x, y: p.y, label: n.task });
        ui.assigning = false; $("mapbox").classList.remove("assigning");
        const rt = route(n, { bytes: 72 }), ll = M.latLon(p);
        addLog({ node: "EOC", msg: "TASK", bytes: 72, tier: rt.tier, path: "coordinates " + ll.lat + ", " + ll.lon + " → " + n.id, lat: rt.lat, sys: true });
        toast("Task pushed to " + n.id + " over " + rt.tier + (rt.tier === "QUEUED" ? " — will deliver when a rung appears" : ""), rt.tier === "QUEUED" ? "warn" : "success");
        render();
      }
    });
    map.addEventListener("mousemove", ev => {
      const l = ev.target.closest("[data-l]");
      if (l) { const k = topo.links[+l.dataset.l]; M.showTip(ev, k.a.id + " ↔ " + k.b.id, k.rssi + " dBm · " + Math.round(k.d * M.UNIT_M) + " m of " + Math.round(M.rangeOf(k.a, k.b) * M.UNIT_M) + " m · Wi-Fi Aware NAN"); return; }
      const g = ev.target.closest("[data-n]");
      if (g) { const n = byId[g.dataset.n], c = topo.nodeCluster[n.id]; M.showTip(ev, n.id + " · " + AG[n.ag].label.split(" ·")[0], c.name + " · " + n.status + " · uplink " + c.reach + (n.queue.length ? " · " + n.queue.length + " queued" : "")); return; }
      const e = ev.target.closest("[data-e]");
      if (e) { const esp = esps.find(x => x.id === e.dataset.e); M.showTip(ev, esp.label, "ESP32 · Meshtastic · 865–867 MHz · " + (esp.on ? "on" : "off") + (esp.lead ? " · lead " + esp.lead.id : " · no phone attached") + (esp.sat ? " · RockBLOCK 9603" : "")); return; }
      M.hideTip();
    });
    map.addEventListener("mouseleave", M.hideTip);

    $("forces").addEventListener("click", ev => { const r = ev.target.closest("[data-n]"); if (r) { select(byId[r.dataset.n]); ui.photoFilter = "node:" + r.dataset.n; renderPhotos(); } });
    $("roster-agency").addEventListener("click", () => { ui.roster = "agency"; renderForces(); });
    $("roster-group").addEventListener("click", () => { ui.roster = "group"; renderForces(); });
    $("zoom-in").addEventListener("click", () => view.zoomBy(1.5));
    $("zoom-out").addEventListener("click", () => view.zoomBy(1 / 1.5));
    $("zoom-fit").addEventListener("click", () => view.fit());
    $("forces").addEventListener("keydown", ev => { if (ev.key === "Enter") { const r = ev.target.closest("[data-n]"); if (r) select(byId[r.dataset.n]); } });
    $("zlist").addEventListener("click", ev => { const r = ev.target.closest("[data-z]"); if (r) { ui.selZone = r.dataset.z; renderAlerts(); renderMap(); } });
    $("zlist").addEventListener("keydown", ev => { if (ev.key === "Enter") { const r = ev.target.closest("[data-z]"); if (r) { ui.selZone = r.dataset.z; renderAlerts(); renderMap(); } } });

    $("btn-zones").addEventListener("click", () => { ui.showZones = !ui.showZones; $("btn-zones").classList.toggle("active", ui.showZones); renderMap(); });
    $("btn-zones").classList.add("active");
    $("btn-relay").addEventListener("click", () => {
      if (!can("deploy relays")) return;
      if (ui.relayDeployed) { toast("L4 already deployed at the knoll.", "warn"); return; }
      ui.relayDeployed = true; esps.push({ ...D.DROPPED_RELAY });
      $("btn-relay").disabled = true; $("btn-relay").textContent = "◆ L4 deployed at knoll";
      addLog({ node: "L4", msg: "JOIN", bytes: 40, tier: "LORA", path: "dropped relay node · joined LoRa component with L1 (1.0 km, line of sight)", lat: 1.8, sys: true });
      toast("L4 dropped at the knoll — same ESP32 hardware, used here as a relay rather than a cluster bridge.", "success");
      topo = M.computeTopology(nodes, esps); render();
    });
    $("btn-bc").addEventListener("click", sendBroadcast);
    $("bc-text").addEventListener("input", renderBroadcastBytes);
    if (!ui.control) ["btn-relay", "btn-bc"].forEach(id => $(id).classList.add("locked"));
  }

  function seedLog() {
    D.SEED_LOG.slice().reverse().forEach(s => addLog({ node: s[0], msg: s[1], bytes: s[2], tier: s[3], path: s[4], lat: s[5], sys: s[1] === "SOS" }));
    log.forEach((e, i) => { e.t = new Date(Date.now() - (log.length - i) * 9000).toTimeString().slice(0, 8); });
  }

  function mount(opts) {
    ui.control = !!(opts && opts.control);
    M.drawTerrain($("terrain")); M.drawStaticFeatures($("sm-static"));
    view = M.createView($("leaflet-map"), $("map"), $("terrain"), {
      onChange: z => { $("zoom-lvl").textContent = z.toFixed(1) + "×"; },
      onBase: (kind, reason) => {
        $("btn-base").textContent = kind === "terrain" ? "Satellite" : "Terrain";
        if (reason === "tiles unavailable") toast("Satellite tiles could not load — showing the drawn terrain instead (offline mode).", "warn");
      }
    });
    $("btn-base").addEventListener("click", () => view.setBase(view.base() === "terrain" ? "satellite" : "terrain"));
    window.addEventListener("resize", () => view.invalidate());
    seedLog(); syncEmergency(); renderAlerts(); renderBroadcastBytes(); renderClocks(); renderRequests(); wire(); render(); renderPhotos();
    // "Open on map" from the Alerts page: control.html?select=NDRF-06
    const want = new URLSearchParams(location.search).get("select");
    if (want && byId[want]) { select(byId[want]); setTimeout(() => view.zoomTo(byId[want].x, byId[want].y, 70), 400); }
    setInterval(step, 900); setInterval(renderClocks, 1000);
  }

  global.RescueLINK = { mount, nodes, zones, requests, log, photos, get topo() { return topo; }, get view() { return view; } };

})(window);
