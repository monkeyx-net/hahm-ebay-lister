#include "player.h"
#include "audio.h"
#include <string.h>

// PLAYER_MOVE_* update position by 1 unit per NMI (60Hz) tick in the
// original ($1769/$1779/$17B1/$17C1: dec/inc a by exactly 1). We run the
// world scroll a bit brisker than the original (SCROLL_SPEED in game.c),
// so the player's own dodge speed is bumped proportionally to keep the
// original's real, quite jagged, mountain terrain dodgeable.
#define PLAYER_MOVE_SPEED 2.0f

// FUEL_DESTROYED_ADD_FUEL_AND_AWARD_50_PTS jumps the drain rate reload value
// (SET_CURRENT_PLAYER_FUEL_DRAIN_COUNTER, $29B5): level 1 -> 10 ticks/unit
// (slowest), level 2 -> 8, level 3+ -> 6 (fastest).
static int fuel_drain_reload(int level) {
    if (level <= 0) return 10;
    if (level == 1) return 8;
    return 6;
}

void player_init(Player *p) {
    memset(p, 0, sizeof(*p));
    p->active = true;
    p->worldY = (PLAYER_WORLDY_MIN + PLAYER_WORLDY_MAX) / 2;
    p->wiggle = (int)PLAYER_WIGGLE_MID;
    p->lives = DEFAULT_LIVES;
    p->fuel = FUEL_MAX;
    p->fuelDrainCounter = fuel_drain_reload(0);
}

float player_forward_pos(const GameState *g) {
    return g->worldScroll + (g->player.wiggle - PLAYER_WIGGLE_MID);
}

static PlayerBullet *find_free_bullet(GameState *g) {
    for (int i = 0; i < MAX_PLAYER_BULLETS; i++)
        if (!g->bullets[i].active) return &g->bullets[i];
    return NULL;
}

static PlayerBomb *find_free_bomb(GameState *g) {
    for (int i = 0; i < MAX_PLAYER_BOMBS; i++)
        if (!g->bombs[i].active && !g->bombs[i].exploding) return &g->bombs[i];
    return NULL;
}

void player_update(GameState *g) {
    Player *p = &g->player;
    if (!p->active) return;

    // --- vertical movement (PLAYER_MOVE_VERTICAL, $1749) ---
    if (g->up) p->worldY -= (int)PLAYER_MOVE_SPEED;
    if (g->down) p->worldY += (int)PLAYER_MOVE_SPEED;
    if (p->worldY < PLAYER_WORLDY_MIN) p->worldY = PLAYER_WORLDY_MIN;
    if (p->worldY > PLAYER_WORLDY_MAX) p->worldY = PLAYER_WORLDY_MAX;

    // --- horizontal wiggle (PLAYER_MOVE_HORIZONTAL, $179E) ---
    if (g->left) p->wiggle -= (int)PLAYER_MOVE_SPEED;
    if (g->right) p->wiggle += (int)PLAYER_MOVE_SPEED;
    if (p->wiggle < PLAYER_WIGGLE_MIN) p->wiggle = PLAYER_WIGGLE_MIN;
    if (p->wiggle > PLAYER_WIGGLE_MAX) p->wiggle = PLAYER_WIGGLE_MAX;

    // --- fuel drain (SET_CURRENT_PLAYER_FUEL_DRAIN_COUNTER, $29B5) ---
    if (p->fuel > 0) {
        if (--p->fuelDrainCounter <= 0) {
            p->fuelDrainCounter = fuel_drain_reload(g->currentLevel);
            p->fuel--;
        }
    } else {
        // PLAYER_OUT_OF_FUEL ($17D4): ignore further UP input, force a slow
        // dive until the jet hits the ground and explodes.
        p->worldY += 1;
        if (p->worldY >= PLAYER_WORLDY_MAX) {
            p->active = false;
            p->exploding = true;
            p->explodeTimer = 40;
            audio_play(SFX_PLAYER_DEATH);
        }
    }

    // --- fire / bomb (SPAWN_PLAYER_BULLET $257F, SPAWN_PLAYER_BOMB $26B1) ---
    if (g->fire && !g->firePrev) {
        PlayerBullet *b = find_free_bullet(g);
        if (b) {
            b->active = true;
            b->worldX = player_forward_pos(g) + 3;
            b->worldY = (float)(p->worldY - 4);
            audio_play(SFX_FIRE);
        }
    }
    if (g->bomb && !g->bombPrev) {
        PlayerBomb *bm = find_free_bomb(g);
        if (bm) {
            bm->active = true;
            bm->exploding = false;
            bm->worldX = player_forward_pos(g);
            bm->worldY = (float)p->worldY;
            bm->vy = 0.6f;
            audio_play(SFX_BOMB_DROP);
        }
    }
}
