/** Line drawings for the decorating screen, in the app's icon style: 24px grid, text colour. */
const PATHS = {
  // Tools and view
  select: 'M6 3.5l12 7.2-5.2 1.3 3.2 6.1-2.4 1.3-3.2-6.2L6 17z',
  topDown: 'M3.5 6.5l5.5-2.5 6 2.5 5.5-2.5v13.5l-5.5 2.5-6-2.5-5.5 2.5zM9 4v13.5M15 6.5V20',
  keyboard: 'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M18 10h.01M7 14h10',
  copy: 'M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9',
  focus: 'M4 8.5V5a1 1 0 0 1 1-1h3.5M15.5 4H19a1 1 0 0 1 1 1v3.5M20 15.5V19a1 1 0 0 1-1 1h-3.5M8.5 20H5a1 1 0 0 1-1-1v-3.5M12 9.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5z',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  turnLeft: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4.5H9',
  turnRight: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15',
  cloud: 'M7 18.5a4 4 0 0 1-.6-8a5.5 5.5 0 0 1 10.6-1.3a4.5 4.5 0 0 1 .5 9.3z',
  alert: 'M12 4l9 15.5H3zM12 10v4.5M12 17.2h.01',
} as const;

type EditIconName = keyof typeof PATHS;

export function EditIcon({ name }: { name: EditIconName }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Drawings of the pieces in the drawer; the fill takes the piece's colour where it has one (flowers, tree kinds). */
const PIECE_PATHS: Record<string, string> = {
  chair: 'M8 4v16M8 12h8v8M16 12V9',
  table: 'M4 8h16M6 8v11M18 8v11M9 8v5h6V8',
  bed: 'M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M6 11.5a1.5 1.5 0 1 0 0 .1',
  storage: 'M5 4h14v16H5zM5 12h14M11 8h2M11 16h2',
  lamp: 'M9 3h6l2.5 6h-11zM12 9v10M8.5 20.5h7',
  mailbox: 'M4 11a4 4 0 0 1 8 0v7H4zM8 7h9a3 3 0 0 1 3 3v8h-8M16 18v3M16 10V5h3',
  crafting: 'M3.5 9h17v4h-17zM6 13v7M18 13v7M9 9V6h6v3',
  shop: 'M4 9.5L6 4h12l2 5.5M4 9.5h16V20H4zM10 20v-5h4v5',
  door: 'M6 3h12v18H6zM14.5 12.5h.01',
  window: 'M5 5h14v14H5zM12 5v14M5 12h14',
  fence: 'M5 7l2-2.5L9 7v13H5zM15 7l2-2.5L19 7v13h-4zM9 10h6M9 15h6',
  tree: 'M12 3a5 5 0 0 1 5 5a4 4 0 0 1-1 7.8H8A4 4 0 0 1 7 8a5 5 0 0 1 5-5zM12 15.8V21',
  fruitTree: 'M12 3a5 5 0 0 1 5 5a4 4 0 0 1-1 7.8H8A4 4 0 0 1 7 8a5 5 0 0 1 5-5zM12 15.8V21M9.5 8.5h.01M14.5 10h.01M11 12.5h.01',
  thinTree: 'M12 3c2.5 3 3.5 6 3.5 9a3.5 3.5 0 0 1-7 0c0-3 1-6 3.5-9zM12 15.5V21',
  pine: 'M12 3l5 7h-3l4 6H6l4-6H7zM12 16v5',
  deadTree: 'M12 21V9M12 14l-4-4M8 10V7M12 12l4-3.5M16 8.5l2-2M12 9l-1.2-4.5',
  sakura: 'M12 4c1.6 2 1.6 4 0 5.2c-1.6-1.2-1.6-3.2 0-5.2zM4.5 11c2.2-1.2 4.2-1 5.2.6c-1.6 1.2-3.6 1-5.2-.6zM19.5 11c-2.2-1.2-4.2-1-5.2.6c1.6 1.2 3.6 1 5.2-.6zM8 19c.3-2.5 1.8-3.8 3.6-3.4c-.3 1.9-1.8 3.3-3.6 3.4zM16 19c-.3-2.5-1.8-3.8-3.6-3.4c.3 1.9 1.8 3.3 3.6 3.4z',
  rock: 'M4 18l2.5-7 5-4 5 2 3.5 9zM9 11.5l3 1.5 2-3',
  fern: 'M12 21V4M12 8c-1.5-1-3-1-4.5 0M12 8c1.5-1 3-1 4.5 0M12 12.5c-2-1-4-1-6 0M12 12.5c2-1 4-1 6 0M12 17c-2.5-1-5-1-7.5.5M12 17c2.5-1 5-1 7.5.5',
  bush: 'M5 17a3.5 3.5 0 0 1 1-6.8a4 4 0 0 1 7.5-2a3.5 3.5 0 0 1 5 3.6a3 3 0 0 1-.5 5.2zM12 17v3',
  flower: 'M12 21v-9M12 17c-2-2.2-4.2-2.4-5.7-1.4M12 4.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5z',
  stump: 'M6 10c0-1.7 2.7-3 6-3s6 1.3 6 3v8c0 1.7-2.7 3-6 3s-6-1.3-6-3zM6 10c0 1.7 2.7 3 6 3s6-1.3 6-3',
  log: 'M4 15.5L15 8.5a2.5 2.5 0 1 1 3 4L7 19.5a2.5 2.5 0 1 1-3-4z',
  mushroom: 'M4 12a8 6 0 0 1 16 0zM10 12v6a2 2 0 0 0 4 0v-6',
  lily: 'M3 16.5c3 2 15 2 18 0M12 14c-2-2-2-5 0-7c2 2 2 5 0 7zM12 14c-3 0-5-2-6-4c3 0 5 1.5 6 4zM12 14c3 0 5-2 6-4c-3 0-5 1.5-6 4z',
  flag: 'M6 21V4M6 5h11l-2.2 4L17 13H6',
  fire: 'M12 3c1 3.2 5 5.2 5 10a5 5 0 0 1-10 0c0-2.2 1-3.7 2.2-4.8c0 2 .8 3.2 2 3.3c0-3-1.2-5 .8-8.5z',
  floor: 'M4 8.5L12 4.5l8 4-8 4zM4 8.5v7l8 4 8-4v-7M12 12.5v7',
  wall: 'M3.5 6h17v12h-17zM3.5 12h17M9 6v6M15 12v6',
  cover: 'M5 19c0-7 5-12 14-13c-1 9-6 14-13 14M5 19c3-4 6-6.5 9-8',
  studio: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
};

export function PieceIcon({ kind, tint }: { kind: string; tint?: string | undefined }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PIECE_PATHS[kind] ?? PIECE_PATHS['studio']} {...(tint ? { fill: tint, fillOpacity: 0.55 } : {})} />
    </svg>
  );
}
