# SHARP WebXR AR/VR Viewer — Requirements & Implementation Plan

**Status:** SPEC ONLY — not implemented. Build begins when a headset is available.
**Owner:** (you)
**Scope:** A second, standalone web page that displays SHARP-generated Gaussian
splats inside a VR/AR headset via WebXR, with **AR passthrough** (placing the
reconstruction into the real room through the headset cameras).
**Location of this doc:** `ml-sharp/web/XR_VIEWER_REQUIREMENTS.md`

---

## 1. Background & rationale

The existing desktop viewer (`web/static/index.html` + `app.js`) uses
`@mkkellogg/gaussian-splats-3d@0.4.7`. Research concluded that library is a
**poor fit for headset XR**:

- It **forces `gpuAcceleratedSort = false` whenever WebXR is active** (hard-coded
  in its `Viewer.js`), so XR always falls back to the CPU/WASM sort.
- Its own README states it is "sub-optimal on mobile devices" and shows visible
  artifacts on fast head motion due to CPU sorting.
- Its author explicitly recommends **Spark** (World Labs) as the better option.

**Chosen renderer: Spark** (`@sparkjsdev/spark`, MIT, by World Labs).
Rationale:

- Native WebXR support (`SparkRenderer` handles WebXR; `preUpdate` auto-disables
  during XR to finish frames ASAP).
- Built for mobile/standalone GPUs (explicit Quest 3 performance guidance).
- Format support incl. `.ply`, `.spz`, `.splat`, `.ksplat`, `.sog`, `.rad`.
- Optional LOD (available as a one-line fallback; **disabled by default here**).
- Is the renderer used by Meta's official **Immersive Web SDK (IWSDK)**.

The **desktop viewer is kept unchanged**; the XR experience is a new, separate
page so there is zero regression risk.

---

## 2. Locked decisions (from user)

| Decision | Choice |
|---|---|
| XR stack | **Spark + vanilla Three.js** (matches existing vanilla-JS codebase) |
| Secure context (dev) | **`adb reverse` tunnel** (headset reaches `http://localhost:8000`) |
| Splat count strategy | **Keep full resolution (1,179,648 splats), NO LOD** |
| Build timing | **Plan only now**; implement when a headset is on hand |
| Headset target | **Headset-agnostic** (code to WebXR spec); concrete test device: Meta Quest 3 |
| Room expectation | AR **passthrough overlay** into the physical room (color passthrough) |
| Tethering | Untethered preferred; tethered acceptable |
| Quality | Highest priority |

### Known conflict (accepted risk)
Spark's published guidance is **"Quest 3: ~1 million splats or less."** The test
scene is **1.18M** — slightly over budget. Per the user's decision we ship
**full-res, no LOD**, and rely on the free perf levers in §7. If the framerate is
unacceptable on real hardware, the documented fallbacks are:
1. One-line LOD: `new SplatMesh({ url, lod: true })` (or prebuilt `.RAD`).
2. Optional offline opacity pruning (quality-safe-ish, cuts ~20–40% of splats).

---

## 3. Goals

- **G1** — Load a SHARP `.ply` (produced by this app's inference) inside a headset.
- **G2** — Support **immersive-AR** with color passthrough: splats visibly placed
  in the real room, anchored to a detected surface.
- **G3** — Support **immersive-VR** as a secondary mode (dark environment, grid).
- **G4** — Provide **scale calibration** (SHARP output has no metric scale) and a
  **placement** interaction (hit-test reticle + tap-to-place + optional anchor).
- **G5** — Reuse the existing pipeline: no change to inference or to the desktop
  viewer; the XR page consumes the same `output.ply`.
- **G6** — Serve it so a standalone headset can reach it over a **secure context**
  (WebXR requirement) using `adb reverse`.

## 4. Non-goals

- No neural/quality changes to inference (out of scope; see the speedup work).
- No prebuilt LOD tree / Rust `build-lod` pipeline (deferred; §12).
- No native/OpenXR PCVR app (deferred; §12).
- No SPZ compression step (deferred; §12).
- No multi-user / networking.
- No change to the desktop `index.html` viewer behavior.
- No headset-specific hard-coding beyond WebXR feature detection.

---

## 5. Reference hardware / environment

- **Dev host:** Windows 11, Ryzen 5 5600, 16 GB RAM, AMD RX 6600 XT (irrelevant
  to headset rendering — the headset renders with its own GPU).
- **Server:** FastAPI in `web/server.py`, currently bound to `127.0.0.1:8000`.
- **Test headset (recommended buy):** Meta Quest 3 (color passthrough, standalone,
  WebXR). Quest 3S is a cheaper acceptable alternative.
- **Desktop emulation:** Immersive Web Emulator (browser extension) for testing the
  WebXR flow with no headset.

---

## 6. Architecture

```
┌─ Headset Browser (Quest Browser) ────────────────────────────────────────┐
│  http://localhost:8000/xr?ply=/ply/<job_id>   (localhost = secure ctx)    │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │ xr.html  — importmap(three 0.180, spark 2.3.1, vendored)         │   │
│   │   └─ xr.js — Three.js scene + SparkRenderer + SplatMesh          │   │
│   │        + WebXR AR/VR session, hit-test, anchor, scale slider     │   │
│   └──────────────────────────────────────────────────────────────────┘   │
└───────────────▲───────────────────────────────────────────────────────────┘
                │  adb reverse tcp:8000 tcp:8000  (USB, dev only)
┌───────────────┴───────────────────────────────────────────────────────────┐
│  FastAPI server (host, 127.0.0.1:8000)                                    │
│   GET /xr            -> xr.html                                           │
│   GET /ply/{job_id}  -> web/jobs/{job_id}/output.ply  (disk, restart-safe)│
│   GET /static/*      -> static assets incl. vendor/                       │
│   GET /result/{id}/output.ply -> existing (kept, unchanged)               │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Functional requirements

**FR-1 — XR page exists at `/xr`.** `GET /xr` returns `web/static/xr.html`.
Accepts query params:
- `ply` (required for content): URL-encoded path to a `.ply` (absolute path,
  e.g. `/ply/930593be`, or a full URL). If omitted → page shows "No splat
  specified" and still allows desktop (non-XR) preview.
- `vr` (optional, `1`/`0`): show/hide the "Enter VR" button (AR remains primary).

**FR-2 — Loads a PLY and renders splats.** The page must:
1. `fetch(plyUrl)` the file once as an `ArrayBuffer`.
2. Compute bounds with the **existing** `SHARPPLYLoader` (`static/PLYLoader.js`,
   `computeBounds`) to get `{ center, radius, vertexCount }`.
3. Construct `new SplatMesh({ fileBytes: new Uint8Array(buf) })` (Spark
   auto-detects PLY) — **no `lod`** (per decision).
4. Add the mesh to a wrapping `THREE.Group` (the "rig") used for orientation,
   scale, and placement.
5. Report `vertexCount` in an on-screen stat.

**FR-3 — Orientation correction.** XR cameras are +Y-up; SHARP scenes are
**y-down** (the desktop viewer works around this with `camera.up.set(0,-1,0)`).
Because the XR camera's `up` cannot be changed, the **rig must be rotated**.
Requirement: apply a rig rotation that makes the subject upright in a +Y-up world.
Recommended starting value **`rig.rotation.x = Math.PI`**; must be **verified in
the emulator/headset** and adjusted if the subject appears upside-down or
mirrored. Expose the final transform as a named constant with a comment.

**FR-4 — Scale calibration.** Because SHARP has no metric scale:
- Default rig scale = chosen so the subject's bounding-sphere diameter is
  **≈ 1.0 m** (`scale = 1.0 / (2 * bounds.radius)` adjusted by an on-device UI
  default, e.g. 1.0).
- Provide an in-XR-accessible **scale slider** (DOM overlay or controller-driven)
  ranging ~`0.05×–5×` of the default, updating `rig.scale` live.

**FR-5 — AR passthrough & placement.**
- Enter **`immersive-ar`** with `requiredFeatures: []`,
  `optionalFeatures: ['local-floor','hit-test','anchors','hand-tracking']`.
- Renderer must be created with `alpha: true`; set `setClearColor(0x000000, 0)`
  and `scene.background = null` in AR so passthrough shows through.
- Implement **hit-test**: `session.requestHitTestSource({ space: viewerSpace })`,
  query `frame.getHitTestResults()` each frame, drive a **reticle** (ring mesh)
  to the first hit pose.
- On the session **`select`** event: move the rig to the reticle pose; if
  `anchors` is available, call `hitResult.createAnchor()` and store it; update
  `rig.matrix` from the anchor each frame so it stays put.
- Before placement, the rig may be shown at a default 1 m in front of the viewer.

**FR-6 — VR mode (secondary).** Enter **`immersive-vr`** with
`optionalFeatures: ['local-floor']`. Provide a dark background and a subtle
floor grid for spatial reference. Same rig, scale, and orientation rules.

**FR-7 — Enter/Exit buttons.** A custom **"Enter AR"** button (primary) and
**"Enter VR"** button (if `?vr=1`). Buttons:
- Check `navigator.xr` and `navigator.xr.isSessionSupported('immersive-ar'|'immersive-vr')`
  before showing/enabling; hide/disable if unsupported.
- Require a user gesture (browser requirement).
- Reflect session state (Enter → Exit) via `renderer.xr` `sessionstart`/`sessionend`.

**FR-8 — Render loop via `renderer.setAnimationLoop`.** Required for WebXR. The
XR camera comes from `renderer.xr.getCamera()` while presenting; the page's own
`PerspectiveCamera` is used only in the non-XR desktop preview.

**FR-9 — Restart-safe server endpoint.** `GET /ply/{job_id}` returns
`web/jobs/{job_id}/output.ply` **read from disk** (must NOT depend on the
in-memory `jobs` dict), so previously generated PLYs remain loadable after a
server restart. 404 if missing. `media_type="application/octet-stream"`.
Keep the existing `/result/{job_id}/output.ply` unchanged.

**FR-10 — Desktop entry point.** Add a **"View in XR"** button to the existing
viewer header (`index.html` + `app.js` wiring) that opens
`/xr?ply=<encoded path>` in a new tab. It must use the job's PLY path
(`result.ply_url`, or `/ply/<job_id>` when available). This works for the
emulator and for launching from a headset browser.

**FR-11 — Vendored dependencies.** The XR page must work without third-party CDN
reachability from the headset: `three` and `spark` are **vendored locally** under
`web/static/vendor/` and referenced via a local `importmap` (see §9).

**FR-12 — Graceful failure.** Clear on-screen messages for: no `navigator.xr`,
`immersive-ar` unsupported, PLY fetch failure, and WebGL2 unavailable (Spark
requires WebGL2).

---

## 8. Non-functional requirements

**NFR-1 — Frame rate target.** Aim for the headset's native refresh (Quest 3: up
to 90 Hz) or at least a stable **72 Hz** with full-res splats. Acceptable
degradation is permitted, but must be measured and reported (no silent jank).

**NFR-2 — Performance levers (required, applied by default).**
- `new THREE.WebGLRenderer({ antialias: false, alpha: true })` — MSAA does not
  help splats and costs a lot.
- `renderer.setPixelRatio(1)` in XR (supersampling is expensive for splats).
- `new SparkRenderer({ renderer, maxStdDev: Math.sqrt(5) })` — VR-recommended
  falloff (default is `sqrt(8)`; `sqrt(5)` is visually near-identical, cheaper).

**NFR-3 — No quality loss from the pipeline.** The exact `output.ply` bytes are
rendered; no resampling, no LOD, no color changes.

**NFR-4 — Isolation.** Zero changes to the desktop viewer's rendering path; the
XR page is additive.

**NFR-5 — Load budget.** Full-res PLY is ~66 MB (1.18M splats). Must show a
loading indicator; must not block the UI thread (fetch + parse off the main
thread where practical).

**NFR-6 — Privacy.** Everything stays on `localhost` over `adb reverse`; no
external tunnel by default.

---

## 9. Files to add / modify

### New
| File | Purpose |
|---|---|
| `web/static/xr.html` | XR page: local `importmap`, canvas, overlay UI (scale slider, stats, status, Enter AR/VR buttons). |
| `web/static/xr.js` | The XR app module (scene, Spark, PLY load, orientation, scale, hit-test, anchor, sessions). |
| `web/static/vendor/three.module.js` | Vendored Three.js **0.180.0** build (`build/three.module.js`). |
| `web/static/vendor/three-addons/…` | Only the addons actually used (e.g. `webxr/XRControllerModelFactory.js` if used). Keep minimal. |
| `web/static/vendor/spark.module.js` | Vendored Spark **2.3.1** (`spark.module.js`). |

> Pin versions exactly. Source URLs at time of writing:
> - three: `https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js`
> - three addons: `https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/`
> - spark: `https://sparkjs.dev/releases/spark/2.3.1/spark.module.js`
> Re-verify the latest stable Spark release before vendoring.

### Modified
| File | Change |
|---|---|
| `web/server.py` | Add `GET /xr` (serves `xr.html`); add restart-safe `GET /ply/{job_id}`. Optionally add COOP/COEP headers **only if** a worker-sort requirement surfaces (not expected for Spark). |
| `web/static/index.html` | Add a **"View in XR"** button in `.viewer-actions`. |
| `web/static/app.js` | Wire the button: open `/xr?ply=<encoded>` in a new tab using the loaded job's PLY path. |

### Untouched
- `web/static/PLYLoader.js` — **reused as-is** (bounds computation).
- Desktop rendering path in `app.js` (`initThreeJS`, `displaySplat`, toolbar).
- Inference pipeline, `requirements.txt`, model code.

---

## 10. Interface contracts

### `GET /xr`
- Response: `HTMLResponse` of `web/static/xr.html`.
- Query: `ply` (string, optional), `vr` (`0`|`1`, optional).
- Errors: static page only; content errors are handled client-side.

### `GET /ply/{job_id}`
- `job_id`: `^[0-9a-f]{8}$` (existing id format).
- 200 → `FileResponse(JOBS_DIR/{job_id}/output.ply, media_type="application/octet-stream")`.
- 404 → `job_id` not found on disk or file missing.
- Must be independent of the `jobs` in-memory dict.

### `xr.html` importmap (local)
```html
<script type="importmap">
{ "imports": {
    "three": "/static/vendor/three.module.js",
    "three/addons/": "/static/vendor/three-addons/",
    "@sparkjsdev/spark": "/static/vendor/spark.module.js"
}}
</script>
```

### `xr.js` responsibilities (required behavior)
1. Create renderer (`antialias:false, alpha:true`), `renderer.xr.enabled = true`,
   `setPixelRatio(1)`.
2. Scene + `PerspectiveCamera(60, w/h, 0.01, 1000)` (desktop preview).
3. `const spark = new SparkRenderer({ renderer, maxStdDev: Math.sqrt(5) }); scene.add(spark);`
4. Fetch PLY → `ArrayBuffer` → `SHARPPLYLoader.computeBounds` → build `SplatMesh({ fileBytes })`.
5. Wrap in rig `Group`; set orientation (§FR-3), default scale (§FR-4).
6. `renderer.setAnimationLoop(render)`; in `render`, if presenting, use
   `renderer.xr.getCamera()`, else the page camera.
7. Session management with `optionalFeatures` per §FR-5/FR-6; wire `select` for
   placement; manage reticle visibility.
8. Scale slider (DOM overlay) → `rig.scale`.
9. Status/stat text (loading %, splat count, session type).

---

## 11. Serving & runbook (dev, when headset arrives)

**Prerequisites**
- Meta Quest with **Developer Mode** enabled; USB-C data cable.
- **Android Platform-Tools** (`adb`) installed on the host.
- Server running on the host: `http://127.0.0.1:8000` (unchanged binding).

**Steps**
1. Start the server:
   `& "C:\EXtreme Files\Coding\ML sharp\sharp-env\Scripts\python.exe" "C:\EXtreme Files\Coding\ML sharp\ml-sharp\web\server.py"`
2. Connect the headset via USB; accept the "Allow USB debugging" prompt.
3. `adb devices` → confirm the headset is listed as `device`.
4. `adb reverse tcp:8000 tcp:8000` (headset `localhost:8000` → host `:8000`).
5. In **Quest Browser**, open:
   `http://localhost:8000/xr?ply=/ply/<job_id>`
   (`localhost` is a secure context → WebXR allowed).
6. Tap **Enter AR** → grant → passthrough session; aim at a surface; tap to place;
   adjust the scale slider.
7. To exit: **Exit** button or the system menu.

**Notes**
- `adb reverse` is **dev-only** and requires the cable to remain connected →
  effectively tethered while testing. Untethered (LAN HTTPS) is deferred (§12).
- If `immersive-ar` is not offered, confirm the device supports color passthrough
  and that the URL is a secure context.

**Host/desktop verification without a headset**
- Load the **Immersive Web Emulator** extension; open `/xr?ply=…`; use it to
  enter AR/VR and verify: load, orientation, scale, reticle, placement, no console errors.

---

## 12. Deferred / future work

- **Prebuilt LOD** (`.RAD` via Spark `build-lod`, needs Node + Rust) for smooth
  scaling of large scenes.
- **LOD-on-demand** runtime fallback trigger (measure FPS, flip `lod:true`).
- **SPZ compression** (`npm run assets:compress <ply>`) to shrink the 66 MB PLY
  for faster headset loads.
- **Untethered serving**: HTTPS with a trusted cert (or reverse proxy) bound to
  `0.0.0.0`, so no USB is needed.
- **Optional offline opacity pruning** to reduce splat count with minimal visual impact.
- **PCVR/OpenXR native path** for maximum quality on the RX 6600 XT.
- **Anchor persistence** across sessions and multi-scene layout.

---

## 13. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 1.18M splats > Quest 3 ~1M budget | Frame drops | NFR-2 levers; `lod:true` one-liner; opacity pruning |
| SHARP single-image reconstruction is view-limited | Thin/sparse from unseen angles | Documented expectation, not a bug; keep viewer close to front view |
| No metric scale | Wrong apparent size | Scale slider + default ~1 m; meh/anchored placement |
| `adb reverse` requires cable | Not truly untethered | Documented; LAN-HTTPS deferred (§12) |
| WebXR needs secure context | Sessions won't start | `localhost` via `adb reverse`; verify `isSessionSupported` |
| Spark/three version drift | API mismatch | Pin exact versions; vendor locally |
| PLY 66 MB load time | Slow start | Loading UI; SPZ compression deferred |

---

## 14. Acceptance criteria (definition of done)

- [ ] `GET /xr` serves the XR page; `GET /ply/{job_id}` serves on-disk PLYs after a
      server restart.
- [ ] Page loads a full-res SHARP PLY (≈1.18M splats) and shows the splat count.
- [ ] Vendor assets only; no runtime CDN dependency for the XR page.
- [ ] On the emulator (and later a Quest 3): **Enter AR** starts `immersive-ar`
      with passthrough; a reticle tracks surfaces; **tap places** the subject;
      it can be anchored.
- [ ] Subject is **upright** (orientation verified) and **scalable** via slider.
- [ ] **Enter VR** works (dark env + grid) when `?vr=1`.
- [ ] NFR-2 perf levers are active; frame rate is **measured and reported** on
      real hardware.
- [ ] Desktop viewer behavior and inference are unchanged (regression-free).
- [ ] Graceful messages for unsupported XR / WebGL2 / fetch failures.

---

## 15. Testing plan

1. **Static/mock:** open `/xr` on the host (no XR) → preview renders the splat
   with the page camera; orientation/scale correct.
2. **Emulator:** Immersive Web Emulator → AR and VR sessions; verify reticle,
   placement, anchoring, scale, exit/re-enter.
3. **Server:** restart server → old job still loadable via `/ply/{job_id}`.
4. **pc_compile / lint:** `python -m py_compile web/server.py`; no JS build step.
5. **Real hardware (when available):** `adb reverse` runbook (§11); measure FPS
   for full-res; if unacceptable, evaluate `lod:true` / pruning and record results.

---

## 16. Reference links

- Spark — home: https://sparkjs.dev/
- Spark — performance tuning (Quest 3 budget, `maxStdDev`, antialias): https://sparkjs.dev/docs/performance
- Spark — `SparkRenderer` (WebXR `preUpdate`): https://sparkjs.dev/docs/spark-renderer/
- Spark — `SplatMesh` / `fileBytes`: https://sparkjs.dev/docs/splat-mesh/
- Spark — quick start / LOD: https://sparkjs.dev/docs/spark-2.0-quick-start
- Spark — GitHub: https://github.com/sparkjsdev/spark
- mkkellogg WebXR limitation/issue: https://github.com/mkkellogg/GaussianSplats3D/issues/65
- Meta Immersive Web SDK (IWSDK): https://developers.meta.com/vr/develop/iwsdk
- IWSDK environment raycast (hit-test reference): https://developers.meta.com/vr/documentation/iwsdk/examples/
- Immersive Web Emulator (desktop WebXR testing): browser extension (Immersive Web WG)

---

## 17. Open questions

- Final rig orientation constant (§FR-3) — confirm empirically (`rotation.x=π`
  vs alternatives) on the emulator, then on hardware.
- Default AR scale factor (§FR-4) — pick after first real-hardware look.
- Whether to expose `lod` as a **runtime toggle** in the XR overlay (recommended,
  given the over-budget splat count) vs a one-time code change.
- Quest 3 vs Quest 3S as the actual purchase (both acceptable; 3 has better
  optics/passthrough).
