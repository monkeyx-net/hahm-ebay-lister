#include "bullets.h"

#define BULLET_SPEED 4.5f
#define BOMB_GRAVITY 0.12f
#define BULLET_CULL_AHEAD 130.0f

void bullets_update(GameState *g) {
    for (int i = 0; i < MAX_PLAYER_BULLETS; i++) {
        PlayerBullet *b = &g->bullets[i];
        if (!b->active) continue;
        b->worldX += BULLET_SPEED;
        if (b->worldX - g->worldScroll > BULLET_CULL_AHEAD) b->active = false;
    }

    for (int i = 0; i < MAX_PLAYER_BOMBS; i++) {
        PlayerBomb *bm = &g->bombs[i];
        if (bm->exploding) {
            if (--bm->explodeTimer <= 0) bm->exploding = false;
            continue;
        }
        if (!bm->active) continue;
        bm->vy += BOMB_GRAVITY;
        bm->worldY += bm->vy;
        if (bm->worldY >= WORLD_H - 1) {
            // Fell past the bottom of the world without hitting terrain --
            // shouldn't normally happen (collision.c catches ground hits
            // first) but guards against a stuck bomb.
            bm->active = false;
        }
    }
}
