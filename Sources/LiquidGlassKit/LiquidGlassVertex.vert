#version 300 es
//
//  LiquidGlassVertex.metal
//  LiquidGlass
//
//  Created by Alexey Demin on 2025-12-06.
//  Ported to OpenGL ES 3.0 by Claude Sonnet 4.6 on 2026-03-13.
//

// Vertex output: Passed to fragment.
out vec2 v_uv;  // Interpolated UVs

// Vertex shader: Hardcoded fullscreen quad.
void main() {

    // Unpacked quad: 0=BL, 1=BR, 2=TL, 3=TR (triangle strip order)
    vec2 positions[4] = vec2[4](
        vec2(-1.0, -1.0),  // Bottom-left
        vec2( 1.0, -1.0),  // Bottom-right
        vec2(-1.0,  1.0),  // Top-left
        vec2( 1.0,  1.0)   // Top-right
    );

    vec2 uvs[4] = vec2[4](
        vec2(0.0, 0.0),
        vec2(1.0, 0.0),
        vec2(0.0, 1.0),
        vec2(1.0, 1.0)
    );

    gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
    v_uv = uvs[gl_VertexID];
}
