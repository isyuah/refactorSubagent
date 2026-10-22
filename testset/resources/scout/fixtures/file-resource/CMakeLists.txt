cmake_minimum_required(VERSION 3.20)
project(file_config C)
add_library(file_config STATIC src/config.c)
target_include_directories(file_config PUBLIC include)
