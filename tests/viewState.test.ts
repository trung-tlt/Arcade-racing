import { describe, expect, it } from 'vitest';
import { ViewState } from '../src/core/ViewState';

const fake = () => {
  const d: Record<string, string> = {};
  return { d, getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => void (d[k] = v) };
};

describe('ViewState', () => {
  it('V cycles chase → hood → cockpit → chase, H cycles full → minimal → off, M toggles the mirror', () => {
    const v = new ViewState();
    expect([v.cycleCamera(), v.cycleCamera(), v.cycleCamera()]).toEqual(['hood', 'cockpit', 'chase']);
    expect([v.cycleHud(), v.cycleHud(), v.cycleHud()]).toEqual(['minimal', 'off', 'full']);
    expect([v.toggleMirror(), v.toggleMirror()]).toEqual([false, true]);
  });
  it('remembers its state and notifies listeners', () => {
    const s = fake();
    const a = new ViewState(s);
    let calls = 0;
    a.onChange(() => calls++);
    a.cycleCamera();
    a.cycleHud();
    expect(calls).toBe(2);
    const b = new ViewState(s);
    expect([b.camera, b.hud, b.mirror]).toEqual(['hood', 'minimal', true]);
  });
  it('survives corrupt and missing storage', () => {
    const s = fake();
    s.setItem('voltline.view', '{nope');
    expect(new ViewState(s).camera).toBe('chase');
    expect(() => new ViewState(null).cycleCamera()).not.toThrow();
  });
});
