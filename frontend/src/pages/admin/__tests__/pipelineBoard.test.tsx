import { act } from 'react';

import { describe, expect, it, vi } from 'vitest';

import type { AdminCatalogItem, FactoryCharacter } from '../../../api/types';
import { mount, type } from '../../../__tests__/mount';
import { PipelineBoard } from '../PipelineBoard';

const character: FactoryCharacter = {
  jobId: 'job_b',
  characterId: 'c_b',
  name: '여우2',
  version: 'v1',
  stage: 'complete',
  createdAt: null,
  thumbnailUrl: '',
  face: null,
  faceKnown: true,
  sourceRef: 'job_b/v1',
  modelUrl: '',
  imported: null,
  otherItems: [],
};

/** Another character's public 미니미, worn on 120 islands. */
const fox: AdminCatalogItem = {
  id: 'fox',
  kind: 'minime',
  label: '여우',
  emoji: '🦊',
  modelUrl: '/models/fox.glb',
  thumbnailUrl: null,
  clips: ['idle', 'walk'],
  source: 'factory',
  sourceRef: 'job_a/v1',
  status: 'published',
  sortOrder: 100,
  characterId: 'c_a',
  versionId: 1,
  versionCount: 1,
  usage: 120,
  updatedAt: '2026-09-01T00:00:00Z',
};

describe('스튜디오 캐릭터를 새 항목으로 가져올 때', () => {
  it('이미 있는 ID는 보내지 않고, 보내는 요청은 새 항목만 만들게 한다', async () => {
    const onImport = vi.fn(async () => true);
    const { container, unmount } = await mount(
      <PipelineBoard
        characters={[character]}
        factoryProblem=""
        items={[fox]}
        itemsProblem=""
        onRetryItems={vi.fn()}
        imports={[]}
        busy={new Set()}
        onImport={onImport}
        onStatus={vi.fn()}
        onPreview={vi.fn()}
        onVersions={vi.fn()}
      />,
    );
    const start = [...container.querySelectorAll('button')].find((button) => button.textContent === '가져오기')!;
    await act(async () => start.click());
    const id = container.querySelector<HTMLInputElement>('input[name=id]')!;
    const submit = () =>
      act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });

    await type(id, 'fox');
    await submit();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('이미 있는 카탈로그 ID예요. 다른 ID를 입력해 주세요');
    expect(onImport).not.toHaveBeenCalled();

    await type(id, 'fox-2');
    await submit();
    expect(onImport).toHaveBeenCalledWith(character, { id: 'fox-2', label: '여우2', emoji: '🧑', kind: 'minime', create: true });
    await unmount();
  });
});
