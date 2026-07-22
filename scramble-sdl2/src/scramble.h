// Scramble (C) 1981 KONAMI -- SDL2/C gameplay port.
//
// Ported from Scott Tunstall's Z80 disassembly of the original arcade ROM
// (seanriddle.com/scramble.asm). This is a *faithful logic port*, not a
// cycle-exact emulator: real level data, collision math, scoring values,
// fuel-drain rates and spawn cadences are taken directly from the
// disassembly (see comments referencing original $XXXX addresses), but
// there is no original tile/sprite ROM in that file to port pixel-for-pixel
// (graphics lived on separate ROM chips on the real board), so rendering
// here uses simple vector shapes, and audio is synthesized square waves
// standing in for the AY-3-8910.
#ifndef SCRAMBLE_H
#define SCRAMBLE_H

#include <stdint.h>
#include <stdbool.h>

// ---------------------------------------------------------------------
// World / screen geometry
// ---------------------------------------------------------------------
// World Y is kept in the *same 0-255 coordinate space the original ROM
// used* for hardware X (which, because the arcade monitor was rotated,
// is the vertical axis on screen). Floor/ceiling bytes from the real
// LEVEL_n_LANDSCAPE_LAYOUT tables and the player's own position are
// directly comparable, exactly as in PLAYER_TO_LANDSCAPE_COLLISION_DETECTION
// (asm $2113).
#define WORLD_H 256

#define SCREEN_W 1024
#define SCREEN_H 768
#define PX_PER_UNIT 3.0f     // world-units -> screen pixels scale
#define ANCHOR_X 220.0f      // fixed screen X the player ship is drawn at

// Real clamp values from PLAYER_MOVE_VERTICAL / PLAYER_MOVE_HORIZONTAL
// (asm $1749-$17CE): jet X (vertical on screen) is clamped to [56,215],
// jet Y (horizontal wiggle) to [128,207].
#define PLAYER_WORLDY_MIN 56
#define PLAYER_WORLDY_MAX 215
#define PLAYER_WIGGLE_MIN 128
#define PLAYER_WIGGLE_MAX 207

#define MAX_PLAYER_BULLETS 4   // sizeof(PLAYER_BULLETS) / sizeof(PLAYER_BULLET), asm $4500
#define MAX_PLAYER_BOMBS 2     // PLAYER_BOMBS array length, asm $43C0
#define MAX_GROUND_OBJECTS 8   // GROUND_OBJECTS array length, asm $4280
#define MAX_INFLIGHT_ENEMIES 4 // INFLIGHT_ENEMIES array length, asm $4400

// Ground object ids -- these match NEXT_GROUND_OBJECT_ID bit values exactly
// as tested by SPAWN_ROCKET_ON_GROUND ($272C, and $01), SPAWN_FUEL_TANK
// ($26FA, and $02), SPAWN_MYSTERY ($275E, and $04), SPAWN_BASE ($2790, and $08).
enum {
    GOBJ_NONE = 0,
    GOBJ_ROCKET = 1,
    GOBJ_FUEL = 2,
    GOBJ_MYSTERY = 4,
    GOBJ_BASE = 8,
};

// LANDSCAPE_FLAGS values (asm $411D) -- which inflight enemy type a level
// spawns, per the header table in the original source.
enum {
    LFLAG_LEVEL1_ROCKETS = 0,
    LFLAG_LEVEL3_FIREBALLS = 1,
    LFLAG_LEVEL2_UFOS = 2,
    LFLAG_LEVEL5_NONE = 4,
    LFLAG_LEVEL4_ROCKETS = 8,
    LFLAG_BASE_NONE = 16,
};

enum EnemyKind {
    ENEMY_NONE = 0,
    ENEMY_ROCKET,
    ENEMY_UFO,
    ENEMY_FIREBALL,
};

// Real scoring values from AWARD_POINTS_FOR_DESTROYING_GROUND_OBJECT ($226D),
// CHECK_IF_PLAYER_BULLET_HIT_ROCKET ($235C) and CHECK_IF_PLAYER_BULLET_HIT_UFO
// ($2197) / CHECK_IF_PLAYER_BOMB_HIT_UFO ($23F6).
#define SCORE_GROUND_ROCKET 50
#define SCORE_FUEL_TANK 150
#define SCORE_MYSTERY_100 100
#define SCORE_MYSTERY_200 200
#define SCORE_MYSTERY_300 300
#define SCORE_BASE 800
#define SCORE_INFLIGHT_ROCKET 80
#define SCORE_UFO 100

// FUEL_DESTROYED_ADD_FUEL_AND_AWARD_50_PTS ($2283): +0x30 fuel, clamped to $FF.
#define FUEL_REFUEL_AMOUNT 0x30
#define FUEL_MAX 0xFF

// Extra life: BONUS_JET_FOR defaults to 10 BCD => bonus jet at 10,000 points
// (asm $0100), only ever awarded once (CURRENT_PLAYER_HAD_EXTRA_LIFE, $4107).
#define EXTRA_LIFE_SCORE 10000

#define DEFAULT_LIVES 3

typedef struct {
    bool active;
    float worldX, worldY;
} PlayerBullet; // PLAYER_BULLET, asm struct @ line ~738

typedef struct {
    bool active;
    bool exploding;
    int explodeTimer;
    float worldX, worldY;
    float vy; // fall speed (gravity)
} PlayerBomb; // PLAYER_BOMB, asm struct @ line ~641

typedef struct {
    bool active;
    bool exploding;
    int explodeTimer;
    int type;          // GOBJ_ROCKET/FUEL/MYSTERY/BASE
    int mysteryPoints; // 0=100,1=200,2=300 (mirrors GROUND_OBJECT.MysteryPointsType)
    float worldX;       // column position along the level
    float worldY;        // sits on the terrain
} GroundObject; // GROUND_OBJECT, asm struct @ line ~552

typedef struct {
    bool active;
    bool exploding;
    int explodeTimer;
    enum EnemyKind kind;
    float worldX, worldY;
    float phase; // used for bob/bounce patterns
    float vx;
} InflightEnemy; // INFLIGHT_ENEMY, asm struct @ line ~695

typedef struct {
    bool active;
    bool exploding;
    int explodeTimer;
    int worldY;      // clamped [56,215]  (PLAYER.X in the original)
    int wiggle;       // clamped [128,207] (PLAYER.Y in the original)
    int lives;
    long score;
    int fuel;             // CURRENT_PLAYER_FUEL, 0-255
    int fuelDrainCounter;
    bool hadExtraLife;    // CURRENT_PLAYER_HAD_EXTRA_LIFE
    int missionsCompleted; // CURRENT_PLAYER_MISSIONS_COMPLETED -> drives fuel drain rate
} Player;

typedef enum {
    GS_TITLE,
    GS_LEVEL_INTRO,
    GS_PLAYING,
    GS_PLAYER_DYING,
    GS_MISSION_COMPLETE,
    GS_GAME_OVER,
} GameStateKind;

typedef struct {
    GameStateKind state;
    int stateTimer;

    Player player;
    PlayerBullet bullets[MAX_PLAYER_BULLETS];
    PlayerBomb bombs[MAX_PLAYER_BOMBS];
    GroundObject groundObjects[MAX_GROUND_OBJECTS];
    InflightEnemy enemies[MAX_INFLIGHT_ENEMIES];

    int currentLevel;       // CURRENT_PLAYERS_LEVEL: 0-4 = level 1-5, 5 = BASE
    float worldScroll;       // camera position along the level, world-units
    long framesAlive;
    long highScore;

    // input, sampled once per frame
    bool up, down, left, right, fire, bomb;
    bool firePrev, bombPrev;
} GameState;

void game_init(GameState *g);
void game_reset_for_new_game(GameState *g);
void game_update(GameState *g);

#endif // SCRAMBLE_H
