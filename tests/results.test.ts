import { describe, expect, it } from 'vitest';
import { ordinal } from '../src/ui/nameTags';
import { formatScore } from '../src/ui/screens/results';

describe('formatScore', () => {
  it('adds thousands separators', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(980)).toBe('980');
    expect(formatScore(2140)).toBe('2,140');
    expect(formatScore(1234567)).toBe('1,234,567');
  });
});

describe('ordinal', () => {
  it('handles 1st/2nd/3rd and the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
    ]);
  });
});
