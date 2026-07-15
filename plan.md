# Game Plan: Snake Royale

## Overview
- **Name:** Snake Royale
- **Repo name:** snake-royale
- **Tagline:** Classic snake, but 2–6 snakes share one arena — eat, grow, and cut your rivals off; last snake slithering wins.
- **Genre (directory category):** arcade

## Core Loop
Steer a constantly-moving snake around a walled arena. Eat glowing pellets to grow one segment and bank a point. Crashing into a wall, another snake's body, or your own tail kills you instantly. In **Endless** (solo) you play for the longest snake / highest score until you crash. In **Royale** (2–6 P2P) every snake shares the arena and the last one alive wins the round — a dead snake scatters into pellets, so trapping a rival also feeds you. The tension is spatial: the longer everyone gets, the less room there is, and a well-timed cut-off ends a rival instantly.

## Controls
- **Desktop:** Arrow keys or WASD to turn. Space/Enter to start/restart. Esc/P to pause. M mutes.
- **Mobile:** `patterns/input.ts` virtual D-pad (auto-injected on touch). Swipe also turns the snake (dominant-axis swipe).

## Multiplayer
- **Mode:** live P2P.
- **Players:** 2–6. Topology: **host-authoritative star**.
- **Each peer sends/receives:** clients send only their intended direction on `in`; the host runs the authoritative grid sim on a fixed `setInterval` tick and broadcasts a full state snapshot on `snap` each tick (grid + all snakes + food + phase). Snapshots are tiny (small grid, capped bodies), so full-state is simplest and desync-proof. `sync` lets a late peer request the current snapshot.
- **Room entry:** create a room OR type a room code (`createRoomEntry` + `normalizeRoomCode`); invite link is a convenience only. Deep-linked `?room=` skips straight in once.
- **Late joiner:** joins mid-round as a spectator (no seat), gets snapshots immediately; plays next round if they stay. A seated peer that drops keeps moving straight until it crashes — the sim never stalls.
- **Host leaves:** `net.ts` re-elects the smallest remaining peer id and fires `onHostChange`. The promoted peer adopts its last snapshot as canonical, re-broadcasts it, and resumes the host-only sim `setInterval` — the round keeps advancing and can still reach game-over. Wired via `onHostChange → NetRoyale.setHost(true)`.
- **Channels:** `in` (dir intent), `snap` (state), `sync` (resync request) — all ≤12 bytes.

## Juice Plan
- **Eat:** pellet pop particles, rising-pitch `eat` blip, score pop, brief head-scale pulse.
- **Death:** screen shake + `crash` noise burst, the whole snake bursts into particles and drops pellets.
- **Movement:** smooth interpolation between grid ticks (rAF `alpha`), glowing snake bodies with a gradient tail, subtle grid pulse.
- **Countdown:** 3-2-1 "Go!" with beeps before a royale round.
- **Palette:** Okabe–Ito colour-blind-safe snake colours; each snake also carries a distinct head eye-mark for non-colour distinction.
- All shake/particles respect `prefers-reduced-motion`.

## Style Direction
**Vibe:** neon retro-arcade.
**Palette:** near-black arena (#0b0e14) with a faint grid; snakes in Okabe–Ito (blue #0072B2, vermillion #D55E00, bluish-green #009E73, orange #E69F00, sky #56B4E9, purple #CC79A7); pellets warm gold #F0C420.
**Theme:** dark.
**Reference feel:** the instant-play of a Google Doodle snake, the tension of an io-style last-one-standing arena.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** Canvas 2D (continuous motion, particles, shake).
- **Engine modules copied from patterns/:** loop, input, net, lobby, rng, sound, storage.
- **Persistence:** localStorage — mute setting + Endless best score (via storage.ts).

## Non-Goals
- No power-ups / obstacles this run (keep the core cut-off loop clean).
- No AI bots in solo (solo is pure Endless snake); bots could be a later expansion.
- No wrap-around walls (lethal walls are the classic tension).

## How To Play (player-facing copy)
Eat the glowing pellets to grow and score. Don't hit the walls, another snake, or your own tail. In Royale, the last snake slithering wins — box your rivals in! Turn with the arrow keys, WASD, or the on-screen pad.
