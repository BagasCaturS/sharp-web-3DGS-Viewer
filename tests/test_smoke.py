"""Smoke tests: PLY roundtrip, covariance decomposition, focal fallback.

Run with: python tests/test_smoke.py
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import torch
from PIL import Image

from sharp.utils import gaussians as gs
from sharp.utils import io


def _fake_gaussians(n: int = 64) -> gs.Gaussians3D:
    torch.manual_seed(0)
    return gs.Gaussians3D(
        mean_vectors=torch.randn(1, n, 3) * 0.1 + torch.tensor([0.0, 0.0, 1.0]),
        singular_values=torch.rand(1, n, 3) * 0.1 + 0.01,
        quaternions=torch.nn.functional.normalize(torch.randn(1, n, 4), dim=-1),
        colors=torch.rand(1, n, 3) * 0.98 + 0.01,
        opacities=torch.rand(1, n) * 0.98 + 0.01,
    )


def test_ply_roundtrip() -> None:
    g = _fake_gaussians()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scene.ply"
        gs.save_ply(g, 500.0, (48, 64), path)
        loaded, meta = gs.load_ply(path)

    assert abs(meta.focal_length_px - 500.0) < 1e-3
    assert meta.resolution_px == (64, 48)
    for a, b, atol in (
        (g.mean_vectors, loaded.mean_vectors, 1e-6),
        (g.quaternions, loaded.quaternions, 1e-6),
        (g.singular_values, loaded.singular_values, 1e-4),
        (g.colors, loaded.colors, 5e-3),
        (g.opacities, loaded.opacities, 1e-4),
    ):
        assert torch.allclose(a, b, atol=atol), (a - b).abs().max().item()


def test_covariance_roundtrip() -> None:
    g = _fake_gaussians()
    cov = gs.compose_covariance_matrices(g.quaternions, g.singular_values)
    q, s = gs.decompose_covariance_matrices(cov)
    assert torch.allclose(gs.compose_covariance_matrices(q, s), cov, atol=1e-4)


def test_focal_fallback() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "plain.png"
        Image.new("RGB", (64, 48), (128, 128, 128)).save(path)
        image, _, f_px = io.load_rgb(path)
    assert image.shape == (48, 64, 3)
    assert abs(f_px - io.convert_focallength(64, 48, 30.0)) < 1e-4


def test_upload_limit() -> None:
    import importlib.util
    import io as _io

    spec = importlib.util.spec_from_file_location(
        "sharp_web_server", Path(__file__).resolve().parents[1] / "web" / "server.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "in.bin"
        mod._save_limited(_io.BytesIO(b"12345"), dest)
        assert dest.read_bytes() == b"12345"
        try:
            mod._save_limited(_io.BytesIO(b"0123456789"), dest, limit=5)
        except Exception as exc:
            assert "too large" in str(exc).lower()
        else:
            raise AssertionError("oversize upload was accepted")
        assert not dest.exists(), "partial upload left on disk"


if __name__ == "__main__":
    test_ply_roundtrip()
    test_covariance_roundtrip()
    test_focal_fallback()
    test_upload_limit()
    print("all smoke tests passed")
