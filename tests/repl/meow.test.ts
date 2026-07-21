import { describe, expect, it } from 'vitest';
import { meowFrame } from '../../src/repl/meow.js';

describe(':meow animation', () => {
  it('trots with paws, flicks the tail, scrolls the ground', () => {
    const frames = Array.from({ length: 24 }, (_, index) => meowFrame(index));

    expect(new Set(frames.map((frame) => frame.legs)).size).toBe(3);
    expect(new Set(frames.map((frame) => frame.paws)).size).toBe(3);
    expect(new Set(frames.map((frame) => frame.tailTip)).size).toBeGreaterThan(1);
    expect(new Set(frames.map((frame) => frame.tailStem1)).size).toBeGreaterThan(1);
    expect(new Set(frames.map((frame) => frame.ground)).size).toBeGreaterThan(1);
    expect(new Set(frames.map((frame) => frame.eyes)).size).toBeGreaterThan(1);
  });

  it('keeps a fixed width so nothing jumps', () => {
    for (let index = 0; index < 24; index += 1) {
      const frame = meowFrame(index);
      expect(frame.legs).toHaveLength(15);
      expect(frame.ground).toHaveLength(22);
    }
  });

  it('scrolls the ground ever further to the left', () => {
    // The pebble spacing is 8: after 8 frames the picture repeats.
    expect(meowFrame(0).ground).toBe(meowFrame(8).ground);
    expect(meowFrame(0).ground).not.toBe(meowFrame(1).ground);
  });
});
