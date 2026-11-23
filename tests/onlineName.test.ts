import { describe, expect, it } from 'vitest';
import { checkName, removeAccents, suggestName, tagText } from '../src/ui/onlineName';
import { startStatus } from '../src/ui/screens/lobby';
import type { RosterEntry } from '../src/shared/protocol';

describe('racer name rules', () => {
  it('accepts letters, numbers, space and . _ -', () => {
    expect(checkName('  Linh_Tran-9.x  ')).toEqual({ kind: 'ok', name: 'Linh_Tran-9.x' });
  });
  it('is empty for blanks', () => {
    expect(checkName('   ')).toEqual({ kind: 'empty' });
  });
  it('flags more than 16 characters', () => {
    expect(checkName('A'.repeat(17))).toEqual({ kind: 'tooLong', n: 17 });
    expect(checkName('A'.repeat(16)).kind).toBe('ok');
  });
  it('offers the accent fix for Vietnamese names', () => {
    const c = checkName('Ngọc Lan');
    expect(c.kind).toBe('accents');
    if (c.kind === 'accents') expect(c.fixed).toBe('Ngoc Lan');
    expect(removeAccents('Đặng Trần')).toBe('Dang Tran');
  });
  it('lists symbols that are simply not allowed', () => {
    expect(checkName('a!b#b!')).toEqual({ kind: 'badChars', chars: ['!', '#'] });
  });
  it('shows name tags in capitals, cut at 12', () => {
    expect(tagText('Linh Tran Long Name')).toBe('LINH TRAN LO');
  });
  it('suggests Word Word-NN', () => {
    expect(suggestName(() => 0)).toBe('NeonKite-10');
    expect(suggestName(() => 0.999)).toMatch(/^SolarBolt-99$/);
  });
});

describe('lobby start line', () => {
  const r = (id: string, ready: boolean): RosterEntry =>
    ({ id, name: id, car: 'x', ready, bot: false, host: id === 'a', ping: 10 }) as RosterEntry;
  it('asks for a second racer when the host is alone', () => {
    const s = startStatus({ roster: [r('a', true)] });
    expect(s.ok).toBe(false);
    expect(s.text).toMatch(/at least 2 racers/);
  });
  it('waits on the ones not ready', () => {
    expect(startStatus({ roster: [r('a', true), r('b', false)] }).text).toMatch(/1\/2 ready · waiting on b/);
  });
});

import { finishedStatus, loadingStatus } from '../src/ui/onlineRaceStatus';
import type { ResultsData } from '../src/ui/types';

describe('online loading status', () => {
  const ro = (id: string, ready: boolean): RosterEntry =>
    ({ id, name: id.toUpperCase(), car: 'x', ready, bot: false, host: false, ping: 1 }) as RosterEntry;
  it('marks loading, ready and (after 10 s) slow racers', () => {
    const s = loadingStatus([ro('a', true), ro('b', false)], 'a', 4);
    expect(s.rows.map((r) => r.state)).toEqual(['ready', 'loading']);
    expect(s.footer).toEqual({ kind: 'wait', secLeft: 16 });
    expect(loadingStatus([ro('a', true), ro('b', false)], 'a', 11).rows[1].state).toBe('slow');
  });
  it('says everyone is in, starting anyway, or that this device is the slow one', () => {
    expect(loadingStatus([ro('a', true), ro('b', true)], 'a', 2).footer).toEqual({ kind: 'all' });
    expect(loadingStatus([ro('a', true), ro('b', false)], 'a', 21).footer).toEqual({ kind: 'anyway', late: ['B'] });
    expect(loadingStatus([ro('a', false), ro('b', true)], 'a', 12).footer).toEqual({ kind: 'youSlow', secLeft: 8 });
  });
});

describe('finished-waiting status', () => {
  const data = {
    position: 2,
    bestLap: '0:41.2',
    rows: [
      { pos: 1, name: 'ZED', total: '1:40.1', isPlayer: false, lap: 3 },
      { pos: 2, name: 'ME', total: '1:41.0', isPlayer: true, lap: 3 },
      { pos: 3, name: 'SLO', total: 'RACING', isPlayer: false, lap: 2 },
    ],
  } as unknown as ResultsData;
  it('lists who is still racing and counts the 30 s grace from the first finisher', () => {
    const s = finishedStatus(data, 3, 12);
    expect(s.place).toBe('P2');
    expect(s.racing).toEqual(['SLO']);
    expect(s.rows[2].text).toBe('LAP 2/3');
    expect(s.secLeft).toBe(18);
    expect(finishedStatus(data, 3, 31).closed).toBe(true);
    expect(finishedStatus(data, 3, null).secLeft).toBeNull();
  });
});
