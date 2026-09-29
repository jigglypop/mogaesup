"""Flat-colour SVG tracing of a transparent 2D illustration, editable in vector tools."""
import io
import re

import numpy as np
from PIL import Image
import vtracer

from src.services.character_pipeline import PipelineError

VECTOR_REVISION = 'illustration-vector-v1'
COLOR_CHOICES = (12, 16, 24, 32)
_SAMPLE = 60000
# Colours are fixed beforehand, so the tracer must not merge or re-average them (layer_difference=1).
_TRACE = dict(colormode='color', hierarchical='stacked', mode='spline', filter_speckle=6, color_precision=8,
              layer_difference=1, corner_threshold=60, length_threshold=4.0, max_iterations=10,
              splice_threshold=45, path_precision=2)
_M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
_WHITE = np.array([0.95047, 1.0, 1.08883])


def _lab(rgb):
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = (c @ _M.T) / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def _nearest(lab, centres):
    index = np.empty(len(lab), dtype=np.int64)
    for start in range(0, len(lab), 100000):
        chunk = lab[start:start + 100000]
        index[start:start + 100000] = np.argmin(((chunk[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
    return index


def _palette(pixels, colors):
    """k-means in Lab with k-means++ seeding, so small distinct accents (eyes, outlines) keep a colour."""
    rng = np.random.default_rng(0)
    sample = pixels[rng.choice(len(pixels), min(len(pixels), _SAMPLE), replace=False)].astype(np.float64)
    lab = _lab(sample)
    colors = min(colors, len(np.unique(sample, axis=0)))
    centres = [lab[rng.integers(len(lab))]]
    distance = ((lab - centres[0]) ** 2).sum(1)
    for _ in range(1, colors):
        centres.append(lab[rng.choice(len(lab), p=distance / distance.sum())] if distance.sum() else lab[0])
        distance = np.minimum(distance, ((lab - centres[-1]) ** 2).sum(1))
    centres = np.array(centres)
    for _ in range(12):
        labels = _nearest(lab, centres)
        for i in range(colors):
            if (labels == i).any():
                centres[i] = lab[labels == i].mean(0)
    labels = _nearest(lab, centres)
    palette = np.array([sample[labels == i].mean(0) for i in range(colors) if (labels == i).any()])
    return np.unique(np.clip(np.round(palette), 0, 255).astype(np.uint8), axis=0)


def trace_illustration(png, colors):
    """Return (svg text, stats) for a PNG: alpha cut at 50%, `colors` flat fills, stacked paths."""
    if colors not in COLOR_CHOICES:
        raise PipelineError('invalid_colors', 'SVG 색 수를 다시 선택하세요.', 422)
    rgba = np.array(Image.open(io.BytesIO(png)).convert('RGBA'))
    opaque = rgba[..., 3] >= 128
    if not opaque.any():
        raise PipelineError('empty_illustration', '원화에 보이는 영역이 없습니다.', 422)
    palette = _palette(rgba[..., :3][opaque], colors)
    lab_palette = _lab(palette.astype(np.float64))
    flat = np.zeros_like(rgba)
    flat[opaque, :3] = palette[_nearest(_lab(rgba[..., :3][opaque].astype(np.float64)), lab_palette)]
    flat[opaque, 3] = 255
    buffer = io.BytesIO()
    Image.fromarray(flat, 'RGBA').save(buffer, 'PNG')
    svg = vtracer.convert_raw_image_to_svg(buffer.getvalue(), img_format='png', **_TRACE)
    hexes = ['#%02X%02X%02X' % tuple(int(v) for v in color) for color in palette]

    # Anti-aliased edge clusters come back averaged; snap every fill to the fixed palette.
    def snap(match):
        value = match.group(1)
        rgb = np.array([[int(value[i:i + 2], 16) for i in (1, 3, 5)]], dtype=np.float64)
        return f'fill="{hexes[int(_nearest(_lab(rgb), lab_palette)[0])]}"'
    svg = re.sub(r'fill="(#[0-9A-Fa-f]{6})"', snap, svg)
    height, width = opaque.shape
    svg = re.sub(r'<svg [^>]*>', f'<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="{width}" '
                 f'height="{height}" viewBox="0 0 {width} {height}">\n<g id="illustration">', svg, count=1)
    svg = svg.replace('</svg>', '</g>\n</svg>')
    used = sorted(set(re.findall(r'fill="(#[0-9A-F]{6})"', svg)))
    return svg, {'colors': colors, 'paths': svg.count('<path'), 'palette': used,
                 'width': width, 'height': height, 'bytes': len(svg.encode())}
