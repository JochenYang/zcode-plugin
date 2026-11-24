#include <metal_stdlib>

struct Broken {
    float2 p [[attribute(0

kernel void broken(device float *x [[buffer(0)]) {
    x[0] = ;
}
