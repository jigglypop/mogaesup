import { useCurrentInteraction, useInteractablesStoreApi, useInteractionKey } from 'gaesup-world';

/** What the player can use nearby, by its key or a tap; both run the same activation. Mount it inside the world. */
export function InteractButton() {
  const target = useCurrentInteraction();
  const store = useInteractablesStoreApi();
  useInteractionKey();
  if (!target) return null;
  const key = target.key.toUpperCase();
  return (
    <button
      type="button"
      className="mg-interact mg-glass"
      aria-keyshortcuts={key}
      // A click leaves the keyboard focus where it was, so Space jumps instead of pressing this again.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => store.getState().activateCurrent()}
    >
      <kbd aria-hidden="true">{key}</kbd>
      <span>{target.label}</span>
    </button>
  );
}
