cmake_minimum_required(VERSION 3.10)
project(scramble_sdl2 C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(SDL2 REQUIRED)

add_executable(scramble
    src/main.c
    src/landscape.c
    src/player.c
    src/enemies.c
    src/bullets.c
    src/collision.c
    src/game.c
    src/render.c
    src/text.c
    src/audio.c
)

target_include_directories(scramble PRIVATE ${SDL2_INCLUDE_DIRS})
target_link_libraries(scramble PRIVATE ${SDL2_LIBRARIES} m)
target_compile_options(scramble PRIVATE -Wall -Wextra -O2)
