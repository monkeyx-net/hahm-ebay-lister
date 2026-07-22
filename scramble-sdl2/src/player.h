// Player ship: movement clamps, fuel drain, lives, bullet/bomb spawning.
// Ported from PLAYER_MOVE_VERTICAL/HORIZONTAL ($1749-$17CE), the fuel-drain
// logic around $1725/$29B5, SPAWN_PLAYER_BULLET ($257F) and
// SPAWN_PLAYER_BOMB ($26B1).
#ifndef SCRAMBLE_PLAYER_H
#define SCRAMBLE_PLAYER_H

#include "scramble.h"

// Centre of the [128,207] wiggle band -- used to turn PLAYER.Y into a
// signed forward/back offset in our level-absolute coordinate space.
#define PLAYER_WIGGLE_MID ((PLAYER_WIGGLE_MIN + PLAYER_WIGGLE_MAX) / 2.0f)

void player_init(Player *p);
float player_forward_pos(const GameState *g); // absolute level-space forward position
void player_update(GameState *g);

#endif // SCRAMBLE_PLAYER_H
