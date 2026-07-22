// Landscape decode: expands the real LEVEL_n_LANDSCAPE_LAYOUT record tables
// (src/data/landscape_data.h, extracted byte-exact from the disassembly)
// into a flat array of 8-world-unit-wide terrain columns, mirroring
// DECODE_LANDSCAPE_FLOOR/CEILING (asm $15CB/$1659) and the record format
// documented at asm line ~4833 (6 bytes: floor pair + ground object id;
// 9 bytes: floor pair + ceiling pair + ground object id).
#ifndef SCRAMBLE_LANDSCAPE_H
#define SCRAMBLE_LANDSCAPE_H

#include "scramble.h"

typedef struct {
    uint8_t floorY;
    bool hasCeiling;
    uint8_t ceilY;
    uint8_t groundObj; // GOBJ_* — 0 if nothing spawns at this column
} TerrainColumn;

#define TERRAIN_COLUMN_WORLD_WIDTH 8

void landscape_load_level(int levelIndex);
int landscape_flags(void);
int landscape_column_count(void);
float landscape_world_width(void);
const TerrainColumn *landscape_column_at_index(int index);
const TerrainColumn *landscape_column_at_world(float worldX);
int landscape_column_index_at_world(float worldX);

// Tracks whether the ground object at a given column has already been
// spawned this level (so SPAWN_ENEMIES-equivalent code only spawns once).
bool landscape_column_object_spawned(int index);
void landscape_mark_column_object_spawned(int index);

#endif // SCRAMBLE_LANDSCAPE_H
