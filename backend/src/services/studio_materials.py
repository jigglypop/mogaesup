"""Bounded runtime derivatives from preserved provider images and GLBs."""
import hashlib
import io
import math

from PIL import Image

from src.services.asset_editor import _write_json
from src.services.glb import parse_glb, build_glb


def texture_maps(source, directory, size):
    with Image.open(io.BytesIO(source.read_bytes())) as image:
        rgb = image.convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
    # Mirrored edge blending makes the tile periodic without inventing an AI
    # material estimate. Normal/roughness maps are explicitly local derivatives.
    edge = max(4, size//32)
    for axis in (0, 1):
        for offset in range(edge):
            a = (0, offset, size, offset+1) if axis == 0 else (offset, 0, offset+1, size)
            b = (0, size-1-offset, size, size-offset) if axis == 0 else (size-1-offset, 0, size-offset, size)
            first, last = rgb.crop(a), rgb.crop(b)
            average = Image.blend(first, last, .5)
            weight = (1-offset/edge)**2
            rgb.paste(Image.blend(first, average, weight), a)
            rgb.paste(Image.blend(last, average, weight), b)
    height = rgb.convert('L').tobytes(); normals = bytearray()
    for y in range(size):
        for x in range(size):
            dx = (height[y*size+(x+1)%size]-height[y*size+(x-1)%size])*2/255
            dy = (height[((y+1)%size)*size+x]-height[((y-1)%size)*size+x])*2/255
            length = math.sqrt(dx*dx+dy*dy+1)
            normals.extend(round(127.5*(value/length+1)) for value in (-dx, dy, 1))
    arrays = {'albedo.webp': rgb, 'normal.webp': Image.frombytes('RGB', (size, size), bytes(normals)),
              'orm.webp': Image.new('RGB', (size, size), (255, 220, 0))}
    files = {}
    for name, image in arrays.items():
        stream = io.BytesIO()
        image.save(stream, format='WEBP', lossless=True, method=4)
        content = stream.getvalue(); (directory/name).write_bytes(content)
        files[name] = hashlib.sha256(content).hexdigest()
    gpu = {'texture_count': 3, 'estimated_bytes_with_mips': size*size*4*3*4//3}
    manifest = {'schema': 'gaesup-webgpu-tile-v1', 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                'size': size, 'tileable': True, 'edge_processing': 'mirror-edge-blend-v1',
                'normal_source': 'albedo-luminance-approximation', 'roughness': 220/255, 'metalness': 0,
                'material': {'baseColor': 'albedo.webp', 'normal': 'normal.webp', 'orm': 'orm.webp',
                             'baseColorSpace': 'srgb', 'dataColorSpace': 'linear', 'wrap': 'repeat',
                             'mipmaps': True, 'normalConvention': 'OpenGL'}, 'gpu': gpu, 'files': dict(files)}
    _write_json(directory/'manifest.json', manifest)
    files['manifest.json'] = hashlib.sha256((directory/'manifest.json').read_bytes()).hexdigest()
    return files, gpu


def prop_model(source, output, max_edge=512):
    document, binary = parse_glb(source.read_bytes(), strict=True)
    triangles = 0
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            count = document['accessors'][primitive.get('indices', primitive['attributes']['POSITION'])]['count']
            mode = primitive.get('mode', 4)
            triangles += count//3 if mode == 4 else max(0, count-2) if mode in (5, 6) else 0
    budget = {'requested_target_polygons': 2000, 'runtime_triangles': triangles,
              'requested_texture_max_edge': max_edge}
    if any('EXT_meshopt_compression' in view.get('extensions', {}) for view in document.get('bufferViews', [])):
        # Meshopt stores independent byte offsets; preserve that compressed file.
        output.write_bytes(source.read_bytes())
        return {**budget, 'texture_max_edge': None, 'resized_textures': 0}
    replacements = {}; edges = []; unknown_image = False
    for image in document.get('images', []):
        formats = {'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP'}
        if 'bufferView' not in image or image.get('mimeType') not in formats:
            unknown_image = True
            continue
        index = image['bufferView']; view = document['bufferViews'][index]; start = view.get('byteOffset', 0)
        with Image.open(io.BytesIO(binary[start:start+view['byteLength']])) as original:
            edges.append(min(max(original.size), max_edge))
            if max(original.size) <= max_edge:
                continue
            resized = original.copy(); resized.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            stream = io.BytesIO(); resized.save(stream, format=formats[image['mimeType']])
            replacements[index] = stream.getvalue()
    packed = bytearray()
    for index, view in enumerate(document.get('bufferViews', [])):
        start = view.get('byteOffset', 0)
        content = replacements.get(index, binary[start:start+view['byteLength']])
        packed.extend(b'\0'*(-len(packed)%4))
        view.update(byteOffset=len(packed), byteLength=len(content)); packed.extend(content)
    document['buffers'][0]['byteLength'] = len(packed)
    output.write_bytes(build_glb(document, bytes(packed)))
    return {**budget, 'texture_max_edge': None if unknown_image else max(edges, default=0),
            'resized_textures': len(replacements)}
