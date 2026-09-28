import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  BUILDING_TILE_OBJECT_OPTIONS,
  BUILDING_TILE_PRESETS,
  BUILDING_WALL_KIND_OPTIONS,
  BUILDING_WALL_PRESETS,
  DEFAULT_BUILDING_OBJECT_CATALOG,
  useBuildingStore,
  useBuildingStoreApi,
  type BuildingObjectCatalogItem,
  type BuildingTool,
  type PlacedObjectType,
} from 'gaesup-world/building';

import type { CatalogItem } from '../api/types';
import { Icon, type IconName } from '../ui/icons';

type BuildingStoreApi = ReturnType<typeof useBuildingStoreApi>;
type Snapshot = ReturnType<ReturnType<BuildingStoreApi['getState']>['serialize']>;
type Part = 'object' | 'tile' | 'wall';
type Shelf = 'furniture' | 'living' | 'nature' | 'floor' | 'wall' | 'studio';
type Lively = Exclude<PlacedObjectType, 'model' | 'billboard' | 'none'>;

const SHELVES: { id: Shelf; label: string; part: Part }[] = [
  { id: 'furniture', label: '가구', part: 'object' },
  { id: 'living', label: '생활', part: 'object' },
  { id: 'nature', label: '자연', part: 'object' },
  { id: 'floor', label: '바닥', part: 'tile' },
  { id: 'wall', label: '벽', part: 'wall' },
  { id: 'studio', label: '스튜디오에서 만든 것', part: 'object' },
];
const TOOLS: { id: BuildingTool; label: string; icon: IconName }[] = [
  { id: 'place', label: '놓기', icon: 'place' },
  { id: 'paint', label: '칠하기', icon: 'paint' },
  { id: 'erase', label: '지우기', icon: 'erase' },
];
const HINTS: Record<BuildingTool, Record<Part, string>> = {
  place: { object: '땅을 눌러 놓아요 · R 돌리기', tile: '빈 칸을 눌러 바닥을 넓혀요 · Q/E 높이', wall: '칸 가장자리를 눌러 벽을 세워요 · R 돌리기' },
  paint: { object: '물건은 칠할 수 없어요', tile: '바닥 칸을 눌러 고른 바닥으로 칠해요', wall: '벽을 눌러 고른 벽으로 바꿔요' },
  erase: { object: '치울 물건을 눌러요', tile: '지울 바닥 칸을 눌러요', wall: '지울 벽을 눌러요' },
};
const byCategory = (...categories: BuildingObjectCatalogItem['category'][]) =>
  DEFAULT_BUILDING_OBJECT_CATALOG.filter((item) => categories.includes(item.category));
const FURNITURE = byCategory('furniture', 'decor');
const LIVING = byCategory('utility', 'structure', 'shop');
const LIVELY: { type: Lively; label: string }[] = [
  { type: 'tree', label: '나무' },
  { type: 'sakura', label: '벚꽃' },
  { type: 'flag', label: '깃발' },
  { type: 'fire', label: '모닥불' },
];
/** The island's own floors first, so painted ground can go back to lawn. */
const ISLAND_FLOORS = [
  { id: 'lawn', label: '잔디밭', color: '#8ccd65' },
  { id: 'flowers', label: '꽃밭', color: '#6fbf53' },
  { id: 'field', label: '밭', color: '#8a5f3a' },
  { id: 'floor', label: '마루', color: '#d3a36a' },
];
const PALETTE = ['#f2ede4', '#8fd0c3', '#ff8a6b', '#3b4a86', '#2d2a32'];
const TURNS = [0, 90, 180, 270];
const QUARTER = Math.PI / 2;

/** Line drawings for the catalog's fallback kinds and the lively pieces. */
const PIECE_PATHS: Record<string, string> = {
  chair: 'M8 4v16M8 12h8v8M16 12V9',
  table: 'M4 8h16M6 8v11M18 8v11M9 8v5h6V8',
  bed: 'M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5M6 11.5a1.5 1.5 0 1 0 0 .1',
  storage: 'M5 4h14v16H5zM5 12h14M11 8h2M11 16h2',
  lamp: 'M9 3h6l2.5 6h-11zM12 9v10M8.5 20.5h7',
  mailbox: 'M4 11a4 4 0 0 1 8 0v7H4zM8 7h9a3 3 0 0 1 3 3v8h-8M16 18v3M16 10V5h3',
  crafting: 'M3.5 9h17v4h-17zM6 13v7M18 13v7M9 9V6h6v3',
  shop: 'M4 9.5L6 4h12l2 5.5M4 9.5h16V20H4zM10 20v-5h4v5',
  door: 'M6 3h12v18H6zM14.5 12.5h.01',
  window: 'M5 5h14v14H5zM12 5v14M5 12h14',
  fence: 'M5 7l2-2.5L9 7v13H5zM15 7l2-2.5L19 7v13h-4zM9 10h6M9 15h6',
  tree: 'M12 3a5 5 0 0 1 5 5a4 4 0 0 1-1 7.8H8A4 4 0 0 1 7 8a5 5 0 0 1 5-5zM12 15.8V21',
  sakura: 'M12 4c1.6 2 1.6 4 0 5.2c-1.6-1.2-1.6-3.2 0-5.2zM4.5 11c2.2-1.2 4.2-1 5.2.6c-1.6 1.2-3.6 1-5.2-.6zM19.5 11c-2.2-1.2-4.2-1-5.2.6c1.6 1.2 3.6 1 5.2-.6zM8 19c.3-2.5 1.8-3.8 3.6-3.4c-.3 1.9-1.8 3.3-3.6 3.4zM16 19c-.3-2.5-1.8-3.8-3.6-3.4c.3 1.9 1.8 3.3 3.6 3.4z',
  flag: 'M6 21V4M6 5h11l-2.2 4L17 13H6',
  fire: 'M12 3c1 3.2 5 5.2 5 10a5 5 0 0 1-10 0c0-2.2 1-3.7 2.2-4.8c0 2 .8 3.2 2 3.3c0-3-1.2-5 .8-8.5z',
  floor: 'M4 8.5L12 4.5l8 4-8 4zM4 8.5v7l8 4 8-4v-7M12 12.5v7',
  wall: 'M3.5 6h17v12h-17zM3.5 12h17M9 6v6M15 12v6',
  cover: 'M5 19c0-7 5-12 14-13c-1 9-6 14-13 14M5 19c3-4 6-6.5 9-8',
  studio: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
};

function PieceIcon({ kind }: { kind: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PIECE_PATHS[kind] ?? PIECE_PATHS['studio']} />
    </svg>
  );
}

/** Places the catalog item at its catalog size and colour. */
function pickModel(store: BuildingStoreApi, item: { id: string; defaultColor: string; modelUrl?: string | undefined }) {
  const state = store.getState();
  state.setSelectedPlacedObjectType('model');
  state.setSelectedModelObjectId(item.id);
  state.setModelScale(1);
  state.setModelColor(item.defaultColor);
  state.setModelUrl(item.modelUrl ?? '');
}

/** Undo and redo over the island's placed objects, floors and walls, as whole snapshots of the building store. */
export function useBuildingHistory(store: BuildingStoreApi) {
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const last = useRef<Snapshot | null>(null);
  const applying = useRef(false);
  const [, changed] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    last.current = store.getState().serialize();
    let timer = 0;
    const unsubscribe = store.subscribe((state, previous) => {
      if (applying.current) return;
      if (state.objects === previous.objects && state.tileGroups === previous.tileGroups && state.wallGroups === previous.wallGroups) return;
      clearTimeout(timer);
      // A drag paints many cells; one pause makes one step.
      timer = window.setTimeout(() => {
        if (last.current) past.current.push(last.current);
        if (past.current.length > 60) past.current.shift();
        future.current = [];
        last.current = store.getState().serialize();
        changed();
      }, 250);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [store]);

  const move = (from: typeof past, to: typeof past) => {
    const snapshot = from.current.pop();
    if (!snapshot || !last.current) return;
    to.current.push(last.current);
    applying.current = true;
    try {
      store.getState().hydrate(snapshot);
    } finally {
      applying.current = false;
    }
    last.current = snapshot;
    changed();
  };
  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    undo: () => move(past, future),
    redo: () => move(future, past),
  };
}

export type DecorateProps = {
  /** Furniture the admins copied in from the character studio. */
  studioItems: CatalogItem[];
  onReset: () => void;
};

/**
 * 꾸미기: the building edit mode with the island's choices. It drives gaesup-world's building store: the edit mode
 * picks what a click works on, the tool what it does, and the current piece, floor or wall what it uses.
 */
export function Decorate({ studioItems, onReset }: DecorateProps) {
  const store = useBuildingStoreApi();
  const mode = useBuildingStore((state) => state.editMode);
  const part: Part = mode === 'tile' || mode === 'wall' ? mode : 'object';
  const tool = useBuildingStore((state) => state.buildingTool);
  const piece = useBuildingStore((state) => (state.selectedPlacedObjectType === 'model' ? state.selectedModelObjectId : state.selectedPlacedObjectType));
  const modelColor = useBuildingStore((state) => state.currentModelColor);
  const rotation = useBuildingStore((state) =>
    part === 'object' ? state.currentObjectRotation : part === 'tile' ? state.currentTileRotation : state.currentWallRotation,
  );
  const cover = useBuildingStore((state) => state.selectedTileObjectType);
  const wallKind = useBuildingStore((state) => state.currentWallKind);
  const [shelf, setShelf] = useState<Shelf>('furniture');
  const [floor, setFloor] = useState('lawn');
  const [wall, setWall] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const state = store.getState();
    state.setEditMode('object');
    if (state.selectedPlacedObjectType === 'none') pickModel(store, FURNITURE[0]!);
    state.setCurrentTileMaterialId('lawn');
    return () => {
      store.getState().setBuildingTool('place');
      store.getState().setEditMode('none');
    };
  }, [store]);

  const chooseShelf = (next: Shelf) => {
    setShelf(next);
    setQuery('');
    const nextPart = SHELVES.find((item) => item.id === next)!.part;
    store.getState().setEditMode(nextPart);
    if (nextPart === 'object' && tool === 'paint') store.getState().setBuildingTool('place');
  };
  const turn = (degrees: number) => {
    const state = store.getState();
    const angle = (degrees / 90) * QUARTER;
    if (part === 'object') state.setObjectRotation(angle);
    else if (part === 'tile') state.setTileRotation(angle);
    else state.setWallRotation(angle);
  };
  const degrees = Math.round(((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / QUARTER) % 4 * 90;

  const selected = useMemo(() => {
    const model = [...DEFAULT_BUILDING_OBJECT_CATALOG, ...studioItems.map((item) => ({ id: item.id, label: item.label }))].find((item) => item.id === piece);
    if (model) return { label: model.label, kind: 'model' as const };
    const lively = LIVELY.find((item) => item.type === piece);
    return lively ? { label: lively.label, kind: 'lively' as const } : null;
  }, [piece, studioItems]);
  const matches = (label: string) => !query.trim() || label.includes(query.trim());

  const tiles = (() => {
    if (shelf === 'furniture' || shelf === 'living') {
      return (shelf === 'furniture' ? FURNITURE : LIVING).filter((item) => matches(item.label)).map((item) => (
        <button key={item.id} className="mg-piece" aria-pressed={piece === item.id} onClick={() => pickModel(store, item)}>
          <PieceIcon kind={item.fallbackKind} />
          <span>{item.label}</span>
        </button>
      ));
    }
    if (shelf === 'nature') {
      return LIVELY.filter((item) => matches(item.label)).map((item) => (
        <button key={item.type} className="mg-piece" aria-pressed={piece === item.type} onClick={() => store.getState().setSelectedPlacedObjectType(item.type)}>
          <PieceIcon kind={item.type} />
          <span>{item.label}</span>
        </button>
      ));
    }
    if (shelf === 'studio') {
      if (studioItems.length === 0) return [<p key="empty" className="mg-empty">스튜디오에서 가져온 가구가 아직 없어요. 운영에서 가져오면 여기에 보여요.</p>];
      return studioItems.filter((item) => matches(item.label)).map((item) => (
        <button key={item.id} className="mg-piece" aria-pressed={piece === item.id} onClick={() => pickModel(store, { id: item.id, defaultColor: '#ffffff', modelUrl: item.modelUrl })}>
          {item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <PieceIcon kind="studio" />}
          <span>{item.label}</span>
        </button>
      ));
    }
    if (shelf === 'floor') {
      return [
        ...ISLAND_FLOORS.filter((item) => matches(item.label)).map((item) => (
          <button key={item.id} className="mg-piece" aria-pressed={floor === item.id} onClick={() => { store.getState().setCurrentTileMaterialId(item.id); setFloor(item.id); }}>
            <i className="mg-piece-swatch" style={{ background: item.color }} />
            <span>{item.label}</span>
          </button>
        )),
        ...BUILDING_TILE_PRESETS.filter((item) => matches(item.labelKo)).map((preset) => (
          <button key={preset.id} className="mg-piece" aria-pressed={floor === preset.id} onClick={() => { store.getState().applyTilePreset(preset.id); setFloor(preset.id); }}>
            <i className="mg-piece-swatch" style={{ background: preset.color }} />
            <span>{preset.labelKo}</span>
          </button>
        )),
        ...BUILDING_TILE_OBJECT_OPTIONS.filter((item) => matches(item.labelKo)).map((option) => (
          <button key={`cover-${option.type}`} className="mg-piece" aria-pressed={cover === option.type} onClick={() => store.getState().setSelectedTileObjectType(option.type)}>
            <PieceIcon kind="cover" />
            <span>덮개 · {option.labelKo}</span>
          </button>
        )),
      ];
    }
    return [
      ...BUILDING_WALL_PRESETS.filter((item) => matches(item.labelKo)).map((preset) => (
        <button key={preset.id} className="mg-piece" aria-pressed={wall === preset.id} onClick={() => { store.getState().applyWallPreset(preset.id); setWall(preset.id); }}>
          <PieceIcon kind="wall" />
          <span>{preset.labelKo}</span>
        </button>
      )),
      ...BUILDING_WALL_KIND_OPTIONS.filter((item) => matches(item.labelKo)).map((option) => (
        <button key={`kind-${option.type}`} className="mg-piece" aria-pressed={wallKind === option.type} onClick={() => store.getState().setWallKind(option.type)}>
          <PieceIcon kind="door" />
          <span>모양 · {option.labelKo}</span>
        </button>
      )),
    ];
  })();

  return (
    <>
      <div className="mg-toolbar mg-glass" role="toolbar" aria-label="꾸미기 도구">
        <div className="mg-tabs is-fit">
          {TOOLS.map((item) => (
            <button
              key={item.id}
              aria-pressed={tool === item.id}
              disabled={item.id === 'paint' && part === 'object'}
              onClick={() => store.getState().setBuildingTool(item.id)}
            >
              <Icon name={item.icon} /> {item.label}
            </button>
          ))}
        </div>
      </div>

      <aside className="mg-inspector mg-glass" aria-label="고른 것">
        <header>
          <b>{part === 'object' ? (selected?.label ?? '물건을 골라요') : part === 'tile' ? '바닥' : '벽'}</b>
          <small>{HINTS[tool][part]}</small>
        </header>
        {tool === 'place' && (
          <div className="mg-label">
            회전
            <div className="mg-tabs" role="radiogroup" aria-label="회전">
              {TURNS.map((value) => (
                <button key={value} role="radio" aria-checked={degrees === value} onClick={() => turn(value)}>
                  {value}°
                </button>
              ))}
            </div>
          </div>
        )}
        {tool === 'place' && part === 'object' && selected?.kind === 'model' && (
          <div className="mg-label">
            색
            <div className="mg-swatches" role="radiogroup" aria-label="색">
              {[...new Set([DEFAULT_BUILDING_OBJECT_CATALOG.find((item) => item.id === piece)?.defaultColor ?? '#a6784f', ...PALETTE])].map((color) => (
                <button key={color} role="radio" aria-checked={modelColor === color} aria-label={color} style={{ background: color }} onClick={() => store.getState().setModelColor(color)} />
              ))}
            </div>
          </div>
        )}
        <button
          className="mg-btn is-danger is-small"
          onClick={() => {
            if (window.confirm('섬을 처음 모습으로 되돌릴까요? 되돌리기로 다시 가져올 수 있어요.')) onReset();
          }}
        >
          섬 처음 모습으로
        </button>
      </aside>

      <section className="mg-drawer mg-glass" aria-label="놓을 것">
        <div className="mg-drawer-head">
          <div className="mg-tabs is-fit" role="tablist" aria-label="종류">
            {SHELVES.map((item) => (
              <button key={item.id} role="tab" aria-selected={shelf === item.id} onClick={() => chooseShelf(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          <label className="mg-drawer-search">
            <Icon name="search" />
            <input value={query} placeholder="물건 찾기" aria-label="물건 찾기" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.stopPropagation()} />
          </label>
        </div>
        <div className="mg-pieces">{tiles}</div>
      </section>
    </>
  );
}
