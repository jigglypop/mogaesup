import '../../pets/pets.css';

import { useCallback, useEffect, useState } from 'react';

import { problemText } from '../../api/client';
import { petApi } from '../../api/endpoints';
import type { AdminPetBreed, CatalogStatus } from '../../api/types';
import breedList from '../../pets/breeds.json';
import { Icon } from '../../ui/icons';
import { STATUS_LABEL } from './catalogView';
import { Thumb } from './parts';

type Notice = { tone: 'ok' | 'error'; text: string };
type ShippedBreed = { slug: string; name: string; order: number; model: string; thumbnail: string; height_m: number; clips: Record<string, number> };

/** The dogs the app ships (frontend/public/gltf/pets, listed in src/pets/breeds.json). */
const SHIPPED = breedList as ShippedBreed[];
const STATUS_ACTIONS: { status: CatalogStatus; label: string }[] = [
  { status: 'published', label: '공개' },
  { status: 'draft', label: '초안으로' },
  { status: 'retired', label: '내리기' },
];

/**
 * `/admin/catalog`'s pet breeds: every breed with its status and how many pets are of it, moved between draft, public
 * and retired; a dog the app ships that is not a breed yet is added as a draft.
 */
export function PetBreeds({ onNotice }: { onNotice: (notice: Notice) => void }) {
  const [breeds, setBreeds] = useState<AdminPetBreed[] | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const load = useCallback(
    () =>
      petApi.adminBreeds().then(
        (result) => {
          setBreeds(result.breeds);
          setProblem('');
        },
        (error: unknown) => setProblem(`품종을 불러오지 못했어요: ${problemText(error)}`),
      ),
    [],
  );
  useEffect(() => void load(), [load]);

  const run = async (id: string, work: () => Promise<AdminPetBreed>, done: (breed: AdminPetBreed) => string) => {
    setBusy((previous) => new Set(previous).add(id));
    try {
      const breed = await work();
      setBreeds((previous) => {
        const list = previous ?? [];
        return list.some((entry) => entry.id === breed.id) ? list.map((entry) => (entry.id === breed.id ? breed : entry)) : [...list, breed];
      });
      onNotice({ tone: 'ok', text: done(breed) });
    } catch (error) {
      onNotice({ tone: 'error', text: problemText(error) });
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };
  const setStatus = (breed: AdminPetBreed, status: CatalogStatus) =>
    void run(breed.id, () => petApi.patchBreed(breed.id, { status }), (changed) => `${changed.label}: ${STATUS_LABEL[changed.status]}`);
  const register = (shipped: ShippedBreed) =>
    void run(
      shipped.slug,
      () =>
        petApi.registerBreed({
          id: shipped.slug,
          label: shipped.name,
          modelUrl: shipped.model,
          thumbnailUrl: shipped.thumbnail,
          clips: Object.keys(shipped.clips),
          heightM: shipped.height_m,
          sortOrder: shipped.order,
        }),
      (added) => `${added.label}: 초안으로 추가했어요`,
    );
  const unlisted = breeds ? SHIPPED.filter((shipped) => !breeds.some((breed) => breed.id === shipped.slug)) : [];

  return (
    <section className="mg-admin-pets" aria-label="펫 품종">
      <h2 className="mg-heading mg-admin-pets-title">
        <Icon name="paw" /> 펫 품종
      </h2>
      {breeds === null && !problem && <p className="mg-empty">품종을 불러오는 중…</p>}
      {problem && (
        <div className="mg-admin-message is-error" role="alert">
          <span>{problem}</span>
          <button type="button" className="mg-btn is-small" onClick={() => void load()}>
            <Icon name="rotate" /> 다시 불러오기
          </button>
        </div>
      )}
      {breeds && breeds.length > 0 && (
        <div className="mg-table-wrap">
          <table className="mg-table mg-admin-table">
            <thead>
              <tr>
                <th aria-label="그림" />
                <th>이름 · ID</th>
                <th>순서</th>
                <th>펫</th>
                <th>상태</th>
                <th aria-label="바꾸기" />
              </tr>
            </thead>
            <tbody>
              {breeds.map((breed) => (
                <tr key={breed.id}>
                  <td>
                    <Thumb src={breed.thumbnailUrl} fallback={breed.emoji} />
                  </td>
                  <td>
                    <span className="mg-admin-name-cell">
                      <b>{breed.label}</b>
                      <code>{breed.id}</code>
                    </span>
                  </td>
                  <td>{breed.sortOrder}</td>
                  <td>{breed.pets}</td>
                  <td>
                    <span className={`mg-badge is-${breed.status}`}>{STATUS_LABEL[breed.status]}</span>
                  </td>
                  <td>
                    <span className="mg-admin-actions">
                      {STATUS_ACTIONS.filter((action) => action.status !== breed.status).map((action) => (
                        <button
                          key={action.status}
                          type="button"
                          className={`mg-btn is-small${action.status === 'published' ? ' is-primary' : ''}`}
                          disabled={busy.has(breed.id)}
                          onClick={() => setStatus(breed, action.status)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unlisted.length > 0 && (
        <ul className="mg-admin-chips mg-admin-pets-shipped" aria-label="앱에 든 모델">
          {unlisted.map((shipped) => (
            <li key={shipped.slug}>
              <button type="button" className="mg-btn is-small" disabled={busy.has(shipped.slug)} onClick={() => register(shipped)}>
                <Icon name="plus" /> {shipped.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
