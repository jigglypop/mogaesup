import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Link, useNavigate, useParams } from 'react-router-dom';

import { problemText } from '../api/client';
import { sajuApi } from '../api/endpoints';
import type { SharedIsland } from '../api/types';
import { Brand, PageShell, TopActions } from '../shell/Shell';
import { frameOf } from '../saju/scene/frames';
import { HARBOR_ISLAND } from '../saju/scene/harbor';
import { Stage } from '../saju/scene/Stage';
import { Icon } from '../ui/icons';
import '../saju/saju.css';

const frame = frameOf([{ x: 0, z: 0, reach: HARBOR_ISLAND.reach }]);

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
      <section className="mg-glass mg-panel">
        <div className="mg-panel-head">
          <h1 className="mg-title">공용섬</h1>
        </div>
        <form className="mg-shared-create" onSubmit={create}>
          <input className="mg-field" aria-label="이름" placeholder="이름" value={title} maxLength={24} onChange={(event) => setTitle(event.target.value)} />
          <button className="mg-btn is-primary" type="submit">만들기</button>
        </form>
        {problem && <p className="mg-error" role="alert">{problem}</p>}
        {!islands && !problem && <p className="mg-empty" role="status">불러오는 중…</p>}
        <ul className="mg-islands">
          {(islands ?? []).map((island) => (
            <li key={island.id}>
              <Link className="mg-island-card mg-card" to={`/island/${island.slug}`}>
                <span className="mg-island-sky is-harbor" aria-hidden="true">
                  <Icon name="users" />
                </span>
                <span className="mg-island-info">
                  <b>{island.title}</b>
                  <small>주인 @{island.creator}</small>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
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
    <div className="mg-saju mg-saju-world mg-shared-island">
      <header className="mg-topbar">
        <div className="mg-topbar-left">
          <Brand />
          <div className="mg-pill mg-glass mg-saju-bar">
            <span className="mg-saju-bar-mark">
              <Icon name="users" />
            </span>
            <h1 className="mg-saju-bar-title">{island?.title ?? '공용섬'}</h1>
            {island && (
              <Link className="mg-saju-visits mg-shared-owner" to={`/@${island.creator}`}>
                주인 <b>@{island.creator}</b>
              </Link>
            )}
          </div>
        </div>
        <TopActions>
          <Link className="mg-btn is-small mg-saju-action" to="/islands">
            <Icon name="island" /> <span>공용섬</span>
          </Link>
        </TopActions>
      </header>
      {problem && <p className="mg-error mg-shared-problem" role="alert">{problem}</p>}
      {island && (
        <div className="mg-saju-stage" data-view="home">
          <Stage homes={[{ id: island.slug, x: 0, z: 0, profile: null, place: 'harbor' }]} bridges={[]} frame={frame} focus={island.slug} />
        </div>
      )}
    </div>
  );
}
