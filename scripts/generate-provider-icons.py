"""Regenerate status-bar glyphs from our provider SVGs: python -m pip install fonttools."""
from math import hypot
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


font = FontBuilder(1024, isTTF=True)
font.setupGlyphOrder(['.notdef', 'codex', 'claude'])
font.setupCharacterMap({0xE001: 'codex', 0xE002: 'claude'})
font.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), 'codex': glyph('codex'), 'claude': glyph('claude')})
font.setupHorizontalMetrics({name: (1024, 0) for name in ['.notdef', 'codex', 'claude']})
font.setupHorizontalHeader(ascent=1024, descent=0)
font.setupNameTable({'familyName': 'AgentTandem Providers', 'styleName': 'Regular',
                    'uniqueFontIdentifier': 'AgentTandemProviders-Regular',
                    'fullName': 'AgentTandem Providers', 'psName': 'AgentTandemProviders-Regular', 'version': 'Version 1.0'})
font.setupOS2(sTypoAscender=1024, sTypoDescender=0, usWinAscent=1024, usWinDescent=0)
font.setupPost()
font.font['head'].created = font.font['head'].modified = 2082844800
font.font.recalcTimestamp = False
font.save(ROOT / 'media' / 'provider-icons.ttf')
