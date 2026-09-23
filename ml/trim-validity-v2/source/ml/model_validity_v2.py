"""Independent, noncontiguous speed-set classifier on a preserved trim encoder."""
import torch
from torch import nn
from model_trim import TrimPointNet


class SpeedSetHead(nn.Module):
    def __init__(self, feature_dim, widths=(256, 128), dropout=0.15):
        super().__init__()
        self.register_buffer('feature_mean', torch.zeros(feature_dim))
        self.register_buffer('feature_std', torch.ones(feature_dim))
        layers = []
        previous = feature_dim
        for width in widths:
            layers += [nn.Linear(previous, width), nn.ReLU(), nn.Dropout(dropout)]
            previous = width
        layers += [nn.Linear(previous, 51)]
        self.layers = nn.Sequential(*layers)

    def forward(self, features):
        return self.layers((features - self.feature_mean) / self.feature_std)


class TrimValidityV2(TrimPointNet):
    def __init__(self, validity_widths=(256, 128), validity_dropout=0.15, **kwargs):
        super().__init__(**kwargs)
        self.speed_set = SpeedSetHead(self.feature_dim, validity_widths, validity_dropout)

    def decode(self, design_features, speed):
        regression, _ = super().decode(design_features, speed)
        grid_logits = self.speed_set(design_features)
        # Integer-speed supervision has arbitrary gaps. Fractional-speed logits
        # are linearly interpolated, not represented by a single valid interval.
        position = speed.clamp(0, 50)
        lower = torch.floor(position).to(torch.int64)
        upper = (lower + 1).clamp(max=50)
        fraction = position - lower.to(position.dtype)
        logits = grid_logits.gather(1, lower) * (1 - fraction)
        logits = logits + grid_logits.gather(1, upper) * fraction
        return regression, logits
