import { useEffect, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';

import type { CatalogItem } from '../api/types';
import { Icon } from '../ui/icons';
import { groundHeightAt } from './edit/objects';
import type { EditSession } from './edit/session';
import { GREETING_MAX, MAX_RESIDENTS, NAME_MAX, residentSpot, type Resident, type ResidentStore } from './residents';
import { SPAWN } from './village';

/** Typing in the drawer stays out of the decorating keys (WASD, Delete, shortcuts). */
const keepKeys = (event: KeyboardEvent) => event.stopPropagation();
const EIGHTH = Math.PI / 4;

/** The middle of the decorating view, where a resident is put or moved to. */
function spotAtView(session: EditSession, others: readonly Resident[]) {
  const pivot = session.pivot();
  const tiles = [...session.runtime.buildingStore.getState().tileGroups.values()];
  return residentSpot({ x: pivot.x, z: pivot.z }, others, SPAWN, (x, z) => groundHeightAt(tiles, x, z));
}

function Thumb({ item }: { item: CatalogItem | undefined }) {
  return item?.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <span aria-hidden="true">{item?.emoji ?? '🙂'}</span>;
}

/** A placed resident: its name and greeting, saved when a field is left, and where it stands. */
function ResidentRow({ resident, item, session, residents }: { resident: Resident; item: CatalogItem | undefined; session: EditSession; residents: ResidentStore }) {
  const [name, setName] = useState(resident.name);
  const [greeting, setGreeting] = useState(resident.greeting);
  useEffect(() => setName(resident.name), [resident.name]);
  useEffect(() => setGreeting(resident.greeting), [resident.greeting]);
  const commitName = () => {
    const next = name.trim();
    if (next && next !== resident.name) residents.update(resident.id, { name: next });
    else setName(resident.name);
  };
  const commitGreeting = () => {
    const next = greeting.trim();
    if (next !== resident.greeting) residents.update(resident.id, { greeting: next });
  };
  const others = () => residents.getState().filter((other) => other.id !== resident.id);
  return (
    <li className="mg-resident">
      <span className="mg-resident-thumb">
        <Thumb item={item} />
      </span>
      <div className="mg-resident-fields">
        <input
          className="mg-field"
          value={name}
          maxLength={NAME_MAX}
          aria-label="주민 이름"
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            keepKeys(event);
            if (event.key === 'Enter') commitName();
          }}
        />
        <input
          className="mg-field"
          value={greeting}
          maxLength={GREETING_MAX}
          placeholder="인사말"
          aria-label={`${resident.name} 인사말`}
          onChange={(event) => setGreeting(event.target.value)}
          onBlur={commitGreeting}
          onKeyDown={(event) => {
            keepKeys(event);
            if (event.key === 'Enter') commitGreeting();
          }}
        />
      </div>
      <div className="mg-resident-actions">
        <button type="button" className="mg-btn is-small" onClick={() => residents.update(resident.id, { position: spotAtView(session, others()) })}>
          여기로
        </button>
        <button
          type="button"
          className="mg-icon-btn is-quiet"
          aria-label={`${resident.name} 돌리기`}
          onClick={() => residents.update(resident.id, { rotation: (resident.rotation + EIGHTH) % (Math.PI * 2) })}
        >
          <Icon name="rotate" />
        </button>
        <button type="button" className="mg-btn is-danger is-small" onClick={() => residents.remove(resident.id)}>
          치우기
        </button>
      </div>
    </li>
  );
}

/**
 * 주민 in the decorating drawer: pick a resident the admins published, name it and give it a line, and it stands in the
 * middle of the view. Residents already placed can be renamed, moved to the view, turned or taken away.
 */
export function ResidentsShelf({ session, residents, items, query }: { session: EditSession; residents: ResidentStore; items: readonly CatalogItem[]; query: string }) {
  const placed = useSyncExternalStore(residents.subscribe, residents.getState);
  const [chosen, setChosen] = useState(items[0]?.id ?? '');
  const [name, setName] = useState('');
  const [greeting, setGreeting] = useState('');
  const item = items.find((candidate) => candidate.id === chosen);
  const full = placed.length >= MAX_RESIDENTS;
  const shown = items.filter((candidate) => !query.trim() || candidate.label.includes(query.trim()));

  const place = (event: FormEvent) => {
    event.preventDefault();
    if (!item || full) return;
    const added = residents.add({
      npc: item.id,
      name: (name.trim() || item.label).slice(0, NAME_MAX),
      greeting: greeting.trim(),
      position: spotAtView(session, placed),
      rotation: 0,
    });
    if (added) {
      setName('');
      setGreeting('');
    }
  };

  if (items.length === 0 && placed.length === 0) return <p className="mg-empty">놓을 수 있는 주민이 없어요</p>;
  return (
    <div className="mg-residents">
      <form className="mg-resident-new" onSubmit={place}>
        <div className="mg-pieces" role="radiogroup" aria-label="주민">
          {shown.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              className="mg-piece"
              aria-checked={candidate.id === chosen}
              onClick={() => setChosen(candidate.id)}
            >
              <Thumb item={candidate} />
              <span>{candidate.label}</span>
            </button>
          ))}
        </div>
        <div className="mg-resident-fields">
          <input
            className="mg-field"
            name="residentName"
            value={name}
            maxLength={NAME_MAX}
            placeholder={item?.label ?? '이름'}
            aria-label="새 주민 이름"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={keepKeys}
          />
          <input
            className="mg-field"
            name="residentGreeting"
            value={greeting}
            maxLength={GREETING_MAX}
            placeholder="인사말"
            aria-label="새 주민 인사말"
            onChange={(event) => setGreeting(event.target.value)}
            onKeyDown={keepKeys}
          />
          <button className="mg-btn is-primary is-small" type="submit" disabled={!item || full}>
            섬에 두기
          </button>
          <small className="mg-muted">
            {placed.length} / {MAX_RESIDENTS}
          </small>
        </div>
      </form>
      {placed.length > 0 && (
        <ul className="mg-resident-list" aria-label="섬의 주민">
          {placed.map((resident) => (
            <ResidentRow
              key={resident.id}
              resident={resident}
              item={items.find((candidate) => candidate.id === resident.npc)}
              session={session}
              residents={residents}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
