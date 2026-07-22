// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * countdown.ts — the three seconds between the round arriving and the snakes moving.
 *
 * Two jobs. The obvious one is fairness: a snake is already travelling on tick
 * one and cannot be stopped, only turned, so an arena that simply appears hands
 * the round to whoever happened to be looking at the screen. You need a beat to
 * find which snake is yours and which way it is pointing before it matters.
 * The quieter one is that it tells you the round is *about* to be yours — an
 * arena that cuts straight to motion reads as a jump-cut.
 *
 * The audio matters more than the number. Players watch the arena, not the
 * overlay, so the pips are what actually starts the round for them: three rising
 * ticks and a higher GO. That is also why the tick fires on the same frame the
 * digit changes rather than on its own timer — a countdown whose sound lags its
 * number feels broken in a way people notice but cannot name.
 *
 * Every peer runs this LOCALLY from the moment the host's start arrives, so they
 * are in step to within one network hop (~50-150ms). The digits used to be
 * gossiped tick by tick from the host, which spent three round-trips to say
 * something every peer already knew and made the pips jitter with the relay.
 * What stays on the wire is the thing that must not be guessed: the host flips
 * the arena from 'count' to 'play' when ITS count ends (see net-game.ts), so
 * there is still exactly one clock the snakes move on.
 */

import type { Sfx } from './sound';

export interface CountdownOptions {
  root: HTMLElement;
  sfx: Sfx;
  /** Ticks to count. Default 3. */
  from?: number;
  /** ms per tick. Default 1000 — only tests have a reason to shorten it. */
  everyMs?: number;
  reducedMotion?: boolean;
  onDone: () => void;
}

export interface Countdown {
  /** Stop early — a peer that left, or a round torn down mid-count. */
  cancel(): void;
}

export function createCountdown(o: CountdownOptions): Countdown {
  const from = o.from ?? 3;
  const everyMs = o.everyMs ?? 1000;
  let n = from;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'assertive');
  if (o.reducedMotion) el.classList.add('reduced');
  o.root.appendChild(el);

  function paint(text: string, cls: string): void {
    el.innerHTML = `<span class="cd-num ${cls}">${text}</span>`;
  }

  function step(): void {
    if (done) return;
    if (n > 0) {
      paint(String(n), 'cd-tick');
      // Pitch climbs with the count so the ear tracks it without reading.
      o.sfx.play('beep', 1 + (from - n) * 0.12);
      n--;
      timer = setTimeout(step, everyMs);
      return;
    }
    paint('GO', 'cd-go');
    o.sfx.play('go');
    timer = setTimeout(() => {
      finish();
      o.onDone();
    }, 450);
  }

  function finish(): void {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    el.remove();
  }

  step();

  return {
    cancel() {
      finish();
    },
  };
}
