import { defaultPartEdit, type PartEdit } from '../part-edit';

export function PartEditControls({ label, value, disabled, onChange }: { label: string; value?: PartEdit; disabled: boolean; onChange(value: PartEdit | null): void }) {
  const edit = value || defaultPartEdit();
  const set = (kind: keyof PartEdit, axis: 0 | 1 | 2, number: number) => {
    const next: PartEdit = { scale: [...edit.scale], translation: [...edit.translation] }; next[kind][axis] = number; onChange(next);
  };
  return <fieldset className="wardrobe-part-edit" disabled={disabled}><legend>{label}</legend>
    {(['가로', '세로', '깊이'] as const).map((axis, index) => <label key={axis}>{axis} 크기
      <input aria-label={`${label} ${axis} 크기`} type="range" min={.8} max={1.2} step={.01} value={edit.scale[index]} onChange={event => set('scale', index as 0 | 1 | 2, Number(event.target.value))} />
      <output>{Math.round(edit.scale[index]! * 100)}%</output></label>)}
    {(['좌우', '상하', '앞뒤'] as const).map((axis, index) => <label key={axis}>{axis} 위치
      <input aria-label={`${label} ${axis} 위치`} type="range" min={-.05} max={.05} step={.001} value={edit.translation[index]} onChange={event => set('translation', index as 0 | 1 | 2, Number(event.target.value))} />
      <output>{(edit.translation[index]! * 100).toFixed(1)} cm</output></label>)}
    <button type="button" onClick={() => onChange(null)}>원래 크기와 위치</button>
  </fieldset>;
}
