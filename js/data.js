/* ============================================================
   RescueLINK — Scenario data
   Everything here is fictional/simulated for the SIH 2026 demo.
   Sector: a landslide on a fictional ridge in Wayanad district.
   Map units: 1 unit = 2.5 m (sector 2.5 km × 1.55 km). Terrain,
   link range and the "high ground" mechanic all use the same
   elevation function in map.js, so the map is internally honest.
   ============================================================ */

(function (global) {
  "use strict";

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  const INCIDENT = {
    id: "WYD-26-0142",
    title: "Landslide — Kottamala ridge, Wayanad district",
    eoc: "District EOC · Kalpetta · 23 km",
    impactAt: Date.now() - (47 * MIN + 12 * 1000)    // T+00:47:12 at page load
  };

  const UNIT_M = 2.5;
  // Sector origin (top-left corner). The satellite basemap is real imagery of
  // the Mundakkai–Chooralmala valley in Wayanad; the scenario drawn on it —
  // names, cells, positions — is fictional and is labelled as such.
  const BASE_LAT = 11.4860, BASE_LON = 76.1376;

  // Real-world cues: NDRF wears orange, SDRF blue, police khaki. The colours
  // are CSS tokens (css/theme.css) so the light and dark palettes — both
  // validated for colour-vision deficiency — swap together; markers also
  // carry the agency initial so identity never rests on colour.
  const AGENCIES = {
    NDRF: { label: "NDRF · 4th Bn Arakkonam", short: "N", color: "var(--ag-ndrf)" },
    SDRF: { label: "Kerala SDRF",            short: "S", color: "var(--ag-sdrf)" },
    POL:  { label: "Kerala Police · Meppadi PS", short: "P", color: "var(--ag-pol)" },
    FIRE: { label: "Fire & Rescue · Kalpetta", short: "F", color: "var(--ag-fire)" },
    VOL:  { label: "Volunteers · Civil Defence", short: "V", color: "var(--ag-vol)" }
  };

  // [id, agency, x, y, status, task]
  const ROSTER = [
    // Elanad bridgehead — staging on the NH-766 spur (low ground)
    ["NDRF-01", "NDRF", 188, 128, "available"],
    ["NDRF-02", "NDRF", 215, 150, "available"],
    ["NDRF-03", "NDRF", 240, 132, "available"],           // sits on the cell fringe
    ["POL-01",  "POL",  170, 160, "engaged", "Cordon, NH-766 spur"],
    ["POL-02",  "POL",  205, 180, "engaged", "Cordon, NH-766 spur"],
    ["FIRE-01", "FIRE", 230, 175, "available"],
    // Slide zone — main team, attached to bridge L2
    ["NDRF-04", "NDRF", 300, 420, "engaged", "Search grid E-3"],
    ["NDRF-05", "NDRF", 325, 445, "engaged", "Search grid E-3"],
    ["SDRF-01", "SDRF", 350, 425, "engaged", "Search grid E-3"],
    ["VOL-01",  "VOL",  310, 465, "engaged", "Casualty relay E-3"],
    ["VOL-02",  "VOL",  340, 470, "engaged", "Casualty relay E-3"],
    ["FIRE-02", "FIRE", 365, 455, "engaged", "Cutting, house row 2"],
    // Slide zone — forward probe line, cut off from L2 by a 165 m gap
    ["NDRF-06", "NDRF", 408, 392, "engaged", "Probe line, slide toe"],
    ["SDRF-02", "SDRF", 440, 395, "engaged", "Probe line, slide toe"],
    ["SDRF-03", "SDRF", 480, 395, "engaged", "Probe line, slide toe"],
    ["VOL-03",  "VOL",  462, 365, "sos",     "Probe line, slide toe"],
    // Kottamala estate knoll — Fire pair with no bridge at all
    ["FIRE-03", "FIRE", 600, 250, "engaged", "Substation fire, Kottamala line"],
    ["FIRE-04", "FIRE", 625, 270, "engaged", "Substation fire, Kottamala line"],
    // Puthur Kadavu — downstream village evacuation, bridge L3
    ["SDRF-04", "SDRF", 780, 545, "engaged", "Evacuate Puthur Kadavu"],
    ["SDRF-05", "SDRF", 810, 560, "engaged", "Evacuate Puthur Kadavu"],
    ["POL-03",  "POL",  840, 540, "engaged", "Traffic, river road"],
    ["VOL-04",  "VOL",  795, 585, "engaged", "Evacuate Puthur Kadavu"],
    ["VOL-05",  "VOL",  830, 590, "available"],
    ["NDRF-07", "NDRF", 765, 575, "engaged", "Evacuate Puthur Kadavu"]
  ];

  const SOS_TEXT = {
    "VOL-03": "Responder in danger — ground moving under probe line, need pull-out and rope team"
  };

  // Store-and-forward items already sitting on the cut-off Fire pair. They
  // only reach the EOC once a rung appears (e.g. the L4 relay is dropped).
  const PENDING_QUEUES = {
    "FIRE-03": [
      { type: "REQ", bytes: 96, req: { id: "REQ-7", kind: "backup", need: "EQUIPMENT", from: "FIRE-03",
        text: "Substation LPG cache — need foam unit + 2 BA sets, water at 40%", age: 14 } },
      { type: "POS", bytes: 48 }, { type: "POS", bytes: 48 }, { type: "IMG", bytes: 41200 }, { type: "TXT", bytes: 88 }
    ],
    "FIRE-04": [ { type: "POS", bytes: 48 }, { type: "POS", bytes: 48 }, { type: "TXT", bytes: 112 } ]
  };

  // ESP32 + LoRa bridges (Meshtastic). L1 carries the Iridium SBD modem.
  const BRIDGES = [
    { id: "L1", x: 225, y: 120, sat: true,  on: true, label: "L1 · staging (SAT modem)" },
    { id: "L2", x: 330, y: 405, sat: false, on: true, label: "L2 · slide zone" },
    { id: "L3", x: 805, y: 530, sat: false, on: true, label: "L3 · Puthur Kadavu" }
  ];
  const DROPPED_RELAY = { id: "L4", x: 612, y: 225, sat: false, on: true, label: "L4 · dropped relay, knoll" };

  // Risk grid cells. Layer 1 (static) is the pre-computed baseline; Layer 2
  // (dynamic) is the live trigger — IMD 3 h rainfall against the cell's own
  // threshold derived from the 2005–2025 station record.
  const ZONES = [
    { id: "Z1", name: "Elanad bridgehead", sub: "NH-766 spur · staging", x: 60,  y: 40,  w: 300, h: 260,
      base: "LOW",      baseP: 0.12, trig: 0.31, rain3h: 64,  thr: 110, slope: 8,  gsi: "Low",      cwc: null, hist: "0 events / 20 y" },
    { id: "Z2", name: "Kottamala estate",  sub: "knoll · tea estate",   x: 360, y: 40,  w: 340, h: 260,
      base: "MEDIUM",   baseP: 0.46, trig: 0.55, rain3h: 88,  thr: 96,  slope: 19, gsi: "Moderate", cwc: null, hist: "1 event / 20 y" },
    { id: "Z3", name: "Ridge north",       sub: "reserve forest",       x: 700, y: 40,  w: 260, h: 260,
      base: "MEDIUM",   baseP: 0.41, trig: 0.38, rain3h: 71,  thr: 104, slope: 27, gsi: "Moderate", cwc: null, hist: "1 event / 20 y" },
    { id: "Z4", name: "Kottamala ridge, upper slope", sub: "slide origin", x: 60, y: 300, w: 300, h: 300,
      base: "CRITICAL", baseP: 0.91, trig: 0.97, rain3h: 118, thr: 72,  slope: 34, gsi: "High",     cwc: null, hist: "3 events / 20 y" },
    { id: "Z5", name: "Elanad hamlet",     sub: "run-out · 42 houses",  x: 360, y: 300, w: 200, h: 300,
      base: "HIGH",     baseP: 0.74, trig: 0.86, rain3h: 118, thr: 80,  slope: 16, gsi: "High",     cwc: null, hist: "2 events / 20 y" },
    { id: "Z6", name: "Puthur Kadavu",     sub: "river bend · 190 residents", x: 560, y: 300, w: 400, h: 300,
      base: "MEDIUM",   baseP: 0.52, trig: 0.71, rain3h: 97,  thr: 90,  slope: 5,  gsi: "Low",      cwc: "Warning level −0.4 m", hist: "flood 2018, 2019" }
  ];

  const REQUESTS = [
    { id: "REQ-9", kind: "sos",    need: "SOS",      from: "VOL-03",  text: SOS_TEXT["VOL-03"], age: 2,  via: "MESH → LoRa L2 → SAT" },
    { id: "REQ-8", kind: "backup", need: "MEDICAL",  from: "NDRF-05", text: "3 casualties extracted at E-3, need paramedic + 2 stretchers", age: 6, via: "MESH → LoRa L2 → SAT" },
    { id: "REQ-6", kind: "backup", need: "MANPOWER", from: "SDRF-04", text: "River rising at the bend, 40 residents still to move from lower row", age: 11, via: "MESH → LoRa L3 → L1 → SAT" }
  ];

  // Seed rows for the transport-ladder log (oldest last).
  const SEED_LOG = [
    ["VOL-03",  "SOS", 64,    "SAT",    "1 hop → L2 ⇢ L1 → Iridium → EOC · priority queue-jump on every tier", 41.2],
    ["NDRF-05", "REQ", 96,    "SAT",    "2 hop → L2 ⇢ L1 → Iridium → EOC", 38.5],
    ["SDRF-04", "REQ", 102,   "SAT",    "1 hop → L3 ⇢ L1 → Iridium → EOC", 52.1],
    ["NDRF-01", "POS", 48,    "SAT",    "0 hop → L1 → Iridium → EOC", 27.9],
    ["FIRE-02", "IMG", 36400, "QUEUED", "exceeds 340 B SBD cap — held for gateway", null],
    ["SDRF-01", "PTT", 1800,  "MESH",   "PTT (Codec 2, 2.4 kb/s) → NDRF-04, 1 hop", 0.08]
  ];

  // Structured field reports received over the mesh (control-reports / view-reports).
  const FIELD_REPORTS = [
    { id: "FR-118", from: "NDRF-05", agency: "NDRF", type: "Casualty", zone: "Z5", ageMin: 4,
      text: "3 extracted alive from house row 2, one with crush injury. Two more voices heard under slab.",
      tier: "SAT", bytes: 212, image: null },
    { id: "FR-117", from: "SDRF-04", agency: "SDRF", type: "Situation", zone: "Z6", ageMin: 9,
      text: "River at the bend rising ~15 cm per 10 min. Lower row (18 houses) cleared, upper row in progress.",
      tier: "SAT", bytes: 188, image: null },
    { id: "FR-116", from: "FIRE-02", agency: "FIRE", type: "Damage", zone: "Z5", ageMin: 12,
      text: "House row 2 — 6 structures collapsed, cutting access from the east side. Photo attached.",
      tier: "QUEUED", bytes: 36400, image: { chunks: 36, received: 21, note: "held at L2 — image exceeds 340 B SBD cap, resumes when a gateway appears" } },
    { id: "FR-115", from: "POL-01", agency: "POL", type: "Access", zone: "Z1", ageMin: 18,
      text: "NH-766 spur passable for 4×4 up to the culvert. Ambulance staging moved 200 m back.",
      tier: "SAT", bytes: 140, image: null },
    { id: "FR-114", from: "VOL-04", agency: "VOL", type: "Headcount", zone: "Z6", ageMin: 23,
      text: "Puthur Kadavu upper row: 62 residents at the school, 4 elderly need transport.",
      tier: "SAT", bytes: 121, image: null },
    { id: "FR-113", from: "NDRF-04", agency: "NDRF", type: "Damage", zone: "Z4", ageMin: 31,
      text: "Crown of slide ~120 m wide at the 950 m contour. Fresh cracks 40 m above — secondary slide risk.",
      tier: "SAT", bytes: 176, image: { chunks: 41, received: 41, note: "delivered over mesh to L2, image held for gateway" } }
  ];

  // Photos uploaded from responder apps. WebP, ~1 KB chunks with sequence
  // headers, hop-by-hop over the mesh with checkpointed resume. Anything over
  // 340 B needs a cluster with internet — so images either arrive through a
  // gateway phone, or are physically carried ("data mule") by a responder
  // walking between clusters, which is ordinary DTN behaviour.
  // The pictures are real, openly licensed photographs (see assets/field/CREDITS.md)
  // standing in for responder uploads; captions are part of the fictional scenario.
  const PHOTOS = [
    { id: "IMG-2041", from: "NDRF-04", zone: "Z4", ageMin: 31, report: "FR-113",
      caption: "Slide scar seen from the toe — debris still moving on the upper slope", src: "assets/field/slide-scar.jpg", credit: { artist: "Spworld2", license: "CC0", title: "White guard volunteer in Chooralmala wayanad landslides 2024.jpg", page: "https://commons.wikimedia.org/wiki/File%3AWhite_guard_volunteer_in_Chooralmala_wayanad_landslides_2024.jpg" },
      bytes: 41200, chunks: 41, received: 41, status: "delivered", via: "MESH → carried by VOL-02 (casualty relay) to staging → gateway NDRF-03" },
    { id: "IMG-2044", from: "FIRE-02", zone: "Z5", ageMin: 12, report: "FR-116",
      caption: "House row 2 — run-out went straight through the hamlet", src: "assets/field/hamlet-runout.jpg", credit: { artist: "Vis M", license: "CC BY-SA 4.0", title: "Remnants of 2024 Wayanad landslides disaster at Mundakkai 02.jpg", page: "https://commons.wikimedia.org/wiki/File%3ARemnants_of_2024_Wayanad_landslides_disaster_at_Mundakkai_02.jpg" },
      bytes: 36400, chunks: 36, received: 21, status: "partial", via: "MESH → held at L2 · resumes from chunk 22 when a gateway or courier reaches Cluster B" },
    { id: "IMG-2038", from: "SDRF-04", zone: "Z6", ageMin: 26, report: "FR-117",
      caption: "Boat evacuation at the bend — lower row cleared", src: "assets/field/river-boat.jpg", credit: { artist: "Ministry of Home Affairs", license: "GODL-India", title: "The NDRF teams carrying out rescue and relief operations in flood-affected areas of Kerala on August 11, 2018.JPG", page: "https://commons.wikimedia.org/wiki/File%3AThe_NDRF_teams_carrying_out_rescue_and_relief_operations_in_flood-affected_areas_of_Kerala_on_August_11%2C_2018.JPG" },
      bytes: 33800, chunks: 34, received: 34, status: "delivered", via: "MESH → carried by POL-03 on the river road → gateway NDRF-03" },
    { id: "IMG-2031", from: "POL-01", zone: "Z1", ageMin: 44, report: "FR-115",
      caption: "Access past the culvert — foot traffic only, vehicles staged back", src: "assets/field/access-track.jpg", credit: { artist: "Ahamedhjewadh", license: "CC0", title: "Rescue workers pass through Mundakai and Churalmala landslide area in Wayanad.jpg", page: "https://commons.wikimedia.org/wiki/File%3ARescue_workers_pass_through_Mundakai_and_Churalmala_landslide_area_in_Wayanad.jpg" },
      bytes: 29900, chunks: 30, received: 30, status: "delivered", via: "1 hop → gateway NDRF-03 → cloud" },
    { id: "IMG-2036", from: "VOL-04", zone: "Z6", ageMin: 35, report: "FR-114",
      caption: "Upper-row residents registered at the school relief camp", src: "assets/field/relief-camp.jpg", credit: { artist: "Arunvrparavur", license: "CC BY-SA 4.0", title: "Padivattom disaster relief camp, Aug 2018.jpg", page: "https://commons.wikimedia.org/wiki/File%3APadivattom_disaster_relief_camp%2C_Aug_2018.jpg" },
      bytes: 31200, chunks: 31, received: 31, status: "delivered", via: "MESH → carried by POL-03 on the river road → gateway NDRF-03" },
    { id: "IMG-2046", from: "NDRF-06", zone: "Z5", ageMin: 8, report: null,
      caption: "Probe line at the slide toe — ground still wet and unstable", src: "assets/field/probe-line.jpg", credit: { artist: "Ahamedhjewadh", license: "CC0", title: "Mundakkai, Chooralmala, Wayanad Landslide rescue team.jpg", page: "https://commons.wikimedia.org/wiki/File%3AMundakkai%2C_Chooralmala%2C_Wayanad_Landslide_rescue_team.jpg" },
      bytes: 38600, chunks: 39, received: 39, status: "delivered", via: "MESH → carried by NDRF-06 back to L2 → courier to staging → gateway NDRF-03" },
    { id: "IMG-2035", from: "SDRF-05", zone: "Z6", ageMin: 38, report: null,
      caption: "Elderly resident lifted into the boat at the river road", src: "assets/field/boat-evac.jpg", credit: { artist: "Ministry of Home Affairs", license: "GODL-India", title: "The NDRF teams carrying out rescue and relief operations in flood-affected areas of Kerala on August 11, 2018 (1).JPG", page: "https://commons.wikimedia.org/wiki/File%3AThe_NDRF_teams_carrying_out_rescue_and_relief_operations_in_flood-affected_areas_of_Kerala_on_August_11%2C_2018_%281%29.JPG" },
      bytes: 30400, chunks: 30, received: 30, status: "delivered", via: "MESH → carried by POL-03 on the river road → gateway NDRF-03" },
    { id: "IMG-2029", from: "FIRE-03", zone: "Z2", ageMin: 52, report: null,
      caption: "Estate track blocked by debris — LPG cache exposed", src: "assets/field/debris-field.jpg", credit: { artist: "Vis M", license: "CC BY-SA 4.0", title: "Remnants of 2024 Wayanad landslides 02.jpg", page: "https://commons.wikimedia.org/wiki/File%3ARemnants_of_2024_Wayanad_landslides_02.jpg" },
      bytes: 41200, chunks: 41, received: 0, status: "pending", via: "no link — held on the phone until it reaches a cluster with internet" }
  ];

  // Pre-assignment of registered forces to flagged cells (control-preassign).
  const REGISTERED_FORCES = [
    { id: "NDRF-4B-T2", agency: "NDRF", name: "4th Bn · Team 2",      strength: 12, base: "Arakkonam (fwd. Kalpetta)", capability: "USAR, medical" },
    { id: "NDRF-4B-T3", agency: "NDRF", name: "4th Bn · Team 3",      strength: 12, base: "Kalpetta",                  capability: "USAR, rope" },
    { id: "SDRF-WYD-1", agency: "SDRF", name: "SDRF Wayanad · Unit 1", strength: 8,  base: "Meppadi",                   capability: "Boat, swiftwater" },
    { id: "SDRF-WYD-2", agency: "SDRF", name: "SDRF Wayanad · Unit 2", strength: 8,  base: "Kalpetta",                  capability: "Evacuation" },
    { id: "FRS-KLP-1",  agency: "FIRE", name: "Fire & Rescue · Kalpetta 1", strength: 6, base: "Kalpetta station",      capability: "Cutting, fire" },
    { id: "POL-MPD",    agency: "POL",  name: "Meppadi PS · Patrol",   strength: 10, base: "Meppadi",                   capability: "Cordon, traffic" },
    { id: "CD-VOL-A",   agency: "VOL",  name: "Civil Defence · Group A", strength: 20, base: "Elanad",                  capability: "Relay, headcount" }
  ];

  const EVAC_ROUTES = [
    { id: "R1", name: "Elanad hamlet → Elanad school",   from: "Z5", to: "Z1", lengthKm: 1.4, status: "Pushed to apps", note: "avoids the slide toe; foot only above the culvert" },
    { id: "R2", name: "Puthur Kadavu → Meppadi hall",    from: "Z6", to: "off-sector", lengthKm: 3.1, status: "Pushed to apps", note: "river road, closed if gauge passes warning level" },
    { id: "R3", name: "Kottamala estate → NH-766 spur",  from: "Z2", to: "Z1", lengthKm: 2.2, status: "Draft", note: "estate track, 4×4 only" }
  ];

  // Satellite EO before/after sample sites for the imagery pages.
  // Sensor network behind the alert engine's dynamic layer. Readings arrive
  // over each agency's own national telemetry (IMD/CWC/NCS links, ISRO
  // downlink), not local cell towers — so they keep coming when the sector
  // is dark. `series` is the recent window used for the readings sparkline.
  const SENSORS = [
    { id: "IMD-MPD-AWS", type: "rain", name: "IMD AWS · Meppadi", source: "IMD", zone: "Z4", unit: "mm/h", reading: 41, thr: 24, status: "CRITICAL", lastMin: 3, windowH: 12,
      series: [4, 5, 3, 6, 9, 14, 18, 22, 27, 31, 36, 41], telemetry: "IMD AWS network (INSAT DCP uplink)", feeds: "Layer 2 trigger for Z4, Z5 (3 h rainfall vs cell threshold)", basis: "3 h total above the 2005–2025 95th percentile for this station" },
    { id: "IMD-KLP-ARG", type: "rain", name: "IMD ARG · Kalpetta", source: "IMD", zone: "Z1", unit: "mm/h", reading: 19, thr: 37, status: "OK", lastMin: 4, windowH: 12,
      series: [3, 4, 4, 6, 8, 10, 12, 15, 17, 18, 19, 19], telemetry: "IMD ARG network (GPRS, falls back to INSAT DCP)", feeds: "Layer 2 trigger for Z1, Z2", basis: "3 h total above the station's 95th percentile" },
    { id: "CWC-PK-01", type: "river", name: "CWC gauge · Puthur Kadavu bend", source: "CWC", zone: "Z6", unit: "m", reading: -0.4, thr: 0, status: "WARNING", lastMin: 2, windowH: 6,
      series: [-1.9, -1.8, -1.6, -1.5, -1.3, -1.1, -1.0, -0.8, -0.7, -0.6, -0.5, -0.4], telemetry: "CWC telemetry (GPRS + satellite)", feeds: "Layer 2 trigger for Z6; evacuation route R2 closure rule", basis: "Warning level = 2018 flood line at this gauge; 0 m = warning level" },
    { id: "NCS-WYD-02", type: "seismic", name: "NCS seismometer · Wayanad", source: "NCS", zone: "Z4", unit: "g", reading: 0.021, thr: 0.01, status: "WARNING", lastMin: 9, windowH: 3,
      series: [0.002, 0.002, 0.003, 0.002, 0.004, 0.009, 0.031, 0.018, 0.012, 0.009, 0.014, 0.021], telemetry: "NCS VSAT", feeds: "Secondary-slide watch on Z4 (ground motion after the main event)", basis: "Peak ground acceleration above the quiet-day noise floor ×5" },
    { id: "GSI-INC-3", type: "tilt", name: "GSI inclinometer · upper slope", source: "GSI", zone: "Z4", unit: "mm/h", reading: 6.2, thr: 2, status: "CRITICAL", lastMin: 6, windowH: 12,
      series: [0.2, 0.3, 0.3, 0.5, 0.8, 1.1, 1.6, 2.4, 3.1, 4.0, 5.3, 6.2], telemetry: "GSI landslide early-warning node (LoRaWAN → GPRS)", feeds: "Layer 2 trigger for Z4; secondary-slide watch", basis: "Displacement rate above the creep threshold for this slope class" },
    { id: "NRSC-EO-P7", type: "eo", name: "Satellite EO change pass · NRSC", source: "NRSC / ISRO", zone: "Z5", unit: "km²", reading: 1.84, thr: 0.5, status: "CRITICAL", lastMin: 26, windowH: 48,
      series: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 1.84], telemetry: "ISRO ground segment → NRSC Bhuvan feed", feeds: "Run-out extent for Z5; imagery pages", basis: "Changed area above 0.5 km² inside a HIGH/CRITICAL cell" }
  ];

  const SENSOR_ALERTS = [
    { id: "SA-118", sensor: "GSI-INC-3", source: "GSI", zone: "Z4", level: "CRITICAL", min: 6, title: "Upper slope still moving — 6.2 mm/h and accelerating", detail: "Inclinometer 3 has tripled its rate in 2 h. Fresh cracks reported by NDRF-04 sit 40 m above the crown.", engine: "Secondary-slide watch on Z4; pull-back broadcast drafted for teams above the 900 m contour." },
    { id: "SA-117", sensor: "NRSC-EO-P7", source: "NRSC / ISRO", zone: "Z5", level: "CRITICAL", min: 26, title: "EO change pass: 1.84 km² altered in Elanad hamlet", detail: "Post-event pass confirms run-out through house rows 1–3. 37 structures inside the changed area.", engine: "Z5 confirmed CRITICAL; Site C imagery published to both consoles." },
    { id: "SA-116", sensor: "CWC-PK-01", source: "CWC", zone: "Z6", level: "WARNING", min: 2, title: "River at −0.4 m and rising ~0.25 m/h", detail: "Debris dam upstream may release. Lower row of Puthur Kadavu is inside the 2018 flood line.", reading: -0.4, engine: "Z6 at MEDIUM; R2 will close automatically at the warning level." },
    { id: "SA-115", sensor: "NCS-WYD-02", source: "NCS", zone: "Z4", level: "WARNING", min: 9, title: "Ground-motion burst 0.031 g at 08:38, aftershocks continuing", detail: "Consistent with mass movement, not tectonic. Correlates with the inclinometer trend.", reading: 0.031, engine: "Feeds the secondary-slide watch; no cell change on its own." },
    { id: "SA-114", sensor: "IMD-MPD-AWS", source: "IMD", zone: "Z4", level: "CRITICAL", min: 47, title: "3 h rainfall 118 mm vs 72 mm threshold — Z4 auto-escalated", detail: "The trigger that flipped the sector into emergency mode. Rate still 41 mm/h.", reading: 41, engine: "Z4 → CRITICAL; Z5 → CRITICAL; emergency mode on; all agencies notified." },
    { id: "SA-113", sensor: "IMD-MPD-AWS", source: "IMD", zone: "Z4", level: "WARNING", min: 9 * 60 + 47, title: "Model flagged Z4 HIGH nine hours before impact", detail: "Rolling 3 h total crossed 72 mm at T−9 h. Static baseline (GSI High, slope 34°, 3 events / 20 y) plus this trigger put the cell at HIGH.", engine: "Z4 → HIGH; pre-assignment plan pushed to registered devices at T−8 h." },
    { id: "SA-112", sensor: "IMD-KLP-ARG", source: "IMD", zone: "Z1", level: "INFO", min: 61, title: "Kalpetta gauge steady at 19 mm/h — staging area below threshold", detail: "Bridgehead cell stays LOW. Access along the NH-766 spur not rain-limited.", engine: "No change." },
    { id: "SA-111", sensor: "CWC-PK-01", source: "CWC", zone: "Z6", level: "INFO", min: 3 * 60 + 12, title: "Gauge telemetry restored after 40 min gap", detail: "GPRS backhaul dropped with the local tower; readings resumed over the CWC satellite path.", engine: "No change.", resolved: true }
  ];

  const RESPONDER_ALERTS = [
    { id: "RA-231", kind: "SOS", node: "VOL-03", zone: "Z5", level: "CRITICAL", min: 2, title: "SOS — responder in danger at the probe line", detail: "Ground moving under the probe line; needs pull-out and a rope team. SOS jumps the queue on every tier.", via: "MESH → LoRa L2 → SAT (64 B, 41 s)" },
    { id: "RA-230", kind: "BACKUP", node: "NDRF-05", zone: "Z5", level: "WARNING", min: 6, title: "Backup requested — medical", detail: "3 casualties extracted at E-3; needs a paramedic and 2 stretchers.", via: "MESH → LoRa L2 → SAT (96 B, 38 s)" },
    { id: "RA-229", kind: "OFFLINE", node: "FIRE-03", zone: "Z2", level: "CRITICAL", min: 14, title: "FIRE-03 and FIRE-04 unreachable — no rung to command", detail: "Last heard 14 min ago. The pair is on the estate knoll with no ESP32 bridge in range; 8 items are queued on their phones (store & forward).", via: "inferred by the backend from missing POS frames" },
    { id: "RA-228", kind: "BACKUP", node: "SDRF-04", zone: "Z6", level: "WARNING", min: 11, title: "Backup requested — manpower", detail: "River rising at the bend; 40 residents still to move from the lower row.", via: "MESH → LoRa L3 → L1 → SAT (102 B, 52 s)" },
    { id: "RA-227", kind: "ZONE", node: "NDRF-06", zone: "Z4", level: "WARNING", min: 17, title: "NDRF-06 entered a CRITICAL cell", detail: "Probe line moved above the 900 m contour into Z4 while the inclinometer is accelerating. App shows the cached Layer 1 warning on-device.", via: "POS frame over MESH → LoRa L2 → SAT" },
    { id: "RA-226", kind: "ACK", node: "SDRF-02", zone: "Z5", level: "INFO", min: 21, title: "Pull-back broadcast BC-001 not acknowledged", detail: "5 of 6 in Cluster B acknowledged over PTT; SDRF-02 has not. Neighbours still see the phone.", via: "ACK frames over MESH; missing ACK inferred" },
    { id: "RA-225", kind: "BATTERY", node: "VOL-01", zone: "Z5", level: "WARNING", min: 33, title: "Battery at 24 %", detail: "Casualty relay E-3. Power bank requested with the next courier to Cluster B.", via: "48 B status frame over MESH → LoRa L2 → SAT" },
    { id: "RA-224", kind: "CHECKIN", node: "POL-03", zone: "Z6", level: "INFO", min: 52, title: "Check-in overdue by 8 min — cleared", detail: "POL-03 was on the river road between L3 and L1 acting as courier; position resumed on arrival.", via: "POS frame via gateway NDRF-03", resolved: true }
  ];

  const IMAGERY_SITES = {
    a: { label: "Site A — Kottamala ridge, slide crown", before: "assets/sat-site-a-before.svg", after: "assets/sat-site-a-after.svg", area: "1.84", structures: 37, confidence: 91 },
    b: { label: "Site B — Puthur Kadavu river bend",     before: "assets/sat-site-b-before.svg", after: "assets/sat-site-b-after.svg", area: "0.92", structures: 12, confidence: 86 },
    c: { label: "Site C — Elanad hamlet run-out",        before: "assets/sat-site-c-before.svg", after: "assets/sat-site-c-after.svg", area: "2.41", structures: 58, confidence: 78 }
  };

  global.RESCUELINK_DATA = {
    MIN, HOUR, UNIT_M, BASE_LAT, BASE_LON,
    INCIDENT, AGENCIES, ROSTER, SOS_TEXT, PENDING_QUEUES, BRIDGES, DROPPED_RELAY,
    ZONES, REQUESTS, SEED_LOG, FIELD_REPORTS, PHOTOS, REGISTERED_FORCES, EVAC_ROUTES, IMAGERY_SITES,
    SENSORS, SENSOR_ALERTS, RESPONDER_ALERTS
  };

})(window);
