"""One image-layout contract shared by prompts, visual guides, and fitting."""
import json

from src.services.avatar_production_spec import bounds_pixels, envelope_pixels, project

PROMPT_REVISION = 'visual-parts-v22'
AXIS_LOCK = (
    'Use the body guide T-pose: upright torso, level shoulders and hips, straight horizontal arms, '
    'straight legs and flat forward-facing feet. Clothing follows this worn pose. '
    'For another view move only the camera; keep the object and its intentional design asymmetry fixed. '
)
PART_CONTENT = {
    'weapon': 'Only one stylized weapon matching the requested design. Complete the grip, guard and blade or head. Exclude the hand, person, stand and effects.',
    'tool': 'Only one requested handheld tool with its complete handle and working end. Exclude the hand, person, stand and spare objects.',
    'glasses': 'Only one pair of wearable glasses: connected lenses, bridge and two complete temples. Exclude face, eyes, hair and hat. Keep the eye openings clear.',
    'hair': 'One complete hairstyle with its original bangs, side locks, crown, rear hair and nape. Complete any hair hidden by headwear in the same style. Exclude headwear, face, scalp skin, ears, neck, body and clothes. Keep the hair-colored root backing and an open head cavity.',
    'hairBack': 'One separate sculpted rear-hair component for a stylized game figurine, covering the crown, back and nape. Output hair strands and their hair-colored scalp backing only. Remove ALL headwear from the reference: no hat, cap, brim, rabbit ears, ear flaps, hood, headband or hat-colored patches. Reconstruct the hair that was hidden beneath the hat. Exclude the figurine, bangs and clothing.',
    'hairFront': 'One separate sculpted front-hair and bangs component for the same game figurine. Preserve the face opening; output hair only, without the figurine, rear hair, hat, cap, rabbit ears, ear flaps or headband.',
    'hat': 'ONE separate removable HEAD ACCESSORY of the exact type in the reference: headband, hairband, bow, hair ornament, crown, cap or hat. Preserve its original thin bands, open spaces, attached ornaments and silhouette. A headband stays an open narrow band; never add a hat crown, brim, cap shell or closed head covering unless the original actually has them. Exclude ALL hair, bangs, side locks, rear hair, scalp, face and body. The hairstyle is a different independently generated part, never part of this object.',
    'top': 'Only the original upper garment, collar, sleeves, cuffs and hem; complete its neck, wrist and waist openings. Exclude hands and body.',
    'bottom': 'Only the original lower garment, waistband and lining; complete its body and leg openings. Exclude legs, torso and shoes.',
    'shoes': 'Only the original matching pair of shoes at the two feet positions, including ankle openings; exclude feet and legs. In profile the far shoe may be occluded; do not spread shoes for display.',
}

# The editable design layer is separate from the shared camera/body frame.
# The full metric fitting contract stays in layout_contract() and the receipt.
from src.services.studio_prompts import DEFAULTS as STUDIO_PROMPTS

DEFAULT_DESIGN_PROMPTS = {key: STUDIO_PROMPTS['parts'][key]
                          for key in ('body', 'hair', 'hat', 'top', 'bottom', 'shoes')}

PART_FIT = {
    'weapon': 'The grip center is at the right wrist socket in equipment. Long axis points +Y, with no roll or yaw; the grip center is 20 percent up from the lowest point. Preserve the requested silhouette and thickness. No wrist geometry.',
    'tool': 'The handle grip is at the left wrist socket in equipment. Long axis points +Y; the grip center is 20 percent up from the lowest point. Preserve the requested silhouette and thickness. No wrist geometry.',
    'glasses': 'The bridge is centered on the facial centerline at the specified eye height. Both lens centers are level. Temples extend backward along -Z around the head with open ends. No solid face plate or opaque lens fill.',
    'hair': (
        'Keep the original hair volume, parting and locks around the shared head. '
        'Join the roots with a continuous HAIR-COLORED backing across the crown, sides and back down to the nape. '
        'This backing is hair, not skin: keep it when excluding the head. A normal parting may remain visible. '
        'The face and neck openings stay open; the inside is a head cavity, not a hole through the rear hair. '
        'Continue any hat-hidden hair in the same style. Preserve asymmetric locks and the outer silhouette.'),
    'hairBack': (
        'Own the rear scalp, rear crown and nape only. Leave the forehead, face and bangs region empty. '
        'Follow the skull surface with a hollow inner cavity; never fill that cavity with a solid head. '
        'Long hair follows the original outline and stays outside the neck, shoulders and upper garment. '
        'Do not add a second fringe, duplicate side locks or an oversized rear volume.'),
    'hairFront': (
        'Own the fringe and original front locks only; the rear scalp and rear crown belong to hairBack. '
        'Keep the original face opening, eye visibility and hairline. Roots follow the outside of the scalp. '
        'Do not include a second rear hair shell, solid skull, face mask or strands running through the face.'),
    'hat': (
        'Fit the original band, clip or head opening to its worn attachment position on the hair with clearance. '
        'Keep the original accessory type, band thickness, open spaces, tilt and ornament proportions in the common coordinate frame. '
        'The headwear target is a placement envelope, not a solid shape to fill. Do not expand a small ornament into a hat or float it above the hair.'),
    'top': (
        'Place collar at the neck, shoulders at shoulder anchors, cuffs at wrist anchors and hem at the original waist level. '
        'Sleeves follow the frozen T-pose: upper arms, elbows, cuffs and wrists are on one horizontal line at shoulder height. Keep neck, sleeve and hem cavities open. '
        'Use the specified garment size with modest ease around the torso, sleeves and cuffs. '
        'Do not enlarge the garment to cover protruding base clothing; that base layer is cropped during assembly. '
        'Preserve the original design and folds without embedding hands, torso or neck geometry.'),
    'bottom': (
        'Place the waistband at the frozen waist. For trousers, place each leg opening around its corresponding leg. '
        'Use the specified garment size with modest ease around the hips, thighs and leg openings. '
        'For trousers preserve the crotch and two hollow leg openings. For a skirt, keep a single continuous open hem and hollow waist; never split the skirt into trouser legs. '
        'Where the top covers the waistband, use separate nested surfaces with clearance, never crossing surfaces. '
        'Keep the specified width and depth ease; do not tighten the garment against the legs. '
        'Do not fuse the legs, extend the garment into the shoes or duplicate the torso.'),
    'shoes': (
        'Create exactly one left and one right shoe at the ankle anchors; no extra shoes or detached soles. '
        'Keep ankle cavities hollow, original toe direction and original sole thickness. '
        'The inner shoe contains its foot with clearance; the ankle rim does not cut through the foot or lower garment. '
        'Both soles share the floor. Never separate, rotate outward, stack or vertically offset the pair for presentation.'),
}


def layout_contract(spec, slot, view):
    c = spec['canvas']
    layout = {
        'units': spec['units'],
        'world_axes': spec['axes'],
        'world_origin': spec['origin'],
        'body_height_m': spec['body_height_m'],
        'rest_pose': spec.get('rest_pose', 'T'),
        'allowed_part_bounds_m': spec['envelopes'][slot],
        'body_landmarks_m': spec['anchors'],
        'hair_length_mode': spec['fitting'].get('hair_length', 'source'),
        'hair_length_in_head_heights': spec['fitting'].get('hair_length_head_ratio'),
        'base_body_cross_sections_m': spec.get('base_body', {}),
        'equipment': spec.get('equipment', {}).get(slot),
        'canvas_px': [c['width'], c['height']],
        'pixel_coordinates': 'origin top-left, x right, y down; bounds [left, top, right, bottom]',
        'camera': spec['views'][view]['camera'],
        'pixels_per_metre': c['pixels_per_metre'],
        'centerline_x': c['center_x'],
        'scalp_top_y': c['scalp_y'],
        'sole_bottom_y': c['sole_y'],
        'body_height_px': c['sole_y']-c['scalp_y'],
        'head_height_px': round((spec['anchors']['crown'][1]-spec['anchors']['neck'][1])*c['pixels_per_metre']),
        'allowed_part_bounds_px': [round(n, 2) for n in envelope_pixels(slot, view, spec)],
        'body_landmarks_px': {name: [round(n, 2) for n in project(point, view, spec)] for name, point in spec['anchors'].items()},
        'pixel_tolerance': spec['tolerances']['canvas_px'],
        'paired_view_height_tolerance_px': spec['tolerances']['view_height_px'],
    }
    fit_profile = spec.get('fit_profiles', {}).get(slot)
    if fit_profile:
        layout['garment_fit_profile'] = {**fit_profile, 'coordinate_units': spec['units']}
        layout['garment_fit_profile_sha256'] = spec.get('fit_profiles_sha256')
    if spec.get('fitting'):
        target = spec['fitting']['bounds'][slot]
        layout['fitting_revision'] = spec['fitting']['revision']
        if not (fit_profile and slot in ('top', 'bottom')):
            layout.update(target_part_bounds_m=target,
                          target_part_size_m=[round(b-a, 6) for a, b in zip(*target)],
                          target_part_bounds_px=[round(n, 2) for n in bounds_pixels(target, view, spec)])
        if slot == 'shoes':
            layout['shoe_bounds_m'] = spec['fitting']['shoe_bounds']
        if slot in spec['fitting'].get('garment_margin_m', {}):
            layout['garment_ease_each_side_xz_m'] = spec['fitting']['garment_margin_m'][slot]
    return layout


def reference_roles(slot, view, *, hair_reference=False, design_from_body_template=False):
    roles = ['GEOMETRY TEMPLATE: exact canvas, silhouette proportions, pose and pixel placement. Colored lines are measurement marks only.']
    if slot != 'body':
        roles.append('FROZEN BODY IN THIS VIEW: exact garment/hair/hat fit, scale and worn position. Do not render the body in the output.')
    if hair_reference:
        roles.append('FROZEN COMPLETE HAIR IN THIS VIEW: exact outer hair volume, crown, centerline and headwear seat. Fit the separate head accessory onto this hair at its original attachment point with clearance. Do NOT render any hair in the accessory output.')
    if design_from_body_template and slot != 'body':
        roles.append(
            'SOURCE BODY TEMPLATE: bald scalp, skin/body shape and proportions only. It contains no source hair, '
            'garment, head accessory or shoes to extract. Use it only for fit, scale and attachment; create the '
            'requested part from the USER-EDITABLE DESIGN BRIEF.')
    else:
        roles.append('ORIGINAL ART: plain skin color and stylized proportions only. Omit all facial features and use the geometry template pose.'
                     if slot == 'body' else
                     'ORIGINAL ART: colors and requested part design only. Its framing, pose and body proportions are not the layout template.')
    if view in ('side', 'back', 'opposite'):
        roles.append('ACCEPTED FRONT VIEW OF THE SAME OBJECT: preserve its identity, shape, top and bottom pixel rows. Rotate it; do not redesign it.')
    if view in ('back', 'opposite'):
        roles.append('ACCEPTED RIGHT-SIDE VIEW OF THE SAME OBJECT: preserve its depth, rear extent and top and bottom pixel rows. Rotate it to the rear; do not redesign it.')
    if view == 'opposite':
        roles.append('ACCEPTED BACK VIEW OF THE SAME OBJECT: preserve rear roots and asymmetry; rotate to the other side, never mirror it.')
    return roles


def hair_length_prompt(spec, *, source_reference=True):
    mode = spec['fitting'].get('hair_length', 'source')
    ratio = spec['fitting'].get('hair_length_head_ratio')
    if mode == 'source':
        if not source_reference:
            return (' NEW-STYLE LENGTH MODE: the bald body template contains no source hair and does not mean zero hair length. '
                    'Use the hairstyle and length stated in the USER-EDITABLE DESIGN BRIEF. If it gives no exact length, '
                    'choose a coherent length for that requested style while staying inside the allowed envelope.')
        return (' ORIGINAL LENGTH MODE: the target lower bound is available space, NOT a required tip height or a short-hair maximum. '
                'Read the hair tips relative to the face, shoulders, waist and boots in the original art. '
                'Preserve short hair as short and long hair as long; do not lengthen or shorten it to fill the template.')
    return (f' SELECTED LENGTH MODE: {mode}. Crown-to-tip length is {ratio:g} times the bald crown-to-neck head height. '
            'Measure that length from the shared body guide. This explicit length selection overrides only the '
            + ('original length; retain its color and hairstyle details.' if source_reference else
               'length implied by the design brief; retain the brief color and hairstyle details.'))


def garment_fit_prompt(slot, profile, *, source_reference=True):
    """Describe only authored garment choices; null/source retains source art."""
    length = profile['length_ratio']
    ease = profile['ease']
    region_ease = profile.get('region_ease') or {}
    lines = [
        'Match the named attachment points to the supplied body guide.',
        (('Preserve the source garment length and its relationship to the body landmarks.' if source_reference else
          'Choose the garment length described by the design brief; if omitted, choose a coherent length for that design.') if length is None else
         f'End the garment at length_ratio={length:g} along the '
         + ('neck-to-waist interval.' if slot == 'top' else 'waist-to-ankle interval.')),
        (('Preserve the source ease and silhouette.' if source_reference else
          'Use the ease and silhouette described by the design brief without copying the fitted body underlayer.') if ease == 'source' else
         f'Use {ease} ease while retaining the '
         + ('source design and openings.' if source_reference else 'design-brief silhouette and openings.')),
        'Do not stretch the garment to fill an overall XYZ target box.',
    ]
    relevant_regions = ('torso', 'sleeve') if slot == 'top' else ('hip',)
    overrides = [(region, region_ease[region]) for region in relevant_regions if region in region_ease]
    if overrides:
        lines.append('Apply these region ease overrides: '
                     + ', '.join(f'{region}={value}' for region, value in overrides)
                     + '. Regions without an override use the common ease setting above.')
    if slot == 'top':
        sleeve = profile['sleeve']
        sleeve_ratio = profile['sleeve_ratio']
        if sleeve == 'source':
            lines.append('Preserve the original sleeve type and sleeve endpoint ratio from the source image.' if source_reference else
                         'Use the sleeve type and endpoint stated in the design brief; if omitted, choose a coherent sleeve for that design.')
        elif sleeve == 'none':
            lines.append('This garment is sleeveless. End each arm opening at the shoulder; do not generate sleeve geometry or wrist cuffs.')
        elif sleeve == 'short':
            lines.append('Use short sleeves; end each sleeve before the elbow'
                         + (f' at shoulder-to-wrist ratio {sleeve_ratio:g}.' if sleeve_ratio is not None else
                            (' at the source design endpoint.' if source_reference else ' at the design-brief endpoint.')
                            + ' Never extend cuffs to the wrists.'))
        else:
            lines.append('Use long sleeves; follow each arm toward the wrist'
                         + (f' and end at shoulder-to-wrist ratio {sleeve_ratio:g}.' if sleeve_ratio is not None else
                            (' and end at the original long-sleeve endpoint.' if source_reference else
                             ' and end at the design-brief long-sleeve endpoint.')))
    else:
        kind = profile['kind']
        lines.append((('Preserve whether the source is trousers or a skirt.' if source_reference else
                       'Use the trousers or skirt kind stated in the design brief; if omitted, choose the kind implied by that design.') if kind == 'source' else
                      'Keep two separate hollow leg openings and a crotch.' if kind == 'pants' else
                      'Keep one continuous hollow skirt hem; do not create trouser legs or a crotch split.'))
    return ' '.join(lines)


def garment_part_content(slot, *, source_reference=True):
    if slot == 'top':
        return (
            'Place the collar and shoulders at their named frozen-body anchors. Keep the neck, arm and hem cavities open. '
            'Follow the sleeve setting described below; sleeve ends are not always wrist cuffs. '
            + ('Preserve the source garment width, depth, folds and design while maintaining clearance from the torso and arms. ' if source_reference else
               'Create the width, depth, folds and design from the design brief while maintaining clearance from the torso and arms. ') +
            'Do not enlarge the garment to cover protruding base clothing; that base layer is cropped during assembly. '
            'Do not embed hands, torso or neck geometry.')
    return (
        'Place the waistband at the frozen waist and follow the kind, length and ease described below. '
        'For trousers keep distinct left and right hollow leg openings. For a skirt keep one continuous hollow hem. '
        'Where the top covers the waistband, use separate nested surfaces with clearance, never crossing surfaces. '
        + ('Preserve the source width, depth, silhouette and hem construction. ' if source_reference else
           'Create the width, depth, silhouette and hem construction from the design brief. ') +
        'Do not fuse the legs, extend the garment into the shoes or duplicate the torso.')


def body_template_part_content(slot):
    """Isolation contract for a new part when the only appearance image is a bald body."""
    content = {
        'weapon': 'Only one new stylized weapon specified by the design brief. Complete its grip, guard and blade or head. Exclude the hand, person, stand and effects.',
        'tool': 'Only one new handheld tool specified by the design brief, with its complete handle and working end. Exclude the hand, person, stand and spare objects.',
        'glasses': 'Only one new pair of wearable glasses specified by the design brief: connected lenses, bridge and two complete temples. Exclude face, eyes, hair and hat. Keep the eye openings clear.',
        'hair': 'Create one complete hairstyle from the design brief: bangs, side locks, crown, rear hair and nape. Exclude scalp skin, face, headwear, body and clothes. Retain the hair-colored root backing around the open head cavity.',
        'hairBack': 'Create one new rear-hair component specified by the design brief, covering the crown, back and nape. Output hair strands and hair-colored scalp backing only. Exclude the figurine, bangs, headwear and clothing.',
        'hairFront': 'Create one new front-hair and bangs component specified by the design brief. Preserve the face opening; exclude the figurine, rear hair and headwear.',
        'hat': 'Create ONE separate removable head accessory of the type specified by the design brief. Preserve intentional open spaces and complete its attachment opening. Exclude hair, scalp, face and body.',
        'top': 'Create only the new upper garment specified by the design brief, including its collar, sleeves or arm openings, cuffs where applicable and hem. Keep every attachment opening hollow. Exclude hands and body.',
        'bottom': 'Create only the new lower garment specified by the design brief, including its waistband, lining and hollow body and hem or leg openings. Exclude legs, torso and shoes.',
        'shoes': 'Create only the new matching pair of shoes specified by the design brief at the two feet positions, including hollow ankle openings. Exclude feet and legs; do not spread the shoes for display.',
    }
    return content[slot]


def build_prompt(spec, slot, view, *, previous_qc=None, accepted_front_qc=None, accepted_side_qc=None,
                 notes='', hair_reference=False):
    """Describe visible design; keep the full metric contract in the receipt.

    The image model receives the body/template and a small set of relevant pixel
    anchors. It is not asked to solve a 3D fitting table or obey body-pose rules
    for an isolated wig. Previously submitted prompts are replayed by the caller.
    """
    c = spec['canvas']
    fit_profile = spec.get('fit_profiles', {}).get(slot)
    template_design = spec.get('design_from_body_template') is True and slot != 'body'
    if template_design and not notes:
        notes = DEFAULT_DESIGN_PROMPTS.get('hair' if slot in ('hairBack', 'hairFront') else slot, '')
    roles = '\n'.join(f'Input image {i}: {role}' for i, role in enumerate(reference_roles(
        slot, view, hair_reference=hair_reference, design_from_body_template=template_design), 1))
    camera = {
        'front': 'Orthographic FRONT, camera on +Z, up +Y. Preserve anatomical left/right and design asymmetry.',
        'side': 'Orthographic RIGHT PROFILE, camera on +X, up +Y. The front of the object points IMAGE-LEFT.',
        'back': 'Orthographic BACK, camera on -Z, up +Y. Anatomical left (+X) appears IMAGE-LEFT. Show the rear of the same object, without front facial details.',
        'opposite': 'Orthographic OPPOSITE PROFILE, camera on -X, up +Y. The front points IMAGE-RIGHT. Rotate the same object; do not mirror the other profile.',
    }[view]
    if slot == 'body':
        content = (
            'One complete bald chibi wardrobe body matching the body guide proportions and joint positions. '
            'The head is a smooth blank egg with uniform skin color, without facial features, ears or facial relief. '
            'The torso and limbs wear one thin opaque matte white fitted underlayer. '
            'Keep the large head, hands and bare feet; exclude hair, headwear, outer clothes and accessories. '
            'Keep the neck and every limb connected; hands remain separate from the torso. '
            f'Crown row {c["scalp_y"]}, sole row {c["sole_y"]}; match the visual guide head size.'
        )
    else:
        content = (garment_part_content(slot, source_reference=not template_design)
                   if fit_profile and slot in ('top', 'bottom') else
                   body_template_part_content(slot) if template_design else PART_CONTENT[slot])
        attachment = (garment_fit_prompt(slot, fit_profile, source_reference=not template_design)
                      if fit_profile and slot in ('top', 'bottom') else PART_FIT[slot])
        if template_design:
            attachment = attachment.replace('ORIGINAL', 'DESIGN-BRIEF').replace('original', 'design-brief')
        content += ' ' + attachment
        if slot == 'hair':
            content += hair_length_prompt(spec, source_reference=not template_design)
        content += (
            ' Show the part in its worn position around the supplied body, then hide the body. '
            'Preserve the part silhouette and local thickness; leave fitting room at attachment openings. '
            'The template rectangles indicate available space, not shapes or dimensions to fill.'
        )
    anchor_names = {
        'body': ('crown', 'neck', 'waist', 'wrist_left', 'wrist_right', 'ankle_left', 'ankle_right'),
        'hair': ('crown', 'neck'), 'hairFront': ('crown', 'neck'), 'hairBack': ('crown', 'neck'),
        'hat': ('crown',), 'top': ('neck', 'shoulder_left', 'shoulder_right', 'waist'),
        'bottom': ('waist', 'ankle_left', 'ankle_right'), 'shoes': ('ankle_left', 'ankle_right'),
        'weapon': ('wrist_right',), 'tool': ('wrist_left',), 'glasses': ('crown', 'neck'),
    }.get(slot, ())
    anchors = {name: [round(n, 1) for n in project(spec['anchors'][name], view, spec)]
               for name in anchor_names}
    design = (
        'USER-EDITABLE DESIGN BRIEF: ' + json.dumps(notes, ensure_ascii=False) + '. '
        'Use it for appearance, material, silhouette and details; the view and output format follow this request.'
        if notes else 'Preserve the requested part design, colors and materials in the original art.'
    )
    sections = [
        f'PART REFERENCE {PROMPT_REVISION}: one {slot}, {view} view, {c["width"]}x{c["height"]} RGBA PNG.',
        roles,
        design,
        content,
        camera,
        'Keep the common canvas, camera magnification and worn placement from the body guide. '
        'Do not center or enlarge an isolated part. Preserve the designed silhouette instead of stretching it to a box. '
        'Relevant body reference points [x,y] in pixels, measured from top-left: ' + json.dumps(anchors),
    ]
    if slot in ('body', 'top'):
        sections.append(AXIS_LOCK)
        if view == 'side':
            sections.append('Horizontal arms and sleeves overlap along the camera axis; do not lower them to expose the hands.')
    elif slot in ('bottom', 'shoes'):
        sections.append('Keep the waist level, legs straight and feet flat facing forward in the body guide pose.')
    if accepted_front_qc and accepted_front_qc.get('bounds_px'):
        box = accepted_front_qc['bounds_px']
        sections.append(f'The saved front image places this part between rows {box[1]} and {box[3]}. '
                        'Keep those heights and the same design in this view. Move only the camera.')
    if view == 'back' and accepted_side_qc and accepted_side_qc.get('bounds_px'):
        sections.append('Use the saved side image to continue the rear volume and silhouette; do not redesign the back.')
    # Legacy QC records remain readable, but removed quality checks must not
    # inject contradictory correction demands into a newly requested image.
    sections.append(
        'One view only, complete and uncropped. Transparent background; opaque material surfaces with antialiased edges. '
        'Neutral diffuse illumination. No text, measurement marks, grid, floor, cast shadow, extra objects or inset views. '
        'Return only the image.'
    )
    return '\n\n'.join(sections)
