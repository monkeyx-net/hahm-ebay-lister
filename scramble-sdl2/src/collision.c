#include "collision.h"
#include "landscape.h"
#include "player.h"
#include "audio.h"
#include <stdlib.h>
#include <math.h>

static bool overlap(float ax, float ay, float bx, float by, float halfW, float halfH) {
    return fabsf(ax - bx) <= halfW && fabsf(ay - by) <= halfH;
}

static void kill_player(GameState *g) {
    Player *p = &g->player;
    if (!p->active) return;
    p->active = false;
    p->exploding = true;
    p->explodeTimer = 45;
    g->state = GS_PLAYER_DYING;
    g->stateTimer = 0;
    audio_play(SFX_PLAYER_DEATH);
}

static void explode_ground_object(GroundObject *go) {
    go->active = false;
    go->exploding = true;
    go->explodeTimer = 20;
}

static void explode_enemy(InflightEnemy *e) {
    e->active = false;
    e->exploding = true;
    e->explodeTimer = 20;
}

// AWARD_POINTS_FOR_DESTROYING_GROUND_OBJECT ($226D).
static void award_ground_object_points(GameState *g, GroundObject *go) {
    switch (go->type) {
    case GOBJ_ROCKET:
        g->player.score += SCORE_GROUND_ROCKET;
        audio_play(SFX_EXPLOSION_SMALL);
        break;
    case GOBJ_FUEL:
        g->player.score += SCORE_FUEL_TANK;
        g->player.fuel += FUEL_REFUEL_AMOUNT;
        if (g->player.fuel > FUEL_MAX) g->player.fuel = FUEL_MAX;
        audio_play(SFX_EXPLOSION_SMALL);
        break;
    case GOBJ_MYSTERY: {
        // MYSTERY_SHOT_AWARD_RANDOM_PTS ($2296): 2/4 chance of 100, 1/4 200, 1/4 300.
        int r = rand() % 4;
        if (r <= 1) { go->mysteryPoints = 0; g->player.score += SCORE_MYSTERY_100; }
        else if (r == 2) { go->mysteryPoints = 1; g->player.score += SCORE_MYSTERY_200; }
        else { go->mysteryPoints = 2; g->player.score += SCORE_MYSTERY_300; }
        audio_play(SFX_MYSTERY);
        break;
    }
    case GOBJ_BASE:
        g->player.score += SCORE_BASE;
        g->state = GS_MISSION_COMPLETE;
        g->stateTimer = 0;
        audio_play(SFX_EXPLOSION_BIG);
        break;
    default:
        break;
    }
}

static void check_player_vs_landscape(GameState *g) {
    if (!g->player.active) return;
    float forward = g->worldScroll + (g->player.wiggle - PLAYER_WIGGLE_MID);
    // Jet body is ~3 characters wide (asm $2116); check nose-to-tail span.
    for (float dx = -12.0f; dx <= 12.0f; dx += 8.0f) {
        const TerrainColumn *col = landscape_column_at_world(forward + dx);
        if (!col) continue;
        if (g->player.worldY + 3 > col->floorY) { kill_player(g); return; }
        if (col->hasCeiling && g->player.worldY - 3 < col->ceilY) { kill_player(g); return; }
    }
}

// CHECK_IF_PLAYER_COLLIDED_WITH_OBJECT ($207A) -- one shared routine the
// original uses for player-vs-{UFO, fireball, ground object, rocket}.
#define PLAYER_HIT_HALF_W 6.5f
#define PLAYER_HIT_HALF_H 8.0f

static void check_player_vs_ground_objects(GameState *g) {
    if (!g->player.active) return;
    float forward = g->worldScroll + (g->player.wiggle - PLAYER_WIGGLE_MID);
    for (int i = 0; i < MAX_GROUND_OBJECTS; i++) {
        GroundObject *go = &g->groundObjects[i];
        if (!go->active) continue;
        if (overlap(forward, (float)g->player.worldY, go->worldX, go->worldY, PLAYER_HIT_HALF_W, PLAYER_HIT_HALF_H)) {
            explode_ground_object(go); // no points for crashing into it
            kill_player(g);
            return;
        }
    }
}

static void check_player_vs_inflight(GameState *g) {
    if (!g->player.active) return;
    int flags = landscape_flags();
    float forward = g->worldScroll + (g->player.wiggle - PLAYER_WIGGLE_MID);
    for (int i = 0; i < MAX_INFLIGHT_ENEMIES; i++) {
        InflightEnemy *e = &g->enemies[i];
        if (!e->active) continue;
        bool applicable =
            (e->kind == ENEMY_ROCKET && (flags == LFLAG_LEVEL1_ROCKETS || flags == LFLAG_LEVEL4_ROCKETS)) ||
            (e->kind == ENEMY_UFO && flags == LFLAG_LEVEL2_UFOS) ||
            (e->kind == ENEMY_FIREBALL && flags == LFLAG_LEVEL3_FIREBALLS);
        if (!applicable) continue;
        if (overlap(forward, (float)g->player.worldY, e->worldX, e->worldY, PLAYER_HIT_HALF_W, PLAYER_HIT_HALF_H)) {
            explode_enemy(e);
            kill_player(g);
            return;
        }
    }
}

#define BULLET_VS_GOBJ_HALF_W 7.5f
#define BULLET_VS_GOBJ_HALF_H 4.5f
#define BULLET_VS_ROCKET_HALF_W 5.5f
#define BULLET_VS_ROCKET_HALF_H 3.5f
#define BULLET_VS_UFO_HALF_W 3.5f
#define BULLET_VS_UFO_HALF_H 4.5f
#define BOMB_VS_UFO_HALF_W 5.5f
#define BOMB_VS_UFO_HALF_H 6.5f

static void check_bullets_vs_targets(GameState *g) {
    for (int bi = 0; bi < MAX_PLAYER_BULLETS; bi++) {
        PlayerBullet *b = &g->bullets[bi];
        if (!b->active) continue;

        for (int i = 0; i < MAX_GROUND_OBJECTS; i++) {
            GroundObject *go = &g->groundObjects[i];
            if (!go->active) continue;
            if (overlap(b->worldX, b->worldY, go->worldX, go->worldY, BULLET_VS_GOBJ_HALF_W, BULLET_VS_GOBJ_HALF_H)) {
                b->active = false;
                explode_ground_object(go);
                award_ground_object_points(g, go);
                goto next_bullet;
            }
        }

        for (int i = 0; i < MAX_INFLIGHT_ENEMIES; i++) {
            InflightEnemy *e = &g->enemies[i];
            if (!e->active || e->kind == ENEMY_FIREBALL) continue; // fireballs are undestroyable
            float hw = (e->kind == ENEMY_UFO) ? BULLET_VS_UFO_HALF_W : BULLET_VS_ROCKET_HALF_W;
            float hh = (e->kind == ENEMY_UFO) ? BULLET_VS_UFO_HALF_H : BULLET_VS_ROCKET_HALF_H;
            if (overlap(b->worldX, b->worldY, e->worldX, e->worldY, hw, hh)) {
                b->active = false;
                explode_enemy(e);
                if (e->kind == ENEMY_UFO) {
                    g->player.score += SCORE_UFO;
                    audio_play(SFX_EXPLOSION_SMALL);
                } else {
                    g->player.score += SCORE_INFLIGHT_ROCKET;
                    audio_play(SFX_EXPLOSION_SMALL);
                }
                goto next_bullet;
            }
        }

        // PLAYER_BULLET_TO_LANDSCAPE_COLLISION_DETECTION ($238F)
        {
            const TerrainColumn *col = landscape_column_at_world(b->worldX);
            if (col) {
                if (b->worldY > col->floorY || (col->hasCeiling && b->worldY < col->ceilY)) {
                    b->active = false;
                }
            }
        }
    next_bullet:;
    }
}

static void check_bombs_vs_targets(GameState *g) {
    for (int bi = 0; bi < MAX_PLAYER_BOMBS; bi++) {
        PlayerBomb *bm = &g->bombs[bi];
        if (!bm->active) continue;

        for (int i = 0; i < MAX_GROUND_OBJECTS; i++) {
            GroundObject *go = &g->groundObjects[i];
            if (!go->active) continue;
            if (overlap(bm->worldX, bm->worldY, go->worldX, go->worldY, BULLET_VS_GOBJ_HALF_W, BULLET_VS_GOBJ_HALF_H)) {
                bm->active = false;
                bm->exploding = true;
                bm->explodeTimer = 15;
                explode_ground_object(go);
                award_ground_object_points(g, go);
                audio_play(SFX_EXPLOSION_SMALL);
                goto next_bomb;
            }
        }

        // PLAYER_BOMB_TO_UFO_COLLISION_DETECTION ($23C9) -- bombs can also down UFOs.
        for (int i = 0; i < MAX_INFLIGHT_ENEMIES; i++) {
            InflightEnemy *e = &g->enemies[i];
            if (!e->active || e->kind != ENEMY_UFO) continue;
            if (overlap(bm->worldX, bm->worldY, e->worldX, e->worldY, BOMB_VS_UFO_HALF_W, BOMB_VS_UFO_HALF_H)) {
                bm->active = false;
                bm->exploding = true;
                bm->explodeTimer = 15;
                explode_enemy(e);
                g->player.score += SCORE_UFO;
                audio_play(SFX_EXPLOSION_SMALL);
                goto next_bomb;
            }
        }

        {
            const TerrainColumn *col = landscape_column_at_world(bm->worldX);
            if (col && bm->worldY >= col->floorY) {
                bm->active = false;
                bm->exploding = true;
                bm->explodeTimer = 15;
                audio_play(SFX_EXPLOSION_SMALL);
            }
        }
    next_bomb:;
    }
}

void collision_update(GameState *g) {
    if (g->state != GS_PLAYING) return;

    check_bullets_vs_targets(g);
    check_bombs_vs_targets(g);
    check_player_vs_ground_objects(g);
    check_player_vs_inflight(g);
    check_player_vs_landscape(g);

    // CHECK_IF_EXTRA_LIFE_SHOULD_BE_AWARDED ($13A7)
    if (!g->player.hadExtraLife && g->player.score >= EXTRA_LIFE_SCORE) {
        g->player.hadExtraLife = true;
        g->player.lives++;
        audio_play(SFX_EXTRA_LIFE);
    }
    if (g->player.score > g->highScore) g->highScore = g->player.score;
}
