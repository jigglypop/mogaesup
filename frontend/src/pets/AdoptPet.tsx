import { useState, type FormEvent, type KeyboardEvent } from 'react';

import { Icon } from '../ui/icons';
import type { BreedInfo } from './controller';

/** The server's limit on a pet's name, in characters. */
export const PET_NAME_MAX = 12;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A name the server takes: 1–12 characters once trimmed, none of them control characters. */
export function petNameOk(name: string): boolean {
  const trimmed = name.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= PET_NAME_MAX && !CONTROL.test(trimmed);
}

/** Typing in the panel stays out of the world's keys (WASD, E, the pet panel's own shortcuts). */
const keepKeys = (event: KeyboardEvent) => event.stopPropagation();

export function BreedPicture({ breed }: { breed: Pick<BreedInfo, 'thumbnailUrl' | 'emoji'> }) {
  const [broken, setBroken] = useState(false);
  return breed.thumbnailUrl && !broken ? (
    <img src={breed.thumbnailUrl} alt="" loading="lazy" onError={() => setBroken(true)} />
  ) : (
    <span aria-hidden="true">{breed.emoji}</span>
  );
}

type AdoptPetProps = {
  breeds: readonly BreedInfo[];
  /** Resolves true once the pet is adopted. */
  onAdopt: (breedId: string, name: string) => Promise<boolean>;
  problem: string;
  onClose: () => void;
};

/** The owner without a pet: a breed, a name, 입양. */
export function AdoptPet({ breeds, onAdopt, problem, onClose }: AdoptPetProps) {
  const [chosen, setChosen] = useState(breeds[0]?.id ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const breed = breeds.find((entry) => entry.id === chosen);
  const ready = !!breed && petNameOk(name) && !busy;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !breed) return;
    setBusy(true);
    try {
      await onAdopt(breed.id, name.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mg-pet mg-glass mg-pet-adopt" aria-label="펫 입양" onSubmit={(event) => void submit(event)} onKeyDown={keepKeys}>
      <header className="mg-pet-head">
        <h2 className="mg-pet-heading">
          <Icon name="paw" /> 펫
        </h2>
        <button type="button" className="mg-icon-btn is-quiet" aria-label="펫 접기" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="mg-pet-breeds" role="radiogroup" aria-label="품종">
        {breeds.map((entry) => (
          <button key={entry.id} type="button" role="radio" aria-checked={entry.id === chosen} onClick={() => setChosen(entry.id)}>
            <BreedPicture breed={entry} />
            <small>{entry.label}</small>
          </button>
        ))}
      </div>
      <div className="mg-pet-adopt-row">
        <input
          className="mg-field"
          value={name}
          maxLength={PET_NAME_MAX * 2}
          placeholder="이름"
          aria-label="이름"
          autoComplete="off"
          enterKeyHint="done"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="mg-btn is-primary" disabled={!ready}>
          입양
        </button>
      </div>
      {problem && (
        <p className="mg-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
