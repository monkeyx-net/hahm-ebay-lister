# Scramble (SDL2 / C port)

A gameplay port of *Scramble* (KONAMI, 1981), built from
[Scott Tunstall's Z80 disassembly](https://seanriddle.com/scramble.asm) of
the original arcade ROM.

## What kind of port this is

This is a **faithful logic port**, not a cycle-accurate emulator, and not a
line-by-line opcode transliteration. Specifically:

- **Real level data**: the floor/ceiling terrain heights and ground-object
  (rocket/fuel/mystery/base) placements for all 5 levels + the BASE level
  are extracted byte-for-byte from the real `LEVEL_n_LANDSCAPE_LAYOUT`
  tables in the disassembly (`$29E2`, `$2DD3`, `$31C4`, `$3465`, `$3856`,
  `$3C47`) — see `src/data/landscape_data.h`.
- **Real mechanics and numbers**: movement clamps, fuel-drain rates per
  level, collision hitbox sizes, scoring values, spawn cadences, and the
  extra-life threshold are all taken directly from the disassembly, with
  comments pointing at the original `$XXXX` addresses they came from.
- **No original graphics**: the disassembled file is the *program* ROM
  only — character/sprite tile bitmaps lived on separate graphics ROM
  chips that aren't part of that file, so there's no pixel art to port.
  Rendering here is simple SDL2 vector shapes instead.
- **No original sound**: likewise, the AY-3-8910 sound board's ROM/driver
  isn't in the disassembled file (it only covers the main CPU board).
  Audio here is a small synthesized square-wave SFX engine triggered at
  the same gameplay events the original queues sound commands for.
- **Simplified enemy flight paths**: the original drives rockets/UFOs/
  fireballs from per-enemy path tables (`FOLLOW_PATH`, `$1578`) that
  aren't reproduced byte-for-byte. Spawn cadence, which levels get which
  enemy type, and — importantly — which enemies are shootable (fireballs
  are **not**, exactly like the original) are preserved; the exact curve
  each enemy flies is our own simple approximation.

See the header comments in `src/scramble.h`, `src/landscape.h`,
`src/player.h`, `src/enemies.h`, and `src/collision.h` for the specific
`$XXXX` addresses each piece of logic was ported from.

## Building

Requires SDL2 (`libsdl2-dev` on Debian/Ubuntu) and CMake.

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/scramble
```

## Controls

| Action           | Keys                    |
|------------------|--------------------------|
| Move             | Arrow keys / WASD        |
| Fire missile     | Z / Space                |
| Drop bomb        | X / Left Ctrl            |
| Quit             | Esc                      |

Fire to start from the title screen.

## Gameplay notes

- 5 levels + a final BASE level, looping back to level 1 after the base is
  destroyed.
- Level 1 & 4: ground-launched rockets. Level 2: UFOs. Level 3: fireballs
  (can't be shot down — dodge only). Level 5 & the base: no flying
  enemies.
- Shoot fuel tanks to refuel and score; shoot the base to complete the
  mission. Running out of fuel forces a slow, uncontrolled dive.
- First to 10,000 points gets one extra life (matches the original's
  single-award bonus jet).
