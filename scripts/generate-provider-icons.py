"""Regenerate status-bar glyphs from our provider SVGs and quota meters: python -m pip install fonttools."""
from math import cos, hypot, pi, sin, tan
from pathlib import Path
import xml.etree.ElementTree as ET

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

ROOT = Path(__file__).resolve().parent.parent


def capsule(pen, start, end, radius):
    """Outline one round-capped SVG line; contours use the same winding."""
    x, y = start
    ex, ey = end
    length = hypot(ex - x, ey - y)
    ux, uy = (ex - x) / length, (ey - y) / length
    nx, ny = -uy, ux
    k = 0.5522847498307936

    def point(cx, cy, along, across):
        return (cx + radius * (along * ux + across * nx), cy + radius * (along * uy + across * ny))

    pen.moveTo(point(x, y, 0, 1))
    pen.lineTo(point(ex, ey, 0, 1))
    pen.curveTo(point(ex, ey, k, 1), point(ex, ey, 1, k), point(ex, ey, 1, 0))
    pen.curveTo(point(ex, ey, 1, -k), point(ex, ey, k, -1), point(ex, ey, 0, -1))
    pen.lineTo(point(x, y, 0, -1))
    pen.curveTo(point(x, y, -k, -1), point(x, y, -1, -k), point(x, y, -1, 0))
    pen.curveTo(point(x, y, -1, k), point(x, y, -k, 1), point(x, y, 0, 1))
    pen.closePath()


def glyph(provider):
    svg = ET.parse(ROOT / 'media' / f'{provider}.svg').getroot()
    target = TTGlyphPen(None)
    # SVG's 24px square, flipped to font coordinates, with a 32-unit margin.
    pen = TransformPen(Cu2QuPen(target, max_err=0.25), (40, 0, 0, -40, 32, 992))
    for element in svg.iter('{http://www.w3.org/2000/svg}path'):
        if provider == 'codex':
            parse_path(element.attrib['d'], pen)
        else:
            lines = RecordingPen()
            parse_path(element.attrib['d'], lines)
            for operation, points in lines.value:
                if operation == 'moveTo':
                    current = points[0]
                elif operation == 'lineTo':
                    capsule(pen, current, points[0], 2.1 / 2)
                    current = points[0]
                elif operation != 'endPath':
                    raise ValueError(f'Unsupported stroked SVG operation: {operation}')
    return target.glyph()


def circle(pen, cx, cy, radius, clockwise=True):
    """Four cubic quarter arcs; clockwise fills and counter-clockwise cuts a hole."""
    k = 0.5522847498307936 * radius
    sign = 1 if clockwise else -1
    pen.moveTo((cx, cy + radius))
    pen.curveTo((cx + sign * k, cy + radius), (cx + sign * radius, cy + k), (cx + sign * radius, cy))
    pen.curveTo((cx + sign * radius, cy - k), (cx + sign * k, cy - radius), (cx, cy - radius))
    pen.curveTo((cx - sign * k, cy - radius), (cx - sign * radius, cy - k), (cx - sign * radius, cy))
    pen.curveTo((cx - sign * radius, cy + k), (cx - sign * k, cy + radius), (cx, cy + radius))
    pen.closePath()


def rectangle(pen, left, bottom, right, top, clockwise=True):
    corners = [(left, bottom), (left, top), (right, top), (right, bottom)]
    pen.moveTo(corners[0])
    for corner in (corners[1:] if clockwise else corners[:0:-1]):
        pen.lineTo(corner)
    pen.closePath()


def quota_ring(eighths):
    """Thin track with a clockwise pie from 12 o'clock, matching the panel's quota rings."""
    target = TTGlyphPen(None)
    pen = Cu2QuPen(target, max_err=0.25)
    cx, cy = 512, 512
    # 1024 units render at 16px: one-pixel track and gap around the pie.
    circle(pen, cx, cy, 440)
    circle(pen, cx, cy, 376, clockwise=False)
    if eighths == 8:
        circle(pen, cx, cy, 312)
    elif eighths:
        radius, sweep = 312, eighths * pi / 4
        def at(angle):
            return (cx + radius * sin(angle), cy + radius * cos(angle))
        pen.moveTo((cx, cy))
        pen.lineTo(at(0))
        steps = eighths // 2 + eighths % 2
        for index in range(steps):
            start, end = sweep * index / steps, sweep * (index + 1) / steps
            k = 4 / 3 * tan((end - start) / 4) * radius
            (sx, sy), (ex, ey) = at(start), at(end)
            pen.curveTo((sx + k * cos(start), sy - k * sin(start)), (ex - k * cos(end), ey + k * sin(end)), (ex, ey))
        pen.closePath()
    return target.glyph()


def quota_level(eighths):
    """Narrow outlined column filled from the bottom; pairs read as one meter per quota window."""
    target = TTGlyphPen(None)
    # One-pixel outline and gap at 16px leave a two-pixel fill.
    left, right, bottom, top, line = 64, 448, 96, 928, 64
    rectangle(target, left, bottom, right, top)
    rectangle(target, left + line, bottom + line, right - line, top - line, clockwise=False)
    if eighths:
        inner = top - bottom - 4 * line
        rectangle(target, left + 2 * line, bottom + 2 * line, right - 2 * line, bottom + 2 * line + round(inner * eighths / 8))
    return target.glyph()


QUOTA_GLYPHS = {f'quota-ring-{n}': (0xE010 + n, quota_ring(n), 1024) for n in range(9)}
QUOTA_GLYPHS.update({f'quota-level-{n}': (0xE020 + n, quota_level(n), 512) for n in range(9)})


font = FontBuilder(1024, isTTF=True)
names = ['.notdef', 'codex', 'claude', *QUOTA_GLYPHS]
font.setupGlyphOrder(names)
font.setupCharacterMap({0xE001: 'codex', 0xE002: 'claude', **{code: name for name, (code, _, _) in QUOTA_GLYPHS.items()}})
font.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), 'codex': glyph('codex'), 'claude': glyph('claude'),
                **{name: outline for name, (_, outline, _) in QUOTA_GLYPHS.items()}})
# Quota meters keep their drawn side bearings; provider logos keep their original metrics.
font.setupHorizontalMetrics({name: (QUOTA_GLYPHS[name][2], font.font['glyf'][name].xMin) if name in QUOTA_GLYPHS else (1024, 0) for name in names})
font.setupHorizontalHeader(ascent=1024, descent=0)
font.setupNameTable({'familyName': 'AgentTandem Providers', 'styleName': 'Regular',
                    'uniqueFontIdentifier': 'AgentTandemProviders-Regular',
                    'fullName': 'AgentTandem Providers', 'psName': 'AgentTandemProviders-Regular', 'version': 'Version 1.0'})
font.setupOS2(sTypoAscender=1024, sTypoDescender=0, usWinAscent=1024, usWinDescent=0)
font.setupPost()
font.font['head'].created = font.font['head'].modified = 2082844800
font.font.recalcTimestamp = False
font.save(ROOT / 'media' / 'provider-icons.ttf')
