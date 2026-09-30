import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  BUILDING_FARM_CROP_OPTIONS,
  BUILDING_FARM_EDGE_OPTIONS,
  BUILDING_FARM_ROWS_OPTIONS,
  BUILDING_FARM_SOIL_OPTIONS,
  BUILDING_FARM_STAGE_OPTIONS,
  BUILDING_TILE_OBJECT_OPTIONS,
  BUILDING_TILE_PRESETS,
  BUILDING_TILE_SHAPE_OPTIONS,
  BUILDING_WALL_KIND_OPTIONS,
  BUILDING_WALL_PRESETS,
  readFarmPlot,
  useBuildingStore,
  useBuildingStoreApi,
  type BuildingOptionMeta,
  type FarmPlotConfig,
} from 'gaesup-world/building';

import type { CatalogItem } from '../api/types';
import { Icon } from '../ui/icons';
import { FURNITURE, ISLAND_FLOORS, LIVING, NATURE, SHELVES, type ModelPiece, type Piece, type Shelf } from './edit/catalog';
import { useEditState } from './edit/context';
import { EditIcon, PieceIcon } from './edit/icons';
import { EIGHTHS, SelectionInspector, Stepper, Turns } from './edit/Inspector';
import { degreesOf } from './edit/objects';
import type { EditPart, EditSession, EditTool } from './edit/session';
import type { ResidentStore } from './residents';
import { ResidentsShelf } from './ResidentsShelf';
import { WEATHER_CHOICES, weatherChoiceOf } from './weather';

type BuildingStoreApi = ReturnType<typeof useBuildingStoreApi>;

const TOOLS: { id: EditTool; label: string; icon: ReactNode; key: string }[] = [
  { id: 'select', label: '선택', icon: <EditIcon name="select" />, key: '1' },
  { id: 'place', label: '놓기', icon: <Icon name="place" />, key: '2' },
  { id: 'paint', label: '칠하기', icon: <Icon name="paint" />, key: '3' },
  { id: 'erase', label: '지우기', icon: <Icon name="erase" />, key: '4' },
];
const HINTS: Record<Exclude<EditTool, 'select'>, Record<EditPart, string>> = {
  place: { object: '땅을 눌러 놓아요 · R 돌리기', tile: '빈 칸을 눌러 바닥을 넓혀요 · Q/E 높이', wall: '칸 가장자리를 눌러 벽을 세워요 · R 돌리기' },
  paint: { object: '물건은 칠할 수 없어요', tile: '바닥 칸을 눌러 고른 바닥으로 칠해요', wall: '벽을 눌러 고른 벽으로 바꿔요' },
  erase: { object: '치울 물건을 눌러요', tile: '지울 바닥 칸을 눌러요', wall: '지울 벽을 눌러요' },
};
const QUARTERS = [0, 90, 180, 270];
const QUARTER = Math.PI / 2;
/** Stairs and ramps face a way; a box or round tile looks the same turned. */
const TURNING_SHAPES = new Set(['stairs', 'ramp']);
/** A farm plot's choices besides its crop, as the inspector offers them while placing or painting farm tiles. */
const FARM_CHOICES = [
  { key: 'stage', label: '자람', options: BUILDING_FARM_STAGE_OPTIONS },
  { key: 'soil', label: '흙', options: BUILDING_FARM_SOIL_OPTIONS },
  { key: 'edge', label: '테두리', options: BUILDING_FARM_EDGE_OPTIONS },
  { key: 'rows', label: '이랑', options: BUILDING_FARM_ROWS_OPTIONS },
] as const;

/** One choice among `options` as a row of radio buttons. */
function Choices<Value extends string>(props: {
  label: string;
  options: readonly BuildingOptionMeta<Value>[];
  value: Value | undefined;
  disabled?: boolean;
  onChoose: (value: Value) => void;
}) {
  return (
    <div className="mg-label">
      {props.label}
      <div className="mg-tabs is-grid" role="radiogroup" aria-label={props.label}>
        {props.options.map((option) => (
          <button key={option.type} role="radio" aria-checked={props.value === option.type} disabled={props.disabled} onClick={() => props.onChoose(option.type)}>
            {option.labelKo}
          </button>
        ))}
      </div>
    </div>
  );
}

const studioPiece = (item: CatalogItem): ModelPiece => ({
  kind: 'model',
  key: item.id,
  id: item.id,
  label: item.label,
  icon: 'studio',
  defaultColor: '#ffffff',
  ...(item.modelUrl ? { modelUrl: item.modelUrl } : {}),
  ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
});

/** Makes `piece` the next thing a click places, at its catalog size and colour. */
function choosePiece(store: BuildingStoreApi, piece: Piece) {
  const state = store.getState();
  if (piece.kind === 'model') {
    state.setSelectedPlacedObjectType('model');
    state.setSelectedModelObjectId(piece.id);
    state.setModelScale(1);
    state.setModelColor(piece.defaultColor);
    state.setModelUrl(piece.modelUrl ?? '');
  } else if (piece.kind === 'tree') {
    state.setSelectedPlacedObjectType('tree');
    state.setTreeKind(piece.treeKind);
  } else {
    state.setSelectedPlacedObjectType(piece.type);
  }
}

type DecorateProps = {
  session: EditSession;
  /** Furniture the admins copied in from the character studio. */
  studioItems: CatalogItem[];
  /** The island's residents, and the published 주민 the owner may add. */
  residents: ResidentStore;
  npcItems: CatalogItem[];
  onReset: () => void;
};

/**
 * 꾸미기: the island's decorating tools over gaesup-world's building store. 선택 picks placed objects to move, turn,
 * copy or remove; 놓기, 칠하기 and 지우기 are the engine's tools, working on the drawer's objects, floors or walls.
 */
export function Decorate({ session, studioItems, residents, npcItems, onReset }: DecorateProps) {
  const store = useBuildingStoreApi();
  const tool = useEditState(session, (state) => state.tool);
  const part = useEditState(session, (state) => state.part);
  const selectedId = useEditState(session, (state) => state.selectedId);
  const topDown = useEditState(session, (state) => state.topDown);
  const notice = useEditState(session, (state) => state.notice);
  const objects = useBuildingStore((state) => state.objects);
  const piece = useBuildingStore((state) =>
    state.selectedPlacedObjectType === 'model'
      ? state.selectedModelObjectId
      : state.selectedPlacedObjectType === 'tree'
        ? `tree-${state.currentTreeKind}`
        : state.selectedPlacedObjectType,
  );
  const modelColor = useBuildingStore((state) => state.currentModelColor);
  const modelUrl = useBuildingStore((state) => state.currentModelUrl);
  const rotation = useBuildingStore((state) =>
    part === 'object' ? state.currentObjectRotation : part === 'tile' ? state.currentTileRotation : state.currentWallRotation,
  );
  const shape = useBuildingStore((state) => state.currentTileShape);
  const height = useBuildingStore((state) => state.currentTileHeight);
  const cover = useBuildingStore((state) => state.selectedTileObjectType);
  const farm = useBuildingStore((state) => state.currentFarm);
  const weather = useBuildingStore((state) => state.weatherEffect);
  const climate = useBuildingStore((state) => state.climate);
  const wallKind = useBuildingStore((state) => state.currentWallKind);
  // Coming back to decorating keeps the part the tools were on, so the drawer opens on its shelf.
  const [shelf, setShelf] = useState<Shelf>(() => ({ object: 'furniture', tile: 'floor', wall: 'wall' } as const)[session.getState().part]);
  const [floor, setFloor] = useState('lawn');
  const [wall, setWall] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const state = store.getState();
    if (state.selectedPlacedObjectType === 'none') choosePiece(store, FURNITURE[0]!);
    state.setCurrentTileMaterialId('lawn');
  }, [store]);

  useEffect(() => {
    session.enter();
    return () => session.exit();
  }, [session]);

  const studio = useMemo(() => studioItems.map(studioPiece), [studioItems]);
  const pieces = useMemo(() => [...FURNITURE, ...LIVING, ...NATURE, ...studio], [studio]);
  const current = pieces.find((item) => item.key === piece);
  const selected = selectedId ? objects.find((object) => object.id === selectedId) : undefined;

  const chooseShelf = (next: Shelf) => {
    setShelf(next);
    setQuery('');
    session.setPart(SHELVES.find((item) => item.id === next)!.part);
    // Residents are placed and weather is picked from the drawer; a click on the island must not drop the last chosen piece.
    if (next === 'residents' || next === 'weather') session.setTool('select');
  };
  /** Picking a floor or wall means using it: the select tool gives way to placing, painting and erasing stay. */
  const toPlace = () => {
    if (session.getState().tool === 'select') session.setTool('place');
  };
  const choose = (next: Piece) => {
    choosePiece(store, next);
    session.setPart('object');
    session.setTool('place');
  };
  const turnNext = (degrees: number) => {
    const state = store.getState();
    const angle = (degrees * Math.PI) / 180;
    if (part === 'object') state.setObjectRotation(angle);
    else if (part === 'tile') state.setTileRotation(angle);
    else state.setWallRotation(angle);
  };
  const nextDegrees = part === 'object' ? degreesOf(rotation) : (Math.round((((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / QUARTER) % 4) * 90;
  const matches = (label: string) => !query.trim() || label.includes(query.trim());
  /** The turns the next piece can take; none for flat floors or drawn trees, which look the same any way round. */
  const turnsFor =
    part === 'object' ? (current?.kind === 'tree' ? null : EIGHTHS) : part === 'wall' || TURNING_SHAPES.has(shape) ? QUARTERS : null;

  const pieceButton = (item: Piece) => (
    <button key={item.key} className="mg-piece" aria-pressed={tool === 'place' && piece === item.key} onClick={() => choose(item)}>
      {item.kind === 'model' && item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <PieceIcon kind={item.icon} tint={'tint' in item ? item.tint : undefined} />}
      <span>{item.label}</span>
    </button>
  );

  const tiles = (() => {
    const shelves: Partial<Record<Shelf, Piece[]>> = { furniture: FURNITURE, living: LIVING, nature: NATURE };
    const list = shelves[shelf];
    if (list) {
      return list.filter((item) => matches(item.label)).map(pieceButton);
    }
    if (shelf === 'studio') {
      if (studio.length === 0) return [<p key="empty" className="mg-empty">스튜디오에서 가져온 가구가 아직 없어요. 운영에서 가져오면 여기에 보여요.</p>];
      return studio.filter((item) => matches(item.label)).map(pieceButton);
    }
    if (shelf === 'weather') {
      const chosen = weatherChoiceOf(weather, climate)?.key;
      return WEATHER_CHOICES.filter((choice) => matches(choice.label)).map((choice) => (
        <button key={choice.key} className="mg-piece" aria-pressed={chosen === choice.key} onClick={() => {
          const state = store.getState();
          state.setWeatherEffect(choice.weather);
          state.setClimate(choice.climate);
        }}>
          <Icon name={choice.icon} />
          <span>{choice.label}</span>
        </button>
      ));
    }
    if (shelf === 'floor') {
      return [
        ...ISLAND_FLOORS.filter((item) => matches(item.label)).map((item) => (
          <button
            key={item.id}
            className="mg-piece"
            aria-pressed={floor === item.id}
            onClick={() => {
              // A floor is bare ground until a cover or crop is picked after it.
              store.getState().setSelectedTileObjectType('none');
              store.getState().setCurrentTileMaterialId(item.id);
              setFloor(item.id);
              toPlace();
            }}
          >
            <i className="mg-piece-swatch" style={{ background: item.color }} />
            <span>{item.label}</span>
          </button>
        )),
        ...BUILDING_TILE_PRESETS.filter((item) => matches(item.labelKo)).map((preset) => (
          <button
            key={preset.id}
            className="mg-piece"
            aria-pressed={floor === preset.id}
            onClick={() => {
              store.getState().setSelectedTileObjectType('none');
              store.getState().applyTilePreset(preset.id);
              setFloor(preset.id);
              toPlace();
            }}
          >
            <i className="mg-piece-swatch" style={{ background: preset.color }} />
            <span>{preset.labelKo}</span>
          </button>
        )),
        ...BUILDING_TILE_OBJECT_OPTIONS.filter((item) => item.type !== 'farm' && matches(item.labelKo)).map((option) => (
          <button key={`cover-${option.type}`} className="mg-piece" aria-pressed={cover === option.type} onClick={() => {
              store.getState().setSelectedTileObjectType(option.type);
              toPlace();
            }}>
            <PieceIcon kind="cover" />
            <span>덮개 · {option.labelKo}</span>
          </button>
        )),
        // Farm tiles by crop; the inspector sets the plot's growth, soil, edge and rows.
        ...BUILDING_FARM_CROP_OPTIONS.filter((item) => matches(`밭 ${item.labelKo}`)).map((option) => (
          <button key={`farm-${option.type}`} className="mg-piece" aria-pressed={cover === 'farm' && (farm.crop ?? 'none') === option.type} onClick={() => {
              const state = store.getState();
              state.setSelectedTileObjectType('farm');
              state.setCurrentFarm({ ...state.currentFarm, crop: option.type });
              toPlace();
            }}>
            <PieceIcon kind="cover" />
            <span>밭 · {option.labelKo}</span>
          </button>
        )),
      ];
    }
    return [
      ...BUILDING_WALL_PRESETS.filter((item) => matches(item.labelKo)).map((preset) => (
        <button
          key={preset.id}
          className="mg-piece"
          aria-pressed={wall === preset.id}
          onClick={() => {
            store.getState().applyWallPreset(preset.id);
            setWall(preset.id);
            toPlace();
          }}
        >
          <PieceIcon kind="wall" />
          <span>{preset.labelKo}</span>
        </button>
      )),
      ...BUILDING_WALL_KIND_OPTIONS.filter((item) => matches(item.labelKo)).map((option) => (
        <button key={`kind-${option.type}`} className="mg-piece" aria-pressed={wallKind === option.type} onClick={() => {
          store.getState().setWallKind(option.type);
          toPlace();
        }}>
          <PieceIcon kind="door" />
          <span>모양 · {option.labelKo}</span>
        </button>
      )),
    ];
  })();

  const reset = (
    <button
      className="mg-btn is-danger is-small"
      onClick={() => {
        if (window.confirm('섬을 처음 모습으로 되돌릴까요? 되돌리기로 다시 가져올 수 있어요.')) onReset();
      }}
    >
      섬 처음 모습으로
    </button>
  );

  const inspector = (() => {
    if (tool === 'select') {
      if (selected) return <SelectionInspector session={session} object={selected} />;
      return (
        <>
          <header>
            <b>선택</b>
            <small>놓인 물건을 눌러 골라요. 고른 물건은 끌어서 옮기고, 돌리고, 복제하고, 지울 수 있어요.</small>
          </header>
          <ul className="mg-edit-tips">
            <li>
              빈 곳을 끌거나 <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd>로 화면을 옮기고, <kbd>T</kbd>로 위에서 봐요
            </li>
            <li>아래에서 놓을 것을 고르면 놓기 도구로 바뀌어요</li>
            <li>
              <kbd>?</kbd>를 누르면 단축키를 모두 볼 수 있어요
            </li>
          </ul>
          {reset}
        </>
      );
    }
    const title = part === 'object' ? (current?.label ?? '물건을 골라요') : part === 'tile' ? '바닥' : '벽';
    const turns = turnsFor;
    return (
      <>
        <header>
          <b>{title}</b>
          <small>{tool === 'place' && part === 'object' && !turns ? '땅을 눌러 놓아요' : HINTS[tool][part]}</small>
        </header>
        {tool === 'place' && part === 'tile' && (
          <>
            <div className="mg-label">
              모양
              <div className="mg-tabs" role="radiogroup" aria-label="바닥 모양">
                {BUILDING_TILE_SHAPE_OPTIONS.map((option) => (
                  <button key={option.type} role="radio" aria-checked={shape === option.type} onClick={() => store.getState().setTileShape(option.type)}>
                    {option.labelKo}
                  </button>
                ))}
              </div>
            </div>
            <div className="mg-label">
              높이
              <Stepper
                label="높이"
                value={`${height}칸`}
                lessDisabled={height <= (TURNING_SHAPES.has(shape) ? 1 : 0)}
                moreDisabled={height >= 6}
                onLess={() => store.getState().setTileHeight(height - 1)}
                onMore={() => store.getState().setTileHeight(height + 1)}
              />
            </div>
          </>
        )}
        {tool !== 'erase' && part === 'tile' && cover === 'farm' &&
          FARM_CHOICES.map(({ key, label, options }) => (
            <Choices<NonNullable<FarmPlotConfig[typeof key]>>
              key={key}
              label={label}
              options={options}
              value={readFarmPlot(farm, rotation)[key]}
              onChoose={(value) => store.getState().setCurrentFarm({ ...store.getState().currentFarm, [key]: value })}
            />
          ))}
        {tool === 'place' && turns && (
          <div className="mg-label">
            회전
            <Turns values={turns} current={nextDegrees} onTurn={turnNext} />
          </div>
        )}
        {/* Colour reaches only models drawn as fallback shapes; a GLB keeps its own colours. */}
        {tool === 'place' && part === 'object' && current?.kind === 'model' && !modelUrl && (
          <div className="mg-label">
            색
            <div className="mg-swatches" role="radiogroup" aria-label="색">
              {[...new Set([current.defaultColor, '#f2ede4', '#8fd0c3', '#ff8a6b', '#3b4a86', '#2d2a32'])].map((color) => (
                <button key={color} role="radio" aria-checked={modelColor === color} aria-label={color} style={{ background: color }} onClick={() => store.getState().setModelColor(color)} />
              ))}
            </div>
          </div>
        )}
        {reset}
      </>
    );
  })();

  return (
    <>
      <div className="mg-toolbar mg-glass" role="toolbar" aria-label="꾸미기 도구">
        <div className="mg-tabs is-fit">
          {TOOLS.map((item) => (
            <button
              key={item.id}
              aria-pressed={tool === item.id}
              aria-label={item.label}
              title={`${item.label} (${item.key})`}
              disabled={item.id === 'paint' && part === 'object'}
              onClick={() => session.setTool(item.id)}
            >
              {item.icon} <span className="mg-tool-label">{item.label}</span>
            </button>
          ))}
        </div>
        <span className="mg-toolbar-gap" aria-hidden="true" />
        {/* Phones have no R key and no room for the inspector while placing. */}
        {tool === 'place' && turnsFor && (
          <button
            className="mg-icon-btn is-quiet mg-only-narrow"
            aria-label="놓을 조각 돌리기"
            onClick={() => turnNext((nextDegrees + (turnsFor[1] ?? 90)) % 360)}
          >
            <EditIcon name="turnRight" />
          </button>
        )}
        <button className="mg-icon-btn is-quiet" aria-pressed={topDown} aria-label="위에서 보기" title="위에서 보기 (T)" onClick={() => session.setTopDown(!topDown)}>
          <EditIcon name="topDown" />
        </button>
        <button className="mg-icon-btn is-quiet" aria-label="단축키" title="단축키 (?)" onClick={() => session.setHelp(true)}>
          <EditIcon name="keyboard" />
        </button>
      </div>

      <aside className={`mg-inspector mg-glass${tool === 'select' && selected ? ' is-selection' : ''}`} aria-label="고른 것">
        {inspector}
        {notice && (
          <p className="mg-edit-notice" role="status">
            {notice}
          </p>
        )}
      </aside>

      <section className={`mg-drawer mg-glass${tool === 'select' && selected ? ' is-behind' : ''}`} aria-label="놓을 것">
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
        {shelf === 'residents' ? (
          <ResidentsShelf session={session} residents={residents} items={npcItems} query={query} />
        ) : (
          <div className="mg-pieces">{tiles}</div>
        )}
      </section>
    </>
  );
}
