/* ============================================================
   RescueLINK — Viewer dashboard (view.html)
   Same live picture as the coordinator: positions, task states,
   alert status, transport ladder. Every control stays visible but
   returns 403 — authority is enforced server-side, not by hiding UI.
   ============================================================ */

(function () {
  "use strict";

  if (!RLAuth.requireRole("observer")) return;
  RLAuth.renderHeader();
  RLAuth.renderNav(RLAuth.NAV.observer, "view.html");

  document.getElementById("header-center").innerHTML =
    '<div class="clocks">' +
      '<div class="clock"><div class="v tabular" id="clk-elapsed">T+00:00:00</div><div class="l">since impact</div></div>' +
    '</div>' +
    '<div class="uplink sat" id="uplink" title="How the command centre is currently reached from the field"><span class="dot"></span><span id="uplink-txt"></span></div>';

  RescueLINK.mount({ control: false });
})();
