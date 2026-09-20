/* ============================================================
   RescueLINK — Sector map: terrain, mesh topology, SVG rendering
   Used by control.html and view.html through mesh.js.

   Basemap: Esri World Imagery through Leaflet, with the mesh drawn
   as one georeferenced SVG overlay (map units → lat/lon). If the
   tiles cannot load (no internet at the venue) the drawn terrain
   takes over automatically. The elevation function below stands in
   for a DEM: it decides Wi-Fi Aware link range (range grows with
   elevation) and where "direct to high ground" sends a responder.
   ============================================================ */

(function (global) {
  "use strict";

  const D = global.RESCUELINK_DATA;
  const UNIT_M = D.UNIT_M;

  // Wi-Fi Aware: ~110 m flat, ~225 m with both ends on high ground.
  const WIFI_BASE = 45, WIFI_ELEV = 45;
  // LoRa (Meshtastic, 865–867 MHz): ~2 km line of sight in this terrain.
  const LORA_RANGE = 800;
  // A phone must be this close to an ESP32 to be its cluster lead (Wi-Fi AP / BLE).
  const ESP_ATTACH = 34;

  // ---------------- Terrain ----------------
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  // Two ridges either side of the river, plus the estate knoll. 0..1.
  function elev(x, y) {
    const rA = Math.exp(-Math.pow(segDist(x, y, 450, 10, 980, 340) / 110, 2)) * 1.0;
    const rB = Math.exp(-Math.pow(segDist(x, y, 20, 340, 480, 610) / 130, 2)) * 0.85;
    const kn = Math.exp(-((x - 610) ** 2 + (y - 205) ** 2) / (70 * 70)) * 0.55;
    return Math.min(1, rA + rB + kn + 0.04);
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function rangeOf(a, b) { return WIFI_BASE + WIFI_ELEV * (elev(a.x, a.y) + elev(b.x, b.y)) / 2; }
  function altitudeM(x, y) { return Math.round(880 + elev(x, y) * 220); }
  function latLon(p) {
    return {
      lat: (D.BASE_LAT - p.y * UNIT_M / 111320).toFixed(5),
      lon: (D.BASE_LON + p.x * UNIT_M / (111320 * Math.cos(D.BASE_LAT * Math.PI / 180))).toFixed(5)
    };
  }
  // Numeric gradient ascent — where a coordinator sends someone to "high ground".
  function highGroundFrom(p, steps) {
    const q = { x: p.x, y: p.y };
    for (let i = 0; i < (steps || 28); i++) {
      const gx = elev(q.x + 1, q.y) - elev(q.x - 1, q.y);
      const gy = elev(q.x, q.y + 1) - elev(q.x, q.y - 1);
      const m = Math.hypot(gx, gy) || 1;
      q.x += gx / m; q.y += gy / m;
    }
    return q;
  }

  // Drawn terrain — the offline fallback basemap (rendered once into a canvas).
  function drawTerrain(canvas) {
    const W = 500, H = 310;
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    const ctx = off.getContext("2d"), img = ctx.createImageData(W, H);
    const lo = [227, 233, 226], hi = [190, 205, 184];       // light terrain ramp for the white console
    const lc = [40, 70, 50], la = 0.18;                      // contour ink
    const E = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) E[j * W + i] = elev(i * 2 + 1, j * 2 + 1);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const e = E[j * W + i];
      const eL = E[j * W + Math.max(0, i - 1)], eU = E[Math.max(0, j - 1) * W + i];
      const shade = 0.5 + (eL - e) * 3.2 + (eU - e) * 2.2;   // light from the north-west
      let r = lo[0] + (hi[0] - lo[0]) * e, g = lo[1] + (hi[1] - lo[1]) * e, b = lo[2] + (hi[2] - lo[2]) * e;
      const k = 0.78 + shade * 0.44; r *= k; g *= k; b *= k;
      const band = Math.floor(e * 10);
      const bandR = Math.floor(E[j * W + Math.min(W - 1, i + 1)] * 10), bandD = Math.floor(E[Math.min(H - 1, j + 1) * W + i] * 10);
      const a = (band !== bandR || band !== bandD) ? la : 0;
      const p = (j * W + i) * 4;
      img.data[p] = r * (1 - a) + lc[0] * a; img.data[p + 1] = g * (1 - a) + lc[1] * a; img.data[p + 2] = b * (1 - a) + lc[2] * a; img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const g = canvas.getContext("2d");
    g.imageSmoothingEnabled = true; g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  // ---------------- Geo ----------------
  const FULL = { x: 0, y: 0, w: 1000, h: 620 };
  function toLatLng(p) { const g = latLon(p); return [parseFloat(g.lat), parseFloat(g.lon)]; }
  function sectorBounds() { return [toLatLng({ x: FULL.w, y: FULL.h }), toLatLng({ x: 0, y: 0 })]; }

  // ---------------- View (Leaflet map + SVG overlay) ----------------
  // Returns the same small API mesh.js used before: zoomBy / zoomTo / fit /
  // consumeDrag, plus onChange(scale) so labels can counter-scale.
  const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const TILES_ATTR = "Imagery &copy; Esri, Maxar, Earthstar Geographics, GIS User Community";
  function createView(container, svg, terrainCanvas, opts) {
    opts = opts || {};
    const bounds = L.latLngBounds(sectorBounds());
    const map = L.map(container, { zoomControl: false, attributionControl: true, minZoom: 12, maxZoom: 18, zoomSnap: 0.25, wheelPxPerZoomLevel: 90 });
    map.attributionControl.setPrefix(false);
    const sat = L.tileLayer(TILES, { maxZoom: 18, attribution: TILES_ATTR });
    const terrain = L.imageOverlay(terrainCanvas.toDataURL("image/png"), bounds, { opacity: 1, attribution: "Drawn terrain (offline stand-in for the DEM)" });
    let usingTerrain = false;
    function useTerrain(on, reason) {
      if (on === usingTerrain) return; usingTerrain = on;
      if (on) { map.removeLayer(sat); terrain.addTo(map); container.classList.add("terrain"); }
      else { map.removeLayer(terrain); sat.addTo(map); container.classList.remove("terrain"); }
      if (opts.onBase) opts.onBase(on ? "terrain" : "satellite", reason);
    }
    sat.addTo(map);
    let tileErrors = 0;
    sat.on("tileerror", () => { if (++tileErrors >= 3 && !usingTerrain) useTerrain(true, "tiles unavailable"); });

    const overlay = L.svgOverlay(svg, bounds, { interactive: true, bubblingMouseEvents: true }).addTo(map);
    map.fitBounds(bounds, { padding: [6, 6] });
    const fitZoom = map.getZoom();
    function scale() { return Math.pow(2, map.getZoom() - fitZoom); }
    function apply() { svg.style.setProperty("--k", (1 / Math.sqrt(Math.max(1, scale()))).toFixed(3)); if (opts.onChange) opts.onChange(scale()); }
    map.on("zoomend", apply); apply();

    // A drag on the overlay must not count as a click on whatever is under the cursor.
    let dragged = false, down = null;
    svg.addEventListener("pointerdown", ev => { dragged = false; down = { x: ev.clientX, y: ev.clientY }; });
    window.addEventListener("pointermove", ev => { if (down && Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y) > 6) dragged = true; });
    window.addEventListener("pointerup", () => { down = null; });

    return {
      map, overlay,
      zoom() { return scale(); },
      fit() { map.fitBounds(bounds, { padding: [6, 6] }); },
      zoomBy(f) { map.setZoom(map.getZoom() + Math.log2(f)); },
      zoomTo(cx, cy, radius) { map.fitBounds(L.latLngBounds(toLatLng({ x: cx - radius * 1.3, y: cy + radius * 1.3 }), toLatLng({ x: cx + radius * 1.3, y: cy - radius * 1.3 })), { maxZoom: 18 }); },
      setBase(kind) { useTerrain(kind === "terrain", "manual"); },
      base() { return usingTerrain ? "terrain" : "satellite"; },
      consumeDrag() { const d = dragged; dragged = false; return d; },
      invalidate() { map.invalidateSize(); }
    };
  }

  function drawStaticFeatures(group) {
    group.innerHTML =
      '<rect class="sm-sector" x="0" y="0" width="1000" height="620"/>' +
      '<path class="sm-scar" d="M250 470 L 290 425 L 340 395 L 405 372 L 430 368 L 440 392 L 395 412 L 350 440 L 305 480 Z"/>' +
      '<path d="M250 470 L 290 425 L 340 395 L 405 372 L 430 368 L 440 392 L 395 412 L 350 440 L 305 480 Z" fill="url(#sm-hatch)"/>' +
      '<text x="470" y="352" class="sm-note">slide run-out</text>' +
      '<text x="150" y="60" class="sm-place">▲ staging</text>' +
      '<text x="760" y="600" class="sm-place">Puthur Kadavu</text>' +
      '<text x="615" y="150" class="sm-place">knoll 1 040 m</text>' +
      '<text x="70" y="580" class="sm-place">Kottamala ridge</text>' +
      '<text x="905" y="24" class="sm-hq">EOC ↗ 23 km</text>' +
      '<text x="8" y="612" class="sm-note">simulated scenario on real imagery · positions and names are fictional</text>';
  }

  // ---------------- Topology ----------------
  // Returns links, clusters (connected components over Wi-Fi Aware links),
  // per-cluster reach (which rung carries its traffic to command) and
  // the coverage gaps a coordinator could close with elevation.
  function computeTopology(nodes, esps) {
    const links = [];
    const par = nodes.map((_, i) => i);
    const find = i => par[i] === i ? i : (par[i] = find(par[i]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const d = dist(nodes[i], nodes[j]), r = rangeOf(nodes[i], nodes[j]);
      if (d < r) {
        links.push({ a: nodes[i], b: nodes[j], d, q: 1 - d / r, rssi: Math.round(-42 - 48 * (d / r)) });
        par[find(i)] = find(j);
      }
    }
    const byRoot = {};
    nodes.forEach((n, i) => { (byRoot[find(i)] = byRoot[find(i)] || []).push(n); });
    esps.forEach(e => { e.lead = null; });
    const clusters = Object.values(byRoot).map(members => {
      const c = { members, esp: null, internetNode: null, reach: "none", reachVia: "", name: "" };
      members.forEach(n => { if (n.internet) c.internetNode = n; });
      esps.forEach(e => { if (!e.on) return; members.forEach(n => { if (dist(n, e) < ESP_ATTACH) { c.esp = e; e.lead = n; } }); });
      c.cx = members.reduce((s, n) => s + n.x, 0) / members.length;
      c.cy = members.reduce((s, n) => s + n.y, 0) / members.length;
      return c;
    });

    // LoRa components among powered bridges
    const act = esps.filter(e => e.on);
    const ep = act.map((_, i) => i);
    const ef = i => ep[i] === i ? i : (ep[i] = ef(ep[i]));
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) if (dist(act[i], act[j]) < LORA_RANGE) ep[ef(i)] = ef(j);
    const loraComp = {};
    act.forEach((e, i) => { loraComp[e.id] = ef(i); });

    const compHasInternet = {}, compHasSat = {};
    clusters.forEach(c => { if (c.esp && c.internetNode) compHasInternet[loraComp[c.esp.id]] = c.internetNode.id; });
    act.forEach(e => { if (e.sat) compHasSat[loraComp[e.id]] = e.id; });

    const nodeCluster = {};
    clusters.forEach(c => {
      if (c.internetNode) { c.reach = "GATEWAY"; c.reachVia = c.internetNode.id; }
      else if (c.esp && compHasInternet[loraComp[c.esp.id]] !== undefined) { c.reach = "LORA"; c.reachVia = "LoRa " + c.esp.id + " → gateway " + compHasInternet[loraComp[c.esp.id]]; }
      else if (c.esp && compHasSat[loraComp[c.esp.id]]) { c.reach = "SAT"; c.reachVia = "LoRa " + c.esp.id + (c.esp.sat ? "" : " → " + compHasSat[loraComp[c.esp.id]]) + " → SAT"; }
      else { c.reach = "none"; c.reachVia = "no uplink — store & forward"; }
      c.members.forEach(n => { nodeCluster[n.id] = c; });
    });

    const gapLines = [];
    clusters.filter(c => c.reach === "none").forEach(c => {
      let best = null;
      c.members.forEach(a => clusters.filter(o => o !== c && o.reach !== "none").forEach(o => o.members.forEach(b => {
        const d = dist(a, b); if (d < 140 && (!best || d < best.d)) best = { a, b, d };
      })));
      if (best) gapLines.push(best);
    });

    clusters.sort((p, q) => p.cx - q.cx).forEach((c, i) => { c.name = "Cluster " + String.fromCharCode(65 + i); });
    return { links, clusters, nodeCluster, loraComp, gapLines };
  }

  function hops(links, from, to) {
    if (from === to) return 0;
    const adj = {};
    links.forEach(l => { (adj[l.a.id] = adj[l.a.id] || []).push(l.b.id); (adj[l.b.id] = adj[l.b.id] || []).push(l.a.id); });
    const seen = { [from.id]: 0 }; const q = [from.id];
    while (q.length) {
      const u = q.shift();
      for (const v of (adj[u] || [])) { if (seen[v] === undefined) { seen[v] = seen[u] + 1; if (v === to.id) return seen[v]; q.push(v); } }
    }
    return null;
  }

  // ---------------- SVG rendering ----------------
  const HQ = { x: 990, y: 30 };
  function agencyColor(ag) { return D.AGENCIES[ag].color; }

  function renderMap(svg, s) {
    const g = id => svg.querySelector("#" + id);
    const { nodes, esps, topo, tasks, zones, selected, showZones, selZone } = s;

    g("sm-zones").innerHTML = showZones ? zones.map(z =>
      '<rect class="sm-zone ' + z.level + (z.id === selZone ? " sel" : "") + '" data-z="' + z.id + '" x="' + z.x + '" y="' + z.y + '" width="' + z.w + '" height="' + z.h + '" rx="2"/>' +
      '<text class="sm-zone-lbl" x="' + (z.x + z.w - 8) + '" y="' + (z.y + z.h - 8) + '" text-anchor="end">' + z.id + " · " + z.level + '</text>').join("") : "";

    const act = esps.filter(e => e.on); let lo = "";
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) if (dist(act[i], act[j]) < LORA_RANGE)
      lo += '<line class="sm-lora" x1="' + act[i].x + '" y1="' + act[i].y + '" x2="' + act[j].x + '" y2="' + act[j].y + '"/>';
    const sat = act.find(e => e.sat);
    if (sat) lo += '<path class="sm-hqlink" d="M' + sat.x + " " + sat.y + " Q " + (sat.x + HQ.x) / 2 + " " + (Math.min(sat.y, HQ.y) - 60) + " " + HQ.x + " " + HQ.y + '"/>';
    g("sm-lora").innerHTML = lo;

    g("sm-clusters").innerHTML = topo.clusters.map(c => {
      const r = Math.max(34, ...c.members.map(n => dist(n, { x: c.cx, y: c.cy }))) + 30;
      const sub = c.reach === "none" ? "no link to command" : c.reach === "GATEWAY" ? "internet via " + c.reachVia : c.reach === "SAT" ? "satellite via " + c.esp.id : "LoRa " + c.esp.id + " → internet";
      c.r = r;
      return '<circle class="sm-cluster ' + c.reach + '" data-c="' + c.name + '" cx="' + c.cx.toFixed(1) + '" cy="' + c.cy.toFixed(1) + '" r="' + r.toFixed(1) + '"><title>' + c.name + ' — click to zoom in</title></circle>' +
        '<text class="sm-cluster-lbl" x="' + c.cx.toFixed(1) + '" y="' + (c.cy - r - 14).toFixed(1) + '">' + c.name + " · " + c.members.length + '</text>' +
        '<text class="sm-cluster-sub" x="' + c.cx.toFixed(1) + '" y="' + (c.cy - r - 3).toFixed(1) + '">' + sub + '</text>';
    }).join("");

    g("sm-gaps").innerHTML = topo.gapLines.map(gp =>
      '<line class="sm-gap" x1="' + gp.a.x + '" y1="' + gp.a.y + '" x2="' + gp.b.x + '" y2="' + gp.b.y + '"/>' +
      '<text class="sm-gap-lbl" x="' + ((gp.a.x + gp.b.x) / 2 + 10) + '" y="' + ((gp.a.y + gp.b.y) / 2 + 18) + '">gap ' + Math.round(gp.d * UNIT_M) + ' m · needs elevation</text>').join("");

    g("sm-links").innerHTML = topo.links.map((l, i) =>
      '<line class="sm-link-hit" data-l="' + i + '" x1="' + l.a.x + '" y1="' + l.a.y + '" x2="' + l.b.x + '" y2="' + l.b.y + '"/>' +
      '<line class="sm-link-under" x1="' + l.a.x + '" y1="' + l.a.y + '" x2="' + l.b.x + '" y2="' + l.b.y + '" stroke-width="' + (4 + l.q * 3).toFixed(1) + '"/>' +
      '<line class="sm-link" data-l="' + i + '" x1="' + l.a.x + '" y1="' + l.a.y + '" x2="' + l.b.x + '" y2="' + l.b.y + '" stroke-width="' + (2 + l.q * 3).toFixed(1) + '" stroke-opacity="' + (0.6 + l.q * 0.4).toFixed(2) + '"/>').join("");

    g("sm-tasks").innerHTML = tasks.map(t => {
      const n = s.byId[t.node];
      return '<line class="sm-task-ln" x1="' + n.x + '" y1="' + n.y + '" x2="' + t.x + '" y2="' + t.y + '"/>' +
        '<g transform="translate(' + t.x + " " + t.y + ')"><circle class="sm-task" r="7"/>' +
        '<line class="sm-task" x1="-11" y1="0" x2="-4" y2="0"/><line class="sm-task" x1="4" y1="0" x2="11" y2="0"/>' +
        '<line class="sm-task" x1="0" y1="-11" x2="0" y2="-4"/><line class="sm-task" x1="0" y1="4" x2="0" y2="11"/>' +
        '<text class="sm-task-lbl" x="12" y="-8">' + t.label + '</text></g>';
    }).join("");

    g("sm-esp").innerHTML = esps.map(e =>
      '<g class="sm-esp' + (e.on ? "" : " off") + '" data-e="' + e.id + '" transform="translate(' + e.x + " " + e.y + ')">' +
      '<rect x="-8" y="-8" width="16" height="16" transform="rotate(45)"/>' +
      (e.sat ? '<path class="dish" d="M-10 -14 a 9 9 0 0 1 14 -6 M-7 -11 a 5 5 0 0 1 8 -3"/>' : "") +
      '<text y="-16">' + e.id + '</text></g>').join("");

    g("sm-nodes").innerHTML = nodes.map(n =>
      '<g class="sm-node' + (n === selected ? " sel" : "") + (n.status === "sos" ? " sos" : "") + '" data-n="' + n.id + '" transform="translate(' + n.x.toFixed(1) + " " + n.y.toFixed(1) + ')">' +
      (n.status === "sos" ? '<circle class="pulse" r="12"/>' : "") +
      '<circle class="ring" r="15"/><circle class="b" r="10.5" style="fill:' + agencyColor(n.ag) + '"/><text>' + D.AGENCIES[n.ag].short + '</text>' +
      '<text class="tag" y="24">' + n.id.replace("NDRF-", "N").replace("SDRF-", "S").replace("POL-", "P").replace("FIRE-", "F").replace("VOL-", "V") + '</text>' +
      (n.internet ? '<circle class="gw" cx="9" cy="-9" r="4.5"/>' : "") +
      (n.queue.length ? '<text class="q" x="12" y="-8">+' + n.queue.length + '</text>' : "") + '</g>').join("");
  }

  function svgPoint(svg, ev) {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width * FULL.w, y: (ev.clientY - r.top) / r.height * FULL.h };
  }

  // ---------------- Tooltip ----------------
  let tipEl = null;
  function tip() {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "sm-tooltip"; tipEl.hidden = true; document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(ev, title, meta) {
    const t = tip();
    t.innerHTML = '<div class="t">' + title + "</div>" + (meta ? '<div class="m">' + meta + "</div>" : "");
    t.hidden = false; t.style.left = ev.clientX + "px"; t.style.top = ev.clientY + "px";
  }
  function hideTip() { tip().hidden = true; }

  global.SMMap = {
    WIFI_BASE, WIFI_ELEV, LORA_RANGE, ESP_ATTACH, UNIT_M,
    elev, dist, rangeOf, altitudeM, latLon, highGroundFrom,
    drawTerrain, drawStaticFeatures, computeTopology, hops, createView, toLatLng, sectorBounds,
    renderMap, svgPoint, showTip, hideTip, agencyColor
  };

})(window);
