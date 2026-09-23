"""Dedicated validity encoder while preserving the original regression model.

The exported feature vector is [regression geometry+scale, validity geometry+scale].
Each half has 2049 features with the standard maxmean PointNet configuration.
"""
from __future__ import annotations

from copy import deepcopy

import torch

from model_trim import TrimPointNet
from model_validity_v2 import TrimValidityV2


class TrimValidityDual(TrimValidityV2):
    def __init__(self, validity_widths=(256, 128), validity_dropout=0.15, **kwargs):
        super().__init__(validity_widths=validity_widths,
                         validity_dropout=validity_dropout, **kwargs)
        # Construct the inherited regression layers/head with the original width.
        # Only the encode/decode exchange tensor advertises the doubled width.
        self.regression_feature_dim = self.feature_dim
        self.validity_feature_dim = self.feature_dim
        self.validity_encoder = deepcopy(self.encoder)
        self.feature_dim = self.regression_feature_dim + self.validity_feature_dim
        self._freeze_regression()
        self.train(self.training)

    def _regression_modules(self):
        return (self.encoder, self.first, self.activation, self.dropout,
                self.hidden, self.regression, self.validity)

    def _freeze_regression(self):
        for module in self._regression_modules():
            for parameter in module.parameters():
                parameter.requires_grad_(False)

    def train(self, mode=True):
        # requires_grad=False alone does not freeze BatchNorm buffers or dropout.
        # Keep the old path in eval mode even when training the separate encoder.
        super().train(mode)
        for module in self._regression_modules():
            module.eval()
        return self

    def initialize_validity_encoder(self):
        """Copy the currently loaded original encoder into the trainable branch."""
        self.validity_encoder.load_state_dict(self.encoder.state_dict())
        for parameter in self.validity_encoder.parameters():
            parameter.requires_grad_(True)
        return self

    def initialize_from_v2(self, state_dict):
        """Load a complete v2 state and initialize the dedicated encoder from it."""
        incompatible = self.load_state_dict(state_dict, strict=False)
        if incompatible.unexpected_keys or any(
                not key.startswith('validity_encoder.') for key in incompatible.missing_keys):
            raise ValueError(f'Expected a complete v2 state: {incompatible}')
        self.initialize_validity_encoder()
        return self

    def encode_validity(self, points, scale_feature):
        return torch.cat([self.validity_encoder(points), scale_feature], dim=1)

    def encode(self, points, scale_feature):
        with torch.no_grad():
            original = torch.cat([self.encoder(points), scale_feature], dim=1)
        classifier = self.encode_validity(points, scale_feature)
        return torch.cat([original, classifier], dim=1)

    def decode(self, design_features, speed):
        original = design_features[:, :self.regression_feature_dim]
        classifier = design_features[:, self.regression_feature_dim:]
        regression, _ = TrimPointNet.decode(self, original, speed)
        grid_logits = self.speed_set(classifier)
        position = speed.clamp(0, 50)
        lower = torch.floor(position).to(torch.int64)
        upper = (lower + 1).clamp(max=50)
        fraction = position - lower.to(position.dtype)
        logits = grid_logits.gather(1, lower) * (1 - fraction)
        logits = logits + grid_logits.gather(1, upper) * fraction
        return regression, logits
