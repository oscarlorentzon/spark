// RayGS splat projection from "Hardware-Rasterized Ray-Based Gaussian Splatting"
// (Rota Bulò et al. 2025), https://arxiv.org/abs/2503.18682, reference
// implementation https://github.com/facebookresearch/vkraygs

// Matches SPLAT_PROJECTION_IDS in SparkRenderer.ts
const int SPLAT_PROJECTION_RAYGS = 1;

struct RaySplat {
    // View space, unit length in the whitened frame
    vec3 axis0;
    vec3 axis1;
    // mu^T Sigma^-1 mu, 0 for orthographic cameras
    float c2;
    // In the whitened frame
    float halfSize;
};

// Anti-aliasing from the paper, returning the opacity scale. The pixel area uses
// depth rather than distance, which is closer to a pixel's footprint off-center.
float rayEvalInflate(vec3 mu, mat3 R, vec3 scales, vec2 focal, float preBlur, float blur, out vec3 inflated) {
    float pixelArea = (isOrthographic ? 1.0 : sqr(mu.z)) / (focal.x * focal.y);
    vec3 local = (isOrthographic ? vec3(0.0, 0.0, -1.0) : mu) * R;
    vec3 l2 = local * local;
    vec3 s2 = scales * scales + preBlur * pixelArea;
    vec3 s2Blur = s2 + blur * pixelArea;
    float det = dot(l2, vec3(s2.y * s2.z, s2.x * s2.z, s2.x * s2.y));
    float detBlur = dot(l2, vec3(s2Blur.y * s2Blur.z, s2Blur.x * s2Blur.z, s2Blur.x * s2Blur.y));

    // Keep flat splats finite along rays
    inflated = sqrt(s2Blur);
    inflated = max(inflated, 1.0e-4 * max(inflated.x, max(inflated.y, inflated.z)));
    return (detBlur > 0.0) ? sqrt(det / detBlur) : 1.0;
}

// Reduces the cutoff to where the opacity falls below minAlpha, if that is
// closer, since the fragment shader discards everything beyond it
float rayEvalCutoff(float opacity, float stdDev, float minAlpha, float falloff) {
    if (opacity > 1.0 || falloff < 1.0) {
        return stdDev;
    }
    return min(stdDev, sqrt(2.0 * log(max(opacity, minAlpha) / minAlpha)));
}

// Two orthonormal vectors spanning the plane orthogonal to unit vector n
void orthonormalBasis(vec3 n, out vec3 b0, out vec3 b1) {
    vec3 t = n + vec3(0.0, 0.0, (n.z >= 0.0) ? 1.0 : -1.0);
    float invDen = 2.0 / dot(t, t);
    b0 = t * (t.x * invDen) - vec3(1.0, 0.0, 0.0);
    b1 = t * (t.y * invDen) - vec3(0.0, 1.0, 0.0);
}

// Unit eigenvector for the larger eigenvalue of symmetric m, in the
// cancellation-free form of the EWA path
vec2 majorEigenvector(mat2 m) {
    float halfDiagDiff = 0.5 * (m[0][0] - m[1][1]);
    float eigenDelta = sqrt(sqr(halfDiagDiff) + sqr(m[0][1]));
    vec2 v = (halfDiagDiff >= 0.0)
        ? vec2(eigenDelta + halfDiagDiff, m[0][1])
        : vec2(m[0][1], eigenDelta - halfDiagDiff);
    float len2 = dot(v, v);
    return (len2 > 0.0) ? v * inversesqrt(len2) : vec2(1.0, 0.0);
}

// Returns false if the camera is inside or on the cutoff ellipsoid
bool rayEvalQuad(vec3 mu, mat3 R, vec3 scales, float stdDev, out RaySplat ray) {
    float kappa = stdDev * stdDev;
    vec3 muHat;
    if (isOrthographic) {
        // Parallel rays: the limit c -> infinity
        muHat = normalize((vec3(0.0, 0.0, -1.0) * R) / scales);
        ray.c2 = 0.0;
    } else {
        vec3 muWhite = (mu * R) / scales;
        ray.c2 = dot(muWhite, muWhite);
        if (!(ray.c2 > kappa * 1.0001)) {
            return false;
        }
        muHat = muWhite * inversesqrt(ray.c2);
    }

    vec3 r0, r1;
    orthonormalBasis(muHat, r0, r1);
    mat2x3 Q = mat2x3(R * (scales * r0), R * (scales * r1));

    // Aligning with the ellipse axes makes the quad a rectangle, as in vkraygs
    vec2 u = majorEigenvector(transpose(Q) * Q);
    ray.axis0 = Q * u;
    ray.axis1 = Q * vec2(-u.y, u.x);

    // Radius of the cutoff circle in the whitened plane
    ray.halfSize = stdDev * ((ray.c2 > 0.0) ? inversesqrt(1.0 - kappa / ray.c2) : 1.0);
    return true;
}

// Corners keep the center's NDC depth so the near plane never clips the quad
vec4 rayEvalCorner(RaySplat ray, vec2 corner, vec4 clipCenter, out vec2 z) {
    z = corner * ray.halfSize;
    vec4 clip = clipCenter + projectionMatrix * vec4(z.x * ray.axis0 + z.y * ray.axis1, 0.0);
    return vec4(clip.xy, (clipCenter.z / clipCenter.w) * clip.w, clip.w);
}
