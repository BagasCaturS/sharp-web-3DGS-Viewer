"""SHARP Web Interface - FastAPI Backend.

Run: python server.py
Serves at http://localhost:8000
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

# ─── Frozen (PyInstaller) vs. source-tree layout ──────────────────────────────
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    APP_DIR = Path(sys.executable).parent
else:
    BUNDLE_DIR = Path(__file__).parent
    APP_DIR = BUNDLE_DIR

# ─── CPU / Torch environment tuning (must be set BEFORE importing torch) ───────
_NUM_THREADS = int(os.environ.get("SHARP_NUM_THREADS") or (os.cpu_count() or 1))
os.environ.setdefault("OMP_NUM_THREADS", str(_NUM_THREADS))
os.environ.setdefault("MKL_NUM_THREADS", str(_NUM_THREADS))
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
# Persist Inductor's compiled artifacts across restarts so lazy compile is cheap.
if FROZEN:
    _INDUCTOR_DIR = (
        Path(os.environ.get("LOCALAPPDATA") or APP_DIR) / "ml-sharp" / ".inductor_cache"
    )
    _INDUCTOR_DIR.mkdir(parents=True, exist_ok=True)
else:
    _INDUCTOR_DIR = BUNDLE_DIR / ".inductor_cache"
os.environ.setdefault("TORCHINDUCTOR_CACHE_DIR", str(_INDUCTOR_DIR))

import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# Add SHARP to path (source runs only; frozen builds bundle the package)
if not FROZEN:
    SHARP_SRC = BUNDLE_DIR.parent / "src"
    if SHARP_SRC.exists():
        sys.path.insert(0, str(SHARP_SRC))

from sharp.cli.predict import DEFAULT_MODEL_URL, INTERNAL_SHAPE, predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils import io
from sharp.utils.gaussians import save_ply

# ─── Configuration ────────────────────────────────────────────────────────────
JOBS_DIR = APP_DIR / "jobs"
JOBS_DIR.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _save_limited(src, dest: Path, limit: int = MAX_UPLOAD_BYTES) -> None:
    """Copy an upload stream to disk, rejecting anything over ``limit`` bytes."""
    try:
        total = 0
        with dest.open("wb") as out:
            while chunk := src.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise HTTPException(413, "File too large (max 50 MB)")
                out.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        raise

# ─── Global State ─────────────────────────────────────────────────────────────
jobs: dict[str, dict[str, Any]] = {}
predictor = None
device = None
model_loaded = False
_compiled = False
_compile_lock = threading.Lock()
_profile_state: dict[str, list[float]] = {}
_profile_hooks_installed = False
_job_sem = threading.Semaphore(1)  # shortcut: single GPU/CPU job only; upgrade to a queue if needed

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger(__name__)


def _env_flag(name: str, default: str = "0") -> bool:
    """Parse a boolean-ish environment flag."""
    return os.environ.get(name, default).strip().lower() not in ("0", "", "false", "no", "off")


# ─── Performance flags ────────────────────────────────────────────────────────
ENABLE_COMPILE = _env_flag("SHARP_COMPILE", "0")
COMPILE_MODE = os.environ.get("SHARP_COMPILE_MODE", "default")
ENABLE_WARMUP = _env_flag("SHARP_WARMUP", "0")
ENABLE_PROFILE = _env_flag("SHARP_PROFILE", "0")


def configure_torch() -> None:
    """Apply CPU threading / numerical tuning after torch is imported."""
    try:
        torch.set_num_threads(_NUM_THREADS)
    except Exception:  # pragma: no cover - best effort
        LOGGER.exception("Could not set torch threads")
    try:
        torch.set_num_interop_threads(1)
    except Exception:  # already initialised or unsupported
        pass
    if hasattr(torch, "set_flush_denormal"):
        try:
            torch.set_flush_denormal(True)
        except Exception:  # pragma: no cover
            pass
    LOGGER.info(
        "Torch config: threads=%d compile=%s mode=%s warmup=%s profile=%s",
        _NUM_THREADS, ENABLE_COMPILE, COMPILE_MODE, ENABLE_WARMUP, ENABLE_PROFILE,
    )


configure_torch()

# ─── FastAPI App ──────────────────────────────────────────────────────────────
app = FastAPI(title="SHARP Web Interface", version="1.0.0")

# shortcut: no CORS needed for same-origin localhost app; wildcard+credentials is unnecessary exposure.

# Serve static files
STATIC_DIR = BUNDLE_DIR / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ─── Model Loading ────────────────────────────────────────────────────────────
def load_model() -> None:
    """Load SHARP model checkpoint."""
    global predictor, device, model_loaded

    if torch.cuda.is_available():
        device = "cuda"
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"

    LOGGER.info("Using device: %s", device)

    # Prefer a locally bundled checkpoint; fall back to download.
    ckpt_name = DEFAULT_MODEL_URL.rsplit("/", 1)[-1]
    local_ckpt = next(
        (
            p
            for p in (APP_DIR / "model" / ckpt_name, BUNDLE_DIR / "model" / ckpt_name)
            if p.is_file()
        ),
        None,
    )
    if local_ckpt is not None:
        LOGGER.info("Loading bundled model checkpoint from %s", local_ckpt)
        state_dict = torch.load(local_ckpt, map_location="cpu", weights_only=True)
    else:
        LOGGER.info("Downloading model from %s", DEFAULT_MODEL_URL)
        state_dict = torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=True)

    predictor = create_predictor(PredictorParams())
    predictor.load_state_dict(state_dict)
    predictor.eval()
    predictor.to(device)

    if ENABLE_PROFILE:
        _install_profile_hooks()

    if ENABLE_WARMUP:
        _warmup()

    model_loaded = True
    LOGGER.info("Model loaded successfully")


def _warmup() -> None:
    """Run one dummy forward to prime oneDNN kernels (not compilation)."""
    if predictor is None:
        return
    try:
        t0 = time.perf_counter()
        dummy = torch.zeros(1, 3, INTERNAL_SHAPE[1], INTERNAL_SHAPE[0], device=device)
        with torch.inference_mode():
            predictor(dummy, torch.tensor([1.0], device=device))
        LOGGER.info("Warmup forward completed in %.1fs", time.perf_counter() - t0)
    except Exception:  # pragma: no cover - warmup is best effort
        LOGGER.exception("Warmup failed (continuing without it)")


def maybe_compile() -> None:
    """Lazily torch.compile the two ViT encoders on the first job.

    Scope is intentionally limited to the encoders (the dominant cost) to keep
    memory/compile-time low. Falls back to eager on any failure.
    """
    global _compiled
    if not ENABLE_COMPILE or _compiled or predictor is None:
        return
    with _compile_lock:
        if _compiled:
            return
        encoder = predictor.monodepth_model.monodepth_predictor.encoder
        orig_patch = encoder.patch_encoder
        orig_image = encoder.image_encoder
        t0 = time.perf_counter()
        try:
            LOGGER.info("Applying torch.compile (mode=%s) to ViT encoders...", COMPILE_MODE)
            encoder.patch_encoder = torch.compile(orig_patch, mode=COMPILE_MODE, dynamic=False)
            encoder.image_encoder = torch.compile(orig_image, mode=COMPILE_MODE, dynamic=False)
            dummy = torch.zeros(1, 3, INTERNAL_SHAPE[1], INTERNAL_SHAPE[0], device=device)
            with torch.inference_mode():
                predictor(dummy, torch.tensor([1.0], device=device))
            LOGGER.info("Encoders compiled in %.1fs", time.perf_counter() - t0)
        except Exception:
            encoder.patch_encoder = orig_patch
            encoder.image_encoder = orig_image
            LOGGER.exception("torch.compile failed; falling back to eager")
        finally:
            _compiled = True


def _install_profile_hooks() -> None:
    """Attach timing hooks to the top-level predictor submodules."""
    global _profile_hooks_installed
    if _profile_hooks_installed or predictor is None:
        return
    targets = {
        "monodepth": predictor.monodepth_model,
        "initializer": predictor.init_model,
        "gaussian_decoder": predictor.feature_model,
        "prediction_head": predictor.prediction_head,
        "composer": predictor.gaussian_composer,
    }

    def make_hooks(name: str):
        def pre_hook(module, inputs):
            module._sharp_t0 = time.perf_counter()

        def post_hook(module, inputs, output):
            t0 = getattr(module, "_sharp_t0", None)
            if t0 is None:
                return
            acc = _profile_state.setdefault(name, [0.0, 0.0])
            acc[0] += time.perf_counter() - t0
            acc[1] += 1

        return pre_hook, post_hook

    for name, module in targets.items():
        if module is not None:
            pre, post = make_hooks(name)
            module.register_forward_pre_hook(pre)
            module.register_forward_hook(post)
    _profile_hooks_installed = True


def _reset_profile() -> None:
    for key in list(_profile_state):
        _profile_state[key] = [0.0, 0.0]


def _log_profile(job_id: str) -> None:
    if not ENABLE_PROFILE or not _profile_state:
        return
    total = sum(v[0] for v in _profile_state.values())
    parts = ", ".join(
        f"{k}={v[0]:.2f}s(x{int(v[1])})" for k, v in _profile_state.items()
    )
    LOGGER.info("[%s] profile: hooked_total=%.2fs | %s", job_id, total, parts)


# ─── Prediction Logic ─────────────────────────────────────────────────────────
def process_job(job_id: str, image_path: Path, output_dir: Path) -> None:
    """Background job processing (one inference at a time)."""
    with _job_sem:
        job = jobs.get(job_id)
        if not job:
            return

        def update_progress(pct: int, msg: str) -> None:
            job["progress"] = pct
            job["status"] = msg
            LOGGER.info("[%s] %d%% - %s", job_id, pct, msg)

        try:
            job["status"] = "Loading image..."
            job["progress"] = 5

            # Load image
            image, _, f_px = io.load_rgb(image_path)
            height, width = image.shape[:2]

            # Lazily optimize the model on the first job (one-time cost).
            if ENABLE_COMPILE and not _compiled:
                update_progress(15, "Optimizing model (first run)...")
                maybe_compile()

            if ENABLE_PROFILE:
                _reset_profile()

            # Run prediction
            gaussians = predict_image(predictor, image, f_px, torch.device(device), update_progress)

            if ENABLE_PROFILE:
                _log_profile(job_id)

            # Save PLY
            ply_path = output_dir / "output.ply"
            save_ply(gaussians, f_px, (height, width), ply_path)

            # Prepare metadata for viewer
            job["result"] = {
                "ply_url": f"/result/{job_id}/output.ply",
                "meta": {
                    "focal_length_px": f_px,
                    "width": width,
                    "height": height,
                    "num_gaussians": gaussians.mean_vectors.shape[1],
                },
            }
            job["progress"] = 100
            job["status"] = "Complete"
            job["done"] = True

        except Exception as e:
            LOGGER.exception("Job %s failed", job_id)
            (output_dir / "output.ply").unlink(missing_ok=True)
            job["progress"] = 100
            job["status"] = f"Error: {e}"
            job["error"] = str(e)
            job["done"] = True


# ─── API Endpoints ────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    """Serve the main page."""
    html_path = STATIC_DIR / "index.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@app.post("/predict")
def predict(file: UploadFile = File(...)) -> JSONResponse:
    """Start a new prediction job."""
    if not model_loaded:
        raise HTTPException(503, "Model not loaded yet")

    # Validate file type
    allowed_ext = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".heic"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed_ext:
        raise HTTPException(400, f"Unsupported file type: {ext}")
    if (file.size or 0) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File too large (max 50 MB)")

    # shortcut: single-user local app; drop only completed jobs to avoid deleting in-progress ones
    for jid in list(jobs.keys()):
        j = jobs.get(jid)
        if j and not j.get("done"):
            continue
        try:
            old = JOBS_DIR / jid
            if old.exists():
                shutil.rmtree(old, ignore_errors=True)
        except Exception:
            pass
        jobs.pop(jid, None)

    # Create job
    job_id = str(uuid.uuid4())[:8]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Save uploaded file
    input_path = job_dir / f"input{ext}"
    try:
        _save_limited(file.file, input_path)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    # Initialize job state
    jobs[job_id] = {
        "id": job_id,
        "progress": 0,
        "status": "Queued",
        "done": False,
        "error": None,
        "result": None,
        "input_path": str(input_path),
        "output_dir": str(job_dir),
    }

    # Start background processing
    thread = threading.Thread(target=process_job, args=(job_id, input_path, job_dir), daemon=True)
    thread.start()

    return JSONResponse({"job_id": job_id, "status": "started"})


@app.get("/status/{job_id}")
async def status(job_id: str) -> JSONResponse:
    """Get job progress."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    return JSONResponse({
        "job_id": job_id,
        "progress": job["progress"],
        "status": job["status"],
        "done": job["done"],
        "error": job["error"],
        "result": job["result"],
    })


@app.get("/result/{job_id}/output.ply")
async def download_ply(job_id: str) -> FileResponse:
    """Download the generated PLY file."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if not job["done"] or job["error"]:
        raise HTTPException(400, "Job not complete or failed")

    ply_path = Path(job["output_dir"]) / "output.ply"
    if not ply_path.exists():
        raise HTTPException(404, "PLY file not found")

    return FileResponse(ply_path, media_type="application/octet-stream", filename=f"{job_id}.ply")


@app.get("/health")
async def health() -> JSONResponse:
    """Health check."""
    return JSONResponse({
        "status": "ok",
        "model_loaded": model_loaded,
        "device": device,
        "jobs_active": sum(1 for j in jobs.values() if not j["done"]),
    })


# ─── Startup ──────────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup_event() -> None:
    """Load model on startup."""
    # shortcut: single-user local app; drop only old job dirs so a second
    # instance sharing this folder never deletes an in-flight job
    cutoff = time.time() - 3600
    for stale in JOBS_DIR.iterdir():
        try:
            if stale.is_dir() and stale.stat().st_mtime < cutoff:
                shutil.rmtree(stale, ignore_errors=True)
        except OSError:
            pass
    load_model()


# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)