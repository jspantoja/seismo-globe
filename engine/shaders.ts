/**
 * GLSL ES 3.00 sources. Kept in one place so the maths they share with the CPU side
 * (camera basis, projection, lat/lng ↔ direction) is easy to compare.
 */

// ---------------------------------------------------------------------------
// The globe itself: one quad that bounds the planet and its atmosphere. Every pixel casts a ray
// from the camera, so the sphere is perfectly round at any zoom (no tessellation), the texture
// is looked up per pixel from the exact latitude and longitude, and the atmosphere is analytic.
// ---------------------------------------------------------------------------

export const GLOBE_VERT = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform vec2 u_extent;
out vec2 v_ndc;
void main() {
  vec2 p = a_pos * u_extent;
  v_ndc = p;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const GLOBE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_ndc;
out vec4 outColor;

uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_back;
uniform float u_alt;       // camera altitude: the camera is at u_back * (1 + u_alt)
uniform vec2 u_tan;        // (tan(fovY/2) * aspect, tan(fovY/2))
uniform mat4 u_viewProj;
uniform sampler2D u_tex;   // equirectangular, sRGB
uniform vec3 u_atmColor;   // sRGB
uniform float u_atmH;      // atmosphere height, in globe radii

const float INV_TAU = 0.15915494309189535;
const float INV_PI = 0.3183098861837907;

vec3 toSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  float dist = 1.0 + u_alt;
  vec3 dir = normalize(u_right * (v_ndc.x * u_tan.x) + u_up * (v_ndc.y * u_tan.y) - u_back);
  vec3 origin = u_back * dist;

  // Ray against the unit sphere. disc > 0 when the ray hits it; 1 - disc is the squared distance
  // from the centre at the ray's closest approach (every pixel's ray heads towards the globe's side).
  float b = dot(origin, dir);
  float disc = b * b - u_alt * (u_alt + 2.0);
  float sq = sqrt(max(disc, 0.0));
  vec3 p = origin + dir * (-b - sq);
  vec3 n = normalize(p);

  // Texture lookup. atan() jumps at the antimeridian, which would make the derivatives huge and pick
  // the blurriest mip along a visible seam: use the derivatives of whichever of u or its shifted copy is smooth.
  float lng = atan(n.x, n.z);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  vec2 uv = vec2(lng * INV_TAU + 0.5, 0.5 - lat * INV_PI);
  float u2 = fract(uv.x + 0.5);
  vec2 ddx = dFdx(uv);
  vec2 ddy = dFdy(uv);
  float ddx2 = dFdx(u2);
  float ddy2 = dFdy(u2);
  if (abs(ddx2) < abs(ddx.x)) ddx.x = ddx2;
  if (abs(ddy2) < abs(ddy.x)) ddy.x = ddy2;
  vec3 texel = textureGrad(u_tex, uv, ddx, ddy).rgb; // linear

  // A soft light that stays with the camera, a little above and to the right.
  vec3 light = normalize(u_right + u_up + u_back);
  float shade = 0.78 + 0.5 * max(dot(n, light), 0.0);
  vec3 lit = toSrgb(texel * shade);

  // Atmosphere: a haze over the planet towards its limb, and a glow outside it. They meet
  // at the same strength on the limb, so there is no seam.
  float facing = clamp(dot(n, -dir), 0.0, 1.0);
  float rim = pow(1.0 - facing, 3.0);
  float closest = sqrt(max(1.0 - disc, 0.0));
  float s = clamp((closest - 1.0) / u_atmH, 0.0, 1.0);
  float aOut = 0.5 * pow(1.0 - s, 2.4);
  vec3 surface = mix(lit, u_atmColor, 0.5 * rim);

  // Analytic anti-aliasing of the limb: disc is ~linear across it.
  float coverage = clamp(0.5 + disc / max(fwidth(disc), 1e-7), 0.0, 1.0);

  vec4 globe = vec4(surface, 1.0);
  vec4 glow = vec4(u_atmColor * aOut, aOut); // premultiplied
  vec4 color = globe * coverage + glow * (1.0 - coverage);

  // Dither: the glow is a long dark gradient that bands visibly in 8 bits.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  color += (noise - 0.5) / 255.0;
  outColor = clamp(color, 0.0, 1.0);

  vec4 clip = u_viewProj * vec4(p, 1.0);
  gl_FragDepth = coverage > 0.5 ? clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0) : 1.0;
}
`;
