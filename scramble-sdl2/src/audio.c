#include "audio.h"
#include <SDL2/SDL.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define SAMPLE_RATE 44100
#define MAX_VOICES 6

typedef struct {
    bool active;
    float freq;
    float phase;
    int samplesLeft;
    int totalSamples;
    float volume;
} Voice;

static SDL_AudioDeviceID s_dev = 0;
static Voice s_voices[MAX_VOICES];
static SDL_mutex *s_mutex = NULL;

static void audio_callback(void *userdata, Uint8 *stream, int len) {
    (void)userdata;
    int samples = len / (int)sizeof(int16_t);
    int16_t *out = (int16_t *)stream;
    memset(out, 0, len);

    if (s_mutex) SDL_LockMutex(s_mutex);
    for (int s = 0; s < samples; s++) {
        float mix = 0.0f;
        for (int v = 0; v < MAX_VOICES; v++) {
            Voice *voice = &s_voices[v];
            if (!voice->active) continue;
            float square = sinf(voice->phase) >= 0.0f ? 1.0f : -1.0f;
            float env = (float)voice->samplesLeft / (float)voice->totalSamples;
            mix += square * voice->volume * env;
            voice->phase += 2.0f * (float)M_PI * voice->freq / (float)SAMPLE_RATE;
            if (voice->phase > 2.0f * (float)M_PI) voice->phase -= 2.0f * (float)M_PI;
            if (--voice->samplesLeft <= 0) voice->active = false;
        }
        if (mix > 1.0f) mix = 1.0f;
        if (mix < -1.0f) mix = -1.0f;
        out[s] = (int16_t)(mix * 6000);
    }
    if (s_mutex) SDL_UnlockMutex(s_mutex);
}

bool audio_init(void) {
    SDL_AudioSpec want, have;
    SDL_zero(want);
    want.freq = SAMPLE_RATE;
    want.format = AUDIO_S16SYS;
    want.channels = 1;
    want.samples = 1024;
    want.callback = audio_callback;

    s_mutex = SDL_CreateMutex();
    s_dev = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (s_dev == 0) return false;
    SDL_PauseAudioDevice(s_dev, 0);
    return true;
}

void audio_shutdown(void) {
    if (s_dev) SDL_CloseAudioDevice(s_dev);
    if (s_mutex) SDL_DestroyMutex(s_mutex);
    s_mutex = NULL;
    s_dev = 0;
}

static void play_tone(float freq, float durationSec, float volume) {
    if (!s_dev) return;
    if (s_mutex) SDL_LockMutex(s_mutex);
    for (int v = 0; v < MAX_VOICES; v++) {
        if (s_voices[v].active) continue;
        int total = (int)(durationSec * SAMPLE_RATE);
        if (total < 1) total = 1;
        s_voices[v] = (Voice){ .active = true, .freq = freq, .phase = 0, .samplesLeft = total, .totalSamples = total, .volume = volume };
        break;
    }
    if (s_mutex) SDL_UnlockMutex(s_mutex);
}

void audio_play(SfxId id) {
    switch (id) {
    case SFX_FIRE: play_tone(880.0f, 0.06f, 0.25f); break;
    case SFX_BOMB_DROP: play_tone(220.0f, 0.10f, 0.25f); break;
    case SFX_EXPLOSION_SMALL: play_tone(140.0f, 0.15f, 0.35f); break;
    case SFX_EXPLOSION_BIG: play_tone(90.0f, 0.4f, 0.45f); break;
    case SFX_PLAYER_DEATH: play_tone(110.0f, 0.6f, 0.45f); break;
    case SFX_EXTRA_LIFE: play_tone(1320.0f, 0.35f, 0.3f); break;
    case SFX_MYSTERY: play_tone(660.0f, 0.2f, 0.3f); break;
    default: break;
    }
}
