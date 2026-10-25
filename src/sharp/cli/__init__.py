"""Command-line-interface to run SHARP model.

For licensing see accompanying LICENSE file.
Copyright (C) 2025 Apple Inc. All Rights Reserved.
"""

import click

from . import predict

try:
    from . import render

    _HAS_RENDER = True
except ImportError:  # gsplat not installed (CPU-only / web build)
    _HAS_RENDER = False


@click.group()
def main_cli():
    """Run inference for SHARP model."""
    pass


main_cli.add_command(predict.predict_cli, "predict")
if _HAS_RENDER:
    main_cli.add_command(render.render_cli, "render")
