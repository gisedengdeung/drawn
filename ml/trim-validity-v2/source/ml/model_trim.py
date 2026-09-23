"""Geometry-and-speed PointNet with six regression outputs and trim validity."""
from __future__ import annotations

import torch
from torch import nn
from model import PointNetEncoder

TARGET_NAMES = ['pitch', 'drag', 'thrust', 'flightTime', 'power', 'current']


class TrimPointNet(nn.Module):
    def __init__(self, pool='maxmean', encoder_widths=(64, 64, 128, 1024),
                 head_widths=(256, 128), dropout=0.1):
        super().__init__()
        self.encoder = PointNetEncoder(tuple(encoder_widths), pool=pool)
        self.feature_dim = self.encoder.out_features + 1
        if not head_widths:
            raise ValueError('At least one conditional hidden layer is required.')
        self.first = nn.Linear(self.feature_dim + 1, head_widths[0])
        self.activation = nn.ReLU()
        self.dropout = nn.Dropout(dropout)
        layers = []
        previous = head_widths[0]
        for width in head_widths[1:]:
            layers += [nn.Linear(previous, width), nn.ReLU(), nn.Dropout(dropout)]
            previous = width
        self.hidden = nn.Sequential(*layers)
        self.regression = nn.Linear(previous, len(TARGET_NAMES))
        self.validity = nn.Linear(previous, 1)

    def encode(self, points, scale_feature):
        return torch.cat([self.encoder(points), scale_feature], dim=1)

    def decode(self, design_features, speed):
        # Algebraically identical to Linear(concat(design, speed / 50)).
        # Project the large geometry descriptor ONCE per design, not 51 times.
        design = nn.functional.linear(
            design_features, self.first.weight[:, :-1], self.first.bias
        )
        velocity = (speed / 50.0).unsqueeze(-1) * self.first.weight[:, -1]
        hidden = self.dropout(self.activation(design.unsqueeze(1) + velocity))
        hidden = self.hidden(hidden)
        return self.regression(hidden), self.validity(hidden).squeeze(-1)

    def forward(self, points, scale_feature, speed=None):
        if speed is None:
            speed = torch.arange(51, device=points.device, dtype=points.dtype)
            speed = speed.unsqueeze(0).expand(points.shape[0], -1)
        return self.decode(self.encode(points, scale_feature), speed)
