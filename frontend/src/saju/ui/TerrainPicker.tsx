import type { Terrain } from '../../api/types';
import './terrainPicker.css';

const TILES = [
  ['default', '사주 잔디'], ['snow', '눈밭'], ['desert', '모래사막'], ['moss', '이끼 정원'],
] as const;

export function TerrainPicker({ value, onChange }: { value: Terrain; onChange: (tile: Terrain) => void }) {
  return (
    <div className="mg-terrain-tiles" role="group" aria-label="섬 바닥 타일">
      {TILES.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
          <img src={`/saju/terrain/${id}.webp`} alt="" width="192" height="112" draggable={false} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
