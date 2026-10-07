import type { HTMLAttributes } from 'react';

import { useGameRoom, useGameStage } from './room';
import { WalkingControls } from './WalkingControls';

/**
 * The island page's surface (its world and the panels over it), marked with what the island is now: itself, or a
 * game's map that has taken its place (`data-environment="game"`, which puts the island's own panels away meanwhile,
 * as they were). On touch screens it carries the walking pad wherever the viewer walks by themselves: the island, and
 * a game they watch (a game they play brings its own controls).
 */
export function GameSurface({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const stage = useGameStage();
  const decorating = !!useGameRoom()?.decorating;
  return (
    <div {...props} data-environment={stage === 'island' ? 'island' : 'game'}>
      {children}
      {!decorating && (stage === 'island' || stage === 'watch') && <WalkingControls placement={stage === 'island' ? 'island' : 'game'} />}
    </div>
  );
}
