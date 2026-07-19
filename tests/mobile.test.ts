/**
 * mobile.test.ts — the zoom guards, which the viewport meta cannot deliver.
 *
 * `<meta name="viewport" content="user-scalable=no">` is IGNORED by iOS Safari
 * and has been since iOS 10. A real player double-tapped mid-round, zoomed into
 * the arena, and had no way back out. Steering a snake is fast repeated taps and
 * swipes, so this is not a corner case here — it is the primary input.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { hardenViewport, type Unharden } from '@ben-gy/game-engine/mobile';

let unharden: Unharden | undefined;

afterEach(() => {
  unharden?.();
  unharden = undefined;
  document.documentElement.style.removeProperty('--vh');
});

/** jsdom has no TouchEvent; a plain Event carries what these handlers read. */
function touchEvent(type: string, touches: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: new Array(touches).fill({}) });
  return e;
}

function fire(e: Event): boolean {
  document.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('hardenViewport — pinch', () => {
  it('refuses the iOS gesture events, the only way to say no to a pinch', () => {
    unharden = hardenViewport();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      expect(fire(new Event(type, { cancelable: true }))).toBe(true);
    }
  });

  it('refuses a multi-touch move (Android routes pinch through touchmove)', () => {
    unharden = hardenViewport();
    expect(fire(touchEvent('touchmove', 2))).toBe(true);
  });

  it('leaves a ONE-finger move alone — that is a player steering', () => {
    unharden = hardenViewport();
    expect(fire(touchEvent('touchmove', 1))).toBe(false);
  });
});

describe('hardenViewport — double-tap zoom', () => {
  it('cancels the second tap inside the double-tap window', () => {
    unharden = hardenViewport();
    expect(fire(touchEvent('touchend', 1))).toBe(false); // first tap: a turn
    expect(fire(touchEvent('touchend', 1))).toBe(true); // second: a zoom, denied
  });

  it('cancels dblclick', () => {
    unharden = hardenViewport();
    expect(fire(new Event('dblclick', { cancelable: true }))).toBe(true);
  });
});

describe('hardenViewport — --vh', () => {
  it('publishes the real viewport height for calc(var(--vh) * 100)', () => {
    unharden = hardenViewport();
    const vh = document.documentElement.style.getPropertyValue('--vh');
    expect(vh).toBe(`${window.innerHeight * 0.01}px`);
  });

  it('ignores a 0 height rather than collapsing the layout', () => {
    // A backgrounded or pre-rendered tab reports innerHeight 0. Writing that
    // through would set --vh: 0px and every calc(var(--vh) * 100) layout would
    // collapse to a blank page. The 1vh fallback in mobile.css must survive.
    const real = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { value: 0, configurable: true });
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
    Object.defineProperty(window, 'innerHeight', { value: real, configurable: true });
  });
});

describe('hardenViewport — teardown', () => {
  it('unhardening removes every listener it installed', () => {
    hardenViewport()();
    expect(fire(new Event('gesturestart', { cancelable: true }))).toBe(false);
    expect(fire(touchEvent('touchmove', 2))).toBe(false);
  });
});
