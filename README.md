# Snake Royale

**Classic snake, but 2–6 snakes share one arena — eat, grow, cut rivals off; last snake slithering wins.**

🎮 Play: https://snake-royale.benrichardson.dev

## What it is
Snake Royale is a free, instant-play take on the arcade classic. Steer a
constantly-moving snake around a walled arena, eat the glowing gold pellets to
grow and score, and never hit a wall, another snake, or your own tail.

- **Endless (solo):** play for the longest snake and your best score. The snake
  speeds up as you grow — one wrong turn ends the run.
- **Royale (2–6, peer-to-peer):** everyone shares one arena and the last snake
  alive wins the round. A beaten snake bursts into pellets, so boxing a rival in
  also feeds you. It's fun for one person immediately; multiplayer is an option
  behind a room code, never a gate.

## How to play
- **Turn:** Arrow keys / WASD, a swipe, or the on-screen D-pad (mobile).
- **Pause / Restart (solo):** P or Esc to pause, R to restart.
- **Mute:** M.
- **Goal:** eat pellets to grow; avoid walls, other snakes and your own tail.

## Multiplayer
Live **peer-to-peer** over WebRTC — there is no game server. One player creates a
room and shares the 4-letter code (or the invite link); a friend can **type the
code** or open the link. The host runs the authoritative simulation and
broadcasts a snapshot each tick; if the host leaves, the game re-elects a new
host on the fly and the round keeps going. Public signaling relays broker the
initial connection, and a small first-party TURN service relays the WebRTC
handshake for players whose network (carrier NAT, school or office Wi-Fi) cannot
open a direct path. Neither carries gameplay data, and nothing is stored on any
server.

## Tech
- Vite 6 + vanilla TypeScript
- Canvas 2D rendering with interpolation, particles and screen shake
- Shared engine (`@ben-gy/game-engine`): epoch-based host election, round and
  rematch protocol, unified keyboard/touch input, seedable deterministic RNG,
  Trystero P2P netcode over WebRTC
- Vitest for game logic, P2P-sync determinism, host-transfer takeover and
  room-code tests
- GitHub Pages hosting

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Local dev
```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## License
MIT
