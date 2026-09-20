# RescueLINK

Cross-agency coordination console for the first hours after a disaster, when cellular and radio infrastructure is down. Built for Smart India Hackathon 2026 (SIH26206, Disaster Management) by Team ANTIMATTER.

**Live demo:** https://joythomasl.github.io/RescueLINK/

## What it shows

- **Four-tier offline network** simulated on a satellite map of a sector in Wayanad: Wi-Fi Aware phone clusters, ESP32 + LoRa bridges between them, a satellite modem at staging (340 B frames), and adaptive transition — any phone that regains internet becomes a gateway and queued traffic flushes.
- **Mesh operations map** — zoom into clusters, coverage gaps that close when a responder is sent to high ground, dropped relays, task assignment and displacement, targeted PTT.
- **Explainable two-layer alert engine** — static baseline (GSI / DEM / history) plus live triggers (IMD rainfall, CWC gauge, seismic, inclinometer, satellite EO), with coordinator override.
- **SOS and backup dispatch**, groups view, field reports and photos (chunked over the mesh, partial transfers shown as far as they got), emergency broadcast with LoRa / satellite byte caps.
- **Alerts page** for sensor alerts and responder alerts, **pre-assignment & evacuation routes**, **satellite imagery** before/after.
- **Two roles enforced server-side in spirit**: Coordinator can act; Viewer sees everything and every action returns 403.

## Demo access

| Role | Email | Password |
|---|---|---|
| Coordinator (District EOC) | `coordinator@rescuelink.gov.in` | `Rescue@2026` |
| Viewer (State EOC) | `viewer@rescuelink.gov.in` | `Observe@2026` |

## Run locally

It is a static site — no build step. Open `index.html` in a browser, or serve the folder:

```
python -m http.server 8000
```

then visit http://localhost:8000/. Satellite tiles need internet; without it the map switches to the drawn terrain automatically.

## Hosting

Pushing to `main` runs `.github/workflows/pages.yml`, which publishes the repository root to GitHub Pages. If the first run is rejected because Pages is not enabled, open **Settings → Pages**, set *Source* to **GitHub Actions**, and re-run the workflow.

## Notes

- All incident data, positions and names are fictional. The basemap is real imagery (Esri World Imagery); the scenario drawn on it is simulated.
- Field photos are real, openly licensed photographs standing in for responder uploads — see `assets/field/CREDITS.md` for attribution (CC0, CC BY-SA 4.0, GODL-India).
