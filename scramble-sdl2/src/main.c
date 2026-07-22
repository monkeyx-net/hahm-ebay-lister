#include <SDL2/SDL.h>
#include <stdio.h>
#include "scramble.h"
#include "render.h"
#include "audio.h"

int main(int argc, char **argv) {
    (void)argc; (void)argv;

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) != 0) {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }

    SDL_Window *window = SDL_CreateWindow(
        "Scramble (SDL2 C port)",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        SCREEN_W, SCREEN_H, SDL_WINDOW_SHOWN);
    if (!window) {
        fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }

    SDL_Renderer *renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    if (!renderer) {
        renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
    }

    if (!audio_init()) {
        fprintf(stderr, "Audio init failed (continuing without sound): %s\n", SDL_GetError());
    }

    GameState game;
    game_init(&game);

    const Uint32 frameDelayMs = 1000 / 60;
    bool running = true;

    while (running) {
        Uint32 frameStart = SDL_GetTicks();

        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) running = false;
            if (ev.type == SDL_KEYDOWN && ev.key.keysym.sym == SDLK_ESCAPE) running = false;
        }

        const Uint8 *keys = SDL_GetKeyboardState(NULL);
        game.up = keys[SDL_SCANCODE_UP] || keys[SDL_SCANCODE_W];
        game.down = keys[SDL_SCANCODE_DOWN] || keys[SDL_SCANCODE_S];
        game.left = keys[SDL_SCANCODE_LEFT] || keys[SDL_SCANCODE_A];
        game.right = keys[SDL_SCANCODE_RIGHT] || keys[SDL_SCANCODE_D];
        game.fire = keys[SDL_SCANCODE_Z] || keys[SDL_SCANCODE_SPACE];
        game.bomb = keys[SDL_SCANCODE_X] || keys[SDL_SCANCODE_LCTRL];

        game_update(&game);
        render_frame(renderer, &game);

        Uint32 elapsed = SDL_GetTicks() - frameStart;
        if (elapsed < frameDelayMs) SDL_Delay(frameDelayMs - elapsed);
    }

    audio_shutdown();
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
