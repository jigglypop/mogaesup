import type { WeatherKind } from 'gaesup-world';
import type { BuildingClimate, BuildingWeatherEffect } from 'gaesup-world/building';

import type { IconName } from '../ui/icons';

/** One weather the owner gives the island: a fixed weather, or a climate whose weather comes and goes. */
export type WeatherChoice = {
  key: string;
  label: string;
  icon: IconName;
  weather: BuildingWeatherEffect;
  climate: BuildingClimate;
};

export const WEATHER_CHOICES: readonly WeatherChoice[] = [
  { key: 'clear', label: '맑음', icon: 'sun', weather: 'none', climate: 'off' },
  { key: 'rain', label: '비', icon: 'rain', weather: 'rain', climate: 'off' },
  { key: 'snow', label: '눈', icon: 'snow', weather: 'snow', climate: 'off' },
  { key: 'storm', label: '폭풍', icon: 'storm', weather: 'storm', climate: 'off' },
  { key: 'wind', label: '바람', icon: 'wind', weather: 'wind', climate: 'off' },
  { key: 'auto', label: '계절 따라', icon: 'sparkle', weather: 'none', climate: 'auto' },
  { key: 'spring', label: '봄 날씨', icon: 'flower', weather: 'none', climate: 'spring' },
  { key: 'summer', label: '여름 날씨', icon: 'sun', weather: 'none', climate: 'summer' },
  { key: 'autumn', label: '가을 날씨', icon: 'leaf', weather: 'none', climate: 'autumn' },
  { key: 'winter', label: '겨울 날씨', icon: 'snow', weather: 'none', climate: 'winter' },
];

/** The choice an island's saved weather and climate make: a weather picked by hand wins, as it does in the engine. */
export function weatherChoiceOf(weather: BuildingWeatherEffect, climate: BuildingClimate): WeatherChoice | undefined {
  if (weather !== 'none') return WEATHER_CHOICES.find((choice) => choice.weather === weather);
  return WEATHER_CHOICES.find((choice) => choice.weather === 'none' && choice.climate === climate);
}

/** The sky right now, as the time chip names it. */
export const WEATHER_NOW: Record<WeatherKind, { label: string; icon: IconName }> = {
  sunny: { label: '맑음', icon: 'sun' },
  cloudy: { label: '흐림', icon: 'cloud' },
  rain: { label: '비', icon: 'rain' },
  snow: { label: '눈', icon: 'snow' },
  storm: { label: '폭풍', icon: 'storm' },
  wind: { label: '바람', icon: 'wind' },
};
