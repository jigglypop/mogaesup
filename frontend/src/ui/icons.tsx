import type { SVGProps } from 'react';

/** Line icons on a 24px grid; they take the text colour. */
const PATHS = {
  island: 'M12 3.5a5 5 0 0 1 0 10a5 5 0 0 1 0-10zM12 13.5V21M8 21h8',
  brush: 'M4 20l1.2-4.3L15.6 5.3a2 2 0 0 1 2.8 0l.3.3a2 2 0 0 1 0 2.8L8.3 18.8zM13.5 7.4l3.1 3.1',
  person: 'M12 4a4 4 0 1 1 0 8a4 4 0 0 1 0-8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  compass: 'M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zM15.5 8.5l-2 5-5 2 2-5z',
  shield: 'M12 3l7 3v5.5c0 4.3-3 7.9-7 9.5c-4-1.6-7-5.2-7-9.5V6z',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20',
  bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5a2 2 0 0 0 4 0',
  send: 'M4 11.5L20 4l-6.5 16-2.5-6.5zM11 13.5L20 4',
  close: 'M6 6l12 12M18 6L6 18',
  undo: 'M9 7L4.5 11.5 9 16M5 11.5h9a5 5 0 0 1 0 10h-2',
  redo: 'M15 7l4.5 4.5L15 16M19 11.5h-9a5 5 0 0 0 0 10h2',
  place: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM12 8.5v7M8.5 12h7',
  paint: 'M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z',
  erase: 'M4.5 15.5l8.5-8.5a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 18.5H7.5zM9.5 10.5l5 5M12 18.5h8',
  rotate: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15',
  gear: 'M12 9a3 3 0 1 1 0 6a3 3 0 0 1 0-6zM12 2.8v2.4M12 18.8v2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M2.8 12h2.4M18.8 12h2.4M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7',
  sun: 'M12 8a4 4 0 1 1 0 8a4 4 0 0 1 0-8zM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4',
  moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z',
  lock: 'M6.5 10.5h11a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5',
  logout: 'M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14M10.5 12H20M16.5 8.5L20 12l-3.5 3.5',
  users: 'M9 5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7zM3 19.5a6 6 0 0 1 12 0M16 5.5a3.2 3.2 0 0 1 0 6.2M18 14a5.5 5.5 0 0 1 3 5.5',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14 7l3 3',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevronLeft: 'M14.5 6l-6 6 6 6',
  chevronRight: 'M9.5 6l6 6-6 6',
  chevronDown: 'M6 9.5l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13',
  music: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0z',
  gauge: 'M4 16a8 8 0 1 1 16 0M12 16l3.5-5M4 16h2M18 16h2',
  palette: 'M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 1.4-2.1c-.6-1.2.2-2.4 1.6-2.4h1.8a3.7 3.7 0 0 0 3.7-3.7C20.5 7.3 16.7 3.5 12 3.5zM7.5 12a1 1 0 1 0 0 .1M10 8a1 1 0 1 0 0 .1M14.5 8a1 1 0 1 0 0 .1',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  sparkle: 'M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8z',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9a3 3 0 1 1 0 6a3 3 0 0 1 0-6z',
  panel: 'M4.5 4.5h15a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM14.5 4.5v15',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
