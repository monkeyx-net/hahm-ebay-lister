// Vector-style SDL2 rendering. No original tile/sprite ROM data exists in
// the disassembled file to draw from (it lived on separate graphics ROM
// chips on the real board), so terrain, ship, enemies and HUD are all
// drawn as simple primitive shapes here.
#ifndef SCRAMBLE_RENDER_H
#define SCRAMBLE_RENDER_H

#include <SDL2/SDL.h>
#include "scramble.h"

void render_frame(SDL_Renderer *r, const GameState *g);

#endif // SCRAMBLE_RENDER_H
