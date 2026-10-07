/**
 * A balloon's size on screen, in CSS pixels, its tail included, and how far right of its tail a design draws its body
 * (민트, 나뭇잎).
 */
export type BalloonSize = { width: number; height: number; shift: number };

/**
 * One balloon's elements: `.mg-balloon[data-design] > .mg-balloon-pop > (.mg-balloon-body > b) + .mg-balloon-tail`, the
 * words set as text (never as markup). The picker draws the same (BalloonPicker's `BalloonShape`).
 */
export function balloonElement(text: string, design: string): HTMLElement {
  const balloon = document.createElement('span');
  balloon.className = 'mg-balloon';
  balloon.dataset['design'] = design;
  const pop = document.createElement('span');
  pop.className = 'mg-balloon-pop';
  const body = document.createElement('span');
  body.className = 'mg-balloon-body';
  const words = document.createElement('b');
  words.textContent = text;
  const tail = document.createElement('i');
  tail.className = 'mg-balloon-tail';
  body.append(words);
  pop.append(body, tail);
  balloon.append(pop);
  return balloon;
}

/** A size for a balloon never laid out (a page without layout): about a line of 14px letters per 220px. */
function guessSize(text: string): BalloonSize {
  const width = Math.min(220, [...text].length * 14 + 24);
  const lines = Math.min(4, Math.ceil(([...text].length * 14) / 196) || 1);
  return { width, height: 22 + 19 * lines, shift: 0 };
}

/** How far across a design moves the body from over its tail: its transform's translation (`matrix(a, b, c, d, e, f)`). */
function shiftOf(balloon: HTMLElement): number {
  const body = balloon.querySelector('.mg-balloon-body');
  const matrix = body ? /^matrix\(([^)]*)\)$/.exec(getComputedStyle(body).transform) : null;
  return matrix ? Number(matrix[1]!.split(',')[4]) || 0 : 0;
}

type Entry = { element: HTMLElement; size: BalloonSize; transform: string; x: number; y: number; opacity: number; shown: boolean };

/** The balloons over the island's canvas, by speaker: each element made once per line and moved, faded or let go. */
export type BalloonDom = {
  readonly element: HTMLElement;
  /** Shows `text` in `design` for `key`, in place of what it said before; answers its size. */
  say(key: string, text: string, design: string): BalloonSize;
  /** Puts the tail's tip at (`x`, `y`); writes only what moved more than half a pixel. */
  place(key: string, x: number, y: number, opacity: number): void;
  /** Out of sight for now (behind the camera, too far, hidden by a game). */
  hide(key: string): void;
  /** Starts fading out; `remove` takes it away. */
  leave(key: string): void;
  remove(key: string): void;
  dispose(): void;
};

/** The balloon layer over the canvas in `host`: under the panels and chat bar beside the canvas, over the name tags. */
export function createBalloonDom(host: HTMLElement): BalloonDom {
  const layer = document.createElement('div');
  layer.className = 'mg-balloon-layer';
  layer.setAttribute('aria-hidden', 'true');
  host.append(layer);
  const entries = new Map<string, Entry>();
  const remove = (key: string) => {
    entries.get(key)?.element.remove();
    entries.delete(key);
  };
  return {
    element: layer,
    say(key, text, design) {
      remove(key);
      const element = balloonElement(text, design);
      // Not seen until it is placed.
      element.style.opacity = '0';
      layer.append(element);
      const size =
        element.offsetWidth > 0
          ? { width: element.offsetWidth, height: element.offsetHeight, shift: shiftOf(element) }
          : guessSize(text);
      entries.set(key, { element, size, transform: '', x: NaN, y: NaN, opacity: 0, shown: true });
      return size;
    },
    place(key, x, y, opacity) {
      const entry = entries.get(key);
      if (!entry) return;
      const { element, size } = entry;
      if (!entry.shown) {
        element.style.display = '';
        entry.shown = true;
      }
      if (!(Math.abs(x - entry.x) <= 0.5 && Math.abs(y - entry.y) <= 0.5)) {
        entry.x = x;
        entry.y = y;
        element.style.transform = `translate(${Math.round(x - size.width / 2)}px, ${Math.round(y - size.height)}px)`;
      }
      const shade = Math.round(Math.min(1, Math.max(0, opacity)) * 100) / 100;
      if (shade !== entry.opacity) {
        entry.opacity = shade;
        // Fully there, it has no opacity of its own, which keeps the glass designs' blur.
        element.style.opacity = shade >= 1 ? '' : String(shade);
      }
    },
    hide(key) {
      const entry = entries.get(key);
      if (!entry?.shown) return;
      entry.element.style.display = 'none';
      entry.shown = false;
    },
    leave(key) {
      entries.get(key)?.element.classList.add('is-leaving');
    },
    remove,
    dispose() {
      layer.remove();
      layer.replaceChildren();
      entries.clear();
    },
  };
}
