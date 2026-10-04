import { defaultPartEdit, PART_REACH, PART_SCALE, type PartEdit } from '../part-edit';

/** Height and how high a part sits come first: they are what fitting a part on mostly takes. */
const SLIDERS: readonly { name: string; kind: keyof PartEdit; axis: 0 | 1 | 2 }[] = [
  { name: '상하 크기', kind: 'scale', axis: 1 },
  { name: '상하 위치', kind: 'translation', axis: 1 },
  { name: '가로 크기', kind: 'scale', axis: 0 },
  { name: '깊이 크기', kind: 'scale', axis: 2 },
  { name: '앞뒤 위치', kind: 'translation', axis: 2 },
  { name: '좌우 위치', kind: 'translation', axis: 0 },
];

export function PartEditControls({ label, value, disabled, onChange }: { label: string; value?: PartEdit; disabled: boolean; onChange(value: PartEdit | null): void }) {
  const edit = value || defaultPartEdit();
  const set = (kind: keyof PartEdit, axis: 0 | 1 | 2, number: number) => {
    const next: PartEdit = { scale: [...edit.scale], translation: [...edit.translation] }; next[kind][axis] = number; onChange(next);
  };
  return <fieldset className="wardrobe-part-edit" disabled={disabled}><legend>{label}</legend>
    {SLIDERS.map(({ name, kind, axis }) => {
      const size = kind === 'scale', number = edit[kind][axis]!;
      return <label key={name}><span>{name}</span>
        <input aria-label={`${label} ${name}`} type="range" min={size ? PART_SCALE.min : -PART_REACH[axis]} max={size ? PART_SCALE.max : PART_REACH[axis]}
          step={size ? .01 : .005} value={number} onChange={event => set(kind, axis, Number(event.target.value))} />
        <output>{size ? `${Math.round(number * 100)}%` : `${(number * 100).toFixed(1)} cm`}</output></label>;
    })}
    <button type="button" onClick={() => onChange(null)}>원래 크기와 위치</button>
  </fieldset>;
}
