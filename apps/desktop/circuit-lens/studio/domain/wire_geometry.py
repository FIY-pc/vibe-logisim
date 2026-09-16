"""Orthogonal segment operations; intersections alone do not imply a net."""


def on_segment(p, a, b):
    return (a[0] == b[0] == p[0] and min(a[1], b[1]) <= p[1] <= max(a[1], b[1]) or
            a[1] == b[1] == p[1] and min(a[0], b[0]) <= p[0] <= max(a[0], b[0]))


def subtract_segments(a, b, removed):
    segments = [(a, b)]
    for p, q in removed:
        remaining = []
        for start, end in segments:
            axis = 1 if start[0] == end[0] else 0
            other = 1 - axis
            lo, hi = sorted((start[axis], end[axis]))
            cut_lo, cut_hi = max(lo, min(p[axis], q[axis])), min(hi, max(p[axis], q[axis]))
            if start[other] != p[other] or p[other] != q[other] or cut_lo >= cut_hi:
                remaining.append((start, end))
                continue
            def at(value):
                result = list(start)
                result[axis] = value
                return tuple(result)
            if lo < cut_lo:
                remaining.append((at(lo), at(cut_lo)))
            if cut_hi < hi:
                remaining.append((at(cut_hi), at(hi)))
        segments = remaining
    return segments
