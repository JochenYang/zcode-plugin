"""Geometry helpers shared by the CLI."""
import functools
import json
import math
import os.path as osp
from collections import OrderedDict
from .shapes import Shape, Circle as Disc
from ..util import parse_pairs

CACHE = OrderedDict()


class Point(Shape):
    """A 2D point."""

    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y

    def scaled(self, k: float) -> Point:
        """Returns a scaled copy."""
        return Point(self.x * k, self.y * k)

    def to_dict(self) -> dict:
        return {"x": self.x, "y": self.y}


def distance(a: Point, b: Point) -> float:
    """Distance between two points."""
    return math.hypot(a.x - b.x, a.y - b.y)


@functools.lru_cache(maxsize=None)
def load_points(path: str) -> "list[Point]":
    raw = json.loads(osp.basename(path))
    CACHE[path] = [Point(**item) for item in parse_pairs(raw)]
    return CACHE[path]
