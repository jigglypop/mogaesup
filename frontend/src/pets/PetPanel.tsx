import './pets.css';

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type { RapierRigidBody } from '@react-three/rapier';

import { standing } from '../games/teleport';
import { usePopover } from '../shell/Shell';
import { Icon } from '../ui/icons';
import { AdoptPet, BreedPicture, PET_NAME_MAX, petNameOk } from './AdoptPet';
import type { PetCommand } from './brain/senses';
import type { PetController, PetStatus } from './controller';
import type { PetFeedback } from './drives';
import { ACTIVITY_LABEL } from './motor';
import { createPetHome, type PetHome, type PetHomeState } from './persistence';

/** Where the CC BY 4.0 credit for the circuit the pets' brains read lives. */
export const ATTRIBUTION_URL = '/pets/connectome-attribution.txt';

export const COMMAND_LABEL: Readonly<Record<PetCommand, string>> = {
  come: '이리 와',
  sit: '앉아',
  down: '엎드려',
  stay: '기다려',
  speak: '짖어',
  jump: '점프',
  fetch: '공 던지기',
};
/** The panel's order. */
const PANEL_COMMANDS: readonly PetCommand[] = ['come', 'sit', 'down', 'stay', 'speak', 'jump', 'fetch'];
const FEEDBACK: { kind: Exclude<PetFeedback, 'pat'>; label: string; key: string }[] = [
  { kind: 'treat', label: '간식', key: 't' },
  { kind: 'praise', label: '칭찬', key: 'g' },
  { kind: 'scold', label: '안돼', key: '' },
];
const DRIVES: { key: keyof PetStatus['drives']; label: string }[] = [
  { key: 'mood', label: '기분' },
  { key: 'energy', label: '기운' },
  { key: 'satiety', label: '배부름' },
  { key: 'bond', label: '친밀도' },
];

/** Keeps typing in the panel out of the world's keys. */
const keepKeys = (event: KeyboardEvent) => event.stopPropagation();
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export type PetIsland = {
  home: PetHome | null;
  state: PetHomeState | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** An owner's chat line, for their pet when it is a command, praise or "안돼". */
  chat: (line: string) => void;
};

const EMPTY = () => () => {};
const NONE = () => null;

/** The island page's pet: loaded for the island, kept until the page leaves it. */
export function usePetIsland({ username, ownerId, isOwner }: { username: string; ownerId: string; isOwner: boolean }): PetIsland {
  const [home, setHome] = useState<PetHome | null>(null);
  useEffect(() => {
    const created = createPetHome({ username, ownerId, isOwner });
    setHome(created);
    void created.load();
    return () => created.dispose();
  }, [username, ownerId, isOwner]);
  const state = useSyncExternalStore(home?.subscribe ?? EMPTY, home?.getState ?? NONE, home?.getState ?? NONE);
  const [open, setOpen] = useState(false);
  const chat = useCallback((line: string) => void home?.getState().controller?.chat(line), [home]);
  return { home, state, open, setOpen, chat };
}

/** Whether the owner's 펫 button shows: a breed to adopt, or a pet already. */
export const petButtonShown = (state: PetHomeState | null) => !!state && state.phase === 'ready' && (!!state.pet || state.breeds.length > 0);

/** The 펫 button in the island's top bar (the owner's). */
export function PetButton({ pets }: { pets: PetIsland }) {
  if (!petButtonShown(pets.state)) return null;
  return (
    <button type="button" className="mg-btn mg-pet-toggle" aria-label="펫" aria-expanded={pets.open} onClick={() => pets.setOpen(!pets.open)}>
      <Icon name="paw" />
      <span className="mg-pet-toggle-label">펫</span>
    </button>
  );
}

/** The owner's pet sheet over the world's bottom: adopting, or the pet's panel. */
export function PetSheet({ pets, playerRef }: { pets: PetIsland; playerRef: RefObject<RapierRigidBody | null> }) {
  const { home, state, open, setOpen } = pets;
  // Where the owner stands: a new pet's home is beside them, and 여기를 집으로 is there.
  const spot = useCallback(() => {
    const at = standing(playerRef.current);
    return at && { x: Math.round(at[0] * 100) / 100, z: Math.round(at[2] * 100) / 100 };
  }, [playerRef]);
  if (!open || !home || !state || state.phase !== 'ready') return null;
  const close = () => setOpen(false);
  if (!state.pet) {
    return (
      <AdoptPet
        breeds={state.breeds}
        problem={state.problem}
        onClose={close}
        onAdopt={(breed, name) => {
          const at = spot() ?? { x: 0, z: 0 };
          return home.adopt(breed, name, { x: at.x + 1, z: at.z + 1 });
        }}
      />
    );
  }
  if (!state.controller) return null;
  return <PetPanel home={home} state={state} controller={state.controller} spot={spot} onClose={close} />;
}

type PetPanelProps = {
  home: PetHome;
  state: PetHomeState;
  controller: PetController;
  spot: () => { x: number; z: number } | null;
  onClose: () => void;
};

/** The owner's pet: what it is doing, how it feels, the commands with how well each is learned, and feedback. */
export function PetPanel({ home, state, controller, spot, onClose }: PetPanelProps) {
  const status = useSyncExternalStore(
    useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
    () => controller.status(),
  );
  const pet = state.pet!;
  const busy = status.busy;
  const locked = state.conflict || busy;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(pet.name);
  const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover();
  const [releasing, setReleasing] = useState(false);
  useEffect(() => setName(pet.name), [pet.name]);

  // Shortcuts while the panel is open: 1–7 the commands, T a treat, G praise; never while typing.
  useEffect(() => {
    if (locked) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || typing(event.target)) return;
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= PANEL_COMMANDS.length) {
        const command = PANEL_COMMANDS[digit - 1]!;
        if (command === 'fetch') controller.throwBall();
        else controller.command(command);
        return;
      }
      const feedback = FEEDBACK.find((entry) => entry.key && entry.key === event.key.toLowerCase());
      if (feedback) controller.feedback(feedback.kind);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, locked]);

  const commitName = async (event?: FormEvent) => {
    event?.preventDefault();
    const next = name.trim();
    if (!petNameOk(next) || next === pet.name) {
      setName(pet.name);
      setNaming(false);
      return;
    }
    if (await home.rename(next)) setNaming(false);
  };

  return (
    <section className="mg-pet mg-glass" aria-label={`${pet.name} 펫`} onKeyDown={keepKeys}>
      <header className="mg-pet-head">
        <span className="mg-pet-face">
          <BreedPicture breed={pet.breedView} />
        </span>
        <div className="mg-pet-who">
          {naming ? (
            <form className="mg-pet-rename" onSubmit={(event) => void commitName(event)}>
              <input
                className="mg-field"
                value={name}
                maxLength={PET_NAME_MAX * 2}
                aria-label="이름"
                autoComplete="off"
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onBlur={() => void commitName()}
              />
            </form>
          ) : (
            <button type="button" className="mg-pet-name" aria-label={`이름 바꾸기: ${pet.name}`} onClick={() => setNaming(true)}>
              <b>{pet.name}</b>
              <Icon name="edit" />
            </button>
          )}
          <span className="mg-chip is-soft mg-pet-doing" role="status">
            {busy ? '다른 창에서 함께하는 중' : ACTIVITY_LABEL[status.activity]}
          </span>
        </div>
        <div className="mg-anchor" ref={menuRef}>
          <button type="button" className="mg-icon-btn is-quiet" aria-label="펫 메뉴" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            <span className="mg-pet-more" aria-hidden="true">⋯</span>
          </button>
          {menuOpen && (
            <div className="mg-popover mg-menu mg-pet-menu is-right" role="menu" aria-label="펫 메뉴">
              <button
                type="button"
                role="menuitem"
                disabled={locked}
                onClick={() => {
                  setMenuOpen(false);
                  const at = spot();
                  if (at) void home.moveHome(at.x, at.z);
                }}
              >
                <Icon name="place" /> 여기를 집으로
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setReleasing(true);
                }}
              >
                <Icon name="trash" /> 떠나보내기
              </button>
              <a role="menuitem" href={ATTRIBUTION_URL} target="_blank" rel="noreferrer">
                <Icon name="link" /> 회로 출처
              </a>
            </div>
          )}
        </div>
        <button type="button" className="mg-icon-btn is-quiet" aria-label="펫 접기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {releasing ? (
        <div className="mg-pet-confirm" role="alertdialog" aria-label="떠나보내기">
          <span>{pet.name}을(를) 떠나보낼까요?</span>
          <div className="mg-row">
            <button type="button" className="mg-btn is-small" onClick={() => setReleasing(false)}>
              취소
            </button>
            <button
              type="button"
              className="mg-btn is-small is-danger"
              onClick={() => {
                void home.release().then((ok) => {
                  if (ok) onClose();
                  else setReleasing(false);
                });
              }}
            >
              떠나보내기
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="mg-pet-bars">
            {DRIVES.map((drive) => (
              <div key={drive.key} className="mg-pet-bar" style={{ '--mg-pet-value': `${status.drives[drive.key]}%` } as CSSProperties}>
                <dt>{drive.label}</dt>
                <dd>
                  <i aria-hidden="true" />
                  <span>{status.drives[drive.key]}</span>
                </dd>
              </div>
            ))}
          </dl>
          <div className="mg-pet-commands" role="group" aria-label="명령">
            {PANEL_COMMANDS.map((command, index) => (
              <button
                key={command}
                type="button"
                className="mg-pet-command"
                aria-pressed={status.command === command}
                aria-keyshortcuts={String(index + 1)}
                disabled={locked}
                onClick={() => (command === 'fetch' ? controller.throwBall() : controller.command(command))}
              >
                <span>{COMMAND_LABEL[command]}</span>
                {status.mastery && <small aria-label={`숙련도 ${status.mastery[command]}%`}>{status.mastery[command]}%</small>}
              </button>
            ))}
          </div>
          <div className="mg-pet-feedback" role="group" aria-label="반응">
            {FEEDBACK.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                className={`mg-btn is-small${entry.kind === 'treat' ? ' is-primary' : ''}`}
                aria-keyshortcuts={entry.key ? entry.key.toUpperCase() : undefined}
                disabled={locked || (entry.kind === 'treat' && !status.canTreat)}
                onClick={() => controller.feedback(entry.kind)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </>
      )}
      {state.conflict && (
        <div className="mg-pet-conflict" role="alert">
          <span>다른 곳에서 펫이 바뀌었어요.</span>
          <button type="button" className="mg-btn is-small" onClick={() => void home.reload()}>
            다시 불러오기
          </button>
        </div>
      )}
      {state.problem && !state.conflict && (
        <p className="mg-error" role="alert">
          {state.problem}
        </p>
      )}
    </section>
  );
}

