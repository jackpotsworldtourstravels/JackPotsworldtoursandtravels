"""The target viewports for responsive testing (Stage 2 §Phase-3C).

Desktop/tablet/mobile sizes the suite drives. The mobile entries also carry a
device-emulation profile (touch + mobile UA) so pages detect a touch phone.
Used by conftest's ``viewport`` fixture and by the responsive specs in Stage 4.
"""
from __future__ import annotations

# name -> {width, height, is_mobile}
VIEWPORTS: dict[str, dict] = {
    # Desktop
    "desktop-1920": {"width": 1920, "height": 1080, "is_mobile": False},
    "desktop-1440": {"width": 1440, "height": 900, "is_mobile": False},
    "desktop-1366": {"width": 1366, "height": 768, "is_mobile": False},
    # Tablet
    "tablet-1024": {"width": 1024, "height": 768, "is_mobile": False},
    "tablet-768": {"width": 768, "height": 1024, "is_mobile": False},
    # Mobile
    "mobile-430": {"width": 430, "height": 932, "is_mobile": True},
    "mobile-390": {"width": 390, "height": 844, "is_mobile": True},
    "mobile-360": {"width": 360, "height": 800, "is_mobile": True},
}

DESKTOP = ["desktop-1920", "desktop-1440", "desktop-1366"]
TABLET = ["tablet-1024", "tablet-768"]
MOBILE = ["mobile-430", "mobile-390", "mobile-360"]
ALL = list(VIEWPORTS)

#: Workflow E2E runs on this smaller set to keep CI time bounded (Stage 2 arch).
WORKFLOW_SET = ["desktop-1440", "mobile-390"]


def context_args(name: str) -> dict:
    """browser_context_args overrides for a named viewport."""
    v = VIEWPORTS[name]
    args: dict = {"viewport": {"width": v["width"], "height": v["height"]}}
    if v["is_mobile"]:
        args.update(has_touch=True, is_mobile=True)
    return args
