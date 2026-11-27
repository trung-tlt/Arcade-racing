import { describe, expect, it } from 'vitest';
import { shouldShowInstallHint, type HintEnv } from '../src/ui/touch/installHint';

const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const base: HintEnv = {
  userAgent: SAFARI_IPHONE,
  platform: 'iPhone',
  maxTouchPoints: 5,
  standalone: false,
  shown: 0,
  dismissed: false,
};

describe('install hint', () => {
  it('shows in iPhone Safari, in a tab, the first time', () => {
    expect(shouldShowInstallHint(base)).toBe(true);
  });
  it('shows on an iPad that reports a Mac platform', () => {
    const ipad = {
      ...base,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    };
    expect(shouldShowInstallHint(ipad)).toBe(true);
  });
  it('stays away from desktop Macs, Android, installed apps, other iOS browsers and after the limit or a dismissal', () => {
    expect(
      shouldShowInstallHint({
        ...base,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowInstallHint({
        ...base,
        userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36',
        platform: 'Linux armv81',
      }),
    ).toBe(false);
    expect(shouldShowInstallHint({ ...base, standalone: true })).toBe(false);
    expect(shouldShowInstallHint({ ...base, userAgent: SAFARI_IPHONE.replace('Version/17.4', 'CriOS/120') })).toBe(
      false,
    );
    expect(shouldShowInstallHint({ ...base, shown: 2 })).toBe(false);
    expect(shouldShowInstallHint({ ...base, dismissed: true })).toBe(false);
  });
});
