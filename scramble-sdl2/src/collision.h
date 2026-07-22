// All collision checks, ported from the *_COLLISION_DETECTION routines
// clustered around asm $2036-$2433: player-vs-{landscape, ground object,
// inflight rocket, UFO, fireball}, bullet/bomb-vs-{landscape, ground
// object, inflight enemy}. Real hitbox half-extents (derived from the
// asm's add/cp windows) and real scoring values are used throughout.
#ifndef SCRAMBLE_COLLISION_H
#define SCRAMBLE_COLLISION_H

#include "scramble.h"

void collision_update(GameState *g);

#endif // SCRAMBLE_COLLISION_H
