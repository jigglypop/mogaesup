"""Existing equipment layers and measured sockets for saved native bodies."""
from typing import Literal

ImageSlot = Literal['body', 'hair', 'head', 'face', 'hairBack', 'hairFront', 'hat', 'top', 'bottom', 'shoes',
                    'weapon', 'shield', 'back', 'faceAccessory', 'neckAccessory', 'tool', 'glasses']
EQUIPMENT = {
    'weapon': {'label': '무기', 'slot': 'hand', 'bone': 'handR', 'size': .9,
               'anchor': [.5, .15, .5], 'placement': [50, 220, 100, 250],
               'description': 'one Maple-style fantasy sword or staff, upright with its grip centered at 15 percent of the full height from the bottom; complete handle and blade, no hand or character'},
    'shield': {'label': '방패', 'slot': 'offhand', 'bone': 'handL', 'size': .5,
               'anchor': [.5, .5, .1], 'placement': [340, 300, 130, 140],
               'description': 'one small fantasy shield, front toward camera, complete back handle centered behind the shield; no arm or character'},
    'back': {'label': '등 장비', 'slot': 'back', 'bone': 'upperChest', 'size': .65,
             'anchor': [.5, .8, .9], 'placement': [145, 265, 220, 170],
             'description': 'one rigid back ornament or wing ornament, front toward camera, upper-center attachment against the back; no body or character'},
    'faceAccessory': {'label': '얼굴 장식', 'slot': 'faceAccessory', 'bone': 'head', 'size': .55,
                      'anchor': [.5, .5, .5], 'placement': [155, 145, 200, 80],
                      'description': 'one pair of fantasy glasses or face ornament; complete rims and temples, no face or hair'},
    'neckAccessory': {'label': '목 장식', 'slot': 'neckAccessory', 'bone': 'neck', 'size': .23,
                      'anchor': [.5, .9, .5], 'placement': [220, 275, 75, 65],
                      'description': 'one necklace with a complete chain and pendant, front toward camera; no neck, torso or character'},
    'tool': {'label': '도구', 'slot': 'offhand', 'bone': 'handL', 'size': .45,
             'anchor': [.5, .2, .5], 'placement': [350, 250, 100, 180],
             'description': 'one handheld tool with its full handle and working end, no hand or character'},
    'glasses': {'label': '안경', 'slot': 'faceAccessory', 'bone': 'head', 'size': .55,
                'anchor': [.5, .5, 1], 'placement': [155, 145, 200, 80],
                'description': 'one pair of glasses with complete rims, bridge and temples, no face or hair'},
}
NATIVE_EQUIPMENT = {'weapon': 'RightHand', 'tool': 'LeftHand', 'glasses': 'Head'}
NATIVE_BODY_SLOTS = frozenset(('body', 'hair', 'head', 'hairBack', 'hairFront',
                               'hat', 'top', 'bottom', 'shoes'))


def is_native_part_set(slots):
    slots = list(slots)
    selected = set(slots)
    if len(slots) != len(selected) or 'body' not in selected:
        return False
    if selected-set(NATIVE_EQUIPMENT)-NATIVE_BODY_SLOTS:
        return False
    # ``head`` is a legacy combined replacement. Likewise ``hair`` is the
    # combined hairstyle and cannot be mixed with split front/back assets.
    if 'head' in selected and selected & {'hair', 'hairBack', 'hairFront', 'hat'}:
        return False
    if 'hair' in selected and selected & {'hairBack', 'hairFront'}:
        return False
    return True


def equipment_layer(slot, order):
    item = EQUIPMENT[slot]
    return {'slot': slot, 'label': item['label'], 'asset': None, 'crop': [0, 0, 1, 1],
            'placement': item['placement'][:], 'visible': True, 'opacity': 1., 'order': order,
            'background': 'border-gray', 'status': 'needs_image', 'description': ''}


def equipment_spec(spec):
    anchors = spec['anchors']
    height = spec['body_height_m']
    head = spec.get('measured_head_bounds_m', spec['fitting']['bounds']['body'])
    neck, crown = anchors['neck'][1], anchors['crown'][1]
    sockets = {}
    for slot, bone in NATIVE_EQUIPMENT.items():
        if slot == 'glasses':
            width = (head[1][0]-head[0][0])*.72
            size = [width, (crown-neck)*.16, (head[1][2]-head[0][2])*.65]
            socket = [anchors['crown'][0], head[0][1]+(head[1][1]-head[0][1])*.40, head[1][2]+.008]
            pivot = [.5, .5, 1.0]
        else:
            socket = anchors['wrist_right' if slot == 'weapon' else 'wrist_left'][:]
            size = [height*.12, height*(.42 if slot == 'weapon' else .28), height*.08]
            pivot = [.5, .2, .5]
        box = [[socket[i]-size[i]*pivot[i] for i in range(3)],
               [socket[i]+size[i]*(1-pivot[i]) for i in range(3)]]
        spec['fitting']['bounds'][slot] = box
        spec['envelopes'][slot] = [[box[0][i]-.02 for i in range(3)], [box[1][i]+.02 for i in range(3)]]
        sockets[slot] = {'bone': bone, 'position_m': socket, 'pivot_fraction': pivot, 'size_m': size}
    spec['equipment'] = sockets
    return spec
