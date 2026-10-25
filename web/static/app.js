/**
 * SHARP Web Interface - Frontend Logic
 * Handles drag-drop upload, progress polling, and Gaussian splat viewing
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { SHARPPLYLoader } from './PLYLoader.js';

// ─── State ────────────────────────────────────────────────────────────────────
let currentJobId = null;
let pollInterval = null;
let scene, camera, renderer, controls, splatViewer;
let activeObjectUrl = null;
let activeBounds = null;
let isProcessing = false;
let pollFailCount = 0;
let gizmoHelper = null;
let gridHelper = null;
let cameraAnimating = false;
let bgIndex = 0;
let mediaRecorder = null;
let recordedChunks = [];
let recording = false;
let prevAutoRotate = false;
let prevAutoRotateSpeed = 2.0;

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const plyZone = document.getElementById('ply-zone');
const plyInput = document.getElementById('ply-input');
const browsePlyBtn = document.getElementById('browse-ply-btn');
const progressSection = document.getElementById('progress-section');
const progressFill = document.getElementById('progress-fill');
const progressPct = document.getElementById('progress-pct');
const progressStatus = document.getElementById('progress-status');
const errorState = document.getElementById('error-state');
const viewerSection = document.getElementById('viewer-section');
const viewerCanvas = document.getElementById('viewer-canvas');
const downloadBtn = document.getElementById('download-btn');
const resetViewBtn = document.getElementById('reset-view-btn');
const deviceBadge = document.getElementById('device-badge');

// Viewer toolbar
const togglePointsBtn = document.getElementById('toggle-points');
const toggleGizmoBtn = document.getElementById('toggle-gizmo');
const toggleGridBtn = document.getElementById('toggle-grid');
const toggleBgBtn = document.getElementById('toggle-bg');
const splatScaleInput = document.getElementById('splat-scale');
const splatScaleVal = document.getElementById('splat-scale-val');
const focalAdjustInput = document.getElementById('focal-adjust');
const focalAdjustVal = document.getElementById('focal-adjust-val');
const screenshotBtn = document.getElementById('screenshot-btn');
const recordBtn = document.getElementById('record-btn');
const recordIndicator = document.getElementById('record-indicator');

// UI visibility & fullscreen
const canvasWrap = document.querySelector('.viewer-canvas-wrap');
const toggleUiBtn = document.getElementById('toggle-ui-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const uiRestoreBtn = document.getElementById('ui-restore-btn');

// Step indicators
const steps = {
    preprocess: document.getElementById('step-preprocess'),
    inference: document.getElementById('step-inference'),
    postprocess: document.getElementById('step-postprocess'),
    save: document.getElementById('step-save'),
};

// Stats
const statGaussians = document.getElementById('stat-gaussians');
const statRes = document.getElementById('stat-res');
const statFocal = document.getElementById('stat-focal');

// ─── Init Three.js ────────────────────────────────────────────────────────────
function initThreeJS() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    // Viewer section is hidden at load, so clientWidth/Height may be 0 - use fallbacks
    const w = viewerCanvas.clientWidth || 800;
    const h = viewerCanvas.clientHeight || 500;

    // Camera - SHARP scenes are authored y-down with the camera looking down +Z,
    // so use -Y as "up" to reproduce the original photo orientation.
    camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 10000);
    camera.up.set(0, -1, 0);
    camera.position.set(0, 0, 5);

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas: viewerCanvas, antialias: true, alpha: true });
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 0.1;
    controls.maxDistance = 100;
    controls.minPolarAngle = 0.01;
    controls.maxPolarAngle = Math.PI - 0.01;
    controls.target.set(0, 0, 0);

    // Gaussian splat viewer - renders true splats into our scene/camera/renderer.
    // Shared memory + GPU sort are disabled to avoid COOP/COEP header requirements.
    splatViewer = new GaussianSplats3D.DropInViewer({
        sharedMemoryForWorkers: false,
        gpuAcceleratedSort: false,
        sphericalHarmonicsDegree: 0,
        selfDrivenMode: false,
        optimizeSplatData: true,
    });
    scene.add(splatViewer);

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);
        if (!cameraAnimating) controls.update();
        renderer.render(scene, camera);
    }
    animate();

    // Handle resize
    window.addEventListener('resize', onResize);
}

function onResize() {
    if (!camera || !renderer) return;
    const w = viewerCanvas.clientWidth || 800;
    const h = viewerCanvas.clientHeight || 500;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
}

// ─── Splat Loading ──────────────────────────────────────────────────────────
async function displaySplat(arrayBuffer, bounds) {
    // Remove any previously loaded splat scene
    if (splatViewer.getSceneCount() > 0) {
        try { await splatViewer.removeSplatScene(0, false); } catch (e) { /* ignore */ }
    }
    // Revoke the previous object URL (only safe once its scene is gone)
    if (activeObjectUrl) {
        try { URL.revokeObjectURL(activeObjectUrl); } catch (e) { /* ignore */ }
        activeObjectUrl = null;
    }

    activeObjectUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: 'application/octet-stream' }));

    await splatViewer.addSplatScene(activeObjectUrl, {
        format: GaussianSplats3D.SceneFormat.Ply,
        splatAlphaRemovalThreshold: 5,
        showLoadingUI: false,
        progressiveLoad: false,
    });

    applySplatSettings();
    frameCamera(bounds);
}

function frameCamera(bounds) {
    if (!bounds || !bounds.center) return;
    const center = bounds.center.clone();
    const radius = bounds.radius || 1;

    activeBounds = { center, radius };

    controls.target.copy(center);
    camera.up.set(0, -1, 0);
    // SHARP/OpenCV: the source camera sits at -Z looking down +Z, so the
    // photo-matching "front" view is from -Z.
    camera.position.set(center.x, center.y, center.z - radius * 1.6);
    camera.near = Math.max(radius / 1000, 0.01);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();

    controls.minDistance = radius / 50;
    controls.maxDistance = radius * 20;
    controls.update();
}

function computeBounds(arrayBuffer) {
    const loader = new SHARPPLYLoader();
    return loader.computeBounds(arrayBuffer);
}

// ─── Viewer Toolbar ───────────────────────────────────────────────────────────
// SHARP scenes are authored y-down (world up = -Y), so "top/bottom" views swap
// the camera's up vector to avoid gimbal lock with the -Y orbit axis.
const CAMERA_PRESETS = {
    // -Z is "front": it matches the original photo (SHARP camera looks down +Z).
    front:  { dir: [0, 0, -1], up: [0, -1, 0] },
    back:   { dir: [0, 0, 1],  up: [0, -1, 0] },
    left:   { dir: [-1, 0, 0], up: [0, -1, 0] },
    right:  { dir: [1, 0, 0],  up: [0, -1, 0] },
    top:    { dir: [0, -1, 0], up: [0, 0, -1] },
    bottom: { dir: [0, 1, 0],  up: [0, 0, 1] },
};

const BACKGROUNDS = [
    { name: 'Dark', color: 0x1a1a2e },
    { name: 'Light', color: 0xdadde3 },
    { name: 'Transparent', color: null },
];

function applySplatSettings() {
    if (!splatViewer || !splatViewer.splatMesh) return;
    if (splatScaleInput) {
        splatViewer.splatMesh.setSplatScale(parseFloat(splatScaleInput.value));
    }
    if (focalAdjustInput && splatViewer.viewer) {
        splatViewer.viewer.focalAdjustment = parseFloat(focalAdjustInput.value);
    }
}

function setCameraView(name) {
    if (!activeBounds) return;
    const preset = CAMERA_PRESETS[name];
    if (!preset) return;

    const { center, radius } = activeBounds;
    const d = radius * 1.6;

    camera.up.set(preset.up[0], preset.up[1], preset.up[2]);
    camera.position.set(
        center.x + preset.dir[0] * d,
        center.y + preset.dir[1] * d,
        center.z + preset.dir[2] * d
    );
    controls.target.copy(center);
    camera.near = Math.max(radius / 1000, 0.01);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.minDistance = radius / 50;
    controls.maxDistance = radius * 20;
    controls.update();
}

function flyIn() {
    if (!activeBounds) return;
    const { center, radius } = activeBounds;
    const start = new THREE.Vector3(center.x, center.y, center.z - radius * 5.0);
    const end = new THREE.Vector3(center.x, center.y, center.z - radius * 1.6);

    camera.up.set(0, -1, 0);
    controls.target.copy(center);
    camera.position.copy(start);
    cameraAnimating = true;

    const t0 = performance.now();
    const duration = 1200;
    (function step() {
        const t = Math.min((performance.now() - t0) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 2);
        camera.position.lerpVectors(start, end, eased);
        camera.lookAt(center);
        if (t < 1) {
            requestAnimationFrame(step);
        } else {
            cameraAnimating = false;
            setCameraView('front');
        }
    })();
}

function togglePointCloud() {
    const mesh = splatViewer && splatViewer.splatMesh;
    if (!mesh) return null;
    const next = !mesh.getPointCloudModeEnabled();
    mesh.setPointCloudModeEnabled(next);
    return next;
}

function toggleGizmo() {
    if (gizmoHelper) {
        scene.remove(gizmoHelper);
        gizmoHelper.geometry.dispose();
        gizmoHelper.material.dispose();
        gizmoHelper = null;
        return false;
    }
    if (!activeBounds) return false;
    gizmoHelper = new THREE.AxesHelper(activeBounds.radius * 1.2);
    gizmoHelper.position.copy(activeBounds.center);
    scene.add(gizmoHelper);
    return true;
}

function toggleGrid() {
    if (gridHelper) {
        scene.remove(gridHelper);
        gridHelper.geometry.dispose();
        gridHelper.material.dispose();
        gridHelper = null;
        return false;
    }
    if (!activeBounds) return false;
    gridHelper = new THREE.GridHelper(activeBounds.radius * 4, 20, 0x3a5a8c, 0x22334d);
    gridHelper.position.set(
        activeBounds.center.x,
        activeBounds.center.y + activeBounds.radius,
        activeBounds.center.z
    );
    scene.add(gridHelper);
    return true;
}

function cycleBackground() {
    bgIndex = (bgIndex + 1) % BACKGROUNDS.length;
    const state = BACKGROUNDS[bgIndex];
    scene.background = state.color === null ? null : new THREE.Color(state.color);
    return state.name;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function captureScreenshot() {
    if (!renderer) return;
    // Render synchronously so toBlob captures real pixels (no preserveDrawingBuffer needed).
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => {
        if (blob) downloadBlob(blob, `sharp-view-${Date.now()}.png`);
    }, 'image/png');
}

function updateRecordUI(active) {
    if (recordBtn) {
        recordBtn.classList.toggle('active', active);
        recordBtn.disabled = active;
    }
    if (recordIndicator) recordIndicator.classList.toggle('visible', active);
}

function recordOrbit() {
    if (!renderer || !controls || recording) return;
    if (typeof MediaRecorder === 'undefined' || !renderer.domElement.captureStream) {
        showError('Video recording is not supported in this browser.');
        return;
    }

    const stream = renderer.domElement.captureStream(30);
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m));
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        downloadBlob(blob, `sharp-orbit-${Date.now()}.webm`);
        stream.getTracks().forEach((t) => t.stop());
        controls.autoRotate = prevAutoRotate;
        controls.autoRotateSpeed = prevAutoRotateSpeed;
        mediaRecorder = null;
        recording = false;
        updateRecordUI(false);
    };

    prevAutoRotate = controls.autoRotate;
    prevAutoRotateSpeed = controls.autoRotateSpeed;
    controls.autoRotate = true;
    if (!prevAutoRotateSpeed) controls.autoRotateSpeed = 2.0;

    recording = true;
    updateRecordUI(true);
    mediaRecorder.start();
    setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    }, 8000);
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}

function resetViewerToolbar() {
    stopRecording();
    if (gizmoHelper) { scene.remove(gizmoHelper); gizmoHelper.geometry.dispose(); gizmoHelper.material.dispose(); gizmoHelper = null; }
    if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); gridHelper = null; }
    [toggleGizmoBtn, toggleGridBtn, togglePointsBtn].forEach((b) => b && b.classList.remove('active'));
    bgIndex = 0;
    if (scene) scene.background = new THREE.Color(BACKGROUNDS[0].color);
    if (splatScaleInput) { splatScaleInput.value = '1'; if (splatScaleVal) splatScaleVal.textContent = '1.00'; }
    if (focalAdjustInput) { focalAdjustInput.value = '1'; if (focalAdjustVal) focalAdjustVal.textContent = '1.00'; }
}

function setupViewerToolbar() {
    document.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.preset;
            if (name === 'flyin') flyIn();
            else setCameraView(name);
        });
    });

    if (togglePointsBtn) {
        togglePointsBtn.addEventListener('click', () => {
            const next = togglePointCloud();
            if (next !== null) togglePointsBtn.classList.toggle('active', next);
        });
    }
    if (toggleGizmoBtn) {
        toggleGizmoBtn.addEventListener('click', () => toggleGizmoBtn.classList.toggle('active', toggleGizmo()));
    }
    if (toggleGridBtn) {
        toggleGridBtn.addEventListener('click', () => toggleGridBtn.classList.toggle('active', toggleGrid()));
    }
    if (toggleBgBtn) {
        toggleBgBtn.addEventListener('click', () => cycleBackground());
    }

    if (splatScaleInput) {
        splatScaleInput.addEventListener('input', () => {
            if (splatScaleVal) splatScaleVal.textContent = parseFloat(splatScaleInput.value).toFixed(2);
            if (splatViewer && splatViewer.splatMesh) {
                splatViewer.splatMesh.setSplatScale(parseFloat(splatScaleInput.value));
            }
        });
    }
    if (focalAdjustInput) {
        focalAdjustInput.addEventListener('input', () => {
            if (focalAdjustVal) focalAdjustVal.textContent = parseFloat(focalAdjustInput.value).toFixed(2);
            if (splatViewer && splatViewer.viewer) {
                splatViewer.viewer.focalAdjustment = parseFloat(focalAdjustInput.value);
            }
        });
    }

    if (screenshotBtn) screenshotBtn.addEventListener('click', captureScreenshot);
    if (recordBtn) recordBtn.addEventListener('click', recordOrbit);

    if (toggleUiBtn) toggleUiBtn.addEventListener('click', toggleUi);
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);
    if (uiRestoreBtn) uiRestoreBtn.addEventListener('click', () => setUiHidden(false));
}

// ─── Hide UI ──────────────────────────────────────────────────────────────────
function setUiHidden(hidden) {
    document.body.classList.toggle('ui-hidden', hidden);
    if (toggleUiBtn) {
        toggleUiBtn.setAttribute('aria-pressed', String(hidden));
        toggleUiBtn.classList.toggle('active', hidden);
    }
    setTimeout(onResize, 60);
}

function toggleUi() {
    setUiHidden(!document.body.classList.contains('ui-hidden'));
}

// ─── Fullscreen (pure canvas, no overlays) ───────────────────────────────────
const fullscreenTarget = canvasWrap || viewerSection;

function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen() {
    if (isFullscreen()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
    }
    if (!fullscreenTarget) return;
    const request = fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen;
    if (request) request.call(fullscreenTarget).catch?.(() => {});
}

function onFullscreenChange() {
    if (fullscreenBtn) fullscreenBtn.classList.toggle('active', isFullscreen());
    setTimeout(onResize, 60);
}

function setupUiControls() {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    // Disable the button if the Fullscreen API is unavailable
    if (fullscreenBtn && !fullscreenTarget?.requestFullscreen && !fullscreenTarget?.webkitRequestFullscreen) {
        fullscreenBtn.disabled = true;
        fullscreenBtn.title = 'Fullscreen not supported by this browser';
    }

    // H toggles the UI
    document.addEventListener('keydown', (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
        if (e.key === 'h' || e.key === 'H') {
            e.preventDefault();
            if (viewerSection.classList.contains('visible')) toggleUi();
        }
    });
}

// ─── Upload Handling ──────────────────────────────────────────────────────────
function setupUpload() {
    // Click to browse
    browseBtn.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('click', (e) => {
        if (e.target === uploadZone || e.target.classList.contains('upload-title') ||
            e.target.classList.contains('upload-subtitle') || e.target.classList.contains('upload-icon')) {
            fileInput.click();
        }
    });

    // File input change
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    // Drag and drop
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });

    uploadZone.addEventListener('dragleave', (e) => {
        if (!uploadZone.contains(e.relatedTarget)) {
            uploadZone.classList.remove('dragover');
        }
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });
}

// ─── PLY Upload Handling ────────────────────────────────────────────────────────
function setupPlyUpload() {
    if (!plyZone || !plyInput || !browsePlyBtn) {
        console.error('[App] PLY upload elements not found!');
        return;
    }

    // Click to browse
    browsePlyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        plyInput.click();
    });

    plyZone.addEventListener('click', (e) => {
        if (e.target === plyZone || e.target.classList.contains('upload-title') ||
            e.target.classList.contains('upload-subtitle') || e.target.classList.contains('upload-icon')) {
            plyInput.click();
        }
    });

    // File input change
    plyInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handlePlyFile(e.target.files[0]);
        }
    });

    // Drag and drop
    plyZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        plyZone.classList.add('dragover');
    });

    plyZone.addEventListener('dragleave', (e) => {
        if (!plyZone.contains(e.relatedTarget)) {
            plyZone.classList.remove('dragover');
        }
    });

    plyZone.addEventListener('drop', (e) => {
        e.preventDefault();
        plyZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            handlePlyFile(e.dataTransfer.files[0]);
        }
    });
}

async function handlePlyFile(file) {
    if (isProcessing) return;

    // Validate
    if (!file.name.match(/\.ply$/i)) {
        showError('Please select a .ply file.');
        return;
    }

    if (file.size > 200 * 1024 * 1024) {
        showError('File too large. Maximum 200MB.');
        return;
    }

    isProcessing = true;
    hideError();
    hideViewer();
    showProgress();
    resetSteps();
    progressStatus.textContent = 'Loading PLY file...';

    try {
        const arrayBuffer = await file.arrayBuffer();
        const bounds = await computeBounds(arrayBuffer);

        // Update stats (no metadata available from a local file)
        statGaussians.textContent = bounds ? bounds.vertexCount.toLocaleString() : '-';
        statRes.textContent = 'N/A (local file)';
        statFocal.textContent = 'N/A (local file)';

        // Store for download
        downloadBtn.dataset.url = URL.createObjectURL(file);
        downloadBtn.dataset.filename = file.name;

        progressStatus.textContent = 'Rendering splats...';
        hideProgress();
        showViewer();

        await displaySplat(arrayBuffer, bounds);
        isProcessing = false;

    } catch (err) {
        console.error('[App] PLY load error:', err);
        showError(`Failed to load PLY: ${err.message}`);
        hideProgress();
        isProcessing = false;
    }
}

function handleFile(file) {
    if (isProcessing) return;

    // Validate
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'image/heic'];
    if (!allowedTypes.includes(file.type) && !file.name.match(/\.(jpg|jpeg|png|webp|bmp|tiff|heic)$/i)) {
        showError('Unsupported file type. Please use JPG, PNG, WebP, BMP, TIFF, or HEIC.');
        return;
    }

    if (file.size > 50 * 1024 * 1024) {
        showError('File too large. Maximum 50MB.');
        return;
    }

    startProcessing(file);
}

async function startProcessing(file) {
    isProcessing = true;
    currentJobId = null;
    hideError();
    hideViewer();
    showProgress();
    resetSteps();

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/predict', {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Upload failed');
        }

        const data = await response.json();
        currentJobId = data.job_id;
        pollProgress();

    } catch (err) {
        showError(err.message);
        hideProgress();
        isProcessing = false;
    }
}

// ─── Progress Polling ─────────────────────────────────────────────────────────
function pollProgress() {
    if (!currentJobId) return;
    pollFailCount = 0;

    pollInterval = setInterval(async () => {
        try {
            const response = await fetch(`/status/${currentJobId}`);
            if (!response.ok) throw new Error('Status check failed');

            const data = await response.json();
            updateProgress(data);

            if (data.done) {
                clearInterval(pollInterval);
                pollInterval = null;
                isProcessing = false;

                if (data.error) {
                    showError(data.error);
                    hideProgress();
                } else if (data.result) {
                    hideProgress();
                    await loadAndShowResult(data.result);
                }
            }
        } catch (err) {
            console.error('Poll error:', err);
            pollFailCount = (pollFailCount || 0) + 1;
            if (pollFailCount >= 3) {
                clearInterval(pollInterval);
                pollInterval = null;
                isProcessing = false;
                showError('Connection lost while processing. Reload and try again.');
                hideProgress();
            }
        }
    }, 2000);
}

function updateProgress(data) {
    const pct = data.progress;
    progressFill.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
    progressStatus.textContent = data.status;

    // Update steps
    if (pct >= 10) setStepComplete('preprocess');
    if (pct >= 30) { setStepActive('inference'); setStepComplete('preprocess'); }
    if (pct >= 70) { setStepActive('postprocess'); setStepComplete('inference'); }
    if (pct >= 90) { setStepActive('save'); setStepComplete('postprocess'); }
    if (pct >= 100) setStepComplete('save');
}

function setStepActive(name) {
    Object.values(steps).forEach(s => s.classList.remove('active'));
    steps[name]?.classList.add('active');
}

function setStepComplete(name) {
    steps[name]?.classList.remove('active');
    steps[name]?.classList.add('complete');
}

function resetSteps() {
    Object.values(steps).forEach(s => s.classList.remove('active', 'complete'));
}

// ─── Result Loading ───────────────────────────────────────────────────────────
async function loadAndShowResult(result) {
    try {
        progressStatus.textContent = 'Loading 3D viewer...';

        const response = await fetch(result.ply_url);
        if (!response.ok) throw new Error(`Failed to fetch result PLY (${response.status})`);
        const arrayBuffer = await response.arrayBuffer();

        const bounds = await computeBounds(arrayBuffer);

        // Update stats
        statGaussians.textContent = result.meta.num_gaussians.toLocaleString();
        statRes.textContent = `${result.meta.width}×${result.meta.height}`;
        statFocal.textContent = `${result.meta.focal_length_px.toFixed(0)}px`;

        // Store download URL
        downloadBtn.dataset.url = result.ply_url;
        downloadBtn.dataset.filename = `${currentJobId}.ply`;

        showViewer();

        await displaySplat(arrayBuffer, bounds);

    } catch (err) {
        showError(`Failed to load result: ${err.message}`);
    }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function showProgress() {
    progressSection.classList.add('visible');
    uploadZone.style.display = 'none';
    plyZone.style.display = 'none';
}

function hideProgress() {
    progressSection.classList.remove('visible');
    uploadZone.style.display = 'block';
    plyZone.style.display = 'block';
}

function showViewer() {
    viewerSection.classList.add('visible');
    // Trigger resize to ensure correct canvas size
    setTimeout(onResize, 50);
}

function hideViewer() {
    viewerSection.classList.remove('visible');
    // Restore a hidden UI so the upload screen renders normally again
    setUiHidden(false);
    if (isFullscreen()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
    }
    resetViewerToolbar();
    if (splatViewer && splatViewer.getSceneCount() > 0) {
        splatViewer.removeSplatScene(0, false).catch(() => {});
    }
    if (activeObjectUrl) {
        try { URL.revokeObjectURL(activeObjectUrl); } catch (e) { /* ignore */ }
        activeObjectUrl = null;
    }
}

function showError(message) {
    errorState.textContent = message;
    errorState.classList.add('visible');
}

function hideError() {
    errorState.classList.remove('visible');
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
    if (downloadBtn.dataset.url) {
        const a = document.createElement('a');
        a.href = downloadBtn.dataset.url;
        a.download = downloadBtn.dataset.filename;
        a.click();
    }
});

resetViewBtn.addEventListener('click', () => {
    if (activeBounds) {
        frameCamera(activeBounds);
    }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
async function checkHealth() {
    try {
        const response = await fetch('/health');
        const data = await response.json();
        deviceBadge.textContent = `Device: ${data.device.toUpperCase()} ${data.model_loaded ? '✓' : '✗'}`;
        deviceBadge.style.color = data.model_loaded ? '#2ecc71' : '#e94560';
    } catch {
        deviceBadge.textContent = 'Server: Disconnected';
        deviceBadge.style.color = '#e94560';
    }
}

// ─── Initialize ───────────────────────────────────────────────────────────────
async function init() {
    setupUpload();
    setupPlyUpload();
    initThreeJS();
    setupViewerToolbar();
    setupUiControls();
    await checkHealth();

    // Periodic health check
    setInterval(checkHealth, 30000);
}

init();
