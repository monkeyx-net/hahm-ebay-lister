#include "enemies.h"
#include "landscape.h"
#include "player.h"
#include "audio.h"
#include <string.h>
#include <stdlib.h>

// View-ahead distance (world-units) at which new terrain/ground objects
// scroll onto the right edge of the screen.
#define VIEW_WIDTH ((SCREEN_W - ANCHOR_X) / PX_PER_UNIT)

#define ROCKET_LAUNCH_MIN 20.0f
#define ROCKET_LAUNCH_MAX 240.0f
#define ROCKET_CLIMB_SPEED 1.6f

#define UFO_SPAWN_AHEAD 150.0f
#define UFO_APPROACH_SPEED 1.1f
#define UFO_BOB_SPEED 0.9f

#define FIREBALL_SPAWN_AHEAD 150.0f
#define FIREBALL_APPROACH_SPEED 1.6f
#define FIREBALL_BOB_SPEED 1.3f

void enemies_reset(GameState *g) {
    memset(g->groundObjects, 0, sizeof(g->groundObjects));
    memset(g->enemies, 0, sizeof(g->enemies));
}

static GroundObject *find_free_ground_object(GameState *g) {
    for (int i = 0; i < MAX_GROUND_OBJECTS; i++)
        if (!g->groundObjects[i].active && !g->groundObjects[i].exploding) return &g->groundObjects[i];
    return NULL;
}

static InflightEnemy *find_free_enemy(GameState *g) {
    for (int i = 0; i < MAX_INFLIGHT_ENEMIES; i++)
        if (!g->enemies[i].active && !g->enemies[i].exploding) return &g->enemies[i];
    return NULL;
}

// Mirrors the scroll-in-new-landscape mechanism (READ_LANDSCAPE_LAYOUT,
// $15C5): as each column reaches the right edge of the screen, spawn
// whatever ground object it carries, exactly once.
void enemies_spawn_ground_objects(GameState *g) {
    int edgeIndex = landscape_column_index_at_world(g->worldScroll + VIEW_WIDTH);
    const TerrainColumn *col = landscape_column_at_index(edgeIndex);
    if (!col || col->groundObj == GOBJ_NONE) return;
    if (landscape_column_object_spawned(edgeIndex)) return;
    landscape_mark_column_object_spawned(edgeIndex);

    GroundObject *go = find_free_ground_object(g);
    if (!go) return;
    go->active = true;
    go->exploding = false;
    go->type = col->groundObj;
    go->worldX = (float)(edgeIndex * TERRAIN_COLUMN_WORLD_WIDTH + TERRAIN_COLUMN_WORLD_WIDTH / 2);
    go->worldY = (float)col->floorY - 5.0f;
}

// Mirrors SPAWN_ENEMIES ($2563): TRY_SPAWN_UFO / TRY_SPAWN_INFLIGHT_ROCKET
// gate on TIMING_VARIABLE & $3F == 0 (every 64 ticks), SPAWN_FIREBALLS on
// & $0F == 0 (every 16 ticks).
void enemies_spawn_inflight(GameState *g) {
    int flags = landscape_flags();

    if ((flags == LFLAG_LEVEL1_ROCKETS || flags == LFLAG_LEVEL4_ROCKETS) &&
        g->framesAlive % 64 == 0) {
        for (int i = 0; i < MAX_GROUND_OBJECTS; i++) {
            GroundObject *go = &g->groundObjects[i];
            if (!go->active || go->type != GOBJ_ROCKET) continue;
            float off = go->worldX - g->worldScroll;
            if (off < ROCKET_LAUNCH_MIN || off > ROCKET_LAUNCH_MAX) continue;
            InflightEnemy *e = find_free_enemy(g);
            if (!e) break;
            go->active = false; // rocket left the ground, no explosion
            e->active = true;
            e->kind = ENEMY_ROCKET;
            e->worldX = go->worldX;
            e->worldY = go->worldY;
            e->vx = 0.0f;
            e->phase = -ROCKET_CLIMB_SPEED;
            break;
        }
    }

    if (flags == LFLAG_LEVEL2_UFOS && g->framesAlive % 64 == 0) {
        InflightEnemy *e = find_free_enemy(g);
        if (e) {
            e->active = true;
            e->kind = ENEMY_UFO;
            e->worldX = g->worldScroll + UFO_SPAWN_AHEAD;
            e->worldY = (float)(40 + rand() % 150);
            e->vx = -UFO_APPROACH_SPEED;
            e->phase = (rand() % 2) ? UFO_BOB_SPEED : -UFO_BOB_SPEED;
        }
    }

    if (flags == LFLAG_LEVEL3_FIREBALLS && g->framesAlive % 16 == 0) {
        InflightEnemy *e = find_free_enemy(g);
        if (e) {
            e->active = true;
            e->kind = ENEMY_FIREBALL;
            e->worldX = g->worldScroll + FIREBALL_SPAWN_AHEAD;
            e->worldY = (float)(60 + rand() % 130);
            e->vx = -FIREBALL_APPROACH_SPEED;
            e->phase = (rand() % 2) ? FIREBALL_BOB_SPEED : -FIREBALL_BOB_SPEED;
        }
    }
}

void enemies_update(GameState *g) {
    for (int i = 0; i < MAX_GROUND_OBJECTS; i++) {
        GroundObject *go = &g->groundObjects[i];
        if (go->exploding) {
            if (--go->explodeTimer <= 0) go->exploding = false;
        }
    }

    for (int i = 0; i < MAX_INFLIGHT_ENEMIES; i++) {
        InflightEnemy *e = &g->enemies[i];
        if (e->exploding) {
            if (--e->explodeTimer <= 0) e->exploding = false;
            continue;
        }
        if (!e->active) continue;

        e->worldX += e->vx;

        switch (e->kind) {
        case ENEMY_ROCKET:
            e->worldY += e->phase; // constant climb
            if (e->worldY < 5.0f) e->active = false; // flew off the top, missed
            break;
        case ENEMY_UFO:
        case ENEMY_FIREBALL:
            e->worldY += e->phase;
            if (e->worldY < 10.0f || e->worldY > 245.0f) e->phase = -e->phase;
            break;
        default:
            break;
        }

        if (e->worldX - g->worldScroll < -60.0f) e->active = false; // passed behind the player
    }
}
