if(MINGW AND PROJECT_NAME STREQUAL "ggml")
    # ggml strips MinGW's lib prefix, but rustc's static library lookup requires it.
    cmake_language(DEFER CALL set_target_properties
        ggml ggml-base ggml-cpu PROPERTIES PREFIX "lib")
endif()
