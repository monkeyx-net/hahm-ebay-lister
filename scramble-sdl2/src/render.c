#include "render.h"
#include "landscape.h"
#include "player.h"
#include "text.h"
#include <math.h>
#include <stdio.h>

static inline float screen_x(const GameState *g, float worldX) {
    return ANCHOR_X + (worldX - g->worldScroll) * PX_PER_UNIT;
}
static inline float screen_y(float worldY) {
    return worldY * PX_PER_UNIT;
}

static void fill_rect(SDL_Renderer *r, float cx, float cy, float w, float h, SDL_Color c) {
    SDL_SetRenderDrawColor(r, c.r, c.g, c.b, c.a);
    SDL_Rect rect = { (int)(cx - w / 2), (int)(cy - h / 2), (int)w, (int)h };
    SDL_RenderFillRect(r, &rect);
}

static void fill_tri(SDL_Renderer *r, SDL_Color c, SDL_FPoint a, SDL_FPoint b, SDL_FPoint cpt) {
    SDL_Vertex verts[3] = {
        { a, c, {1,1} }, { b, c, {1,1} }, { cpt, c, {1,1} },
    };
    SDL_RenderGeometry(r, NULL, verts, 3, NULL, 0);
}

static void draw_stars(SDL_Renderer *r, const GameState *g) {
    SDL_SetRenderDrawColor(r, 90, 90, 110, 255);
    for (int i = 0; i < 60; i++) {
        // Deterministic pseudo-random starfield that parallax-scrolls slowly.
        float baseX = (float)((i * 137) % 4000);
        float x = fmodf(baseX - g->worldScroll * 0.2f, 1400.0f);
        if (x < 0) x += 1400.0f;
        float y = (float)((i * 71) % SCREEN_H);
        SDL_RenderDrawPoint(r, (int)x, (int)y);
    }
}

static void draw_terrain(SDL_Renderer *r, const GameState *g) {
    int startIdx = landscape_column_index_at_world(g->worldScroll - 8.0f);
    if (startIdx < 0) startIdx = 0;
    int endIdx = landscape_column_index_at_world(g->worldScroll + (SCREEN_W - ANCHOR_X) / PX_PER_UNIT + 8.0f);
    int count = landscape_column_count();
    if (endIdx > count - 1) endIdx = count - 1;

    SDL_Color floorColor = { 120, 90, 60, 255 };
    SDL_Color ceilColor = { 90, 70, 100, 255 };

    for (int i = startIdx; i < endIdx; i++) {
        const TerrainColumn *a = landscape_column_at_index(i);
        const TerrainColumn *b = landscape_column_at_index(i + 1);
        if (!a || !b) continue;
        float x0 = screen_x(g, (float)(i * TERRAIN_COLUMN_WORLD_WIDTH));
        float x1 = screen_x(g, (float)((i + 1) * TERRAIN_COLUMN_WORLD_WIDTH));
        float fy0 = screen_y((float)a->floorY);
        float fy1 = screen_y((float)b->floorY);

        SDL_Vertex floorQuad[4] = {
            { {x0, fy0}, floorColor, {1,1} },
            { {x1, fy1}, floorColor, {1,1} },
            { {x1, (float)SCREEN_H}, floorColor, {1,1} },
            { {x0, (float)SCREEN_H}, floorColor, {1,1} },
        };
        int idx[6] = {0,1,2, 0,2,3};
        SDL_RenderGeometry(r, NULL, floorQuad, 4, idx, 6);

        if (a->hasCeiling && b->hasCeiling) {
            float cy0 = screen_y((float)a->ceilY);
            float cy1 = screen_y((float)b->ceilY);
            SDL_Vertex ceilQuad[4] = {
                { {x0, 0}, ceilColor, {1,1} },
                { {x1, 0}, ceilColor, {1,1} },
                { {x1, cy1}, ceilColor, {1,1} },
                { {x0, cy0}, ceilColor, {1,1} },
            };
            SDL_RenderGeometry(r, NULL, ceilQuad, 4, idx, 6);
        }
    }
}

static void draw_ground_objects(SDL_Renderer *r, const GameState *g) {
    for (int i = 0; i < MAX_GROUND_OBJECTS; i++) {
        const GroundObject *go = &g->groundObjects[i];
        if (!go->active && !go->exploding) continue;
        float sx = screen_x(g, go->worldX);
        float sy = screen_y(go->worldY);
        if (sx < -20 || sx > SCREEN_W + 20) continue;

        if (go->exploding) {
            SDL_Color c = { 255, 180, 60, 255 };
            fill_rect(r, sx, sy, 14, 14, c);
            continue;
        }

        switch (go->type) {
        case GOBJ_ROCKET: {
            SDL_Color c = { 220, 60, 60, 255 };
            fill_tri(r, c, (SDL_FPoint){sx, sy - 10}, (SDL_FPoint){sx - 6, sy + 6}, (SDL_FPoint){sx + 6, sy + 6});
            break;
        }
        case GOBJ_FUEL: {
            SDL_Color c = { 60, 200, 90, 255 };
            fill_rect(r, sx, sy, 12, 14, c);
            break;
        }
        case GOBJ_MYSTERY: {
            SDL_Color c = { 200, 80, 220, 255 };
            fill_tri(r, c, (SDL_FPoint){sx, sy - 8}, (SDL_FPoint){sx - 8, sy + 8}, (SDL_FPoint){sx + 8, sy + 8});
            break;
        }
        case GOBJ_BASE: {
            SDL_Color c = { 230, 210, 60, 255 };
            fill_rect(r, sx, sy, 26, 20, c);
            break;
        }
        default: break;
        }
    }
}

static void draw_inflight_enemies(SDL_Renderer *r, const GameState *g) {
    for (int i = 0; i < MAX_INFLIGHT_ENEMIES; i++) {
        const InflightEnemy *e = &g->enemies[i];
        if (!e->active && !e->exploding) continue;
        float sx = screen_x(g, e->worldX);
        float sy = screen_y(e->worldY);
        if (sx < -20 || sx > SCREEN_W + 20) continue;

        if (e->exploding) {
            fill_rect(r, sx, sy, 16, 16, (SDL_Color){255, 200, 80, 255});
            continue;
        }

        switch (e->kind) {
        case ENEMY_ROCKET:
            fill_tri(r, (SDL_Color){255, 90, 40, 255}, (SDL_FPoint){sx, sy - 9}, (SDL_FPoint){sx - 5, sy + 7}, (SDL_FPoint){sx + 5, sy + 7});
            break;
        case ENEMY_UFO:
            fill_rect(r, sx, sy, 20, 8, (SDL_Color){80, 220, 220, 255});
            fill_rect(r, sx, sy - 5, 10, 6, (SDL_Color){160, 240, 240, 255});
            break;
        case ENEMY_FIREBALL:
            fill_rect(r, sx, sy, 14, 14, (SDL_Color){255, 120, 30, 255});
            break;
        default: break;
        }
    }
}

static void draw_bullets_and_bombs(SDL_Renderer *r, const GameState *g) {
    for (int i = 0; i < MAX_PLAYER_BULLETS; i++) {
        const PlayerBullet *b = &g->bullets[i];
        if (!b->active) continue;
        fill_rect(r, screen_x(g, b->worldX), screen_y(b->worldY), 8, 3, (SDL_Color){255, 240, 120, 255});
    }
    for (int i = 0; i < MAX_PLAYER_BOMBS; i++) {
        const PlayerBomb *bm = &g->bombs[i];
        if (bm->exploding) {
            fill_rect(r, screen_x(g, bm->worldX), screen_y(bm->worldY), 16, 16, (SDL_Color){255, 170, 60, 255});
        } else if (bm->active) {
            fill_rect(r, screen_x(g, bm->worldX), screen_y(bm->worldY), 6, 6, (SDL_Color){255, 255, 200, 255});
        }
    }
}

static void draw_player(SDL_Renderer *r, const GameState *g) {
    const Player *p = &g->player;
    float sx = ANCHOR_X + (p->wiggle - PLAYER_WIGGLE_MID) * (PX_PER_UNIT * 0.4f);
    float sy = screen_y((float)p->worldY);

    if (p->exploding) {
        SDL_Color c = { 255, 160, 40, 255 };
        fill_rect(r, sx, sy, 20 + (p->explodeTimer % 10), 20 + (p->explodeTimer % 10), c);
        return;
    }
    if (!p->active) return;

    SDL_Color c = { 230, 230, 255, 255 };
    fill_tri(r, c, (SDL_FPoint){sx + 12, sy}, (SDL_FPoint){sx - 10, sy - 8}, (SDL_FPoint){sx - 10, sy + 8});
    fill_rect(r, sx - 6, sy, 10, 3, (SDL_Color){120, 200, 255, 255});
}

static void draw_hud(SDL_Renderer *r, const GameState *g) {
    char buf[64];
    SDL_Color white = {255,255,255,255};
    SDL_Color yellow = {255,220,60,255};

    snprintf(buf, sizeof buf, "1UP  %06ld", g->player.score);
    text_draw(r, 20, 12, 2, white, buf);

    snprintf(buf, sizeof buf, "HIGH %06ld", g->highScore);
    text_draw(r, SCREEN_W - text_width(buf, 2) - 20, 12, 2, white, buf);

    snprintf(buf, sizeof buf, "LEVEL %d", g->currentLevel + 1);
    text_draw(r, 20, 36, 2, yellow, g->currentLevel == 5 ? "BASE" : buf);

    // Lives, drawn as small triangles.
    for (int i = 0; i < g->player.lives - 1 && i < 6; i++) {
        float x = 20.0f + i * 22.0f;
        float y = 64.0f;
        fill_tri(r, (SDL_Color){230,230,255,255}, (SDL_FPoint){x+8,y}, (SDL_FPoint){x-6,y-6}, (SDL_FPoint){x-6,y+6});
    }

    // Fuel gauge.
    int fx = SCREEN_W - 180, fy = 40, fw = 150, fh = 14;
    SDL_SetRenderDrawColor(r, 60, 60, 60, 255);
    SDL_Rect frame = { fx - 2, fy - 2, fw + 4, fh + 4 };
    SDL_RenderDrawRect(r, &frame);
    SDL_SetRenderDrawColor(r, 60, 200, 90, 255);
    SDL_Rect fuelBar = { fx, fy, (int)(fw * (g->player.fuel / (float)FUEL_MAX)), fh };
    SDL_RenderFillRect(r, &fuelBar);
    text_draw(r, fx, fy - 20, 1, white, "FUEL");
}

static void draw_centered(SDL_Renderer *r, int y, int scale, SDL_Color c, const char *s) {
    int w = text_width(s, scale);
    text_draw(r, (SCREEN_W - w) / 2, y, scale, c, s);
}

static void draw_overlay(SDL_Renderer *r, const GameState *g) {
    SDL_Color white = {255,255,255,255};
    SDL_Color yellow = {255,220,60,255};
    switch (g->state) {
    case GS_TITLE:
        draw_centered(r, 260, 5, yellow, "SCRAMBLE");
        draw_centered(r, 340, 2, white, "KONAMI 1981 - SDL2 C PORT");
        if ((g->stateTimer / 30) % 2 == 0)
            draw_centered(r, 420, 2, white, "PRESS FIRE TO START");
        draw_centered(r, 480, 1, white, "ARROWS/WASD MOVE  Z FIRE  X BOMB");
        break;
    case GS_LEVEL_INTRO: {
        char buf[32];
        snprintf(buf, sizeof buf, g->currentLevel == 5 ? "BASE" : "LEVEL %d", g->currentLevel + 1);
        draw_centered(r, 340, 4, yellow, buf);
        break;
    }
    case GS_MISSION_COMPLETE:
        draw_centered(r, 300, 3, yellow, "CONGRATULATIONS");
        draw_centered(r, 360, 2, white, "YOU COMPLETED YOUR DUTIES");
        break;
    case GS_GAME_OVER:
        draw_centered(r, 340, 4, yellow, "GAME OVER");
        break;
    default:
        break;
    }
}

void render_frame(SDL_Renderer *r, const GameState *g) {
    SDL_SetRenderDrawColor(r, 8, 8, 20, 255);
    SDL_RenderClear(r);

    draw_stars(r, g);
    draw_terrain(r, g);
    draw_ground_objects(r, g);
    draw_inflight_enemies(r, g);
    draw_bullets_and_bombs(r, g);
    draw_player(r, g);
    draw_hud(r, g);
    draw_overlay(r, g);

    SDL_RenderPresent(r);
}
