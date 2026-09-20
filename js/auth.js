/* ============================================================
   RescueLINK — Auth & shared session/UI helpers
   sessionStorage only — no backend, no localStorage.

   In the real system identity is provisioned before deployment
   (QR / pre-registration at mission briefing) so no live login is
   ever required in the field. This demo login stands in for the
   dashboard's own sign-in at the EOC, which does have connectivity.
   ============================================================ */

(function (global) {
  "use strict";

  const ACCOUNTS = {
    "coordinator@rescuelink.gov.in": {
      password: "Rescue@2026",
      role: "control",
      label: "Coordinator — District EOC",
      name: "R. K. Sharma"
    },
    "viewer@rescuelink.gov.in": {
      password: "Observe@2026",
      role: "observer",
      label: "Viewer — State EOC",
      name: "Dr. A. Krishnan"
    }
  };

  function login(email, password) {
    const acct = ACCOUNTS[(email || "").trim().toLowerCase()];
    if (!acct || acct.password !== password) {
      return { ok: false, error: "Invalid email or password. Check the demo access panel below." };
    }
    sessionStorage.setItem("sm_role", acct.role);
    sessionStorage.setItem("sm_email", email.trim().toLowerCase());
    sessionStorage.setItem("sm_name", acct.name);
    return { ok: true, role: acct.role };
  }

  function logout() {
    ["sm_role", "sm_email", "sm_name", EMERGENCY_KEY, EMERGENCY_START_KEY].forEach(k => sessionStorage.removeItem(k));
    window.location.href = "index.html";
  }

  function getRole() { return sessionStorage.getItem("sm_role"); }
  function getName() { return sessionStorage.getItem("sm_name") || "Operator"; }

  function requireRole(expected) {
    const role = getRole();
    if (!role) { window.location.href = "index.html"; return null; }
    if (expected && role !== expected) {
      window.location.href = role === "control" ? "control.html" : "view.html";
      return null;
    }
    return role;
  }

  function isControl() { return getRole() === "control"; }

  // ---------------- Theme ----------------
  // The page stamps data-theme before first paint (inline script in <head>);
  // this just flips it and remembers the choice for this browser.
  const THEME_KEY = "rl_theme";
  function getTheme() { return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* private mode — fine, just not remembered */ }
    document.querySelectorAll(".theme-toggle").forEach(paintToggle);
    document.dispatchEvent(new CustomEvent("rl:theme-changed", { detail: { theme: t } }));
  }
  function paintToggle(btn) {
    const dark = getTheme() === "dark";
    btn.innerHTML = '<span class="ic" aria-hidden="true">' + (dark ? "☀" : "☾") + "</span>" + (dark ? "Light" : "Dark");
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
  }
  function themeToggleHTML(id) { return '<button type="button" class="theme-toggle" id="' + (id || "theme-toggle") + '"></button>'; }
  function bindThemeToggle(btn) {
    if (!btn) return; paintToggle(btn);
    btn.addEventListener("click", () => setTheme(getTheme() === "dark" ? "light" : "dark"));
  }

  // ---------------- Toasts ----------------
  function ensureToastStack() {
    let stack = document.getElementById("toast-stack");
    if (!stack) { stack = document.createElement("div"); stack.id = "toast-stack"; document.body.appendChild(stack); }
    return stack;
  }

  function toast(message, opts) {
    opts = opts || {};
    const stack = ensureToastStack();
    const el = document.createElement("div");
    el.className = "toast" + (opts.type ? " " + opts.type : "");
    el.innerHTML = (opts.title ? "<strong>" + opts.title + "</strong>" : "") + message;
    stack.appendChild(el);
    while (stack.children.length > 4) stack.firstChild.remove();
    setTimeout(() => { el.classList.add("hide"); setTimeout(() => el.remove(), 220); }, opts.duration || 4200);
  }

  function denyMutation(what) {
    toast("403 — Viewer role cannot " + (what || "act") + ". Enforced server-side, not just hidden in the UI.", { type: "error", title: "Action blocked" });
  }

  // ---------------- Modal ----------------
  function openModal({ title, bodyHTML, footerButtons, wide }) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal" + (wide ? " wide" : "");
    modal.innerHTML =
      '<div class="modal-header"><span>' + title + '</span>' +
      '<button class="modal-close" aria-label="Close">&times;</button></div>' +
      '<div class="modal-body">' + bodyHTML + '</div>' +
      '<div class="modal-footer"></div>';
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close() { backdrop.remove(); }
    modal.querySelector(".modal-close").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

    const footer = modal.querySelector(".modal-footer");
    (footerButtons || []).forEach(btn => {
      const b = document.createElement("button");
      b.className = btn.className || "btn-secondary";
      b.textContent = btn.label;
      b.addEventListener("click", () => {
        const result = btn.onClick ? btn.onClick(modal) : undefined;
        if (result !== false) close();
      });
      footer.appendChild(b);
    });
    return { close, modal };
  }

  // ---------------- Photo viewer ----------------
  // A photo that only partly arrived is shown exactly as far as it got:
  // chunks are sequential, so the received fraction is the top of the image.
  function photoStatusChip(ph) {
    return ph.status === "delivered" ? '<span class="chip chip-ok">DELIVERED</span>'
         : ph.status === "partial" ? '<span class="chip chip-p1">PARTIAL · ' + ph.received + "/" + ph.chunks + "</span>"
         : '<span class="chip chip-p0">PENDING · 0/' + ph.chunks + "</span>";
  }
  function photoFigure(ph, cls) {
    const frac = ph.chunks ? ph.received / ph.chunks : 1;
    return '<div class="photo-frame ' + (cls || "") + " " + ph.status + '">' +
      (ph.status === "pending" ? '<div class="photo-pending">No chunks received yet</div>'
        : '<img src="' + ph.src + '" alt="' + ph.caption + '" style="clip-path:inset(0 0 ' + Math.round((1 - frac) * 100) + '% 0)">') +
      (ph.status === "partial" ? '<div class="photo-cut" style="top:' + Math.round(frac * 100) + '%"><span>resumes at chunk ' + (ph.received + 1) + "</span></div>" : "") +
      '</div>';
  }
  function openPhotoViewer(ph, ctx) {
    ctx = ctx || {};
    const kb = (ph.bytes / 1024).toFixed(1) + " KB";
    const bodyHTML =
      photoFigure(ph, "large") +
      '<div class="photo-meta">' +
        '<div class="pm-cap">' + ph.caption + "</div>" +
        '<table class="kv-table">' +
        '<tr><td class="k">From</td><td><span class="mono">' + ph.from + "</span>" + (ctx.agency ? " · " + ctx.agency : "") + (ctx.group ? " · " + ctx.group : "") + "</td></tr>" +
        '<tr><td class="k">Cell</td><td>' + ph.zone + (ctx.zoneName ? " · " + ctx.zoneName : "") + "</td></tr>" +
        '<tr><td class="k">Taken</td><td>' + ph.ageMin + " min ago</td></tr>" +
        '<tr><td class="k">Status</td><td>' + photoStatusChip(ph) + "</td></tr>" +
        '<tr><td class="k">Transfer</td><td>WebP ' + kb + " · " + ph.chunks + " chunks × ~1 KB · <span class=\"prog\"><i style=\"width:" + Math.round(ph.received / ph.chunks * 100) + "%\"></i></span>" + ph.received + "/" + ph.chunks + "</td></tr>" +
        '<tr><td class="k">Path</td><td>' + ph.via + "</td></tr>" +
        (ph.report ? '<tr><td class="k">Report</td><td><span class="mono">' + ph.report + "</span></td></tr>" : "") +
        "</table>" +
        (ph.credit ? '<div class="photo-credit">Photo: <a href="' + ph.credit.page + '" target="_blank" rel="noopener">' + ph.credit.title + '</a> — ' + ph.credit.artist + " · " + ph.credit.license + " via Wikimedia Commons. Real photograph standing in for a responder upload; the caption is part of the demo scenario.</div>" : "") +
        (ph.status === "pending" ? '<div class="sim-label" style="margin:10px 0 0">Text and GPS from this responder went through; the photo waits for a rung that can carry 41 KB — displace them to a cluster with internet, or wait for a courier.</div>' : "") +
      "</div>";
    return openModal({ title: ph.id + " — photo from " + ph.from, bodyHTML, wide: true, footerButtons: [{ label: "Close", className: "btn-secondary" }] });
  }

  // ---------------- Emergency mode (shared via sessionStorage) ----------------
  // Flipped automatically by the alert engine when any risk cell reaches
  // CRITICAL; the coordinator can still override per cell.
  const EMERGENCY_KEY = "sm_emergency";
  const EMERGENCY_START_KEY = "sm_emergency_start";
  const INCIDENT_LABEL = "Landslide — Kottamala ridge, Wayanad";

  function isEmergencyActive() { return sessionStorage.getItem(EMERGENCY_KEY) === "1"; }

  function setEmergency(active, startAt) {
    if (active) {
      sessionStorage.setItem(EMERGENCY_KEY, "1");
      if (startAt || !sessionStorage.getItem(EMERGENCY_START_KEY)) {
        sessionStorage.setItem(EMERGENCY_START_KEY, String(startAt || Date.now()));
      }
    } else {
      sessionStorage.setItem(EMERGENCY_KEY, "0");
      sessionStorage.removeItem(EMERGENCY_START_KEY);
    }
    applyEmergencyUI();
  }

  function getEmergencyStart() {
    const v = sessionStorage.getItem(EMERGENCY_START_KEY);
    return v ? parseInt(v, 10) : null;
  }

  function fmtElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
  }

  let bannerTimer = null;

  function applyEmergencyUI() {
    const active = isEmergencyActive();
    document.body.classList.toggle("emergency-active", active);
    const banner = document.getElementById("emergency-banner");
    if (banner) banner.classList.toggle("show", active);
    if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; }
    if (active && banner) {
      const tick = () => {
        const start = getEmergencyStart() || Date.now();
        banner.innerHTML = '<span class="eb-tag">Emergency mode</span>' + INCIDENT_LABEL +
          ' — alert engine: Z4 CRITICAL (3 h rainfall 118 mm vs 72 mm threshold) · T+' + fmtElapsed(Date.now() - start) + ' since impact';
      };
      tick();
      bannerTimer = setInterval(tick, 1000);
    }
    document.dispatchEvent(new CustomEvent("sm:emergency-changed", { detail: { active } }));
  }

  // ---------------- Shared header injection ----------------
  function renderHeader() {
    const role = getRole();
    const headerEl = document.getElementById("app-header");
    if (!headerEl) return;
    const isCtrl = role === "control";
    headerEl.innerHTML =
      '<div class="wordmark">' +
        '<svg class="crest-svg" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 22c6-9 20-9 26 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="6" cy="20" r="2.4" fill="currentColor"/><circle cx="16" cy="15.4" r="2.4" fill="currentColor"/><circle cx="26" cy="20" r="2.4" fill="currentColor"/><path d="M6 20l10-4.6L26 20" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".6"/></svg>' +
        '<span>RescueLINK<br><small>CROSS-AGENCY COORDINATION · OFFLINE MESH</small></span></div>' +
      '<div class="header-center" id="header-center"></div>' +
      '<div class="header-right">' +
        '<span class="role-badge' + (isCtrl ? '' : ' observer') + '">' + (isCtrl ? 'COORDINATOR — CAN ACT' : 'VIEWER — READ ONLY') + '</span>' +
        '<span class="text-dim" style="font-size:12px;">' + getName() + '</span>' +
        themeToggleHTML("theme-toggle") +
        '<button id="logout-btn" class="btn-ghost btn-sm">Logout</button>' +
      '</div>';
    document.getElementById("logout-btn").addEventListener("click", logout);
    bindThemeToggle(document.getElementById("theme-toggle"));
    applyEmergencyUI();
  }

  function renderNav(items, activeHref) {
    const navEl = document.getElementById("main-nav");
    if (!navEl) return;
    navEl.innerHTML = items.map(it =>
      '<a href="' + it.href + '"' + (it.id ? ' id="' + it.id + '"' : '') +
      (it.href === activeHref ? ' class="active"' : '') + '>' + it.label + '</a>'
    ).join("");
  }

  const NAV = {
    control: [
      { href: "control.html", label: "Operations Map" },
      { href: "control-alerts.html", label: "Alerts" },
      { href: "control-preassign.html", label: "Pre-assignment & Routes" },
      { href: "control-reports.html", label: "Field Reports" },
      { href: "control-analyzer.html", label: "Satellite Imagery" }
    ],
    observer: [
      { href: "view.html", label: "Operations Map" },
      { href: "view-alerts.html", label: "Alerts" },
      { href: "view-reports.html", label: "Field Reports" },
      { href: "view-analyzer.html", label: "Satellite Imagery" }
    ]
  };

  global.RLAuth = {
    login, logout, getRole, getName, requireRole, isControl,
    toast, denyMutation, openModal, openPhotoViewer, photoFigure, photoStatusChip,
    getTheme, setTheme, themeToggleHTML, bindThemeToggle,
    isEmergencyActive, setEmergency, getEmergencyStart, fmtElapsed,
    renderHeader, renderNav, ACCOUNTS, NAV
  };

})(window);
