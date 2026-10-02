const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** What someone is drawn in when the room's colour for them is not a colour. */
export const NEUTRAL_PEER = '#7a7592';

/** The room hands over each person's own colour string; it goes into a style only when it is a hex colour. */
export const peerColor = (color: unknown): string => (typeof color === 'string' && HEX_COLOR.test(color) ? color : NEUTRAL_PEER);
