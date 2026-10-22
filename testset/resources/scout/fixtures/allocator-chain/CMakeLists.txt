cmake_minimum_required(VERSION 3.20)
project(frame_codec C)
add_library(frame_codec STATIC src/frame.c src/wire.c src/hex.c)
target_include_directories(frame_codec PUBLIC include PRIVATE src)
