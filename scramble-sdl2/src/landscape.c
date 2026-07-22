#include "landscape.h"
#include "data/landscape_data.h"
#include <string.h>

#define MAX_COLUMNS 512

static TerrainColumn s_columns[MAX_COLUMNS];
static bool s_spawned[MAX_COLUMNS];
static int s_count = 0;
static int s_flags = 0;

void landscape_load_level(int levelIndex) {
    if (levelIndex < 0) levelIndex = 0;
    if (levelIndex >= SCR_NUM_LEVELS) levelIndex = SCR_NUM_LEVELS - 1;

    const LandscapeLayout *layout = &SCR_LEVELS[levelIndex];
    s_flags = layout->flags;
    s_count = 0;

    for (int i = 0; i < layout->count && s_count + 2 <= MAX_COLUMNS; i++) {
        const LandscapeRecord *r = &layout->records[i];
        // Column order mirrors the original: byte2 (floorA) is scrolled on
        // before byte0 (floorB) within a record -- see DECODE_LANDSCAPE_FLOOR
        // ($1610-$1625), which stores extent[E].GroundX = byte2 before
        // extent[E+1].GroundX = byte0.
        s_columns[s_count++] = (TerrainColumn){
            .floorY = r->floorA,
            .hasCeiling = r->hasCeiling,
            .ceilY = r->ceilA,
            .groundObj = GOBJ_NONE,
        };
        s_columns[s_count++] = (TerrainColumn){
            .floorY = r->floorB,
            .hasCeiling = r->hasCeiling,
            .ceilY = r->ceilB,
            .groundObj = r->groundObj,
        };
    }

    memset(s_spawned, 0, sizeof(s_spawned));
}

int landscape_flags(void) { return s_flags; }
int landscape_column_count(void) { return s_count; }
float landscape_world_width(void) { return (float)(s_count * TERRAIN_COLUMN_WORLD_WIDTH); }

const TerrainColumn *landscape_column_at_index(int index) {
    if (index < 0 || index >= s_count) return NULL;
    return &s_columns[index];
}

int landscape_column_index_at_world(float worldX) {
    if (worldX < 0) worldX = 0;
    return (int)(worldX / TERRAIN_COLUMN_WORLD_WIDTH);
}

const TerrainColumn *landscape_column_at_world(float worldX) {
    return landscape_column_at_index(landscape_column_index_at_world(worldX));
}

bool landscape_column_object_spawned(int index) {
    if (index < 0 || index >= MAX_COLUMNS) return true;
    return s_spawned[index];
}

void landscape_mark_column_object_spawned(int index) {
    if (index < 0 || index >= MAX_COLUMNS) return;
    s_spawned[index] = true;
}
