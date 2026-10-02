"""Bounded eligibility checks for an uploaded hair already bound to the frozen body.

The Blender recheck uses the same numeric checks without importing the API's image
inspection dependencies. The service first inspects the complete source and seals
its hash, metrics and selected body into the existing worker input.
"""
import math
import struct

from src.services.glb import parse_glb

MAX_BYTES = 256 * 1024 * 1024
MAX_TRIANGLES = 40000
MAX_VERTICES = 100000
MAX_VALUES = 4_000_000
MAX_CHANNELS = 1024
MAX_PRIMITIVES = 128
ATTRIBUTES = frozenset(('POSITION', 'NORMAL', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1',
    'COLOR_0', 'COLOR_1', 'JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1'))
HEAD_BONES = frozenset(('head', 'neck', 'head_end', 'headfront'))
TOLERANCE = 1e-4


def _finite(values):
    return all(type(v) in (int, float) and math.isfinite(v) for v in values)


def _close(a, b):
    return len(a) == len(b) and _finite(a) and _finite(b) and all(abs(x-y) <= TOLERANCE for x, y in zip(a, b))


def _multiply(a, b):
    return tuple(sum(a[row*4+k]*b[k*4+column] for k in range(4)) for row in range(4) for column in range(4))


def _matrix(node):
    if 'matrix' in node:
        if any(k in node for k in ('translation', 'rotation', 'scale')):
            raise ValueError('Ambiguous native node transform')
        value = node['matrix']
        if len(value) != 16 or not _finite(value): raise ValueError('Nonfinite native rest transform')
        determinant = (value[0]*(value[5]*value[10]-value[9]*value[6])
            - value[4]*(value[1]*value[10]-value[9]*value[2])
            + value[8]*(value[1]*value[6]-value[5]*value[2]))
        if not _close(tuple(value[i] for i in (3, 7, 11, 15)), (0., 0., 0., 1.)) or determinant <= 1e-12:
            raise ValueError('Invalid native affine rest transform')
        return tuple(value[column*4+row] for row in range(4) for column in range(4))
    translation, rotation, scale = (node.get('translation', (0, 0, 0)),
        node.get('rotation', (0, 0, 0, 1)), node.get('scale', (1, 1, 1)))
    if len(translation) != 3 or len(rotation) != 4 or len(scale) != 3 or not _finite((*translation, *rotation, *scale)):
        raise ValueError('Nonfinite native rest transform')
    if any(s <= 0 for s in scale) or abs(sum(v*v for v in rotation)-1) > 1e-5:
        raise ValueError('Invalid native rest transform')
    x, y, z, w = rotation; sx, sy, sz = scale; tx, ty, tz = translation
    return ((1-2*(y*y+z*z))*sx, 2*(x*y-z*w)*sy, 2*(x*z+y*w)*sz, tx,
        2*(x*y+z*w)*sx, (1-2*(x*x+z*z))*sy, 2*(y*z-x*w)*sz, ty,
        2*(x*z-y*w)*sx, 2*(y*z+x*w)*sy, (1-2*(x*x+y*y))*sz, tz, 0., 0., 0., 1.)


def _accessor(doc, binary, index):
    if type(index) is not int or not 0 <= index < len(doc.get('accessors', [])):
        raise ValueError('Invalid native accessor')
    item = doc['accessors'][index]
    if item.get('sparse') or 'bufferView' not in item:
        raise ValueError('Sparse native accessors are not supported')
    sizes = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
    widths = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
    code, size = sizes[item['componentType']]; width = widths[item['type']]
    count = item['count']
    if type(count) is not int or not 0 < count <= 2_000_000: raise ValueError('Native accessor exceeds the bounded size')
    view = doc['bufferViews'][item['bufferView']]
    offset = view.get('byteOffset', 0)+item.get('byteOffset', 0)
    stride = view.get('byteStride', size*width)
    if any(type(v) is not int or v < 0 for v in (offset, stride, view['byteLength'])) or stride < size*width:
        raise ValueError('Invalid native accessor range')
    end = offset+(count-1)*stride+size*width
    if end > len(binary) or end > view.get('byteOffset', 0)+view['byteLength']:
        raise ValueError('Native accessor exceeds its buffer')
    result = []
    for row in range(count):
        value = struct.unpack_from('<'+code*width, binary, offset+row*stride)
        if item.get('normalized'):
            if code not in 'BH': raise ValueError('Unsupported normalized native accessor')
            maximum = (1 << (size*8))-1
            value = tuple(v/maximum for v in value)
        if not _finite(value): raise ValueError('Nonfinite native vertex or binding')
        result.append(value)
    return result


class _Reader:
    """Bound both distinct decoding and aggregate traversal of aliased accessors."""
    def __init__(self, doc, binary):
        self.doc, self.binary, self.cache, self.values = doc, binary, {}, 0

    def __call__(self, index):
        if type(index) is not int or not 0 <= index < len(self.doc.get('accessors', [])):
            raise ValueError('Invalid native accessor')
        item = self.doc['accessors'][index]
        widths = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
        count = item['count']
        if type(count) is not int or count <= 0: raise ValueError('Invalid native accessor size')
        self.values += count*widths[item['type']]
        if self.values > MAX_VALUES: raise ValueError('Native decoded-value traversal budget exceeded')
        if index not in self.cache:
            self.cache[index] = _accessor(self.doc, self.binary, index)
        return self.cache[index]


def _rig(doc, binary, read=None):
    read = read or _Reader(doc, binary)
    nodes = doc.get('nodes', [])
    if len(doc.get('skins', [])) != 1 or len(nodes) > 2048:
        raise ValueError('Exactly one bounded native skin is required')
    parents, matrices = {}, [_matrix(n) for n in nodes]
    for parent, node in enumerate(nodes):
        for child in node.get('children', []):
            if type(child) is not int or not 0 <= child < len(nodes) or child in parents:
                raise ValueError('Invalid native hierarchy')
            parents[child] = parent
    world = {}
    for index in range(len(nodes)):
        chain, current = [], index
        while current not in world:
            if current in chain: raise ValueError('Cyclic native hierarchy')
            chain.append(current)
            if current not in parents: break
            current = parents[current]
        for current in reversed(chain):
            world[current] = _multiply(world[parents[current]], matrices[current]) if current in parents else matrices[current]
            if not _finite(world[current]): raise ValueError('Nonfinite native world rest')
    skin = doc['skins'][0]; joints = skin.get('joints', [])
    if not 0 < len(joints) <= 256 or len(set(joints)) != len(joints): raise ValueError('Invalid native joints')
    if any(type(i) is not int or not 0 <= i < len(nodes) for i in joints): raise ValueError('Invalid native joint reference')
    names = [nodes[i].get('name') for i in joints]
    if any(not isinstance(n, str) or not n or len(n) > 100 for n in names) or len(set(names)) != len(names):
        raise ValueError('Native joint names must be unique')
    accessor = doc['accessors'][skin['inverseBindMatrices']]
    if accessor['type'] != 'MAT4' or accessor['componentType'] != 5126 or accessor['count'] != len(joints):
        raise ValueError('Invalid native inverse bind matrices')
    binds = read(skin['inverseBindMatrices'])
    signature = {}
    for index, name, bind in zip(joints, names, binds):
        if not _close(tuple(bind[i] for i in (3, 7, 11, 15)), (0., 0., 0., 1.)):
            raise ValueError('Invalid native bind transform')
        signature[name] = {'parent': nodes[parents[index]].get('name') if parents.get(index) in joints else None,
            'world': world[index], 'bind': tuple(bind[column*4+row] for row in range(4) for column in range(4))}
    return names, signature, world


def _clips(doc, binary, read=None):
    read = read or _Reader(doc, binary)
    clips = doc.get('animations', [])
    if len(clips) > 32 or sum(len(c['channels']) for c in clips) > MAX_CHANNELS:
        raise ValueError('Native animation channel budget exceeded')
    result = {}
    for clip in clips:
        name = clip.get('name')
        if not isinstance(name, str) or name in result: raise ValueError('Invalid native clip name')
        channels = {}
        for channel in clip['channels']:
            target = channel['target']; node = doc['nodes'][target['node']]
            key = (node.get('name'), target['path'])
            if key in channels: raise ValueError('Duplicate native clip channel')
            sampler = clip['samplers'][channel['sampler']]
            times = read(sampler['input'])
            if any(b[0] <= a[0] for a, b in zip(times, times[1:])): raise ValueError('Invalid native clip time')
            channels[key] = (sampler.get('interpolation', 'LINEAR'), times, read(sampler['output']))
        result[name] = channels
    return result


def _validate_native_hair(content, *, body_content=None, inspect=True):
    """Return measured runtime metrics, or reject; no fitting or supplier I/O occurs."""
    if not 0 < len(content) <= MAX_BYTES: raise ValueError('Native hair exceeds the bounded size')
    doc, binary = parse_glb(content, strict=True)
    if (len(doc.get('nodes', [])) > 2048 or len(doc.get('accessors', [])) > 4096
            or sum(len(m['primitives']) for m in doc.get('meshes', [])) > MAX_PRIMITIVES):
        raise ValueError('Native accessor or primitive budget exceeded')
    clips = doc.get('animations', [])
    if len(clips) > 32 or sum(len(c['channels']) for c in clips) > MAX_CHANNELS:
        raise ValueError('Native animation channel budget exceeded')
    if inspect:
        from src.services.asset_delivery import DeliveryPolicy, inspect_glb
        check = inspect_glb(content, DeliveryPolicy(max_file_bytes=MAX_BYTES,
            max_vertices=MAX_VERTICES, max_triangles=MAX_TRIANGLES, max_texture_dimension=2048))
        if check['errors']: raise ValueError('Native hair structure or runtime budget is invalid')
    read = _Reader(doc, binary)
    names, signature, _ = _rig(doc, binary, read)
    if not any(n.casefold() == 'head' for n in names): raise ValueError('Native hair requires the body head bone')
    mesh_nodes = [(i, n) for i, n in enumerate(doc['nodes']) if 'mesh' in n]
    if (not mesh_nodes or any(type(n['mesh']) is not int for _, n in mesh_nodes)
            or sorted(n['mesh'] for _, n in mesh_nodes) != list(range(len(doc.get('meshes', []))))):
        raise ValueError('Native hair has hidden or multiply instantiated meshes')
    triangles = vertices = 0
    for index, node in mesh_nodes:
        tags = node.get('extras') or {}
        if (node.get('skin') != 0 or type(node.get('skin')) is not int or not isinstance(tags, dict)
                or not any(tags.get(k) == 'hair' for k in ('part_role', 'standard_slot'))
                or any(tags.get(k) not in (None, 'hair') for k in ('part_role', 'standard_slot'))):
            raise ValueError('Every native mesh must be tagged and skinned as hair')
        for primitive in doc['meshes'][node['mesh']]['primitives']:
            attributes = primitive['attributes']
            if not attributes.keys() <= ATTRIBUTES: raise ValueError('Unsupported native vertex attributes')
            if primitive.get('mode', 4) != 4 or primitive.get('targets'):
                raise ValueError('Only static native triangle meshes are accepted')
            positions = read(attributes['POSITION']); vertices += len(positions)
            if doc['accessors'][attributes['POSITION']]['type'] != 'VEC3': raise ValueError('Invalid native positions')
            indices = read(primitive['indices']) if 'indices' in primitive else [(i,) for i in range(len(positions))]
            if len(indices) % 3 or any(len(i) != 1 or type(i[0]) is not int or not 0 <= i[0] < len(positions) for i in indices):
                raise ValueError('Invalid native triangle indices')
            triangles += len(indices)//3
            for attribute, accessor in attributes.items():
                values = read(accessor)
                if len(values) != len(positions): raise ValueError('Native attribute count changed')
                if attribute.startswith(('JOINTS_', 'WEIGHTS_')) and attribute not in ('JOINTS_0', 'WEIGHTS_0', 'JOINTS_1', 'WEIGHTS_1'):
                    raise ValueError('Unsupported native joint set')
            totals = [0.]*len(positions)
            for suffix in ('0', '1'):
                jkey, wkey = 'JOINTS_'+suffix, 'WEIGHTS_'+suffix
                if suffix == '1' and jkey not in attributes and wkey not in attributes: continue
                if jkey not in attributes or wkey not in attributes: raise ValueError('Missing native skin weights')
                ja, wa = doc['accessors'][attributes[jkey]], doc['accessors'][attributes[wkey]]
                if ja['type'] != 'VEC4' or ja['componentType'] not in (5121, 5123) or ja.get('normalized'):
                    raise ValueError('Invalid native joint accessor')
                if wa['type'] != 'VEC4' or (wa['componentType'] != 5126 and not (wa['componentType'] in (5121, 5123) and wa.get('normalized'))):
                    raise ValueError('Invalid native weight accessor')
                for row, (joints, weights) in enumerate(zip(read(attributes[jkey]), read(attributes[wkey]))):
                    for joint, weight in zip(joints, weights):
                        if type(joint) is not int or not 0 <= joint < len(names) or not 0 <= weight <= 1:
                            raise ValueError('Invalid native skin binding')
                        if weight > 0 and names[joint].casefold() not in HEAD_BONES:
                            raise ValueError('Native hair is bound outside the head bone family')
                    totals[row] += sum(weights)
            if any(abs(total-1.) > 1e-5 for total in totals): raise ValueError('Native weights must be nonempty and normalized')
    if triangles > MAX_TRIANGLES or vertices > MAX_VERTICES: raise ValueError('Native hair exceeds the runtime geometry budget')
    clips = _clips(doc, binary, read)
    if body_content is not None:
        if not 0 < len(body_content) <= MAX_BYTES: raise ValueError('Native body exceeds the bounded size')
        body_doc, body_binary = parse_glb(body_content, strict=True)
        body_read = _Reader(body_doc, body_binary)
        _, body_signature, _ = _rig(body_doc, body_binary, body_read)
        if signature.keys() != body_signature.keys(): raise ValueError('Native hair bone names differ from the body')
        for name, source in signature.items():
            target = body_signature[name]
            if source['parent'] != target['parent'] or not _close(source['world'], target['world']) or not _close(source['bind'], target['bind']):
                raise ValueError('Native hair rest pose or inverse bind differs from the body')
            # Skinned glTF world positions use joint-world * inverse-bind;
            # the mesh-node world transform cancels in the skinning equation.
            # Native body exports can retain a centimetre mesh node while a
            # separately exported hair node is identity: compare bind space.
            if not _close(_multiply(source['world'], source['bind']), _multiply(target['world'], target['bind'])):
                raise ValueError('Native hair bind coordinate frame differs from the body')
        if clips and clips != _clips(body_doc, body_binary, body_read): raise ValueError('Native hair clips differ from the body motions')
    return {'source_triangles': triangles, 'runtime_triangles': triangles, 'target_triangles': MAX_TRIANGLES,
        'budget_met': True, 'preserved': True, 'optimization': 'native_upload_preserved', 'texture_max_edge': 2048}


def validate_native_hair(content, *, body_content=None, inspect=True):
    """Fail closed on malformed data; all caller-visible failures are ValueError."""
    try:
        return _validate_native_hair(content, body_content=body_content, inspect=inspect)
    except ValueError:
        raise
    except (KeyError, IndexError, TypeError, struct.error, OverflowError) as exc:
        raise ValueError('Invalid native hair structure') from exc
