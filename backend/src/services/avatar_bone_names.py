"""Bone lookup across skeletons: a skeleton may prefix its bone names ('mixamorig:LeftArm', 'mixamorig_LeftArm').

As bind() and the wardrobe (avatar_wardrobe_coverage.bone_keys) do, a bone is found by its own name first, then by the
name in lower case without the rig prefix.
"""
import re

# The prefixes avatar_wardrobe_coverage.bone_keys removes: up to the last ':', then a Mixamo 'mixamorig_' or 'mixamorig1_'.
_RIG_PREFIX = re.compile(r'^(?:.*[:])?(?:mixamorig\d*_)?')


def bone_key(name):
    """'mixamorig:LeftArm', 'mixamorig_LeftArm' and 'LeftArm' are all 'leftarm'."""
    return _RIG_PREFIX.sub('', name.lower(), count=1)


def bone_name(rig, name):
    """The name `rig` gives the bone `name` ('mixamorig:LeftArm' for 'LeftArm'), or None when it has none."""
    bones = rig.data.bones
    if name in bones:
        return name
    wanted = bone_key(name)
    return next((bone.name for bone in bones if bone_key(bone.name) == wanted), None)
