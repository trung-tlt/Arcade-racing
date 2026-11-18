import { beforeEach, describe, expect, it } from 'vitest';
import {
  QUALITY_PRESETS,
  loadSettings,
  onSettingsChange,
  resetSettings,
  settings,
  updateSettings,
  userSettings,
} from '../src/core/Settings';

class FakeStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

let storage: FakeStorage;
beforeEach(() => {
  storage = new FakeStorage();
  loadSettings(storage);
  resetSettings();
});

describe('settings', () => {
  it('has the documented defaults', () => {
    expect(userSettings).toMatchObject({
      preset: 'med',
      resolutionScale: 100,
      shadows: true,
      bloom: true,
      showFps: false,
      volumeMaster: 80,
      volumeEffects: 90,
      volumeEngine: 70,
      volumeMusic: 80,
      aimAssist: true,
      cameraShake: true,
      fovKick: true,
      speedUnit: 'kmh',
    });
    expect(settings.volumeMaster).toBeCloseTo(0.8);
    expect(settings.volumeMusic).toBeCloseTo(0.8);
  });

  it('clamps, persists and exposes the music volume (0..1)', () => {
    updateSettings({ volumeMusic: 250 });
    expect(userSettings.volumeMusic).toBe(100);
    updateSettings({ volumeMusic: 30 });
    expect(settings.volumeMusic).toBeCloseTo(0.3);
    const saved = storage.getItem('voltline.settings') as string;
    expect(JSON.parse(saved).volumeMusic).toBe(30);
    const old = new FakeStorage();
    old.setItem('voltline.settings', JSON.stringify({ volumeMaster: 50 })); // saved before the music slider existed
    loadSettings(old);
    expect(userSettings.volumeMusic).toBe(80);
  });

  it('persists and round-trips', () => {
    updateSettings({ volumeMaster: 35, speedUnit: 'mph', fovKick: false, resolutionScale: 75 });
    const saved = storage.getItem('voltline.settings');
    expect(saved).toBeTruthy();
    updateSettings({ volumeMaster: 99 });
    loadSettings(storage); // reload what the last update wrote
    expect(userSettings.volumeMaster).toBe(99);
    const fresh = new FakeStorage();
    fresh.setItem('voltline.settings', saved as string);
    loadSettings(fresh);
    expect(userSettings).toMatchObject({ volumeMaster: 35, speedUnit: 'mph', fovKick: false, resolutionScale: 75 });
  });

  it('falls back to defaults on corrupt or missing JSON', () => {
    const bad = new FakeStorage();
    bad.setItem('voltline.settings', '{not json');
    loadSettings(bad);
    expect(userSettings.preset).toBe('med');
    expect(userSettings.volumeEffects).toBe(90);
    loadSettings(new FakeStorage());
    expect(userSettings.speedUnit).toBe('kmh');
  });

  it('ignores unknown fields and repairs wrong types', () => {
    const s = new FakeStorage();
    s.setItem(
      'voltline.settings',
      JSON.stringify({ hax: 1, preset: 'ultra', bloom: 'yes', volumeMaster: '50', fovKick: false }),
    );
    loadSettings(s);
    expect(userSettings.preset).toBe('med');
    expect(userSettings.bloom).toBe(true);
    expect(userSettings.volumeMaster).toBe(80);
    expect(userSettings.fovKick).toBe(false);
    expect('hax' in userSettings).toBe(false);
  });

  it('clamps out-of-range values', () => {
    updateSettings({ volumeMaster: 500, volumeEngine: -20, resolutionScale: 10 });
    expect(userSettings.volumeMaster).toBe(100);
    expect(userSettings.volumeEngine).toBe(0);
    expect(userSettings.resolutionScale).toBe(50);
    updateSettings({ resolutionScale: 73 });
    expect(userSettings.resolutionScale).toBe(75);
    expect(settings.volumeEngine).toBe(0);
  });

  it('applies presets to shadows, bloom and runtime values', () => {
    updateSettings({ preset: 'low' });
    expect(userSettings.shadows).toBe(false);
    expect(userSettings.bloom).toBe(false);
    expect(settings.shadows).toBe(false);
    expect(settings.particleScale).toBe(QUALITY_PRESETS.low.particleScale);
    updateSettings({ preset: 'high' });
    expect(settings.shadowMapSize).toBe(2048);
    expect(settings.shadows).toBe(true);
    updateSettings({ preset: 'low', bloom: true }); // explicit override wins
    expect(settings.bloom).toBe(true);
    expect(settings.shadows).toBe(false);
  });

  it('scales the pixel ratio by resolution scale', () => {
    updateSettings({ preset: 'low', resolutionScale: 50 });
    expect(settings.pixelRatio).toBeCloseTo(0.5);
  });

  it('notifies listeners and supports unsubscribe', () => {
    let n = 0;
    const off = onSettingsChange(() => n++);
    updateSettings({ showFps: true });
    expect(n).toBe(1);
    resetSettings();
    expect(n).toBe(2);
    off();
    updateSettings({ showFps: true });
    expect(n).toBe(2);
  });

  it('survives a storage that throws', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(() => loadSettings(throwing)).not.toThrow();
    expect(() => updateSettings({ bloom: false })).not.toThrow();
    expect(settings.bloom).toBe(false);
  });
});
