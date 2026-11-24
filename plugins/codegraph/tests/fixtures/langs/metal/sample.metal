#include <metal_stdlib>
using namespace metal;

/// Per-vertex inputs.
struct VertexIn {
    float2 position [[attribute(0)]];
    float3 color [[attribute(1)]];
};

struct VertexOut {
    float4 position [[position]];
    float3 color;
};

/// Transforms a vertex into clip space.
vertex VertexOut vertex_main(uint vid [[vertex_id]],
                             constant VertexIn *vertices [[buffer(0)]]) {
    VertexOut out;
    out.position = float4(vertices[vid].position, 0.0, 1.0);
    out.color = vertices[vid].color;
    return out;
}

/// Blends a fragment's colour.
fragment float4 fragment_main(VertexOut in [[stage_in]]) {
    return float4(in.color, 1.0);
}

kernel void add_arrays(device const float *in [[buffer(0)]],
                       device float *out [[buffer(1)]],
                       uint id [[thread_position_in_grid]]) {
    out[id] = in[id] * 2.0f;
}
