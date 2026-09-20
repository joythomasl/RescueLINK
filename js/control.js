/* ============================================================
   RescueLINK — Coordinator dashboard (control.html)
   Full rights: assign, displace, override, dispatch, broadcast.
   ============================================================ */

(function () {
  "use strict";

  if (!RLAuth.requireRole("control")) return;
  RLAuth.renderHeader();
  RLAuth.renderNav(RLAuth.NAV.control, "control.html");

  // Elapsed-time clock and the command-link badge live in the header.
  document.getElementById("header-center").innerHTML =
    '<div class="clocks">' +
      '<div class="clock"><div class="v tabular" id="clk-elapsed">T+00:00:00</div><div class="l">since impact</div></div>' +
    '</div>' +
    '<div class="uplink sat" id="uplink" title="How the command centre is currently reached from the field"><span class="dot"></span><span id="uplink-txt"></span></div>';

  RescueLINK.mount({ control: true });
})();
