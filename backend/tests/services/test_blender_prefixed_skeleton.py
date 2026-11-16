"""The arm geometry worker (sleeve fit, top weights, T rest pose) on a skeleton that prefixes its bone names, against
stand-in Blender modules (tests/fake_blender.py). It looked the limb bones up by their plain names ('LeftArm'): on a
'mixamorig:' skeleton t_rest_pose raised a KeyError outside the per-part guard, and the whole assembly failed."""
import pytest

import fake_blender
from fake_blender import armature, bone, mesh

PREFIXES = ['mixamorig:', 'mixamorig_', 'mixamorig1_']


class EditBone:
    """An edit bone of a fake rig: the matrix it is given becomes the bone's rest frame, as leaving edit mode does."""

    def __init__(self, bone):
        self.bone, self.name, self.use_connect = bone, bone.name, True

    @property
    def matrix(self):
        return self.bone.matrix_local

    @matrix.setter
    def matrix(self, value):
        self.bone.matrix_local, self.bone.head_local = value.copy(), value.translation


def posed_rig(scene, prefix, *, legs=True):
    """A skeleton off the T pose: arms 45 degrees down (115 mm upper and lower arms, a finger past each hand), knees
    bent forward and toes out."""
    rows = [('Hips', (0, 0, .25), None), ('Spine', (0, 0, .32), 'Hips')]
    step = .115*.5**.5   # out and down along one arm segment
    for side, sign in (('Left', 1), ('Right', -1)):
        rows += [(side+'Arm', (sign*.16, 0, .43), 'Spine'),
                 (side+'ForeArm', (sign*(.16+step), 0, .43-step), side+'Arm'),
                 (side+'Hand', (sign*(.16+2*step), 0, .43-2*step), side+'ForeArm'),
                 (side+'HandIndex1', (sign*(.16+2.15*step), 0, .43-2.15*step), side+'Hand')]
        if legs:
            rows += [(side+'UpLeg', (sign*.08, 0, .22), 'Hips'), (side+'Leg', (sign*.10, -.01, .13), side+'UpLeg'),
                     (side+'Foot', (sign*.11, 0, .05), side+'Leg'), (side+'ToeBase', (sign*.13, -.06, .01), side+'Foot')]
    made = {}
    for name, head, parent in rows:
        made[name] = bone(prefix+name, head, made.get(parent))
        ancestor = made[name].parent
        while ancestor is not None:
            ancestor.children_recursive.append(made[name])
            ancestor = ancestor.parent
    rig = armature(scene, 'rig', list(made.values()))
    rig.data.edit_bones = [EditBone(item) for item in rig.data.bones]
    return rig


@pytest.mark.parametrize('prefix', PREFIXES)
def test_a_prefixed_skeleton_is_set_in_the_t_rest_pose(monkeypatch, prefix):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_arm_geometry')
    arms = modules['avatar_arm_geometry']
    scene = bpy.context.scene
    rig = posed_rig(scene, prefix)
    skin = mesh(scene, 'body', [tuple(rig.data.bones[prefix+'LeftHand'].head_local)], rig=rig,
                weights=[{prefix+'LeftHand': 1.}])
    report = arms.t_rest_pose(rig, [skin])
    assert report['rest_pose'] == 'T'
    assert report['wrists_m'] == {'left': pytest.approx([.39, .43, 0.]), 'right': pytest.approx([-.39, .43, 0.])}
    for side, sign in (('left', 1), ('right', -1)):
        legs = report['legs_m'][side]
        assert [legs[joint][0] for joint in ('UpLeg', 'Leg', 'Foot')] == pytest.approx([sign*.08]*3)
    # The skin moved with its hand, and the finger with the hand.
    assert tuple(skin.data.vertices[0].co) == pytest.approx((.39, 0., .43))
    hand, finger = (rig.data.bones[f'{prefix}Left{name}'].head_local for name in ('Hand', 'HandIndex1'))
    assert (finger-hand).length == pytest.approx(.15*.115)


def test_a_skeleton_without_leg_chains_keeps_its_rest_pose(monkeypatch):
    """A skeleton t_rest_pose cannot align (an upper body without legs) is reported as preserved, not a KeyError."""
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_arm_geometry')
    arms = modules['avatar_arm_geometry']
    scene = bpy.context.scene
    rig = posed_rig(scene, 'mixamorig:', legs=False)
    before = {item.name: tuple(item.head_local) for item in rig.data.bones}
    skin = mesh(scene, 'body', [before['mixamorig:LeftHand']], rig=rig, weights=[{'mixamorig:LeftHand': 1.}])
    assert arms.t_rest_pose(rig, [skin]) == {'preserved': True, 'reason': 'unsupported_skeleton'}
    assert {item.name: tuple(item.head_local) for item in rig.data.bones} == before
    assert tuple(skin.data.vertices[0].co) == before['mixamorig:LeftHand']


@pytest.mark.parametrize('prefix', PREFIXES)
def test_a_prefixed_skeleton_fits_and_weights_the_sleeves_on_its_own_arm_bones(monkeypatch, prefix):
    """The sleeve fit of a top without a fit profile and its arm weights looked the arm bones up by their plain names
    as well: on a prefixed skeleton such a top was never offered."""
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_arm_geometry')
    arms = modules['avatar_arm_geometry']
    scene = bpy.context.scene
    rig = armature(scene, 'rig', [bone(prefix+'Spine2', (0, 0, 1.2)), *(
        bone(prefix+side+name, (sign*x, 0, 1.3)) for side, sign in (('Left', 1), ('Right', -1))
        for name, x in (('Arm', .2), ('ForeArm', .4), ('Hand', .6)))])
    # A vest reaching 0.5 m to each side, its middle at x = 0.
    top = mesh(scene, 'top', [(0., 0, 1.35), (.5, 0, 1.3), (-.5, 0, 1.3), (.49, 0, 1.), (-.49, 0, 1.), (0., 0, 1.)])
    for item in rig.data.bones:
        top.vertex_groups.new(name=item.name)
    report, masks = arms.fit_sleeves([top], rig, {'base_body': {'torso_width_m': .3}})
    arms.bind_top_regions([top], rig, masks)
    names = {group.index: group.name for group in top.vertex_groups}
    rows = [{names[entry.group] for entry in vertex.groups} for vertex in top.data.vertices]
    assert set(report['sides']) == {'left', 'right'}
    assert rows[0] == {prefix+'Spine2'}
    assert rows[1] == {prefix+'LeftForeArm'} and rows[2] == {prefix+'RightForeArm'}
