import './studio.css';

import { lazy } from 'react';

import { useStudioSleep } from '../api/studioSleep';
import { useAuth } from '../auth/AuthProvider';
import { SignInRedirect } from '../auth/signIn';
import { Loading } from '../pages/Loading';
import { PageShell } from '../shell/Shell';
import { StudioWaking } from './StudioPower';
import { Stage } from './StudioPage';

const Wardrobe = lazy(() => import('../character/studio/Wardrobe'));

/** `/character`: everyone dresses their own character here; making characters is the operators' factory under /admin. */
export default function CharacterPage() {
  const { status, user } = useAuth();
  const sleep = useStudioSleep();
  if (status === 'loading') return <Loading />;
  if (!user) return <SignInRedirect />;
  return (
    <PageShell title="내 캐릭터" wide>
      <Stage>{sleep ? <StudioWaking sleep={sleep} member /> : <Wardrobe />}</Stage>
    </PageShell>
  );
}
