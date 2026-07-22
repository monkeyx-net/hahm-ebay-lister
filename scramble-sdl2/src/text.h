// Tiny built-in 5x7 bitmap font, rendered as filled rectangles. There's no
// original character-ROM tile data in the disassembly to draw from, so
// this is our own simple stand-in for score/HUD/message text.
#ifndef SCRAMBLE_TEXT_H
#define SCRAMBLE_TEXT_H

#include <SDL2/SDL.h>

void text_draw(SDL_Renderer *r, int x, int y, int scale, SDL_Color color, const char *str);
int text_width(const char *str, int scale);

#endif // SCRAMBLE_TEXT_H
