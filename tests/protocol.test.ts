import { describe, expect, it } from 'vitest';
import { dataHash } from '../src/shared/dataHash';
import {
  MAX_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  parseClientMessage,
  parseServerMessage,
  sanitizeName,
} from '../src/shared/protocol';

const join = { t: 'join', v: PROTOCOL_VERSION, hash: 'abc', name: 'Linh', car: 'kestrel_gt', room: 'abc12' };
const ok = (m: unknown): ReturnType<typeof parseClientMessage> => parseClientMessage(JSON.stringify(m));

describe('client message validation', () => {
  it('accepts a join and normalises the room code and name', () => {
    const r = ok({ ...join, name: '  <b>Linh</b>\n', room: 'ab-c12!' });
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.t === 'join') {
      expect(r.msg.room).toBe('ABC12');
      expect(r.msg.name).toBe('bLinh/b');
    }
  });

  it('clamps input ranges and rejects non-numbers', () => {
    const r = ok({ t: 'input', tick: 7, throttle: 5, brake: -2, steer: 9, drift: 1, nitro: true, fire: 'yes' });
    expect(r).toEqual({
      ok: true,
      msg: {
        t: 'input',
        tick: 7,
        throttle: 1,
        brake: 0,
        steer: 1,
        drift: false,
        nitro: true,
        fire: false,
        fireSecondary: false,
      },
    });
    expect(ok({ t: 'input', tick: 1, throttle: 'a', brake: 0, steer: 0 }).ok).toBe(false);
    expect(parseClientMessage('{"t":"input","tick":1,"throttle":1e999,"brake":0,"steer":0}').ok).toBe(false);
    expect(ok({ t: 'input', tick: -1, throttle: 0, brake: 0, steer: 0 }).ok).toBe(false);
    expect(ok({ t: 'input', tick: 1.5, throttle: 0, brake: 0, steer: 0 }).ok).toBe(false);
  });

  it('rejects junk, oversize and unknown types', () => {
    expect(parseClientMessage('not json').ok).toBe(false);
    expect(parseClientMessage('42').ok).toBe(false);
    expect(parseClientMessage('null').ok).toBe(false);
    expect(ok({ t: 'nope' }).ok).toBe(false);
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)).ok).toBe(false);
    expect(ok({ ...join, room: '!!!' }).ok).toBe(false);
    expect(ok({ ...join, laps: 'many' }).ok).toBe(false);
  });

  it('caps laps and sanitises names', () => {
    const r = ok({ ...join, laps: 99 });
    if (r.ok && r.msg.t === 'join') expect(r.msg.laps).toBe(9);
    expect(sanitizeName('', 16, 'Player')).toBe('Player');
    expect(sanitizeName('x'.repeat(40), 16, 'P')).toHaveLength(16);
  });

  it('a ping carries the client stats, clamped; a malformed block is dropped but the ping stays', () => {
    const cs = {
      sec: 2,
      frames: 120,
      hitches: 1,
      over50: 3,
      snaps: 0,
      maxErrM: 0.9,
      nearOver50: 2,
      holds: 0,
      catchUps: 1,
      interpMs: 120,
      deep: 0,
    };
    const good = ok({ t: 'ping', c: 5, rtt: 50, cs });
    expect(good.ok && good.msg).toEqual({ t: 'ping', c: 5, rtt: 50, cs });
    const huge = ok({ t: 'ping', c: 5, cs: { ...cs, frames: 1e12 } });
    expect(huge.ok && huge.msg.t === 'ping' && huge.msg.cs?.frames).toBe(1e6);
    const partial = ok({ t: 'ping', c: 5, cs: { sec: 2 } });
    expect(partial.ok && partial.msg).toEqual({ t: 'ping', c: 5 });
  });

  it('parses a server message and survives garbage', () => {
    expect(parseServerMessage('{"t":"pong","c":1,"s":2}')).toEqual({ t: 'pong', c: 1, s: 2 });
    expect(parseServerMessage('garbage')).toBeNull();
    expect(parseServerMessage('{"x":1}')).toBeNull();
  });

  it('data hash is stable', () => {
    expect(dataHash()).toBe(dataHash());
    expect(dataHash()).toMatch(/^[0-9a-f]{8}$/);
  });
});
