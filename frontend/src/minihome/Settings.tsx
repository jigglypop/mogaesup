import type { WorldQuality } from 'gaesup-world';

import { usePopover } from '../shell/Shell';
import { Icon } from '../ui/icons';
import type { SceneSettings } from './Scene';

const QUALITY: { value: WorldQuality & string; label: string }[] = [
  { value: 'auto', label: '자동' },
  { value: 'high', label: '높음' },
  { value: 'medium', label: '보통' },
  { value: 'low', label: '낮음' },
];

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="mg-switch">
      <span>
        <b>{label}</b>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

type SettingsProps = {
  settings: SceneSettings;
  onChange: (next: Partial<SceneSettings>) => void;
  bgm: boolean;
  onBgm: (on: boolean) => void;
  onPerformance: () => void;
};

/** How the world draws on this device; kept per viewer. */
export function SettingsMenu({ settings, onChange, bgm, onBgm, onPerformance }: SettingsProps) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="mg-anchor" ref={ref}>
      <button className="mg-icon-btn" aria-label="화면 설정" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="gear" />
      </button>
      {open && (
        <div className="mg-popover mg-menu mg-settings is-right" role="dialog" aria-label="화면 설정" tabIndex={-1}>
          <p className="mg-menu-title">화면 품질</p>
          <div className="mg-tabs" role="radiogroup" aria-label="화면 품질">
            {QUALITY.map((option) => (
              <button key={option.value} role="radio" aria-checked={settings.quality === option.value} onClick={() => onChange({ quality: option.value })}>
                {option.label}
              </button>
            ))}
          </div>
          <Switch label="후처리" checked={settings.postProcessing} onChange={(postProcessing) => onChange({ postProcessing })} />
          {/* Turning it on turns 후처리 on with it, which the switch above then shows. */}
          <Switch
            label="고품질 조명"
            checked={settings.postProcessing && !!settings.cinematic}
            onChange={(cinematic) => onChange(cinematic ? { cinematic, postProcessing: true } : { cinematic })}
          />
          <Switch label="가리면 반투명" checked={settings.cameraFade ?? true} onChange={(cameraFade) => onChange({ cameraFade })} />
          <Switch label="절전 모드" checked={settings.idleThrottle} onChange={(idleThrottle) => onChange({ idleThrottle })} />
          <Switch label="배경 음악" checked={bgm} onChange={onBgm} />
          <button
            className="mg-btn is-quiet is-small"
            onClick={() => {
              setOpen(false);
              onPerformance();
            }}
          >
            <Icon name="gauge" /> 성능 보기
          </button>
        </div>
      )}
    </div>
  );
}
