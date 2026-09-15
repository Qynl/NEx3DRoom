/**
 * All GLSL lives here. WebGL2 / GLSL ES 3.00.
 *
 * Four programs:
 *   pbr      - lit, textured, physically based. Used by the whole room and the AI.
 *   depth    - shadow map pass.
 *   unlit    - additive/alpha quads: the AI aura, soft contact shadows.
 *   post     - bright pass, blur, final tonemap.
 */

const HEADER = `#version 300 es
precision highp float;
precision highp int;
`;

/* ---------------------------------------------------------------- PBR ---- */

export const PBR_VERT = HEADER + `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec4 aTangent;

uniform mat4 uModel;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
uniform mat3 uNormalMat;
uniform vec2 uUVScale;

out vec3 vWorld;
out vec3 vNormal;
out vec3 vTangent;
out vec2 vUV;
out vec4 vLightSpace;
flat out float vHanded;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  vTangent = normalize(uNormalMat * aTangent.xyz);
  vUV = aUV * uUVScale;
  vHanded = aTangent.w;
  vLightSpace = uLightViewProj * world;
  gl_Position = uViewProj * world;
}
`;

export const PBR_FRAG = HEADER + `
in vec3 vWorld;
in vec3 vNormal;
in vec3 vTangent;
in vec2 vUV;
in vec4 vLightSpace;
flat in float vHanded;

out vec4 outColor;

#define MAX_LIGHTS 8
#define PI 3.14159265359

uniform vec3 uCameraPos;

// --- material -------------------------------------------------------------
uniform vec3  uAlbedo;
uniform float uMetallic;
uniform float uRoughness;
uniform vec3  uEmissive;
uniform float uEmissiveStrength;
uniform float uOpacity;
uniform float uNormalScale;
uniform vec4  uMapFlags;      // x albedo, y normal, z roughness, w double sided
uniform sampler2D uAlbedoMap;
uniform sampler2D uNormalMap;
uniform sampler2D uRoughMap;

// --- environment ----------------------------------------------------------
uniform samplerCube uEnvMap;
uniform float uEnvIntensity;
uniform float uEnvMaxLod;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform float uAmbientIntensity;

// --- sun + shadow ---------------------------------------------------------
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uShadowStrength;
uniform vec2  uShadowTexel;
uniform highp sampler2DShadow uShadowMap;
uniform float uShadowEnabled;

// --- point lights ---------------------------------------------------------
uniform int   uLightCount;
uniform vec3  uLightPos[MAX_LIGHTS];
uniform vec3  uLightColor[MAX_LIGHTS];   // colour * intensity
uniform vec2  uLightParams[MAX_LIGHTS];  // x range, y source radius

// --- atmosphere -----------------------------------------------------------
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uTranslucency;

const float MIN_ROUGH = 0.045;

float distributionGGX(vec3 N, vec3 H, float a) {
  float a2 = a * a;
  float NdH = max(dot(N, H), 0.0);
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-7);
}

float geometrySmith(float NdV, float NdL, float a) {
  float k = a * 0.5;
  float g1 = NdV / (NdV * (1.0 - k) + k);
  float g2 = NdL / (NdL * (1.0 - k) + k);
  return g1 * g2;
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  float f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (1.0 - F0) * f;
}

vec3 fresnelRough(float cosTheta, vec3 F0, float roughness) {
  vec3 one = vec3(1.0);
  return F0 + (max(one * (1.0 - roughness), F0) - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// Karis' analytic approximation of the split-sum BRDF LUT.
vec2 envBRDF(float NoV, float roughness) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = roughness * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

float shadowFactor(vec3 N, vec3 L) {
  if (uShadowEnabled < 0.5) return 1.0;
  vec3 proj = vLightSpace.xyz / max(vLightSpace.w, 1e-5);
  vec2 uv = proj.xy * 0.5 + 0.5;
  if (uv.x < 0.005 || uv.x > 0.995 || uv.y < 0.005 || uv.y > 0.995) return 1.0;
  if (proj.z > 1.0) return 1.0;
  // Normal offset kills most self shadowing acne on thin geometry.
  float bias = 0.0016 + 0.004 * (1.0 - max(dot(N, L), 0.0));
  float depth = proj.z - bias;
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += texture(uShadowMap, vec3(uv + vec2(float(x), float(y)) * uShadowTexel, depth));
    }
  }
  return mix(1.0, sum / 9.0, uShadowStrength);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorld);

  vec3 albedo = uAlbedo;
  if (uMapFlags.x > 0.5) albedo *= texture(uAlbedoMap, vUV).rgb;

  float roughness = uRoughness;
  if (uMapFlags.z > 0.5) roughness *= texture(uRoughMap, vUV).r;
  roughness = clamp(roughness, MIN_ROUGH, 1.0);
  float metallic = uMetallic;

  if (uMapFlags.y > 0.5) {
    vec3 T = normalize(vTangent);
    vec3 B = cross(N, T) * vHanded;
    vec3 mapN = texture(uNormalMap, vUV).xyz * 2.0 - 1.0;
    mapN.xy *= uNormalScale;
    N = normalize(T * mapN.x + B * mapN.y + N * mapN.z);
  }

  float NdV = max(dot(N, V), 1e-4);
  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  float alpha = roughness * roughness;

  vec3 colour = vec3(0.0);

  // ---- sun ---------------------------------------------------------------
  vec3 L = normalize(uSunDir);
  float NdL = max(dot(N, L), 0.0);
  if (NdL > 0.0 || uTranslucency > 0.0) {
    float vis = shadowFactor(N, L);
    vec3 radiance = uSunColor;
    vec3 H = normalize(V + L);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
    float D = distributionGGX(N, H, alpha);
    float G = geometrySmith(NdV, max(NdL, 1e-4), alpha);
    vec3 spec = (D * G * F) / (4.0 * NdV * max(NdL, 1e-4) + 1e-4);
    vec3 diff = (1.0 - F) * (1.0 - metallic) * albedo / PI;
    colour += (diff + spec) * radiance * NdL * vis;
    if (uTranslucency > 0.0) {
      // Thin fabric: light leaking through (curtains, lamp shades, leaves).
      float back = pow(max(dot(-N, L), 0.0), 1.5) * 0.6 + max(dot(V, -L), 0.0) * 0.4;
      colour += albedo * radiance * back * uTranslucency;
    }
  }

  // ---- point lights ------------------------------------------------------
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 toLight = uLightPos[i] - vWorld;
    float dist = length(toLight);
    float range = uLightParams[i].x;
    if (dist > range) continue;
    vec3 Li = toLight / max(dist, 1e-4);
    float NdLi = max(dot(N, Li), 0.0);
    if (NdLi <= 0.0) continue;
    float window = clamp(1.0 - dist / range, 0.0, 1.0);
    float atten = window * window / (1.0 + dist * dist * 0.35);
    vec3 H = normalize(V + Li);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
    float D = distributionGGX(N, H, alpha);
    float G = geometrySmith(NdV, NdLi, alpha);
    vec3 spec = (D * G * F) / (4.0 * NdV * NdLi + 1e-4);
    vec3 diff = (1.0 - F) * (1.0 - metallic) * albedo / PI;
    colour += (diff + spec) * uLightColor[i] * atten * NdLi;
  }

  // ---- image based lighting ---------------------------------------------
  vec3 R = reflect(-V, N);
  vec2 brdf = envBRDF(NdV, roughness);
  vec3 Fenv = fresnelRough(NdV, F0, roughness);
  float lod = roughness * uEnvMaxLod;
  vec3 envSpec = textureLod(uEnvMap, R, lod).rgb * uEnvIntensity;
  // Two-tone irradiance: sky above, warm floor bounce below.
  vec3 irradiance = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
  vec3 envDiff = irradiance * albedo * (1.0 - metallic);
  colour += envDiff * uAmbientIntensity * (1.0 - Fenv * 0.5);
  colour += envSpec * (Fenv * brdf.x + brdf.y);

  // ---- emission ----------------------------------------------------------
  vec3 emission = uEmissive * uEmissiveStrength;
  if (uMapFlags.x > 0.5 && uEmissiveStrength > 0.0) {
    emission *= texture(uAlbedoMap, vUV).rgb * 2.0 + 0.15;
  }
  colour += emission;

  // ---- depth cue ---------------------------------------------------------
  float dist = length(uCameraPos - vWorld);
  float fog = 1.0 - exp(-dist * uFogDensity);
  colour = mix(colour, uFogColor, clamp(fog, 0.0, 0.55));

  outColor = vec4(colour, uOpacity);
}
`;

/* --------------------------------------------------------------- depth --- */

export const DEPTH_VERT = HEADER + `
layout(location = 0) in vec3 aPosition;
uniform mat4 uModel;
uniform mat4 uLightViewProj;
void main() {
  gl_Position = uLightViewProj * uModel * vec4(aPosition, 1.0);
}
`;

export const DEPTH_FRAG = HEADER + `
void main() { }
`;

/* --------------------------------------------------------------- unlit --- */

export const UNLIT_VERT = HEADER + `
layout(location = 0) in vec3 aPosition;
layout(location = 2) in vec2 aUV;
uniform mat4 uModel;
uniform mat4 uViewProj;
out vec2 vUV;
out vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vUV = aUV;
  gl_Position = uViewProj * world;
}
`;

export const UNLIT_FRAG = HEADER + `
in vec2 vUV;
in vec3 vWorld;
out vec4 outColor;
uniform sampler2D uTexture;
uniform vec4 uColor;
uniform float uUseTexture;
uniform float uSoftEdge;
uniform vec3 uCameraPos;
void main() {
  vec4 tex = uUseTexture > 0.5 ? texture(uTexture, vUV) : vec4(1.0);
  float alpha = tex.a * uColor.a;
  if (uSoftEdge > 0.5) {
    // Fade the quad out towards its rim so billboards have no visible border.
    vec2 d = vUV - 0.5;
    float r = clamp(length(d) * 2.0, 0.0, 1.0);
    alpha *= pow(1.0 - r, 2.2);
  }
  if (alpha < 0.002) discard;
  outColor = vec4(tex.rgb * uColor.rgb * alpha, alpha);
}
`;

/* ---------------------------------------------------------------- post --- */

export const POST_VERT = HEADER + `
out vec2 vUV;
void main() {
  // Fullscreen triangle, no vertex buffer needed.
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1)) - 1.0;
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const BRIGHT_FRAG = HEADER + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTexture;
uniform float uThreshold;
uniform float uSoftKnee;
void main() {
  vec3 c = texture(uTexture, vUV).rgb;
  float l = max(max(c.r, c.g), c.b);
  float knee = max(uSoftKnee, 1e-4);
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
  outColor = vec4(c * contrib, 1.0);
}
`;

export const BLUR_FRAG = HEADER + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTexture;
uniform vec2 uDirection;   // texel sized step
void main() {
  vec3 sum = texture(uTexture, vUV).rgb * 0.227027;
  sum += (texture(uTexture, vUV + uDirection * 1.3846).rgb
        + texture(uTexture, vUV - uDirection * 1.3846).rgb) * 0.316216;
  sum += (texture(uTexture, vUV + uDirection * 3.2308).rgb
        + texture(uTexture, vUV - uDirection * 3.2308).rgb) * 0.070270;
  outColor = vec4(sum, 1.0);
}
`;

export const COMPOSITE_FRAG = HEADER + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uTime;
uniform float uGrain;
uniform vec3 uTint;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) * 1.055 - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec3 colour = texture(uScene, vUV).rgb;
  colour += texture(uBloom, vUV).rgb * uBloomStrength;
  colour *= uExposure;
  colour = aces(colour);
  colour *= uTint;

  vec2 q = vUV - 0.5;
  float vig = 1.0 - uVignette * dot(q, q) * 1.35;
  colour *= clamp(vig, 0.0, 1.0);

  if (uGrain > 0.0) {
    float g = hash(vUV * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
    colour += g * uGrain;
  }

  outColor = vec4(toSRGB(max(colour, 0.0)), 1.0);
}
`;
