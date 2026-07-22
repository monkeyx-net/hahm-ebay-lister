// Overall game flow. The original drives everything from SCRIPT_NUMBER /
// SCRIPT_STAGE ($4005/$400A, see the big header comment in the source
// .asm around line ~150): a script-driven state machine where each stage
// is a subroutine that, when done, bumps the stage counter. We keep that
// same idea in a much smaller, purpose-built form: GameStateKind plays
// the role of SCRIPT_NUMBER, and g->stateTimer plays the role of a
// per-stage counter.
#include "scramble.h"
#include "landscape.h"
#include "player.h"
#include "bullets.h"
#include "enemies.h"
#include "collision.h"
#include "audio.h"
#include <string.h>

// Original scrolls the landscape 1 world-unit per 60Hz NMI tick (~60px/s).
// We run slightly brisker for a more modern feel.
#define SCROLL_SPEED 1.8f

#define LEVEL_INTRO_FRAMES 90
#define MISSION_COMPLETE_FRAMES 210
#define GAME_OVER_FRAMES 240

static void start_level(GameState *g) {
    landscape_load_level(g->currentLevel);
    enemies_reset(g);
    memset(g->bullets, 0, sizeof(g->bullets));
    memset(g->bombs, 0, sizeof(g->bombs));
    g->worldScroll = 0.0f;
    g->state = GS_LEVEL_INTRO;
    g->stateTimer = 0;
}

// SELECT_NEXT_LANDSCAPE ($27C9): advance to the next level, capping at the
// BASE level (index 5), which then repeats until destroyed.
static void advance_level(GameState *g) {
    if (g->currentLevel < 5) g->currentLevel++;
    start_level(g);
}

void game_init(GameState *g) {
    memset(g, 0, sizeof(*g));
    player_init(&g->player);
    g->highScore = 20000;
    g->currentLevel = 0;
    landscape_load_level(0);
    g->state = GS_TITLE;
}

void game_reset_for_new_game(GameState *g) {
    long hs = g->highScore;
    player_init(&g->player);
    memset(g->bullets, 0, sizeof(g->bullets));
    memset(g->bombs, 0, sizeof(g->bombs));
    enemies_reset(g);
    g->currentLevel = 0;
    g->framesAlive = 0;
    g->highScore = hs;
    start_level(g);
}

static void respawn_player(GameState *g) {
    long score = g->player.score;
    bool hadExtra = g->player.hadExtraLife;
    int lives = g->player.lives; // already decremented by the caller
    player_init(&g->player);
    g->player.score = score;
    g->player.hadExtraLife = hadExtra;
    g->player.lives = lives;
    memset(g->bullets, 0, sizeof(g->bullets));
    memset(g->bombs, 0, sizeof(g->bombs));
}

void game_update(GameState *g) {
    g->stateTimer++;

    switch (g->state) {
    case GS_TITLE:
        if (g->fire && !g->firePrev) {
            game_reset_for_new_game(g);
        }
        break;

    case GS_LEVEL_INTRO:
        if (g->stateTimer >= LEVEL_INTRO_FRAMES) {
            g->state = GS_PLAYING;
            g->stateTimer = 0;
        }
        break;

    case GS_PLAYING: {
        g->framesAlive++;
        player_update(g);
        bullets_update(g);
        enemies_spawn_ground_objects(g);
        enemies_spawn_inflight(g);
        enemies_update(g);
        collision_update(g);

        if (g->state == GS_PLAYING && g->player.active) {
            g->worldScroll += SCROLL_SPEED;
            int edgeCol = landscape_column_index_at_world(g->worldScroll + (SCREEN_W - ANCHOR_X) / PX_PER_UNIT);
            if (edgeCol >= landscape_column_count()) {
                // Reached the end of this level's data -- advance (or loop
                // the BASE level, matching SELECT_NEXT_LANDSCAPE).
                if (g->currentLevel >= 5) {
                    start_level(g); // BASE loops until destroyed
                } else {
                    advance_level(g);
                }
            }
        }
        break;
    }

    case GS_PLAYER_DYING:
        if (--g->player.explodeTimer <= 0) {
            g->player.lives--;
            if (g->player.lives > 0) {
                respawn_player(g);
                g->state = GS_PLAYING;
            } else {
                g->state = GS_GAME_OVER;
                g->stateTimer = 0;
            }
        }
        break;

    case GS_MISSION_COMPLETE:
        if (g->stateTimer >= MISSION_COMPLETE_FRAMES) {
            g->currentLevel = 0; // loop back to level 1 for another round
            start_level(g);
        }
        break;

    case GS_GAME_OVER:
        if (g->stateTimer >= GAME_OVER_FRAMES || (g->fire && !g->firePrev)) {
            g->state = GS_TITLE;
            g->stateTimer = 0;
        }
        break;
    }

    g->firePrev = g->fire;
    g->bombPrev = g->bomb;
}
