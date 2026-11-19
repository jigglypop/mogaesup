import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Link, useNavigate, useParams } from 'react-router-dom';

import { problemText } from '../api/client';
import { sajuApi } from '../api/endpoints';
import type { SharedIsland } from '../api/types';
import { PageShell } from '../shell/Shell';
import { frameOf } from '../saju/scene/frames';
import { Stage } from '../saju/scene/Stage';
import '../saju/saju.css';

const frame = frameOf([{ x: 0, z: 0 }]);

export function IslandsPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [islands, setIslands] = useState<SharedIsland[] | null>(null);
  const [problem, setProblem] = useState('');
  // Each press raises another island, so a second press (or Enter) while one is on its way sends nothing; one that
  // answers after the page was left takes nobody anywhere.
  const creating = useRef(false);
  const shown = useRef(true);
  useEffect(() => {
    let live = true;
    shown.current = true;
    sajuApi.islands().then(
      (page) => { if (live) setIslands(page.islands); },
      () => { if (live) setProblem('공용섬을 불러오지 못했어요.'); },
    );
    return () => { live = false; shown.current = false; };
  }, []);
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (creating.current) return;
    creating.current = true;
    setProblem('');
    void sajuApi.createIsland(title).then(
      (island) => { if (shown.current) navigate(`/island/${island.slug}`); },
      (error) => { if (shown.current) setProblem(problemText(error)); },
    ).finally(() => { creating.current = false; });
  };
  return (
    <PageShell title="공용섬">
      <form onSubmit={create}>
        <label>
          이름
          <input value={title} maxLength={24} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <button className="mg-btn is-primary" type="submit">만들기</button>
      </form>
      {problem && <p className="mg-error" role="alert">{problem}</p>}
      <ul>
        {(islands ?? []).map((island) => (
          <li key={island.id}>
            <Link to={`/island/${island.slug}`}>{island.title}</Link>
            <small>{island.creator}</small>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}

export function SharedIslandPage() {
  const { slug = '' } = useParams();
  const [island, setIsland] = useState<SharedIsland | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let live = true;
    sajuApi.island(slug).then(
      (found) => { if (live) setIsland(found); },
      (error) => { if (live) setProblem(problemText(error)); },
    );
    return () => { live = false; };
  }, [slug]);
  return (
    <div className="mg-saju">
      <div className="mg-saju-world">
        <header className="mg-topbar">
          <Link to="/islands">{island?.title ?? '공용섬'}</Link>
        </header>
        {problem && <p className="mg-error" role="alert">{problem}</p>}
        {island && (
          <div className="mg-saju-stage">
            <Stage homes={[{ id: island.slug, x: 0, z: 0, profile: null }]} bridges={[]} frame={frame} focus={island.slug} />
          </div>
        )}
      </div>
    </div>
  );
}
