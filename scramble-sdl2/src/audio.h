// Minimal SDL2 square-wave SFX synthesizer. Stands in for the AY-3-8910
// sound chip -- the sound board's ROM/driver isn't part of the disassembled
// file (that's the *main* CPU board only), so there's nothing to port here;
// these are original, simple beeps triggered at the same game events the
// asm queues sound commands for (QUEUE_*_SOUND calls near $28xx-$29xx).
#ifndef SCRAMBLE_AUDIO_H
#define SCRAMBLE_AUDIO_H

#include <stdbool.h>

typedef enum {
    SFX_FIRE,
    SFX_BOMB_DROP,
    SFX_EXPLOSION_SMALL,
    SFX_EXPLOSION_BIG,
    SFX_PLAYER_DEATH,
    SFX_EXTRA_LIFE,
    SFX_MYSTERY,
    SFX_COUNT,
} SfxId;

bool audio_init(void);
void audio_shutdown(void);
void audio_play(SfxId id);

#endif // SCRAMBLE_AUDIO_H
