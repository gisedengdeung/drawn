"""PointNet regressor for drone KPI prediction.

Two deliberate departures from the classification reference implementation:

No T-Net. The input alignment network exists to make the encoder invariant to
rigid rotation, which is right for scanned objects in arbitrary poses and wrong
here. Every AircraftVerse mesh sits in the same CAD frame, and orientation is
signal: a wing's angle and the z-extent of the airframe carry performance
meaning. Rotating the cloud to a learned canonical pose would throw that away.

Scale enters after the pooling, not per point. A cloud is normalised into the
unit sphere, so its absolute size lives in one scalar. Broadcasting that scalar
across 1,024 points would spend encoder capacity re-deriving a constant, and
the max pool would collapse it again anyway. It belongs next to the global
descriptor, where the head can form shape-by-size interactions directly.
"""

from __future__ import annotations

import torch
from torch import nn


class PointNetEncoder(nn.Module):
    """Shared per-point MLP followed by a symmetric pool.

    The pool choice matters more than it looks. A max pool keeps, per channel,
    the single most extreme point, which makes it an excellent bounding-box
    reader — span and aspect ratio come out at R2 0.993 — but it cannot report
    an interior dimension such as a fuselage cross-section that is enclosed by
    arms and propellers. A mean pool carries distributional information instead.
    `maxmean` concatenates both.
    """

    POOLS = ("max", "mean", "maxmean")

    def __init__(self, widths=(64, 64, 128, 1024), in_channels: int = 3, pool: str = "max"):
        super().__init__()
        if pool not in self.POOLS:
            raise ValueError(f"pool must be one of {self.POOLS}")
        layers = []
        previous = in_channels
        for width in widths:
            layers += [
                nn.Conv1d(previous, width, kernel_size=1, bias=False),
                nn.BatchNorm1d(width),
                nn.ReLU(inplace=True),
            ]
            previous = width
        self.layers = nn.Sequential(*layers)
        self.pool = pool
        self.out_features = widths[-1] * (2 if pool == "maxmean" else 1)

    def forward(self, points: torch.Tensor) -> torch.Tensor:
        # points: (B, 3, P) -> (B, out_features)
        features = self.layers(points)
        if self.pool == "max":
            return features.amax(dim=2)
        if self.pool == "mean":
            return features.mean(dim=2)
        return torch.cat([features.amax(dim=2), features.mean(dim=2)], dim=1)


class PointNetRegressor(nn.Module):
    def __init__(
        self,
        n_targets: int,
        use_scale: bool = True,
        encoder_widths=(64, 64, 128, 1024),
        head_widths=(512, 256),
        dropout: float = 0.3,
        pool: str = "max",
    ):
        super().__init__()
        self.encoder = PointNetEncoder(encoder_widths, pool=pool)
        self.use_scale = use_scale

        previous = self.encoder.out_features + (1 if use_scale else 0)
        layers = []
        for width in head_widths:
            layers += [
                nn.Linear(previous, width),
                nn.BatchNorm1d(width),
                nn.ReLU(inplace=True),
                nn.Dropout(dropout),
            ]
            previous = width
        layers.append(nn.Linear(previous, n_targets))
        self.head = nn.Sequential(*layers)

    def forward(self, points: torch.Tensor, scale_feature: torch.Tensor) -> torch.Tensor:
        features = self.encoder(points)
        if self.use_scale:
            features = torch.cat([features, scale_feature], dim=1)
        return self.head(features)


def count_parameters(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
