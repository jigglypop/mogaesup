import { describe, expect, it } from 'vitest';

import { WEATHER_CHOICES, weatherChoiceOf } from '../weather';

describe('weatherChoiceOf', () => {
  it('names a weather picked by hand, whatever the climate', () => {
    expect(weatherChoiceOf('rain', 'off')?.key).toBe('rain');
    expect(weatherChoiceOf('snow', 'summer')?.key).toBe('snow');
  });

  it('names the climate while no weather is picked', () => {
    expect(weatherChoiceOf('none', 'off')?.key).toBe('clear');
    expect(weatherChoiceOf('none', 'auto')?.key).toBe('auto');
    expect(weatherChoiceOf('none', 'winter')?.key).toBe('winter');
  });

  it('gives every choice a distinct key', () => {
    expect(new Set(WEATHER_CHOICES.map((choice) => choice.key)).size).toBe(WEATHER_CHOICES.length);
  });
});
