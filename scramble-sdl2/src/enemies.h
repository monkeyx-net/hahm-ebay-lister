// Ground object spawning (from real landscape data) and inflight enemy
// spawning/movement. Spawn gating mirrors SPAWN_ENEMIES ($2563):
// TRY_SPAWN_UFO / TRY_SPAWN_INFLIGHT_ROCKET fire every 64 ticks
// (TIMING_VARIABLE & $3F == 0, $25D2/$2615), SPAWN_FIREBALLS every 16
// ($267A). Per-level enemy kind comes from LANDSCAPE_FLAGS (asm $411D):
// 0/8 = rockets, 2 = UFOs, 1 = fireballs, 4/16 = none.
//
// Exact original flight paths (FOLLOW_PATH, $1578, driven by per-enemy
// path tables) aren't reproduced byte-for-byte here -- that's well past
// "faithful logic port" territory -- but spawn cadences, positions-ish,
// and (importantly) which enemies are shootable vs. not are preserved:
// fireballs, exactly as in the original, cannot be destroyed by the
// player (see PLAYER_TO_FIREBALL_COLLISION_DETECTION, $20C2 -- no bullet
// or bomb collision routine touches them at all).
#ifndef SCRAMBLE_ENEMIES_H
#define SCRAMBLE_ENEMIES_H

#include "scramble.h"

void enemies_reset(GameState *g);
void enemies_spawn_ground_objects(GameState *g);
void enemies_spawn_inflight(GameState *g);
void enemies_update(GameState *g);

#endif // SCRAMBLE_ENEMIES_H
