#include <cuda_runtime.h>
#include <cstdio>

#define TILE 16

/// Per-thread vector.
struct alignas(16) Vec4 { float x, y, z, w; };

__device__ __forceinline__ float dot(const Vec4 a, const Vec4 b) {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

/// One thread per output element.
__global__ void saxpy(int n, float a, const float *x, float *y) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) y[i] = a * x[i] + y[i];
}

template <typename T>
__global__ void fill(T *out, int n, T value) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) out[i] = value;
}

void launch(float *x, float *y, int n, cudaStream_t stream) {
    saxpy<<<(n + 255) / 256, 256, 0, stream>>>(n, 2.0f, x, y);
    fill<float><<<1, 256>>>(x, n, 1.0f);
}
