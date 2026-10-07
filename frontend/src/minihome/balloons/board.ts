import { MINIME_SCALE } from '../character';
import { balloonTtl, designOfColor } from './designs';
import type { BalloonDom, BalloonSize } from './dom';
import { stackBalloons, type BalloonBox } from './layout';

export type Point = { x: number; y: number; z: number };
/** Where a point of the world falls on screen (CSS pixels from the canvas's top left), and how far from the camera. */
export type Screen = { x: number; y: number; distance: number };

/** Where a 미니미's name tag is drawn up from, above where they stand; their balloon's tip goes above it. */
export const NAME_TAG_HEIGHT = 1.7 * MINIME_SCALE + 0.4;
/** Then this much higher on screen, clear of the name tag (22px high) drawn up from that point. */
const OVER_NAME_TAG_PX = 26;
/** The viewer has no name tag over their own head: their balloon's tip goes just over the head. */
export const HEAD_HEIGHT = 1.7 * MINIME_SCALE;
const OVER_HEAD_PX = 14;
/** Speakers this far from the listener fade out until, at the second, their balloon goes. */
const FADE_FROM = 18;
const FADE_TO = 24;
/** A game puts people it hides far below the island. */
const HIDDEN_BELOW = -100;
/** How fast a balloon catches up with its speaker and with its place in a stack, per second. */
const FOLLOW_RATE = 8;
const STACK_RATE = 12;
/** How long a balloon takes to fade out (balloons.css `.is-leaving`). */
export const LEAVE_MS = 200;
/** Room kept between a balloon and the side of the screen it would run past. */
const EDGE_PX = 6;
/**
 * The viewer's own balloon, whatever `client_id` the room gives them: joining again (another balloon picked) gives a
 * new one, and the next line still takes the place of the last.
 */
export const OWN_KEY = '\u0000own';

/**
 * The design each speaker talks in: the viewer their own, anyone else the one their room colour stands for. Asked when
 * a line comes, so someone who joined again in another balloon (a new `client_id`, a new colour) talks in it from
 * their next line on, and a line already up keeps its own.
 */
export const designOfSpeaker =
  (ownKey: string | null, ownDesign: string, players: ReadonlyMap<string, { readonly color?: unknown }>) =>
  (key: string): string =>
    key === ownKey ? ownDesign : designOfColor(players.get(key)?.color);

type Said = {
  text: string;
  design: string;
  /** Said by the viewer: placed over their own body, wherever the room puts them. */
  own: boolean;
  /** When it was said; of two balloons as far away, the newer stays nearer its speaker. */
  since: number;
  until: number;
  goneAt: number | null;
  size: BalloonSize;
  at: Point | null;
  /** How far up its stack has moved it (px); null until first placed, where it then starts. */
  lift: number | null;
};

export type Frame = {
  now: number;
  /** Seconds since the last frame. */
  delta: number;
  /** Where a speaker stands now; null once they left. */
  locate: (key: string, own: boolean) => Point | null;
  /** Hidden by a game: not shown, but kept. */
  hidden: (key: string) => boolean;
  /** Where the viewer stands, whom the far ones fade for. */
  listener: Point | null;
  /** Where a point falls on screen; null behind the camera or off the screen. */
  toScreen: (point: Point) => Screen | null;
  /** The screen's width (CSS pixels): a balloon stays inside it, at an edge its tail no longer right over its speaker. */
  width: number;
};

/**
 * Everyone's balloons, by speaker. `hear` takes what the room says now (speaker to line, the viewer's own among them):
 * a line that is new for its speaker (another line, or one after none) goes up for as long as {@link balloonTtl} gives
 * it, whatever the room's own expiry. `frame` follows each speaker, stacks balloons that would cover each other, fades
 * the far ones, and lets go of finished ones.
 */
export function createBalloonBoard(dom: BalloonDom) {
  const said = new Map<string, Said>();
  /** The line each speaker has in the room's map now. */
  const heard = new Map<string, string>();
  const scratch: Point = { x: 0, y: 0, z: 0 };

  const leave = (key: string, item: Said, now: number) => {
    if (item.goneAt !== null) return;
    item.goneAt = now + LEAVE_MS;
    dom.leave(key);
  };

  return {
    /** `designOf` is asked about the speakers of new lines (`client_id`s); `ownKey` is the viewer's own one now. */
    hear(speech: ReadonlyMap<string, string>, now: number, designOf: (id: string) => string, ownKey: string | null) {
      for (const id of heard.keys()) if (!speech.has(id)) heard.delete(id);
      for (const [id, text] of speech) {
        if (heard.get(id) === text) continue;
        heard.set(id, text);
        if (!text.trim()) continue;
        const own = id === ownKey;
        const key = own ? OWN_KEY : id;
        const design = designOf(id);
        const before = said.get(key);
        const size = dom.say(key, text, design);
        said.set(key, {
          text,
          design,
          own,
          since: now,
          until: now + balloonTtl(text),
          goneAt: null,
          size,
          // A new line from the same speaker stays where their last one was.
          at: before?.at ?? null,
          lift: before?.lift ?? null,
        });
      }
    },

    frame({ now, delta, locate, hidden, listener, toScreen, width }: Frame) {
      const boxes: (BalloonBox & { tip: number; opacity: number; since: number })[] = [];
      const follow = 1 - Math.exp(-FOLLOW_RATE * delta);
      for (const [key, item] of said) {
        if (item.goneAt === null && now >= item.until) leave(key, item, now);
        if (item.goneAt !== null && now >= item.goneAt) {
          dom.remove(key);
          said.delete(key);
          continue;
        }
        const target = locate(key, item.own);
        if (!target) {
          // Gone from the room: the balloon fades where it was.
          leave(key, item, now);
          if (!item.at) {
            dom.remove(key);
            said.delete(key);
            continue;
          }
        } else if (hidden(key) || target.y < HIDDEN_BELOW) {
          dom.hide(key);
          item.at = null;
          continue;
        } else if (!item.at) {
          item.at = { ...target };
        } else {
          item.at.x += (target.x - item.at.x) * follow;
          item.at.y += (target.y - item.at.y) * follow;
          item.at.z += (target.z - item.at.z) * follow;
        }
        const at = item.at!;
        const away = listener ? Math.hypot(at.x - listener.x, at.y - listener.y, at.z - listener.z) : 0;
        if (away >= FADE_TO) {
          dom.hide(key);
          continue;
        }
        scratch.x = at.x;
        scratch.y = at.y + (item.own ? HEAD_HEIGHT : NAME_TAG_HEIGHT);
        scratch.z = at.z;
        const screen = toScreen(scratch);
        if (!screen) {
          dom.hide(key);
          continue;
        }
        // Where the balloon's body is across (a design may draw it beside its tail), kept on the screen: near a side the
        // whole balloon moves in, its tail with it.
        const body = screen.x + item.size.shift;
        const half = item.size.width / 2;
        const across =
          width >= item.size.width + 2 * EDGE_PX ? Math.min(Math.max(body, EDGE_PX + half), width - EDGE_PX - half) : width / 2;
        boxes.push({
          id: key,
          tip: screen.x + across - body,
          x: across,
          y: screen.y - (item.own ? OVER_HEAD_PX : OVER_NAME_TAG_PX),
          width: item.size.width,
          height: item.size.height,
          distance: screen.distance,
          since: item.since,
          opacity: away <= FADE_FROM ? 1 : (FADE_TO - away) / (FADE_TO - FADE_FROM),
        });
      }
      // Newest first, so that of two as far away the newer stays put.
      boxes.sort((a, b) => b.since - a.since);
      const lifts = stackBalloons(boxes);
      const settle = 1 - Math.exp(-STACK_RATE * delta);
      for (const box of boxes) {
        const item = said.get(box.id)!;
        const lift = lifts.get(box.id) ?? 0;
        // A balloon first shown starts in its place in the stack; after that it glides there.
        let shown = item.lift === null ? lift : item.lift + (lift - item.lift) * settle;
        if (Math.abs(lift - shown) < 0.5) shown = lift;
        item.lift = shown;
        dom.place(box.id, box.tip, box.y - shown, box.opacity);
      }
    },

    /** Whether any balloon is up: without one a frame has nothing to do. */
    busy: () => said.size > 0,

    /** The balloons up now, by speaker (for tests and checks). */
    shown: () => new Map([...said].map(([key, item]) => [key, { text: item.text, design: item.design, own: item.own }])),

    clear() {
      for (const key of said.keys()) dom.remove(key);
      said.clear();
      heard.clear();
    },
  };
}

export type BalloonBoard = ReturnType<typeof createBalloonBoard>;
