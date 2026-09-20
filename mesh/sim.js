/* ============================================================
   RescueLINK — Mesh communication simulator

   A small discrete-event engine (nodes, links, in-flight packets,
   simulated clock) plus one scenario per mechanism in the design:
   leaderless clusters, managed flooding, Codec 2 PTT, chunked
   images, LoRa airtime, gateway fail-over, satellite fall-back,
   DTN transition, alerts into a dead zone, priority queues,
   partition and rejoin. Everything is simulated; the numbers used
   (hop range, 4–6 NDP cap, 1 % LoRa duty, 340 B SBD, jitter buffer
   80–240 ms, 2 s heartbeat, …) are the ones from the design notes.
   ============================================================ */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const W = 960, H = 560;
  const canvas = $("net"), ctx = canvas.getContext("2d");
  const rnd = (a, b) => a + Math.random() * (b - a);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------------- Engine ----------------
  const E = { nodes: [], links: [], packets: [], t: 0, speed: 4, paused: false, log: [], sc: null, C: {}, step: -1, timers: [] };
  const byId = {};
  function node(id, x, y, kind, label, extra) { const n = Object.assign({ id, x, y, kind, label: label || id, alive: true, seen: new Set(), badge: "", ring: null, r: kind === "phone" ? 13 : 12 }, extra || {}); E.nodes.push(n); byId[id] = n; return n; }
  function link(a, b, kind, opts) { const l = Object.assign({ a, b, kind: kind || "wifi", delay: kind === "lora" ? 900 : kind === "sat" ? 30000 : kind === "net" ? 120 : 45, loss: 0, up: true }, opts || {}); E.links.push(l); return l; }
  function linkBetween(a, b) { return E.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a)); }
  function neighbors(id) { const n = byId[id]; if (!n || !n.alive) return []; return E.links.filter(l => l.up && (l.a === id || l.b === id)).map(l => l.a === id ? l.b : l.a).filter(o => byId[o] && byId[o].alive); }
  function send(from, to, o) {
    o = o || {}; const l = linkBetween(from, to); const A = byId[from], B = byId[to];
    if (!l || !l.up || !A || !B || !A.alive || !B.alive) return null;
    if (Math.random() < (o.loss != null ? o.loss : l.loss)) { E.stats.lost = (E.stats.lost || 0) + 1; return null; }
    const p = { from, to, link: l, prog: 0, dur: o.dur || (l.delay + rnd(0, o.jitter || 0)), color: o.color || "#1F7A5C", label: o.label || "", r: o.r || 5, payload: o.payload || {}, onArrive: o.onArrive, born: E.t };
    E.packets.push(p); return p;
  }
  function flood(at, from, o) { let n = 0; neighbors(at).forEach(nb => { if (nb !== from && send(at, nb, o)) n++; }); return n; }
  function bfs(from, to) { // shortest path over up links & alive nodes
    const prev = { [from]: null }, q = [from];
    while (q.length) { const u = q.shift(); if (u === to) break; neighbors(u).forEach(v => { if (!(v in prev)) { prev[v] = u; q.push(v); } }); }
    if (!(to in prev)) return null; const path = []; for (let v = to; v != null; v = prev[v]) path.unshift(v); return path;
  }
  function reachable(from) { const seen = new Set([from]), q = [from]; while (q.length) { const u = q.shift(); neighbors(u).forEach(v => { if (!seen.has(v)) { seen.add(v); q.push(v); } }); } return seen; }
  function log(msg, cls) { E.log.unshift({ t: E.t, msg, cls: cls || "" }); if (E.log.length > 200) E.log.length = 200; logDirty = true; }
  function after(ms, fn) { E.timers.push({ at: E.t + ms, fn }); }
  function hint(t) { $("hint").textContent = t || ""; }
  function fmtT(ms) { return (ms / 1000).toFixed(1) + " s"; }
  function kill(id) { const n = byId[id]; if (!n) return; n.alive = false; E.packets = E.packets.filter(p => p.from !== id && p.to !== id); }
  function revive(id) { const n = byId[id]; if (n) n.alive = true; }
  function ring(cx, cy, n, r) { const out = []; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n; out.push([cx + Math.cos(a) * r * (i % 2 ? 1 : .78), cy + Math.sin(a) * r * (i % 2 ? .82 : 1)]); } return out; }
  function meshByRange(ids, range, kind) { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const a = byId[ids[i]], b = byId[ids[j]]; if (Math.hypot(a.x - b.x, a.y - b.y) < range) link(ids[i], ids[j], kind || "wifi"); } }
  function p95(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * .95))]; }

  const COL = { wifi: () => css("--green"), lora: () => css("--amber"), sat: () => css("--violet"), net: () => css("--blue"), ble: () => css("--blue") };

  // ---------------- Rendering ----------------
  function draw() {
    const ink = css("--ink"), ink2 = css("--ink-2"), ink3 = css("--ink-3"), paper = css("--paper"), red = css("--red"), gold = css("--gold");
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = css("--canvas-grid"); ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    if (E.sc && E.sc.drawUnder) E.sc.drawUnder(ctx);
    // links
    E.links.forEach(l => {
      const a = byId[l.a], b = byId[l.b]; if (!a || !b) return;
      const dead = !l.up || !a.alive || !b.alive;
      if (l.hidden && dead) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.setLineDash(dead ? [3, 6] : l.kind === "lora" ? [9, 6] : l.kind === "sat" ? [2, 5] : []);
      ctx.strokeStyle = dead ? red : COL[l.kind](); ctx.globalAlpha = dead ? .45 : (l.kind === "wifi" ? .55 : .9); ctx.lineWidth = dead ? 1.2 : l.kind === "wifi" ? 2.2 : 2;
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (l.label) { ctx.fillStyle = ink3; ctx.font = "500 10px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(l.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 6 + (l.ly || 0)); }
    });
    if (E.sc && E.sc.draw) E.sc.draw(ctx);
    // packets
    E.packets.forEach(p => {
      const a = byId[p.from], b = byId[p.to]; const x = a.x + (b.x - a.x) * p.prog, y = a.y + (b.y - a.y) * p.prog;
      ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill(); ctx.strokeStyle = paper; ctx.lineWidth = 1.5; ctx.stroke();
      if (p.label) { ctx.fillStyle = ink; ctx.font = "600 9.5px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(p.label, x, y - p.r - 3); }
    });
    // nodes
    E.nodes.forEach(n => {
      ctx.globalAlpha = n.alive ? 1 : .5;
      if (n.ring) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2); ctx.strokeStyle = n.ring; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.fillStyle = n.alive ? (n.fill || (n.kind === "phone" ? "#2a6fd6" : n.kind === "esp" ? gold : n.kind === "cloud" ? css("--blue") : n.kind === "cmd" ? css("--gold-2") : n.kind === "sensor" ? css("--violet") : "#888")) : ink3;
      ctx.strokeStyle = paper; ctx.lineWidth = 2;
      if (n.kind === "esp") { ctx.save(); ctx.translate(n.x, n.y); ctx.rotate(Math.PI / 4); ctx.fillRect(-10, -10, 20, 20); ctx.strokeRect(-10, -10, 20, 20); ctx.restore(); }
      else if (n.kind === "cloud" || n.kind === "cmd") { ctx.beginPath(); ctx.roundRect(n.x - 34, n.y - 16, 68, 32, 8); ctx.fill(); ctx.stroke(); }
      else if (n.kind === "sat") { ctx.fillRect(n.x - 12, n.y - 6, 24, 12); ctx.strokeRect(n.x - 12, n.y - 6, 24, 12); ctx.fillRect(n.x - 30, n.y - 3, 14, 6); ctx.fillRect(n.x + 16, n.y - 3, 14, 6); }
      else { ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      if (!n.alive) { ctx.strokeStyle = red; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(n.x - 8, n.y - 8); ctx.lineTo(n.x + 8, n.y + 8); ctx.moveTo(n.x + 8, n.y - 8); ctx.lineTo(n.x - 8, n.y + 8); ctx.stroke(); }
      ctx.globalAlpha = 1;
      if (n.kind === "cloud" || n.kind === "cmd") { ctx.fillStyle = "#fff"; ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText(n.label, n.x, n.y + 4); }
      else { ctx.fillStyle = ink; ctx.font = "600 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText(n.label, n.x, n.y + n.r + 14); }
      if (n.internet) { ctx.beginPath(); ctx.arc(n.x + n.r - 2, n.y - n.r + 2, 5, 0, Math.PI * 2); ctx.fillStyle = css("--green"); ctx.fill(); ctx.strokeStyle = paper; ctx.stroke(); }
      if (n.badge) { ctx.font = "700 9.5px JetBrains Mono, monospace"; const w = ctx.measureText(n.badge).width + 10; ctx.fillStyle = n.badgeColor || gold; ctx.beginPath(); ctx.roundRect(n.x - w / 2, n.y - n.r - 24, w, 15, 4); ctx.fill(); ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(n.badge, n.x, n.y - n.r - 13); }
      if (n.sub) { ctx.fillStyle = ink2; ctx.font = "500 10px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(n.sub, n.x, n.y + n.r + 26); }
    });
    if (E.sc && E.sc.drawOver) E.sc.drawOver(ctx);
  }

  // ---------------- Loop ----------------
  let last = performance.now(), logDirty = true, metricT = 0;
  function frame(now) {
    const real = Math.min(50, now - last); last = now;
    try { advance(real); } catch (err) { console.error(err); log("Simulator error: " + err.message, "bad"); E.paused = true; }
    if (logDirty) { renderLog(); logDirty = false; }
    draw(); setTimeout(() => frame(performance.now()), 16);
  }
  function advance(real) {
    if (!E.paused) {
      const dt = real * E.speed; E.t += dt;
      E.packets.forEach(p => { p.prog = Math.min(1, p.prog + dt / p.dur); });
      const arrived = E.packets.filter(p => p.prog >= 1); E.packets = E.packets.filter(p => p.prog < 1);
      arrived.forEach(p => { const n = byId[p.to]; if (n && n.alive) { if (p.onArrive) p.onArrive(n, p); if (E.sc.onArrive) E.sc.onArrive(n, p); } });
      const due = E.timers.filter(t => t.at <= E.t); E.timers = E.timers.filter(t => t.at > E.t); due.forEach(t => t.fn());
      if (E.sc.tick) E.sc.tick(dt);
      metricT += real; if (metricT > 250) { metricT = 0; renderMetrics(); $("clock").textContent = "t = " + fmtT(E.t); }
      if (autoRun && E.step < E.sc.steps.length - 1 && E.t - stepAt > (E.sc.stepGap || 6000)) nextStep();
    }
  }

  // ---------------- UI ----------------
  function renderMetrics() {
    if (!E.sc || !E.sc.metrics) return;
    $("metrics").innerHTML = E.sc.metrics().map(m => '<div class="metric' + (m.wide ? " wide" : "") + '"><b class="' + (m.cls || "") + '">' + m.value + "</b><span>" + m.label + "</span>" + (m.bar != null ? '<div class="bar"><i class="' + (m.barCls || "") + '" style="width:' + Math.max(0, Math.min(100, m.bar)) + '%"></i></div>' : "") + "</div>").join("");
  }
  function renderLog() { $("log").innerHTML = E.log.slice(0, 90).map(e => '<div class="' + e.cls + '"><span class="t">' + fmtT(e.t) + "</span><span>" + e.msg + "</span></div>").join(""); $("log-cnt").textContent = E.log.length + " events"; }
  function renderControls() {
    const box = $("controls"); box.innerHTML = "";
    (E.sc.controls || []).forEach(c => {
      const d = document.createElement("div"); d.className = "ctl";
      if (c.type === "range") {
        E.C[c.id] = c.value;
        d.innerHTML = '<label for="c-' + c.id + '">' + c.label + '</label><span class="v" id="v-' + c.id + '">' + c.value + (c.unit || "") + '</span><input type="range" id="c-' + c.id + '" min="' + c.min + '" max="' + c.max + '" step="' + (c.step || 1) + '" value="' + c.value + '">' + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelector("input").addEventListener("input", ev => { E.C[c.id] = +ev.target.value; $("v-" + c.id).textContent = ev.target.value + (c.unit || ""); if (E.sc.onControl) E.sc.onControl(c.id, E.C[c.id]); });
      } else if (c.type === "switch") {
        E.C[c.id] = !!c.value;
        d.innerHTML = '<label class="switch"><input type="checkbox" id="c-' + c.id + '"' + (c.value ? " checked" : "") + ">" + c.label + "</label><span></span>" + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelector("input").addEventListener("change", ev => { E.C[c.id] = ev.target.checked; if (E.sc.onControl) E.sc.onControl(c.id, E.C[c.id]); });
      } else if (c.type === "select") {
        E.C[c.id] = c.value;
        d.innerHTML = '<label for="c-' + c.id + '">' + c.label + "</label><span></span><select id=\"c-" + c.id + '">' + c.options.map(o => '<option value="' + o[0] + '"' + (o[0] == c.value ? " selected" : "") + ">" + o[1] + "</option>").join("") + "</select>" + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelector("select").addEventListener("change", ev => { E.C[c.id] = isNaN(+ev.target.value) ? ev.target.value : +ev.target.value; if (E.sc.onControl) E.sc.onControl(c.id, E.C[c.id]); });
      } else if (c.type === "buttons") {
        d.innerHTML = (c.label ? "<label>" + c.label + "</label><span></span>" : "") + '<div class="row">' + c.buttons.map(b => '<button type="button" class="btn sm ' + (b.cls || "") + '" data-b="' + b.id + '">' + b.label + "</button>").join("") + "</div>" + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelectorAll("[data-b]").forEach(b => b.addEventListener("click", () => { if (E.sc.onControl) E.sc.onControl(b.dataset.b, true); }));
      }
      box.appendChild(d);
    });
  }
  function setControl(id, v) { E.C[id] = v; const el = $("c-" + id); if (!el) return; if (el.type === "checkbox") el.checked = !!v; else el.value = v; const vv = $("v-" + id); if (vv) vv.textContent = v + ((E.sc.controls.find(c => c.id === id) || {}).unit || ""); }
  let autoRun = false, stepAt = 0;
  function renderSteps() {
    $("steps").innerHTML = E.sc.steps.map((s, i) => '<i class="' + (i < E.step ? "done" : i === E.step ? "cur" : "") + '"></i>').join("");
    $("narr").innerHTML = E.step < 0 ? E.sc.intro : E.sc.steps[E.step].text;
    $("btn-next").disabled = E.step >= E.sc.steps.length - 1; $("btn-next").textContent = E.step < 0 ? "Start →" : E.step >= E.sc.steps.length - 1 ? "Done" : "Next step →";
  }
  function nextStep() { if (E.step >= E.sc.steps.length - 1) return; E.step++; stepAt = E.t; const s = E.sc.steps[E.step]; if (s.run) s.run(); renderSteps(); renderMetrics(); }
  function load(sc) {
    E.nodes.length = 0; E.links.length = 0; E.packets.length = 0; E.log.length = 0; E.timers.length = 0; E.t = 0; E.stats = {}; E.C = {}; E.step = -1; stepAt = 0;
    for (const k in byId) delete byId[k];
    E.sc = sc; hint(sc.hint || "");
    $("sc-tier").textContent = sc.tier; $("sc-title").textContent = sc.title; $("sc-blurb").textContent = sc.blurb;
    document.querySelectorAll(".sc").forEach(b => b.classList.toggle("on", b.dataset.id === sc.id));
    renderControls(); sc.setup(); renderSteps(); renderMetrics(); logDirty = true;
    try { history.replaceState(null, "", "#" + sc.id); } catch (e) {}
  }

  // ============================================================
  //  Scenarios
  // ============================================================
  const S = [];

  // ---------- 1. Leaderless vs Group Owner ----------
  S.push({
    id: "leaderless", group: "Tier 1 — Wi-Fi Aware", tier: "Tier 1 · why Wi-Fi Aware", title: "Leaderless cluster vs. a Group Owner",
    blurb: "The same seven phones, two ways of connecting them. Wi-Fi Direct needs a Group Owner; Wi-Fi Aware needs nobody. Click a phone to knock it out and watch what the cluster does.",
    hint: "Click any phone to knock it out. Click again to bring it back.",
    intro: "Position updates (small green packets) flood through the cluster every couple of seconds. <b>Start</b> to compare the two connection models.",
    controls: [
      { id: "mode", type: "select", label: "Connection model", value: "direct", options: [["direct", "Wi-Fi Direct — one Group Owner"], ["nan", "Wi-Fi Aware — leaderless (chosen)"]], desc: "Wi-Fi Direct: every client talks through the owner. Wi-Fi Aware: publish/subscribe, any pair within ~150 m links." },
      { id: "reset", type: "buttons", buttons: [{ id: "revive", label: "Bring everyone back" }] }
    ],
    st: {}, setup() {
      const s = this.st; s.go = "P1"; s.reelect = null; s.outage = 0; s.delivered = 0; s.emit = 0; s.alive = 7; s.reach = 7;
      ring(480, 290, 7, 190).forEach((p, i) => node("P" + (i + 1), p[0], p[1], "phone", "P" + (i + 1), { battery: 40 + i * 8 }));
      this.rebuild();
    },
    rebuild() {
      const s = this.st; E.links.length = 0; const ids = E.nodes.map(n => n.id);
      if (E.C.mode === "direct") {
        E.nodes.forEach(n => { n.badge = ""; n.ring = null; });
        if (s.go && byId[s.go].alive) { const go = byId[s.go]; go.badge = "GROUP OWNER"; go.badgeColor = css("--amber"); ids.forEach(id => { if (id !== s.go) link(s.go, id, "wifi"); }); }
      } else { E.nodes.forEach(n => { n.badge = ""; }); meshByRange(ids, 310, "wifi"); }
    },
    onControl(id, v) { if (id === "mode") { this.st.reelect = null; this.rebuild(); log("Connection model → " + (v === "direct" ? "Wi-Fi Direct (Group Owner P-star)" : "Wi-Fi Aware (leaderless mesh)"), "sys"); } if (id === "revive") { E.nodes.forEach(n => revive(n.id)); this.rebuild(); log("All phones back online", "ok"); } },
    onNodeClick(n) {
      const s = this.st;
      if (n.alive) { kill(n.id); log(n.id + " knocked out", "bad"); if (E.C.mode === "direct" && n.id === s.go) { s.reelect = E.t + 3000; E.links.forEach(l => { l.up = false; }); log("Group Owner lost — every client link is gone. Re-election in 3.0 s…", "bad"); } }
      else { revive(n.id); log(n.id + " back online", "ok"); if (E.C.mode === "direct" && !s.reelect && byId[s.go].alive) this.rebuild(); }
      if (E.C.mode === "nan") this.rebuild();
    },
    tick(dt) {
      const s = this.st;
      if (s.reelect) { s.outage += dt; if (E.t >= s.reelect) { s.reelect = null; const c = E.nodes.filter(n => n.alive).sort((a, b) => b.battery - a.battery)[0]; if (c) { s.go = c.id; this.rebuild(); log("Election done — " + c.id + " is the new Group Owner. Clients reconnect.", "warn"); } } }
      s.emit += dt; if (s.emit > 1800) { s.emit = 0; const alive = E.nodes.filter(n => n.alive); const src = alive[Math.floor(Math.random() * alive.length)]; if (src) { const pid = Math.random().toString(36).slice(2, 8); flood(src.id, null, { color: css("--green"), r: 4, payload: { pid, ttl: 4 } }); } }
      const alive = E.nodes.filter(n => n.alive); const from = alive.find(n => n.id !== s.go) || alive[0]; s.reach = from ? reachable(from.id).size : 0; s.alive = alive.length;
    },
    onArrive(n, p) { const { pid, ttl } = p.payload; if (!pid || n.seen.has(pid)) return; n.seen.add(pid); this.st.delivered++; if (ttl > 0) flood(n.id, p.from, { color: css("--green"), r: 4, payload: { pid, ttl: ttl - 1 } }); },
    metrics() { const s = this.st; return [{ label: "phones alive", value: s.alive + " / 7" }, { label: "reachable from a client", value: s.reach + " / " + s.alive, cls: s.reach < s.alive ? "bad" : "good" }, { label: "cluster outage", value: fmtT(s.outage), cls: s.outage ? "bad" : "good" }, { label: "beacons delivered", value: s.delivered }]; },
    steps: [
      { text: "<b>Wi-Fi Direct.</b> P1 is the Group Owner — every other phone is a client of P1, so every packet goes through it. This is the topology Meshrabiya automates under its virtual IP layer.", run() { setControl("mode", "direct"); E.sc.rebuild(); } },
      { text: "<b>Knock out the owner.</b> P1 goes down and every client link goes with it. Nobody can talk until an election finishes — about 3 s here, longer in practice. The outage clock is running.", run() { E.sc.onNodeClick(byId.P1); } },
      { text: "<b>Recovered — with a new owner.</b> The highest-battery phone became Group Owner and the clients reconnected. It works, but the cluster has a single point of failure again, and the same thing happens next time.", run() { } },
      { text: "<b>Switch to Wi-Fi Aware.</b> Same seven phones. No owner: each pair within range links directly through publish/subscribe discovery. No QR codes, no BLE priming.", run() { E.nodes.forEach(n => revive(n.id)); setControl("mode", "nan"); E.sc.rebuild(); log("Wi-Fi Aware: leaderless mesh formed by symmetric discovery", "ok"); } },
      { text: "<b>Knock out P1 again.</b> Only P1's own links disappear. Beacons keep flooding through the rest; the outage clock does not move.", run() { E.sc.onNodeClick(byId.P1); } },
      { text: "<b>Take out two more.</b> P3 and P5 drop. The cluster stays connected through the remaining paths — this is what \"if one device drops, the network must not collapse\" looks like. Try clicking phones yourself.", run() { E.sc.onNodeClick(byId.P3); E.sc.onNodeClick(byId.P5); } }
    ]
  });

  // ---------- 2. Managed flooding ----------
  S.push({
    id: "flooding", group: "Tier 1 — Wi-Fi Aware", tier: "Tier 1 · routing layer", title: "Managed flooding, TTL and the dedup cache",
    blurb: "There is no route table. A packet is sent down every path; the first copy to arrive wins and every later duplicate is dropped by a rolling cache of seen packet IDs. TTL stops the storm.",
    hint: "Use the controls to send a packet from A to I. Try TTL 2, then switch the dedup cache off.",
    intro: "Nine phones, meshed by range. <b>Start</b> to send a packet from <b>A</b> to <b>I</b> and watch the copies fan out.",
    controls: [
      { id: "ttl", type: "range", label: "hopLimit (TTL)", min: 1, max: 8, value: 5, desc: "Decremented at every relay; the packet is dropped at 0." },
      { id: "dedup", type: "switch", label: "Dedup cache (~50 packetIds)", value: true, desc: "Off = a relay forwards every copy it receives, even ones it has already relayed." },
      { id: "send", type: "buttons", buttons: [{ id: "sendAI", label: "Send A → I", cls: "primary" }, { id: "clear", label: "Clear" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { copies: 0, dup: 0, ttlDrop: 0, delivered: null, hops: null, sentAt: null, seq: 0 });
      const P = [["A", 90, 280], ["B", 230, 150], ["C", 240, 410], ["D", 400, 260], ["E", 470, 120], ["F", 520, 420], ["G", 660, 250], ["H", 720, 420], ["I", 870, 300]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0])); meshByRange(P.map(p => p[0]), 235, "wifi");
      byId.A.ring = css("--gold"); byId.I.ring = css("--violet"); byId.A.sub = "source"; byId.I.sub = "destination";
    },
    onControl(id) { if (id === "sendAI") this.fire(); if (id === "clear") { E.packets.length = 0; E.nodes.forEach(n => { n.seen.clear(); n.badge = ""; }); Object.assign(this.st, { copies: 0, dup: 0, ttlDrop: 0, delivered: null, hops: null }); } },
    fire() {
      const s = this.st; E.nodes.forEach(n => { n.seen.clear(); n.badge = ""; }); Object.assign(s, { copies: 0, dup: 0, ttlDrop: 0, delivered: null, hops: null, sentAt: E.t, pid: "pkt-" + (++s.seq) });
      byId.A.seen.add(s.pid);
      s.copies += flood("A", null, { color: css("--gold"), label: "ttl " + (E.C.ttl - 1), payload: { pid: s.pid, ttl: E.C.ttl - 1, hops: 1 } });
      log("A floods " + s.pid + " to " + neighbors("A").length + " neighbours, hopLimit " + E.C.ttl, "sys");
    },
    onArrive(n, p) {
      const s = this.st, { pid, ttl, hops } = p.payload; if (pid !== s.pid) return;
      if (n.id === "I") { if (s.delivered == null) { s.delivered = E.t - s.sentAt; s.hops = hops; n.badge = "DELIVERED"; n.badgeColor = css("--green"); log("I received " + pid + " after " + hops + " hops in " + fmtT(s.delivered) + " — first copy wins", "ok"); } else { s.dup++; } return; }
      if (E.C.dedup && n.seen.has(pid)) { s.dup++; n.badge = "dup ×" + (++n.dups || 1); n.badgeColor = css("--ink-3"); return; }
      n.seen.add(pid); n.dups = 0;
      if (ttl <= 0) { s.ttlDrop++; n.badge = "TTL 0"; n.badgeColor = css("--red"); return; }
      s.copies += flood(n.id, p.from, { color: css("--gold"), label: "ttl " + (ttl - 1), payload: { pid, ttl: ttl - 1, hops: hops + 1 } });
      if (s.copies > 400) { E.packets.length = 0; log("Packet storm cut off at 400 copies — this is what TTL and the dedup cache exist to prevent.", "bad"); }
    },
    metrics() { const s = this.st; return [{ label: "copies transmitted", value: s.copies, cls: s.copies > 60 ? "bad" : "" }, { label: "duplicates dropped", value: s.dup }, { label: "dropped at TTL 0", value: s.ttlDrop }, { label: "delivered to I", value: s.delivered == null ? "—" : fmtT(s.delivered) + " · " + s.hops + " hops", cls: s.delivered == null ? "" : "good" }, { label: "in flight", value: E.packets.length }]; },
    steps: [
      { text: "<b>Send A → I with TTL 5.</b> A hands the packet to every neighbour. Each relay checks: is it for me? TTL left? seen this packetId? — then forwards to everyone except where it came from.", run() { E.sc.fire(); } },
      { text: "<b>First copy wins.</b> I got the packet over the shortest path; the copies still arriving are dropped as duplicates. Relays that saw the ID twice show a <b>dup</b> badge. Note how few copies it took overall.", run() { } },
      { text: "<b>TTL too low.</b> Same packet with hopLimit 2. The packet dies two hops out and never reaches I — TTL bounds the flood, so it has to cover the longest path you need (three Wi-Fi hops is the qualification target).", run() { setControl("ttl", 2); E.sc.fire(); } },
      { text: "<b>Dedup cache off, TTL 6.</b> Every relay now forwards every copy it receives, including ones bouncing back. Watch the copy count climb — this is a packet storm, and it only stops because TTL runs out.", run() { setControl("ttl", 6); setControl("dedup", false); E.sc.fire(); } },
      { text: "<b>Back to normal.</b> Dedup on, TTL 5. Same delivery, a fraction of the traffic. Flooding is only cheap because of these two checks.", run() { setControl("dedup", true); setControl("ttl", 5); E.sc.fire(); } }
    ]
  });

  // ---------- 3. PTT voice ----------
  S.push({
    id: "ptt", group: "Tier 1 — Wi-Fi Aware", tier: "Voice · Codec 2 push-to-talk", title: "PTT across three hops with loss, jitter and a dropped relay",
    blurb: "A talks, D listens, three hops apart with an alternate path. 80 ms Codec 2 datagrams (128 B on the wire) flood along both paths; D dedups, buffers, plays or conceals. Mouth-to-ear target: p95 under 500 ms.",
    hint: "Hold PTT with the switch. Add loss and jitter; then drop the B–C link.",
    intro: "Two paths from A to D: A–B–C–D and A–E–F–D. <b>Start</b> to press PTT.",
    controls: [
      { id: "talk", type: "switch", label: "PTT held (A talking)", value: false },
      { id: "loss", type: "range", label: "Per-link loss", min: 0, max: 30, value: 0, unit: " %" },
      { id: "jitter", type: "range", label: "Per-link jitter", min: 0, max: 150, value: 0, unit: " ms" },
      { id: "buf", type: "range", label: "Jitter buffer", min: 80, max: 240, step: 10, value: 120, unit: " ms", desc: "Playout waits this long behind the first frame. Adaptive 80–240 ms in the design." },
      { id: "wall", type: "switch", label: "Wall between B and C", value: false, desc: "Drops the B–C link mid-talkspurt." }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { seq: 0, acc: 0, rx: {}, played: 0, concealed: 0, late: 0, dup: 0, lat: [], first: null, buffered: 0 });
      node("A", 110, 280, "phone", "A · talker"); node("B", 330, 150, "phone", "B"); node("C", 590, 150, "phone", "C"); node("D", 850, 280, "phone", "D · listener"); node("E", 330, 420, "phone", "E"); node("F", 590, 420, "phone", "F");
      link("A", "B"); link("B", "C"); link("C", "D"); link("A", "E", "wifi", { delay: 55 }); link("E", "F", "wifi", { delay: 55 }); link("F", "D", "wifi", { delay: 55 });
      byId.A.ring = css("--gold"); byId.D.ring = css("--violet");
    },
    onControl(id, v) { if (id === "wall") { linkBetween("B", "C").up = !v; log(v ? "Wall: B–C link dropped mid-talkspurt" : "B–C link restored", v ? "bad" : "ok"); } if (id === "talk") { byId.A.badge = v ? "PTT · TX" : ""; byId.A.badgeColor = css("--red"); if (v) { this.st.first = null; log("PTT pressed — A stops listening, opens the mic, encodes 1600 bit/s Codec 2", "sys"); } else log("PTT released — mic closed, output stays open", "sys"); } },
    tick(dt) {
      const s = this.st; E.links.forEach(l => { l.loss = E.C.loss / 100; });
      if (E.C.talk) { s.acc += dt; while (s.acc >= 80) { s.acc -= 80; const seq = s.seq++; const t0 = E.t; flood("A", null, { color: css("--red"), r: 4, jitter: E.C.jitter, payload: { seq, t0 } }); } }
      // playout clock at D
      if (s.first != null) {
        for (const k in s.rx) { const r = s.rx[k]; const due = s.first.t + E.C.buf + (r.seq - s.first.seq) * 80; if (!r.done && E.t >= due) { r.done = true; if (r.buffered) { s.played++; s.lat.push(due - r.t0); if (s.lat.length > 200) s.lat.shift(); } else { s.concealed++; } } }
        s.buffered = Object.values(s.rx).filter(r => r.buffered && !r.done).length;
        for (const k in s.rx) if (s.rx[k].done && Object.keys(s.rx).length > 300) delete s.rx[k];
      }
    },
    onArrive(n, p) {
      const s = this.st, { seq, t0 } = p.payload; if (seq == null) return;
      if (n.id === "D") {
        if (s.rx[seq] && s.rx[seq].buffered) { s.dup++; return; }
        if (s.first == null) s.first = { seq, t: E.t };
        const due = s.first.t + E.C.buf + (seq - s.first.seq) * 80;
        if (E.t > due) { s.late++; s.rx[seq] = s.rx[seq] || { seq, t0, done: true, buffered: false }; return; }   // never retransmit late voice
        s.rx[seq] = { seq, t0, buffered: true, done: false }; return;
      }
      if (n.seen.has("v" + seq)) return; n.seen.add("v" + seq); if (n.seen.size > 60) n.seen.delete(n.seen.values().next().value);
      flood(n.id, p.from, { color: css("--red"), r: 4, jitter: E.C.jitter, payload: { seq, t0 } });
    },
    metrics() { const s = this.st; const p = Math.round(p95(s.lat)); const tot = s.played + s.concealed || 1; return [{ label: "mouth-to-ear p95", value: (s.lat.length ? p + " ms" : "—"), cls: p > 500 ? "bad" : p ? "good" : "", bar: p / 5, barCls: p > 500 ? "red" : "green" }, { label: "frames played", value: s.played }, { label: "concealed (loss)", value: s.concealed + " · " + Math.round(s.concealed / tot * 100) + "%", cls: s.concealed / tot > .05 ? "bad" : "" }, { label: "late — discarded", value: s.late }, { label: "duplicates dropped at D", value: s.dup }, { label: "jitter buffer fill", value: s.buffered + " frames", bar: s.buffered / (E.C.buf / 80 + 2) * 100 }]; },
    steps: [
      { text: "<b>Press PTT.</b> Every 80 ms A emits one voice datagram carrying two Codec 2 frames. It floods down both paths; D keeps the first copy of each sequence number and drops the other.", run() { setControl("talk", true); E.sc.onControl("talk", true); } },
      { text: "<b>Add 10 % loss per link.</b> A frame lost on one path usually still arrives on the other — flooding is the loss protection. Frames missing on both are <b>concealed</b>, never retransmitted.", run() { setControl("loss", 10); } },
      { text: "<b>Add 80 ms of jitter.</b> Frames now arrive unevenly. The 120 ms jitter buffer absorbs it; frames arriving after their playout deadline are discarded as <b>late</b>. Playing them on arrival would sound robotic.", run() { setControl("jitter", 80); } },
      { text: "<b>Drop the B–C link.</b> One relay steps behind a wall. Voice continues over A–E–F–D with no switch-over gap, because it was already flowing there — nothing had to reroute.", run() { setControl("wall", true); E.sc.onControl("wall", true); } },
      { text: "<b>Jitter buffer at 240 ms.</b> Fewer late frames, but mouth-to-ear latency rises by the same amount. This is the trade the adaptive buffer walks between 80 and 240 ms.", run() { setControl("buf", 240); } }
    ]
  });

  // ---------- 4. Image transfer ----------
  S.push({
    id: "image", group: "Tier 1 — Wi-Fi Aware", tier: "Images · chunked transfer", title: "Chunked image over hop-by-hop TCP, with checkpointed resume",
    blurb: "A 40 KB WebP is cut into 1 KB chunks and carried hop-by-hop; each relay stores a chunk fully before forwarding it. If a relay walks away, the sender waits for another path, asks the receiver for its last verified chunk, and resumes from there. Multi-path splitting is shown too — and why it was rejected.",
    hint: "Start the transfer, then make relay C walk away. Try the rejected multi-path mode.",
    intro: "Sender A, receiver D. Primary path A–B–C–D, alternate A–E–F–D. <b>Start</b> to begin sending 40 chunks.",
    controls: [
      { id: "start", type: "buttons", buttons: [{ id: "go", label: "Start transfer", cls: "primary" }, { id: "walk", label: "Relay C walks away", cls: "danger" }, { id: "back", label: "C returns" }] },
      { id: "multi", type: "switch", label: "Multi-path splitting (rejected)", value: false, desc: "Alternate chunks over both paths. Watch the NDP count at relays against the 4-path cap." }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { total: 40, next: 0, verified: -1, active: false, outstanding: {}, resumes: 0, retx: 0, ooo: 0, lastSeq: -1, t0: null, done: null, sendAcc: 0, path: ["A", "B", "C", "D"], alt: ["A", "E", "F", "D"], stored: {}, locked: false });
      node("A", 110, 280, "phone", "A · sender"); node("B", 330, 150, "phone", "B"); node("C", 590, 150, "phone", "C"); node("D", 850, 280, "phone", "D · receiver"); node("E", 330, 420, "phone", "E"); node("F", 590, 420, "phone", "F");
      link("A", "B"); link("B", "C"); link("C", "D"); link("A", "E"); link("E", "F"); link("F", "D");
      ["B", "C", "E", "F"].forEach(id => { byId[id].ndp = 2; }); // background NDPs already open at relays
      this.badges();
    },
    badges() { ["B", "C", "E", "F"].forEach(id => { const n = byId[id]; n.sub = "NDP " + n.ndp + "/4" + (n.ndp > 4 ? " ⚠" : ""); }); byId.D.sub = "verified " + (this.st.verified + 1) + "/" + this.st.total; },
    onControl(id, v) {
      const s = this.st;
      if (id === "go") { Object.assign(s, { next: 0, verified: -1, active: true, outstanding: {}, resumes: 0, retx: 0, ooo: 0, lastSeq: -1, t0: E.t, done: null, stored: {} }); E.nodes.forEach(n => { n.badge = ""; }); log("Transfer start: 40 KB WebP → 40 × 1 KB chunks, hop-by-hop TCP over " + s.path.join("–"), "sys"); }
      if (id === "walk") { kill("C"); log("Relay C walked away — chunks in flight through C are lost", "bad"); }
      if (id === "back") { revive("C"); log("C is back", "ok"); }
      if (id === "multi") { ["B", "C", "E", "F"].forEach(x => { byId[x].ndp = 2; }); s.locked = false; log(v ? "Multi-path splitting ON — chunks alternate over both paths" : "Single best path", v ? "warn" : "sys"); }
      this.badges();
    },
    route(k) { const s = this.st; const pathUp = p => p.every(id => byId[id].alive); if (E.C.multi) { const both = [s.path, s.alt].filter(pathUp); return both.length ? both[k % both.length] : null; } return pathUp(s.path) ? s.path : pathUp(s.alt) ? s.alt : null; },
    tick(dt) {
      const s = this.st; if (!s.active) return;
      // NDP accounting: an active route holds one data path open at each relay it crosses
      ["B", "C", "E", "F"].forEach(id => { byId[id].ndp = 2; });
      const routes = E.C.multi ? [s.path, s.alt] : [this.route(0)]; routes.filter(Boolean).forEach(r => r.slice(1, -1).forEach(id => { byId[id].ndp += 1; }));
      if (E.C.multi) ["B", "C", "E", "F"].forEach(id => { byId[id].ndp += 1; }); // ARQ/control paths back to the sender
      const over = ["B", "C", "E", "F"].some(id => byId[id].ndp > 4); if (over && !s.locked) { s.locked = true; log("NDP cap exceeded at a relay — other traffic through it is blocked until a path is torn down", "bad"); } if (!over) s.locked = false;
      // timeouts → checkpointed resume
      for (const k in s.outstanding) { if (E.t - s.outstanding[k] > 1400) { delete s.outstanding[k]; const r = this.route(+k); if (!r) { byId.A.badge = "WAITING FOR PATH"; byId.A.badgeColor = css("--amber"); return; } s.resumes++; s.retx++; log("Chunk " + k + " timed out. A asks D for its last verified chunk → " + s.verified + ". Resuming from " + (s.verified + 1) + " over " + r.join("–") + ".", "warn"); s.next = s.verified + 1; byId.A.badge = "RESUMED @" + s.next; byId.A.badgeColor = css("--green"); for (const j in s.outstanding) delete s.outstanding[j]; } }
      s.sendAcc += dt; const gap = s.locked ? 520 : 130;
      if (s.sendAcc >= gap && s.next < s.total && Object.keys(s.outstanding).length < 6) { s.sendAcc = 0; const k = s.next++; const r = this.route(k); if (!r) { s.next--; byId.A.badge = "WAITING FOR PATH"; byId.A.badgeColor = css("--amber"); return; } byId.A.badge = ""; s.outstanding[k] = E.t; this.hop(k, r, 0); }
      if (s.verified >= s.total - 1 && !s.done) { s.done = E.t - s.t0; s.active = false; byId.D.badge = "IMAGE COMPLETE"; byId.D.badgeColor = css("--green"); log("All 40 chunks verified in " + fmtT(s.done) + (s.resumes ? " with " + s.resumes + " resume(s)" : ""), "ok"); }
    },
    hop(k, r, i) {
      const s = this.st; const from = r[i], to = r[i + 1]; if (!to) return;
      send(from, to, { color: css("--blue"), label: "#" + k, dur: s.locked ? 900 : undefined, payload: { k, r, i: i + 1 }, onArrive: (n, p) => {
        if (n.id === "D") { if (k > s.verified + 1 && E.C.multi) s.ooo++; if (k === s.verified + 1) { s.verified = k; while (s.stored["D" + (s.verified + 1)]) s.verified++; } else s.stored["D" + k] = true; delete s.outstanding[k]; this.badges(); return; }
        s.stored[n.id + ":" + k] = true; this.hop(k, r, p.payload.i);   // store fully, then forward
      } });
    },
    metrics() { const s = this.st; const maxNdp = Math.max(...["B", "C", "E", "F"].map(id => byId[id] ? byId[id].ndp : 0)); return [{ label: "chunks verified at D", value: (s.verified + 1) + " / " + s.total, bar: (s.verified + 1) / s.total * 100, barCls: "green" }, { label: "resumes (checkpointed)", value: s.resumes }, { label: "retransmitted", value: s.retx }, { label: "arrived out of order", value: s.ooo, cls: s.ooo ? "warn" : "" }, { label: "busiest relay NDPs", value: maxNdp + " / 4", cls: maxNdp > 4 ? "bad" : "good" }, { label: "elapsed", value: s.done ? fmtT(s.done) : s.t0 ? fmtT(E.t - s.t0) : "—" }]; },
    steps: [
      { text: "<b>Start the transfer.</b> Chunks move one hop at a time; B stores #k completely before passing it on. D verifies chunks in order and reports how far it has got.", run() { E.sc.onControl("go"); } },
      { text: "<b>Relay C walks away.</b> Chunks that were inside C are gone. A stops getting confirmations, times out, and instead of restarting from zero asks D: what is the last chunk you verified?", run() { E.sc.onControl("walk"); } },
      { text: "<b>Resume over the alternate path.</b> A continues from verified + 1 over A–E–F–D. The transfer finishes with a handful of retransmissions, not forty.", run() { } },
      { text: "<b>The rejected alternative: split across both paths.</b> C is back. Alternate chunks now go over both routes. Look at the relays: each open path costs a data-path slot, and Wi-Fi Aware chips sustain only 4–6. Relays go over the cap, everything through them slows, and chunks arrive out of order.", run() { E.sc.onControl("back"); setControl("multi", true); E.sc.onControl("multi", true); E.sc.onControl("go"); } },
      { text: "<b>Why single-path wins.</b> Bandwidth was never the bottleneck — the connection cap was. One path with checkpointed resume keeps the rest of the network's routing capacity free.", run() { setControl("multi", false); E.sc.onControl("multi", false); } }
    ]
  });

  // ---------- 5. LoRa airtime ----------
  function loraAirtime(bytes, sf) { const bw = 125000, cr = 1, de = sf >= 11 ? 1 : 0; const ts = Math.pow(2, sf) / bw; const pre = (8 + 4.25) * ts; const ps = 8 + Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * (cr + 4), 0); return (pre + ps * ts) * 1000; }
  S.push({
    id: "lora", group: "Tier 2 — ESP32 + LoRa", tier: "Tier 2 · LoRa backbone", title: "LoRa airtime: why the backbone is managed in seconds, not packets",
    blurb: "Two clusters, each with an ESP32 bridge running Meshtastic. Every position update that leaves a cluster costs airtime on the shared 865–867 MHz channel, and the duty-cycle allowance is 1 % — 36 seconds of transmit time an hour. Spreading factor decides how expensive each packet is.",
    hint: "Change the spreading factor and the telemetry interval; raise an SOS while the channel is saturated.",
    intro: "Each phone reports its position on the interval you set. The gateway phone hands them to the bridge for LoRa backhaul to the EOC. <b>Start</b>.",
    controls: [
      { id: "sf", type: "select", label: "Spreading factor", value: 9, options: [[7, "SF7 — fast, short range"], [9, "SF9 — default"], [12, "SF12 — long range, contingency"]] },
      { id: "interval", type: "range", label: "Position update interval", min: 2, max: 60, value: 10, unit: " s" },
      { id: "bytes", type: "range", label: "Telemetry packet", min: 48, max: 240, step: 8, value: 164, unit: " B", desc: "Meshtastic ceiling 255 B; 240 B is the working limit." },
      { id: "summary", type: "switch", label: "Backhaul cluster summaries only", value: false, desc: "Gateway coalesces its cluster's positions into one 96 B summary per interval." },
      { id: "sos", type: "buttons", buttons: [{ id: "raiseSOS", label: "Raise SOS (176 B)", cls: "danger" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { busy: [], q: [], sent: 0, coal: 0, sosLat: null, sosAt: null, acc: {}, chanFree: 0, dropped: 0 });
      ring(190, 300, 5, 110).forEach((p, i) => node("A" + (i + 1), p[0], p[1], "phone", "A" + (i + 1))); node("L1", 330, 300, "esp", "L1 · bridge");
      ring(620, 300, 5, 110).forEach((p, i) => node("B" + (i + 1), p[0], p[1], "phone", "B" + (i + 1))); node("L2", 760, 300, "esp", "L2 · bridge");
      node("EOC", 900, 120, "cmd", "EOC");
      meshByRange(["A1", "A2", "A3", "A4", "A5"], 170); meshByRange(["B1", "B2", "B3", "B4", "B5"], 170);
      link("A2", "L1", "wifi", { label: "AP" }); link("B2", "L2", "wifi", { label: "AP" }); link("L1", "L2", "lora", { label: "LoRa 865–867 MHz", ly: -26 }); link("L2", "EOC", "net", { label: "backhaul" });
      byId.A2.badge = "GATEWAY"; byId.B2.badge = "GATEWAY";
    },
    onControl(id) { if (id === "raiseSOS") { const s = this.st; s.sosAt = E.t; this.enqueue({ kind: "SOS", bytes: 176, from: "A4", pri: 0 }); byId.A4.ring = css("--red"); log("A4 raises SOS — P0: reserved airtime, jumps the queue", "bad"); } },
    enqueue(m) { const s = this.st; if (m.pri === 0) s.q.unshift(m); else { if (E.C.summary || s.q.filter(x => x.pri === 2).length > 6) { const i = s.q.findIndex(x => x.pri === 2 && x.from === m.from); if (i >= 0) { s.q[i] = m; s.coal++; return; } } s.q.push(m); } },
    tick(dt) {
      const s = this.st; const win = 60000; s.busy = s.busy.filter(b => b.end > E.t - win);
      // sources
      ["A1", "A3", "A4", "A5"].forEach(id => { s.acc[id] = (s.acc[id] || 0) + dt; if (s.acc[id] >= E.C.interval * 1000) { s.acc[id] = 0; send(id, "A2", { color: css("--green"), r: 4, onArrive: () => { if (E.C.summary) { s.pendingSummary = (s.pendingSummary || 0) + 1; } else this.enqueue({ kind: "POS", bytes: E.C.bytes, from: id, pri: 2 }); } }); } });
      if (E.C.summary) { s.sumAcc = (s.sumAcc || 0) + dt; if (s.sumAcc >= E.C.interval * 1000) { s.sumAcc = 0; if (s.pendingSummary) { this.enqueue({ kind: "SUMMARY×" + s.pendingSummary, bytes: 96, from: "A2", pri: 2 }); s.pendingSummary = 0; } } }
      // channel
      const dutyNow = s.busy.reduce((a, b) => a + (Math.min(b.end, E.t) - Math.max(b.start, E.t - win)), 0) / win;
      s.duty = dutyNow;
      if (s.chanFree <= E.t && s.q.length) {
        const m = s.q[0]; const at = loraAirtime(m.bytes, E.C.sf);
        const overBudget = dutyNow >= .01;
        if (overBudget && m.pri !== 0) { // routine telemetry yields; keep only the latest sample per origin
          const latest = {}; s.q.filter(x => x.pri === 2).forEach(x => { latest[x.from] = x; }); const before = s.q.length; s.q = s.q.filter(x => x.pri === 0 || latest[x.from] === x); s.coal += before - s.q.length; s.holdLog = (s.holdLog || 0) + dt; if (s.holdLog > 5000) { s.holdLog = 0; log("Duty cycle at 1 % — routine telemetry suspended, latest sample kept per origin", "warn"); } return; }
        s.q.shift(); s.chanFree = E.t + at; s.busy.push({ start: E.t, end: E.t + at }); s.sent++;
        send("L1", "L2", { color: m.pri === 0 ? css("--red") : css("--amber"), label: m.kind + " " + m.bytes + "B", dur: at, r: 6, onArrive: () => { send("L2", "EOC", { color: m.pri === 0 ? css("--red") : css("--amber"), r: 5, onArrive: () => { if (m.pri === 0 && s.sosAt != null) { s.sosLat = E.t - s.sosAt; s.sosAt = null; byId.A4.ring = null; log("SOS reached the EOC in " + fmtT(s.sosLat), "ok"); } } }); } });
      }
    },
    metrics() { const s = this.st; const at = loraAirtime(E.C.bytes, E.C.sf); const perHour = Math.floor(36000 / at); return [{ label: "airtime per telemetry packet", value: (at / 1000).toFixed(3) + " s" }, { label: "packets/hour within 1 %", value: perHour, cls: perHour < 60 ? "bad" : "" }, { label: "duty used (60 s window)", value: ((s.duty || 0) * 100).toFixed(2) + " %", cls: (s.duty || 0) >= .01 ? "bad" : "good", bar: (s.duty || 0) * 10000, barCls: (s.duty || 0) >= .01 ? "red" : "green" }, { label: "LoRa queue", value: s.q.length, cls: s.q.length > 8 ? "bad" : "" }, { label: "coalesced / dropped", value: s.coal }, { label: "last SOS latency", value: s.sosLat != null ? fmtT(s.sosLat) : "—", cls: s.sosLat > 10000 ? "bad" : s.sosLat ? "good" : "" }]; },
    steps: [
      { text: "<b>SF9, 164 B every 10 s from four phones.</b> Each packet takes 0.84 s of air. That is about 42 packets an hour inside the 1 % allowance — and four phones at 10 s intervals want 1,440. Watch the duty gauge.", run() { } },
      { text: "<b>Saturation.</b> At 1 % the bridge suspends routine telemetry and keeps only the latest sample per phone. The queue stops growing but positions at the EOC go stale — which is why sample age must always be displayed.", run() { setControl("interval", 4); } },
      { text: "<b>Raise an SOS while saturated.</b> P0 traffic has reserved airtime: it goes to the front of the queue and crosses in one packet time, roughly 0.9 s plus the backhaul.", run() { E.sc.onControl("raiseSOS"); } },
      { text: "<b>SF12 — the contingency setting.</b> The same 164 B packet now costs 6.1 s of air; the hour's budget is six packets. Long range is paid for in capacity. Treat SF12 as an emergency fall-back, not the default.", run() { setControl("sf", 12); } },
      { text: "<b>The fix: keep positions inside the cluster, backhaul summaries.</b> Frequent updates stay on Wi-Fi Aware; the gateway sends one 96 B cluster summary per interval, labelled as a summary with gateway provenance. Duty falls well under budget at SF9.", run() { setControl("sf", 9); setControl("summary", true); setControl("interval", 10); } }
    ]
  });

  // ---------- 6. Gateway fail-over ----------
  S.push({
    id: "failover", group: "Tier 2 — ESP32 + LoRa", tier: "Tier 2 · gateway fail-over", title: "The ESP32 chooses its next phone — a lease, not an election",
    blurb: "The bridge holds the physical LoRa link, so the bridge controls fail-over. The attached phone heartbeats every 2 s; when the lease expires, authorised candidates in range request ownership and the ESP32 picks one by external power, battery and reachability. Lease generations fence out a phone that comes back late.",
    hint: "Cut the gateway phone's power, then bring it back after the hand-over.",
    intro: "P1 is attached to bridge L1 (lease generation 1) and heartbeats every 2 s. P2 and P3 are provisioned as gateway-capable. <b>Start</b>.",
    controls: [{ id: "acts", type: "buttons", buttons: [{ id: "cut", label: "P1 loses power", cls: "danger" }, { id: "return", label: "P1 comes back" }] }],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { gen: 1, owner: "P1", lastHb: 0, hbAcc: 0, expired: null, phase: "attached", lostAt: null, recovered: null, queued: 12, ack: 9 });
      node("L1", 480, 250, "esp", "L1 · ESP32 + LoRa"); node("P1", 300, 160, "phone", "P1", { battery: 61, ext: false }); node("P2", 300, 380, "phone", "P2", { battery: 38, ext: true }); node("P3", 660, 380, "phone", "P3", { battery: 84, ext: false }); node("P4", 660, 160, "phone", "P4", { battery: 70, ext: false, capable: false });
      node("EOC", 880, 110, "cmd", "EOC"); link("L1", "EOC", "lora", { label: "LoRa backbone" });
      ["P1", "P2", "P3", "P4"].forEach(id => link(id, "L1", "ble", { label: "" })); meshByRange(["P1", "P2", "P3", "P4"], 420);
      byId.P1.sub = "61 % · battery"; byId.P2.sub = "38 % · on external power"; byId.P3.sub = "84 % · battery"; byId.P4.sub = "not gateway-capable";
      this.badges();
    },
    badges() { const s = this.st; E.nodes.forEach(n => { if (n.kind === "phone") { n.badge = n.id === s.owner ? "ATTACHED · gen " + s.gen : (n.capable === false ? "" : "candidate"); n.badgeColor = n.id === s.owner ? css("--green") : css("--ink-3"); } }); byId.L1.sub = "lease gen " + s.gen + " · " + s.queued + " queued · " + s.ack + " acked"; },
    onControl(id) {
      const s = this.st;
      if (id === "cut" && byId.P1.alive) { kill("P1"); s.lostAt = E.t; s.phase = "lost"; log("P1 lost power. L1 keeps its queue (" + s.queued + " records, " + s.ack + " already acknowledged); heartbeats stop.", "bad"); }
      if (id === "return") { revive("P1"); log("P1 back online — attaches with its old lease (gen 1)", "sys"); send("P1", "L1", { color: css("--blue"), label: "attach gen1", onArrive: () => { if (s.gen > 1) { log("L1 rejects P1: generation 1 < current " + s.gen + " — the old owner is fenced out; no split-brain", "warn"); byId.P1.badge = "FENCED (stale gen)"; byId.P1.badgeColor = css("--red"); } else { s.owner = "P1"; this.badges(); } } }); }
    },
    tick(dt) {
      const s = this.st; s.hbAcc += dt;
      if (s.hbAcc >= 2000) { s.hbAcc = 0; if (byId[s.owner].alive) send(s.owner, "L1", { color: css("--green"), r: 4, label: "hb", onArrive: () => { s.lastHb = E.t; } }); }
      if (s.phase === "lost" && E.t - s.lastHb > 4200) { s.phase = "electing"; log("Lease expired after two missed heartbeats. Candidates authenticate and request ownership.", "warn"); ["P2", "P3"].forEach(c => send(c, "L1", { color: css("--blue"), label: "request", onArrive: () => { s.req = (s.req || 0) + 1; if (s.req === 2) { s.req = 0; const pick = byId.P2.ext ? "P2" : "P3"; s.gen++; s.owner = pick; s.phase = "syncing"; log("L1 selects " + pick + " (external power beats 84 % battery) → lease gen " + s.gen, "ok"); this.badges(); send("L1", pick, { color: css("--amber"), label: "inventory", onArrive: () => send(pick, "L1", { color: css("--amber"), label: "resume ids", onArrive: () => { s.phase = "attached"; s.recovered = E.t - s.lostAt; s.lastHb = E.t; log("Queue inventories exchanged; delivery resumes with the same message IDs. Recovery " + fmtT(s.recovered) + " (target < 20 s). Records lost: 0.", "ok"); this.badges(); } }) }); } } })); }
      if (s.phase === "attached" && Math.random() < dt / 6000) { s.queued++; s.ack++; this.badges(); }
    },
    metrics() { const s = this.st; return [{ label: "lease owner", value: s.owner + " · gen " + s.gen }, { label: "state", value: s.phase, cls: s.phase === "attached" ? "good" : "warn" }, { label: "recovery time", value: s.recovered != null ? fmtT(s.recovered) : s.lostAt ? fmtT(E.t - s.lostAt) : "—", cls: s.recovered != null ? (s.recovered < 20000 ? "good" : "bad") : "" }, { label: "acknowledged records lost", value: 0, cls: "good" }]; },
    steps: [
      { text: "<b>Normal operation.</b> P1 heartbeats to the bridge every 2 s. The queue of outbound records lives on the ESP32 <i>and</i> on the phones that originated them.", run() { } },
      { text: "<b>P1 loses power.</b> No election among the phones — the bridge simply notices the heartbeats stop. After two missed beats the lease expires.", run() { E.sc.onControl("cut"); } },
      { text: "<b>Candidates request; the bridge chooses.</b> P2 (38 %, but on a vehicle charger) beats P3 (84 % battery): external power first, then battery, then reachability, then a deterministic tie-break. The lease generation increments.", run() { } },
      { text: "<b>P1 comes back.</b> It offers its old lease, generation 1. The bridge refuses: the generation is stale. That fence is what prevents two phones both believing they own the LoRa link.", run() { E.sc.onControl("return"); } }
    ]
  });

  // ---------- 7. Satellite ----------
  S.push({
    id: "satellite", group: "Tier 3 — Satellite", tier: "Tier 3 · satellite fall-back", title: "When the LoRa chain can't reach command",
    blurb: "The EOC is 120 km away. Normally two LoRa repeaters carry traffic there. When terrain takes the repeaters out, the gateway bridge falls back to Iridium Short Burst Data: 340 bytes a frame, tens of seconds a round trip, needs open sky. Simulated for the hackathon against the real RockBLOCK interface.",
    hint: "Toggle the terrain and change the message size; then send.",
    intro: "Cluster on the left with a satellite-equipped bridge L1; repeaters R1 and R2 chain to the EOC. <b>Start</b>.",
    controls: [
      { id: "terrain", type: "switch", label: "Terrain degrades the LoRa chain", value: false, desc: "R2 drops out of range." },
      { id: "sky", type: "switch", label: "Open sky at L1", value: true, desc: "Iridium needs sky visibility — not range." },
      { id: "size", type: "range", label: "Message size", min: 40, max: 700, step: 10, value: 120, unit: " B" },
      { id: "send", type: "buttons", buttons: [{ id: "tx", label: "Send to EOC", cls: "primary" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { sent: 0, path: "—", lat: null, frames: 0, sentAt: null });
      ring(150, 330, 4, 90).forEach((p, i) => node("A" + (i + 1), p[0], p[1], "phone", "A" + (i + 1))); meshByRange(["A1", "A2", "A3", "A4"], 150);
      node("L1", 290, 330, "esp", "L1 · bridge + SBD"); link("A2", "L1", "wifi", { label: "AP" });
      node("R1", 480, 300, "esp", "R1 · repeater"); node("R2", 680, 260, "esp", "R2 · repeater"); node("EOC", 890, 230, "cmd", "EOC · 120 km");
      link("L1", "R1", "lora", { label: "LoRa" }); link("R1", "R2", "lora", { label: "LoRa" }); link("R2", "EOC", "lora", { label: "LoRa" });
      node("SAT", 560, 60, "sat", "Iridium · LEO"); link("L1", "SAT", "sat", { delay: 14000, label: "SBD ↑" }); link("SAT", "EOC", "sat", { delay: 14000, label: "SBD ↓" });
    },
    onControl(id, v) {
      const s = this.st;
      if (id === "terrain") { byId.R2.alive = !v; log(v ? "Terrain: R2 unreachable — the LoRa chain is broken" : "LoRa chain restored", v ? "bad" : "ok"); }
      if (id === "sky") { linkBetween("L1", "SAT").up = !!v; log(v ? "L1 has open sky" : "L1 under canopy — no satellite visibility", v ? "ok" : "bad"); }
      if (id === "tx") {
        s.sentAt = E.t; const bytes = E.C.size;
        send("A1", "A2", { color: css("--gold"), label: bytes + " B", onArrive: () => send("A2", "L1", { color: css("--gold"), onArrive: () => {
          if (bfs("L1", "EOC") && byId.R2.alive) { s.path = "LoRa · 2 repeaters"; this.relay(["L1", "R1", "R2", "EOC"], 0, bytes); return; }
          if (!linkBetween("L1", "SAT").up) { s.path = "none — queued"; log("No LoRa chain and no sky: message held on L1 (store & forward)", "bad"); return; }
          const frames = Math.ceil(bytes / 340); s.frames = frames; s.path = "satellite SBD · " + frames + " frame" + (frames > 1 ? "s" : "");
          if (frames > 1) log(bytes + " B exceeds the 340 B SBD frame — split into " + frames + " frames (and this is why the composer shows a byte cap)", "warn");
          for (let f = 0; f < frames; f++) send("L1", "SAT", { color: css("--violet"), label: "SBD " + (f + 1) + "/" + frames, r: 6, dur: 14000 + f * 9000 + rnd(0, 6000), onArrive: () => send("SAT", "EOC", { color: css("--violet"), r: 6, dur: 12000 + rnd(0, 8000), onArrive: () => { if (f === frames - 1) { s.lat = E.t - s.sentAt; s.sent++; log("EOC received the message over satellite in " + fmtT(s.lat), "ok"); } } }) });
        } }) });
      }
    },
    relay(path, i, bytes) { const s = this.st; if (i >= path.length - 1) { s.lat = E.t - s.sentAt; s.sent++; log("EOC received the message over the LoRa chain in " + fmtT(s.lat), "ok"); return; } send(path[i], path[i + 1], { color: css("--amber"), label: bytes + " B", dur: loraAirtime(Math.min(bytes, 240), 9) + 200, onArrive: () => this.relay(path, i + 1, bytes) }); },
    metrics() { const s = this.st; return [{ label: "path used", value: s.path, wide: true }, { label: "last latency", value: s.lat != null ? fmtT(s.lat) : "—", cls: s.lat > 20000 ? "warn" : s.lat ? "good" : "" }, { label: "SBD frames", value: s.frames || "—" }, { label: "messages delivered", value: s.sent }]; },
    steps: [
      { text: "<b>Normal: LoRa chain.</b> A 120 B message hops L1 → R1 → R2 → EOC in a few seconds. Satellite is not used while a cheaper path exists.", run() { E.sc.onControl("tx"); } },
      { text: "<b>Terrain breaks the chain.</b> R2 is gone; no time to deploy another repeater mid-golden-hour. The bridge falls back to Iridium SBD. Notice the latency — tens of seconds, not milliseconds.", run() { setControl("terrain", true); E.sc.onControl("terrain", true); E.sc.onControl("tx"); } },
      { text: "<b>Oversize message.</b> 600 B does not fit a 340 B frame. It is split into two SBD frames — which is why the console's broadcast composer shows a live byte count against the cap.", run() { setControl("size", 600); E.sc.onControl("tx"); } },
      { text: "<b>Satellite is limited by sky, not distance.</b> Put L1 under canopy: Iridium is unreachable even though the satellite passes overhead. Messages wait on the bridge. This is why the modem lives on a specific gateway node with a clear view.", run() { setControl("sky", false); E.sc.onControl("sky", false); setControl("size", 120); E.sc.onControl("tx"); } }
    ]
  });

  // ---------- 8. DTN transition ----------
  S.push({
    id: "dtn", group: "Tier 4 — Adaptive transition", tier: "Tier 4 · Delay-tolerant networking", title: "Any phone that regains internet becomes the gateway",
    blurb: "A cellular coverage bubble sits over part of the sector. Phones inside it validate real internet (NET_CAPABILITY_VALIDATED), broadcast an \"I have internet\" beacon, and the cluster routes cloud-bound traffic through them. Queued reports flush in one batch. Leave the bubble and you fall one rung down the same ladder — the mesh is never torn down.",
    hint: "Drag the coverage slider to move the cell bubble; toggle flicker.",
    intro: "Eight phones in a cluster; the cloud backend top-right. No phone has internet yet, so every report queues. <b>Start</b>.",
    controls: [
      { id: "cov", type: "range", label: "Cell coverage position", min: 0, max: 100, value: 100, desc: "Slide left to move the coverage bubble over the cluster." },
      { id: "flicker", type: "switch", label: "Coverage flickers", value: false, desc: "Signal comes and goes every ~6 s." }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { tiers: { DIRECT: 0, GATEWAY: 0, QUEUED: 0 }, flushed: 0, acc: {}, valid: {}, gw: null, flick: 0, covOn: true });
      const P = [["P1", 150, 200], ["P2", 250, 330], ["P3", 320, 170], ["P4", 420, 300], ["P5", 520, 190], ["P6", 560, 380], ["P7", 660, 260], ["P8", 740, 400]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0], { q: 0 })); meshByRange(P.map(p => p[0]), 190);
      node("CLOUD", 880, 80, "cloud", "Cloud"); E.nodes.filter(n => n.kind === "phone").forEach(n => link(n.id, "CLOUD", "net", { delay: 250 }));
      E.links.filter(l => l.kind === "net").forEach(l => { l.up = false; l.hidden = true; });
    },
    covCenter() { return { x: 180 + E.C.cov * 9, y: 330, r: 150 }; },
    drawUnder(ctx) { const c = this.covCenter(); if (!this.st.covOn) return; ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.fillStyle = css("--blue"); ctx.globalAlpha = .12; ctx.fill(); ctx.globalAlpha = .7; ctx.setLineDash([6, 6]); ctx.strokeStyle = css("--blue"); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = css("--blue"); ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText("cellular coverage", c.x, c.y - c.r - 8); },
    tick(dt) {
      const s = this.st; const c = this.covCenter();
      if (E.C.flicker) { s.flick += dt; if (s.flick > 6000) { s.flick = 0; s.covOn = !s.covOn; log(s.covOn ? "Coverage back" : "Coverage lost", s.covOn ? "ok" : "warn"); } } else s.covOn = true;
      E.nodes.filter(n => n.kind === "phone").forEach(n => {
        const inside = s.covOn && Math.hypot(n.x - c.x, n.y - c.y) < c.r;
        if (inside) { s.valid[n.id] = (s.valid[n.id] || 0) + dt; if (s.valid[n.id] > 1500 && !n.internet) { n.internet = true; n.badge = "GATEWAY"; n.badgeColor = css("--green"); linkBetween(n.id, "CLOUD").up = true; log(n.id + ": NET_CAPABILITY_VALIDATED → beacons \"I have internet\" into the mesh", "ok"); s.bgen = (s.bgen || 0) + 1; flood(n.id, null, { color: css("--green"), r: 4, label: "beacon", payload: { beacon: n.id, gen: s.bgen, ttl: 4 } }); } }
        else { s.valid[n.id] = 0; if (n.internet) { n.internet = false; n.badge = ""; linkBetween(n.id, "CLOUD").up = false; log(n.id + " lost internet — beacon withdrawn; peers fall one rung", "warn"); } }
      });
      const gws = E.nodes.filter(n => n.internet).map(n => n.id); s.gw = gws[0] || null;
      E.nodes.filter(n => n.kind === "phone").forEach(n => {
        s.acc[n.id] = (s.acc[n.id] || 0) + dt; if (s.acc[n.id] < 2200) return; s.acc[n.id] = rnd(0, 800);
        const count = 1 + n.q; n.q = 0;
        if (n.internet) { s.tiers.DIRECT += count; if (count > 1) s.flushed += count - 1; for (let i = 0; i < Math.min(count, 4); i++) send(n.id, "CLOUD", { color: css("--blue"), r: 4, dur: 250 + i * 120 }); return; }
        const gw = gws.map(g => ({ g, p: bfs(n.id, g) })).filter(x => x.p).sort((a, b) => a.p.length - b.p.length)[0];
        if (gw) { s.tiers.GATEWAY += count; if (count > 1) { s.flushed += count - 1; log(n.id + " reconnects: flushes " + count + " queued items in one batch via " + gw.g, "ok"); } this.relay(gw.p, 0, Math.min(count, 4)); return; }
        n.q += count; s.tiers.QUEUED++; n.sub = "queued " + n.q;
      });
      E.nodes.forEach(n => { if (n.kind === "phone") n.sub = n.q ? "queued " + n.q : ""; });
    },
    onArrive(n, p) { const b = p.payload.beacon; if (!b) return; const key = b + ":" + p.payload.gen; if (n.seen.has(key)) return; n.seen.add(key); if (p.payload.ttl > 0 && !n.internet) flood(n.id, p.from, { color: css("--green"), r: 4, label: "beacon", payload: { beacon: b, gen: p.payload.gen, ttl: p.payload.ttl - 1 } }); },
    relay(path, i, count) { if (i >= path.length - 1) { for (let k = 0; k < count; k++) send(path[i], "CLOUD", { color: css("--blue"), r: 4, dur: 250 + k * 120 }); return; } for (let k = 0; k < count; k++) send(path[i], path[i + 1], { color: css("--gold"), r: 4, dur: 45 + k * 60, onArrive: k === 0 ? () => this.relay(path, i + 1, count) : null }); },
    metrics() { const s = this.st; const q = E.nodes.reduce((a, n) => a + (n.q || 0), 0); return [{ label: "gateway", value: s.gw || "none", cls: s.gw ? "good" : "bad" }, { label: "queued right now", value: q, cls: q ? "warn" : "good" }, { label: "sent DIRECT", value: s.tiers.DIRECT }, { label: "sent via GATEWAY peer", value: s.tiers.GATEWAY }, { label: "held (store & forward)", value: s.tiers.QUEUED }, { label: "flushed on reconnect", value: s.flushed }]; },
    steps: [
      { text: "<b>Dead zone.</b> The coverage bubble is off to the right. Every phone's reports queue locally — nothing is lost, nothing is delivered.", run() { setControl("cov", 100); } },
      { text: "<b>Coverage reaches P7 and P8.</b> After 1.5 s of validated internet they beacon into the mesh. Everyone else now routes cloud traffic through them (gold hops) and flushes their queues in one batch.", run() { setControl("cov", 66); } },
      { text: "<b>Same ladder in reverse.</b> Slide coverage away: gateways withdraw their beacons and the cluster drops one rung to store-and-forward. The mesh underneath never changed.", run() { setControl("cov", 100); } },
      { text: "<b>Flickering signal.</b> This is the realistic case. Watch traffic alternate between DIRECT / GATEWAY / QUEUED without anyone switching modes — a quality gradient, not on/off.", run() { setControl("cov", 62); setControl("flicker", true); } }
    ]
  });

  // ---------- 9. Alert into a dead zone ----------
  S.push({
    id: "alert", group: "Tier 4 — Adaptive transition", tier: "Alerts · reaching responders in a dead zone", title: "Three ways an alert gets into a dead zone",
    blurb: "The sensor feed reaches the backend over IMD's own telemetry — local damage rarely blocks it. The hard part is the last stretch: getting the alert to phones inside the dead zone. Three paths, one new packet type: broadcast.",
    hint: "Fire each path from the controls. Compare broadcast against unicast.",
    intro: "IMD station → backend is up. The cluster below has no internet. <b>Start</b> to see the alert arrive at the backend.",
    controls: [
      { id: "bcast", type: "switch", label: "Broadcast message type", value: true, desc: "Off = the backend must address each phone with its own unicast packet." },
      { id: "paths", type: "buttons", label: "Deliver via", buttons: [{ id: "p1", label: "① Patchy: one phone has signal" }, { id: "p2", label: "② Blackout: LoRa / satellite" }, { id: "p3", label: "③ Pre-loaded static risk" }, { id: "clr", label: "Clear" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { alerted: new Set(), pkts: 0, t0: null, full: null });
      node("IMD", 90, 70, "sensor", "IMD station"); node("BE", 480, 70, "cloud", "Backend"); link("IMD", "BE", "net", { label: "national telemetry (INSAT DCP)", delay: 400 });
      node("SAT", 800, 70, "sat", "Iridium"); link("BE", "SAT", "sat", { delay: 9000 });
      const P = [["P1", 160, 300], ["P2", 270, 400], ["P3", 300, 240], ["P4", 420, 340], ["P5", 520, 240], ["P6", 560, 420], ["P7", 680, 320], ["P8", 760, 440]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0])); meshByRange(P.map(p => p[0]), 185);
      node("L1", 850, 300, "esp", "L1 · bridge + SBD"); link("P7", "L1", "wifi", { label: "AP" }); link("SAT", "L1", "sat", { delay: 9000 });
      link("BE", "P5", "net", { delay: 300 }); linkBetween("BE", "P5").up = false;
    },
    drawUnder(ctx) { ctx.beginPath(); ctx.roundRect(100, 190, 800, 320, 16); ctx.setLineDash([8, 6]); ctx.strokeStyle = css("--red"); ctx.globalAlpha = .6; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = css("--red"); ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillText("DEAD ZONE — no cellular", 112, 208); },
    onControl(id) {
      const s = this.st;
      if (id === "clr") { s.alerted.clear(); s.pkts = 0; s.t0 = null; s.full = null; E.nodes.forEach(n => { n.badge = ""; n.seen.clear(); n.internet = false; }); linkBetween("BE", "P5").up = false; return; }
      s.alerted.clear(); s.pkts = 0; s.t0 = E.t; s.full = null; E.nodes.forEach(n => { if (n.kind === "phone") { n.badge = ""; n.seen.clear(); } });
      const alertId = "alert-" + Math.random().toString(36).slice(2, 7);
      if (id === "p1") { byId.P5.internet = true; linkBetween("BE", "P5").up = true; log("Path ①: P5 still has one bar of signal. It auto-promotes to gateway — the same Tier 4 logic, running inbound.", "sys"); this.fromBackend(alertId, "P5"); }
      if (id === "p2") { log("Path ②: total blackout. Backend injects the alert at the satellite tier → L1 → cluster lead P7 → flood.", "sys"); s.pkts++; send("BE", "SAT", { color: css("--violet"), label: "ALERT 118 B", r: 6, onArrive: () => { s.pkts++; send("SAT", "L1", { color: css("--violet"), label: "SBD", r: 6, onArrive: () => { s.pkts++; send("L1", "P7", { color: css("--red"), label: "ALERT", onArrive: () => this.deliver("P7", null, alertId, 4) }); } }); } }); }
      if (id === "p3") { log("Path ③: no packets at all. The Layer 1 static classification was cached at mission briefing; every phone already knows Z4 is HIGH risk.", "sys"); E.nodes.filter(n => n.kind === "phone").forEach(n => { n.badge = "CACHED: Z4 HIGH"; n.badgeColor = css("--amber"); s.alerted.add(n.id); }); s.full = 0; }
    },
    fromBackend(alertId, gw) {
      const s = this.st;
      if (E.C.bcast) { s.pkts++; send("BE", gw, { color: css("--red"), label: "ALERT bcast", onArrive: () => this.deliver(gw, null, alertId, 4) }); }
      else { E.nodes.filter(n => n.kind === "phone").forEach((n, i) => { s.pkts++; send("BE", gw, { color: css("--red"), label: "→" + n.id, dur: 300 + i * 90, onArrive: () => { const p = bfs(gw, n.id); if (p) this.unicast(p, 0, n.id); } }); }); }
    },
    unicast(path, i, dst) { const s = this.st; if (i >= path.length - 1) { this.mark(byId[dst]); return; } s.pkts++; send(path[i], path[i + 1], { color: css("--red"), r: 4, label: "→" + dst, onArrive: () => this.unicast(path, i + 1, dst) }); },
    deliver(at, from, alertId, ttl) { const n = byId[at]; if (n.seen.has(alertId)) return; n.seen.add(alertId); this.mark(n); if (ttl > 0) this.st.pkts += flood(at, from, { color: css("--red"), r: 4, label: "bcast", payload: { alertId, ttl: ttl - 1 } }); },
    onArrive(n, p) { if (p.payload.alertId && n.kind === "phone") this.deliver(n.id, p.from, p.payload.alertId, p.payload.ttl); },
    mark(n) { const s = this.st; if (n.kind !== "phone") return; n.badge = "ALERT: Z4 CRITICAL"; n.badgeColor = css("--red"); s.alerted.add(n.id); if (s.alerted.size === 8 && s.full == null) { s.full = E.t - s.t0; log("All 8 phones alerted in " + fmtT(s.full) + " using " + s.pkts + " packets", "ok"); } },
    metrics() { const s = this.st; return [{ label: "phones alerted", value: s.alerted.size + " / 8", cls: s.alerted.size === 8 ? "good" : "", bar: s.alerted.size / 8 * 100, barCls: "green" }, { label: "packets transmitted", value: s.pkts }, { label: "time to full coverage", value: s.full != null ? fmtT(s.full) : "—" }, { label: "message type", value: E.C.bcast ? "broadcast" : "unicast ×8" }]; },
    steps: [
      { text: "<b>The sensor side is fine.</b> IMD's station reports over INSAT DCP telemetry to the backend regardless of the local towers. The alert engine flips Z4 to CRITICAL. Now it has to reach eight phones with no internet.", run() { send("IMD", "BE", { color: css("--violet"), label: "rain 41 mm/h", r: 6, onArrive: () => log("Backend: Z4 → CRITICAL. Alert ready for the field.", "warn") }); } },
      { text: "<b>Path ① — patchy coverage.</b> P5 still has a bar of signal. It receives the alert, and because it is a <b>broadcast</b> packet every relay treats itself as a recipient and forwards it — same TTL and dedup rules as everything else.", run() { E.sc.onControl("p1"); } },
      { text: "<b>Path ② — total blackout.</b> Nobody has signal. The backend injects at the satellite tier; the bridge hands it to the cluster lead and it floods down.", run() { E.sc.onControl("clr"); E.sc.onControl("p2"); } },
      { text: "<b>Path ③ — pre-loaded.</b> No packets: the static risk classification was cached on every phone at briefing. A responder walking into Z4 already sees the warning. This is the worst-case floor.", run() { E.sc.onControl("clr"); E.sc.onControl("p3"); } },
      { text: "<b>Why broadcast needed adding.</b> Turn the broadcast type off and run path ① again: the backend must address eight unicast packets and each is relayed separately. Count the packets.", run() { E.sc.onControl("clr"); setControl("bcast", false); E.sc.onControl("p1"); } }
    ]
  });

  // ---------- 10. Priority & queueing ----------
  S.push({
    id: "priority", group: "Cross-cutting", tier: "Priority and queueing", title: "Four priorities through one constrained link",
    blurb: "Six phones push traffic through relay R to the EOC over a link with limited capacity. P0 has reserved capacity and jumps the queue; P1 is delivered reliably; P2 positions are coalesced to the latest sample; P3 bulk only moves when there is spare capacity. Per-origin fairness stops one faulty phone from starving everyone else's emergencies.",
    hint: "Lower the link capacity; raise an SOS; then turn on the faulty phone.",
    intro: "Traffic is flowing. <b>Start</b> to constrain the link.",
    controls: [
      { id: "cap", type: "range", label: "Link capacity", min: 2, max: 20, value: 14, unit: " pkt/s" },
      { id: "faulty", type: "switch", label: "P6 is faulty — spams SOS", value: false },
      { id: "fair", type: "switch", label: "Per-origin fairness in P0", value: true, desc: "Caps any one origin to 1 P0 packet/s when others are waiting." },
      { id: "sos", type: "buttons", buttons: [{ id: "raise", label: "P3 raises SOS", cls: "danger" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { q: { 0: [], 1: [], 2: {}, 3: [] }, deliv: { 0: 0, 1: 0, 2: 0, 3: 0 }, coal: 0, dropped3: 0, sosLat: [], acc: 0, gen: {}, lastP0: {}, tokens: 0 });
      ring(200, 300, 6, 130).forEach((p, i) => node("P" + (i + 1), p[0], p[1], "phone", "P" + (i + 1))); node("R", 470, 300, "phone", "R · relay"); node("EOC", 860, 300, "cmd", "EOC");
      for (let i = 1; i <= 6; i++) link("P" + i, "R"); link("R", "EOC", "wifi", { label: "constrained link", delay: 300 });
    },
    draw(ctx) { const s = this.st; const x = 560, y = 380, w = 260; const rows = [["P0 SOS", s.q[0].length, css("--red")], ["P1 tasks", s.q[1].length, css("--amber")], ["P2 positions", Object.keys(s.q[2]).length, css("--gold")], ["P3 bulk", s.q[3].length, css("--ink-3")]]; ctx.font = "600 11px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = css("--ink-2"); ctx.fillText("Queue at R", x, y - 8); rows.forEach((r, i) => { ctx.fillStyle = css("--ink-2"); ctx.fillText(r[0], x, y + 14 + i * 22); ctx.fillStyle = css("--line"); ctx.fillRect(x + 90, y + 4 + i * 22, w - 90, 12); ctx.fillStyle = r[2]; ctx.fillRect(x + 90, y + 4 + i * 22, Math.min(w - 90, r[1] * 6), 12); ctx.fillStyle = css("--ink"); ctx.font = "600 10px JetBrains Mono, monospace"; ctx.fillText(r[1], x + w + 6, y + 14 + i * 22); ctx.font = "600 11px Inter, sans-serif"; }); },
    onControl(id) { if (id === "raise") { this.emit("P3", 0, "SOS"); log("P3 raises SOS", "bad"); } },
    emit(from, pri, kind) { const s = this.st; send(from, "R", { color: [css("--red"), css("--amber"), css("--gold"), css("--ink-3")][pri], r: pri === 0 ? 6 : 4, payload: { pri, kind, from, t0: E.t }, onArrive: (n, p) => { const m = p.payload; if (pri === 2) { if (s.q[2][from]) s.coal++; s.q[2][from] = m; } else if (pri === 3) { if (s.q[3].length > 12) s.dropped3++; else s.q[3].push(m); } else s.q[pri].push(m); } }); },
    tick(dt) {
      const s = this.st;
      // generators
      for (let i = 1; i <= 6; i++) { const id = "P" + i; s.gen[id] = (s.gen[id] || 0) + dt; if (s.gen[id] > 700) { s.gen[id] -= 700; this.emit(id, 2, "POS"); if (Math.random() < .25) this.emit(id, 3, "BULK"); if (Math.random() < .12) this.emit(id, 1, "TASK-ACK"); } }
      if (E.C.faulty) { s.fAcc = (s.fAcc || 0) + dt; if (s.fAcc > 120) { s.fAcc = 0; this.emit("P6", 0, "SOS?"); byId.P6.badge = "FAULTY"; byId.P6.badgeColor = css("--red"); } } else byId.P6.badge = "";
      // constrained link: token bucket
      s.tokens = Math.min(E.C.cap, s.tokens + E.C.cap * dt / 1000);
      while (s.tokens >= 1) {
        let m = null;
        const p0 = s.q[0]; if (p0.length) { const idx = E.C.fair ? p0.findIndex(x => E.t - (s.lastP0[x.from] || -1e9) > 1000 || new Set(p0.map(y => y.from)).size === 1) : 0; if (idx >= 0) { m = p0.splice(idx, 1)[0]; s.lastP0[m.from] = E.t; } else if (p0.length > 20) { p0.splice(0, p0.length - 20); } }
        if (!m && s.q[1].length) m = s.q[1].shift();
        if (!m) { const k = Object.keys(s.q[2])[0]; if (k) { m = s.q[2][k]; delete s.q[2][k]; } }
        if (!m && s.q[3].length && s.tokens > E.C.cap * .5) m = s.q[3].shift();   // bulk only with spare capacity
        if (!m) break;
        s.tokens -= 1; s.deliv[m.pri]++;
        send("R", "EOC", { color: [css("--red"), css("--amber"), css("--gold"), css("--ink-3")][m.pri], r: m.pri === 0 ? 6 : 4, label: m.pri === 0 ? m.kind : "", onArrive: () => { if (m.pri === 0 && m.from === "P3") { s.sosLat.push(E.t - m.t0); if (s.sosLat.length > 20) s.sosLat.shift(); } } });
      }
    },
    metrics() { const s = this.st; return [{ label: "delivered P0 / P1", value: s.deliv[0] + " / " + s.deliv[1] }, { label: "delivered P2 / P3", value: s.deliv[2] + " / " + s.deliv[3] }, { label: "P2 coalesced", value: s.coal }, { label: "P3 dropped (no capacity)", value: s.dropped3, cls: s.dropped3 ? "warn" : "" }, { label: "P3's SOS latency p95", value: s.sosLat.length ? Math.round(p95(s.sosLat)) + " ms" : "—", cls: p95(s.sosLat) > 2000 ? "bad" : s.sosLat.length ? "good" : "" }, { label: "P0 waiting", value: s.q[0].length, cls: s.q[0].length > 5 ? "bad" : "" }]; },
    steps: [
      { text: "<b>Plenty of capacity.</b> Everything gets through. Notice positions from the same phone are already merged into the latest sample while they wait.", run() { } },
      { text: "<b>Constrain the link to 5 packets a second.</b> P3 bulk stops moving — it only rides spare capacity. P2 coalesces harder. P1 acknowledgements still get through.", run() { setControl("cap", 5); } },
      { text: "<b>SOS under load.</b> P3's SOS goes straight to the head of the queue and crosses in well under the 2 s target.", run() { E.sc.onControl("raise"); } },
      { text: "<b>A faulty phone spams SOS.</b> P6 fires a P0 packet every 120 ms. Per-origin fairness caps it to one a second whenever other P0 traffic is waiting — raise P3's SOS again and see it still get through.", run() { setControl("faulty", true); E.sc.onControl("raise"); } },
      { text: "<b>Fairness off.</b> Now P6 monopolises the reserved P0 capacity and P3's genuine SOS waits behind it. This is the failure the per-origin rule exists to prevent.", run() { setControl("fair", false); E.sc.onControl("raise"); } }
    ]
  });

  // ---------- 11. Partition & rejoin ----------
  S.push({
    id: "partition", group: "Cross-cutting", tier: "Partition and rejoin", title: "Two halves keep working; conflicts stay visible on rejoin",
    blurb: "A cluster splits when a wall — a collapsed building, a ridge — cuts the links between two groups. Both halves keep operating and both may make decisions. When they rejoin, observations converge and any conflicting assignment is flagged rather than silently overwritten.",
    hint: "Toggle the wall, assign task T-7 from each side, then rejoin.",
    intro: "Eight phones; C1 and C2 are the two team leads' phones. <b>Start</b>.",
    controls: [
      { id: "wall", type: "switch", label: "Wall splits the cluster", value: false },
      { id: "assign", type: "buttons", label: "Assign task T-7", buttons: [{ id: "a1", label: "from C1 (left)" }, { id: "a2", label: "from C2 (right)" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { assign: {}, conflicts: 0, obs: {}, acc: 0, synced: 0 });
      const P = [["C1", 150, 280], ["P2", 260, 170], ["P3", 270, 400], ["P4", 400, 290], ["P5", 560, 290], ["P6", 690, 170], ["P7", 700, 400], ["C2", 810, 280]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0], { log: {}, obs: 0 })); meshByRange(P.map(p => p[0]), 200);
      byId.C1.ring = css("--gold"); byId.C2.ring = css("--gold"); byId.C1.sub = "team lead A"; byId.C2.sub = "team lead B";
    },
    draw(ctx) { if (!E.C.wall) return; ctx.fillStyle = css("--red"); ctx.globalAlpha = .18; ctx.fillRect(470, 120, 20, 340); ctx.globalAlpha = 1; ctx.fillStyle = css("--red"); ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText("PARTITION", 480, 110); },
    onControl(id) {
      const s = this.st;
      if (id === "wall") { const l = linkBetween("P4", "P5"); if (l) l.up = !E.C.wall; log(E.C.wall ? "Wall: P4–P5 link down. Two partitions, each fully operational." : "Wall gone — partitions rejoin, sync begins", E.C.wall ? "bad" : "ok"); if (!E.C.wall) this.sync(); }
      if (id === "a1" || id === "a2") { const from = id === "a1" ? "C1" : "C2"; const to = id === "a1" ? "P3" : "P7"; const rec = { task: "T-7", to, by: from, t: E.t, epoch: from }; log(from + " assigns T-7 → " + to, "sys"); this.propagate(from, rec); }
    },
    propagate(from, rec) { const reach = reachable(from); reach.forEach(id => { const n = byId[id]; const prev = n.log["T-7"]; if (prev && prev.to !== rec.to) { n.conflict = true; } n.log["T-7"] = prev && prev.to !== rec.to ? { ...rec, conflict: [prev, rec] } : rec; }); const path = [...reach].filter(x => x !== from); path.forEach((id, i) => { const p = bfs(from, id); if (p) this.hop(p, 0, css("--gold")); }); this.badges(); },
    hop(path, i, color) { if (i >= path.length - 1) return; send(path[i], path[i + 1], { color, r: 4, onArrive: () => this.hop(path, i + 1, color) }); },
    sync() { const s = this.st; const all = E.nodes; const recs = all.map(n => n.log["T-7"]).filter(Boolean); const uniq = {}; recs.forEach(r => { uniq[r.to] = r; }); const vals = Object.values(uniq); all.forEach(n => { if (vals.length > 1) { n.log["T-7"] = { task: "T-7", conflict: vals, to: vals.map(v => v.to).join(" & ") }; n.conflict = true; } else if (vals.length === 1) n.log["T-7"] = vals[0]; n.obs = 7; }); s.synced++; if (vals.length > 1) { s.conflicts = 1; log("Sync: T-7 was assigned to " + vals.map(v => v.to + " (by " + v.by + ")").join(" and ") + " — conflict kept visible for the coordinator to resolve", "warn"); } else log("Sync: observations converged; no conflicts", "ok"); for (let i = 0; i < 4; i++) { send("P4", "P5", { color: css("--blue"), r: 4, dur: 200 + i * 120 }); send("P5", "P4", { color: css("--blue"), r: 4, dur: 200 + i * 120 }); } this.badges(); },
    badges() { E.nodes.forEach(n => { const r = n.log["T-7"]; n.badge = r ? (r.conflict ? "T-7 CONFLICT" : "T-7 → " + r.to) : ""; n.badgeColor = r && r.conflict ? css("--red") : css("--green"); }); },
    tick(dt) { const s = this.st; s.acc += dt; if (s.acc > 1500) { s.acc = 0; E.nodes.forEach(n => { n.obs = reachable(n.id).size - 1; flood(n.id, null, { color: css("--green"), r: 3, payload: { obs: 1, ttl: 0 } }); }); } },
    metrics() { const s = this.st; const halves = new Set(E.nodes.map(n => [...reachable(n.id)].sort()[0])).size; const conf = E.nodes.filter(n => n.log["T-7"] && n.log["T-7"].conflict).length; return [{ label: "partitions", value: halves, cls: halves > 1 ? "warn" : "good" }, { label: "phones seeing a T-7 conflict", value: conf + " / 8", cls: conf ? "bad" : "good" }, { label: "peers observed by C1", value: byId.C1 ? byId.C1.obs : 0 }, { label: "peers observed by C2", value: byId.C2 ? byId.C2.obs : 0 }, { label: "syncs completed", value: s.synced }]; },
    steps: [
      { text: "<b>One cluster.</b> Every phone sees seven peers. Team leads C1 and C2 share one picture.", run() { } },
      { text: "<b>The wall goes up.</b> The P4–P5 link is gone and the cluster is two partitions of four. Each half keeps flooding positions and can keep dispatching — nothing waits for a leader.", run() { setControl("wall", true); E.sc.onControl("wall"); } },
      { text: "<b>Both leads assign T-7.</b> C1 gives it to P3; C2, unaware, gives it to P7. Each decision propagates within its own half.", run() { E.sc.onControl("a1"); after(600, () => E.sc.onControl("a2")); } },
      { text: "<b>Rejoin.</b> The wall comes down, the halves exchange logs, and observations converge. T-7 has two assignees — the sync does <i>not</i> pick one silently; every phone shows the conflict for a human to resolve.", run() { setControl("wall", false); E.sc.onControl("wall"); } }
    ]
  });

  // ============================================================
  //  Boot
  // ============================================================
  function buildList() {
    const groups = [...new Set(S.map(s => s.group))]; const box = $("scenarios");
    box.innerHTML = groups.map(g => '<div class="sc-group">' + g + "</div>" + S.filter(s => s.group === g).map(s => '<button type="button" class="sc" data-id="' + s.id + '"><b><span class="n">' + String(S.indexOf(s) + 1).padStart(2, "0") + "</span>" + s.title + "</b><span>" + s.tier + "</span></button>").join("")).join("");
    box.querySelectorAll(".sc").forEach(b => b.addEventListener("click", () => load(S.find(s => s.id === b.dataset.id))));
  }
  canvas.addEventListener("click", ev => {
    const r = canvas.getBoundingClientRect(); const x = (ev.clientX - r.left) / r.width * W, y = (ev.clientY - r.top) / r.height * H;
    const n = E.nodes.find(n => Math.hypot(n.x - x, n.y - y) < 22);
    if (n && E.sc && E.sc.onNodeClick) E.sc.onNodeClick(n);
  });
  $("btn-next").addEventListener("click", nextStep);
  $("btn-reset").addEventListener("click", () => load(E.sc));
  $("auto-run").addEventListener("change", ev => { autoRun = ev.target.checked; if (autoRun && E.step < 0) nextStep(); });
  $("btn-pause").addEventListener("click", () => { E.paused = !E.paused; $("btn-pause").textContent = E.paused ? "▶" : "⏸"; $("btn-pause").classList.toggle("on", E.paused); });
  document.querySelectorAll(".spd").forEach(b => b.addEventListener("click", () => { E.speed = +b.dataset.s; document.querySelectorAll(".spd").forEach(x => x.classList.toggle("on", x === b)); }));
  (function theme() { const btn = $("theme-toggle"); function paint() { const dark = document.documentElement.getAttribute("data-theme") === "dark"; btn.innerHTML = '<span aria-hidden="true">' + (dark ? "☀" : "☾") + "</span>" + (dark ? "Light" : "Dark"); } btn.addEventListener("click", () => { const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("rl_theme", t); } catch (e) {} paint(); }); paint(); })();

  buildList();
  // #scenario opens a scenario; #scenario,auto also starts auto-run (kiosk / demo use)
  const hash = (location.hash || "").slice(1).split(","); load(S.find(s => s.id === hash[0]) || S[0]);
  if (hash[1] === "auto") { $("auto-run").checked = true; autoRun = true; nextStep(); }
  frame(performance.now());
})();
