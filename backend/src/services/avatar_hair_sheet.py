"""Separate adjacent sheet views in original pixel coordinates, without rescaling."""
from PIL import Image


def _seam(alpha, width, height, anchor, radius):
    low, high = max(1, anchor-radius), min(width-1, anchor+radius)
    candidates = list(range(low, high+1))
    previous = [0.0] * len(candidates)
    parents = []
    for y in range(height):
        costs, row = [], []
        for i, x in enumerate(candidates):
            start, stop = max(0, i-1), min(len(candidates), i+2)
            parent = min(range(start, stop), key=lambda j: previous[j]+abs(i-j)*.15)
            # Transparent gaps are preferable to straight cuts through strands.
            opacity = max(alpha[y*width+x-1], alpha[y*width+x]) / 255
            costs.append(previous[parent] + opacity*20 + abs(x-anchor)*.08)
            row.append(parent)
        previous = costs
        parents.append(row)
    index = min(range(len(previous)), key=previous.__getitem__)
    result = [0] * height
    for y in range(height-1, -1, -1):
        result[y] = candidates[index]
        index = parents[y][index]
    return result


def _crop_views(source, xedges):
    width, height = source.size
    alpha = source.getchannel('A').tobytes()
    seams = [[0]*height]
    for index, anchor in enumerate(xedges[1:-1], 1):
        radius = min(6, (anchor-xedges[index-1])//4, (xedges[index+1]-anchor)//4)
        seams.append(_seam(alpha, width, height, anchor, radius))
    seams.append([width]*height)
    tiles = []
    for left, right in zip(seams, seams[1:]):
        x0, x1 = min(left), max(right)
        tile = source.crop((x0, 0, x1, height))
        masked = bytearray(tile.getchannel('A').tobytes())
        for y in range(height):
            offset = y*(x1-x0)
            masked[offset:offset+left[y]-x0] = bytes(left[y]-x0)
            masked[offset+right[y]-x0:offset+x1-x0] = bytes(x1-right[y])
        tile.putalpha(Image.frombytes('L', tile.size, bytes(masked)))
        # Disconnected locks are still hair. Component size is not evidence
        # that pixels belong to a neighbouring view.
        tiles.append(tile)
    return tiles


def crop_rows(image, yedges, xedges_by_row, *, remove_skin=False):
    """Separate rows as well as columns; long hair can extend past a row anchor."""
    from src.services.avatar_part_batches import isolate_hair
    source = isolate_hair(image) if remove_skin else image.convert('RGBA')
    width, height = source.size
    horizontal = source.getchannel('A').transpose(Image.Transpose.TRANSPOSE).tobytes()
    seams = [[0]*width]
    for index, anchor in enumerate(yedges[1:-1], 1):
        radius = min(24, (anchor-yedges[index-1])//4, (yedges[index+1]-anchor)//4)
        seams.append(_seam(horizontal, height, width, anchor, radius))
    seams.append([height]*width)
    rows = []
    for top, bottom, xedges in zip(seams, seams[1:], xedges_by_row):
        y0, y1 = min(top), max(bottom)
        row = source.crop((0, y0, width, y1))
        alpha = bytearray(row.getchannel('A').tobytes())
        for x in range(width):
            for y in range(y0, top[x]):
                alpha[(y-y0)*width+x] = 0
            for y in range(bottom[x], y1):
                alpha[(y-y0)*width+x] = 0
        row.putalpha(Image.frombytes('L', row.size, bytes(alpha)))
        rows.append(_crop_views(row, xedges))
    return rows


def crop_row(image, y0, y1, xedges, *, remove_skin=False):
    from src.services.avatar_part_batches import isolate_hair
    row = image.crop((0, y0, image.width, y1)).convert('RGBA')
    return _crop_views(isolate_hair(row) if remove_skin else row, xedges)
