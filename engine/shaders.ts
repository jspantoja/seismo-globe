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

// ---------------------------------------------------------------------------
// Layers lying on the surface (fills, lines). Positions arrive as a (high, low) pair of float32
// vectors that add up to the exact float64 position; the camera position is split the same way and
// subtracted *before* anything else ("relative to eye"). The difference is small and exact, so
// vertices do not tremble however close the camera gets. These layers do not use the depth buffer:
// they are drawn in order, and a per-vertex "horizon" value (> 0 when the point faces the camera,
// linear, so it interpolates exactly) hides what is on the far side of the planet.
// ---------------------------------------------------------------------------

export const FILL_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_hi;
layout(location = 1) in vec3 a_lo;
layout(location = 2) in vec4 a_color;
uniform mat4 u_mvp;      // projection * rotation
uniform vec3 u_eyeHi;
uniform vec3 u_eyeLo;
uniform vec3 u_eye;      // camera position
uniform float u_bias;    // |eye|^2 - 1
out vec4 v_color;
out float v_h;
void main() {
  vec3 rel = (a_hi - u_eyeHi) + (a_lo - u_eyeLo);
  v_h = dot(rel, u_eye) + u_bias;
  v_color = a_color;
  gl_Position = u_mvp * vec4(rel, 1.0);
}
`;

export const FILL_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_h;
out vec4 outColor;
void main() {
  float visible = clamp(v_h / max(fwidth(v_h), 1e-9) + 0.5, 0.0, 1.0);
  float a = v_color.a * visible;
  outColor = vec4(v_color.rgb * a, a);
}
`;

// One instance per line segment; four vertices (a strip) per instance.
export const LINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 i_p0Hi;
layout(location = 1) in vec3 i_p0Lo;
layout(location = 2) in vec3 i_p1Hi;
layout(location = 3) in vec3 i_p1Lo;
layout(location = 4) in vec3 i_prev;
layout(location = 5) in vec3 i_next;
layout(location = 6) in float i_width;
layout(location = 7) in vec4 i_color;
uniform mat4 u_mvp;
uniform vec3 u_eyeHi;
uniform vec3 u_eyeLo;
uniform vec3 u_eye;
uniform float u_bias;
uniform vec2 u_viewport;  // CSS pixels
uniform float u_pixel;    // one device pixel, in CSS pixels
out vec4 v_color;
out float v_h;
out float v_across;
out float v_half;

vec2 toScreen(vec4 c) { return c.xy / c.w * 0.5 * u_viewport; }

void main() {
  int corner = gl_VertexID;
  float side = (corner & 1) == 0 ? -1.0 : 1.0;
  bool atEnd = corner >= 2;

  vec3 r0 = (i_p0Hi - u_eyeHi) + (i_p0Lo - u_eyeLo);
  vec3 r1 = (i_p1Hi - u_eyeHi) + (i_p1Lo - u_eyeLo);
  vec4 c0 = u_mvp * vec4(r0, 1.0);
  vec4 c1 = u_mvp * vec4(r1, 1.0);
  vec4 cp = u_mvp * vec4(i_prev - u_eyeHi, 1.0);
  vec4 cn = u_mvp * vec4(i_next - u_eyeHi, 1.0);
  vec2 s0 = toScreen(c0);
  vec2 s1 = toScreen(c1);
  vec2 sp = toScreen(cp);
  vec2 sn = toScreen(cn);

  vec2 seg = s1 - s0;
  float segLen = length(seg);
  vec2 d = segLen > 1e-6 ? seg / segLen : vec2(1.0, 0.0);

  // Direction of the neighbour segment at this end, and the miter between the two.
  vec2 other = atEnd ? (sn - s1) : (s0 - sp);
  float otherLen = length(other);
  vec2 dOther = otherLen > 1e-6 ? other / otherLen : d;
  vec2 t = d + dOther;
  float tLen = length(t);
  t = tLen > 1e-4 ? t / tLen : d;
  vec2 normal = vec2(-d.y, d.x);
  vec2 miter = vec2(-t.y, t.x);
  float scale = 1.0 / max(dot(miter, normal), 0.25);

  float halfWidth = 0.5 * i_width;
  float reach = halfWidth + u_pixel; // one device pixel of margin for the soft edge
  vec2 pos = (atEnd ? s1 : s0) + miter * side * reach * scale;
  vec4 c = atEnd ? c1 : c0;
  vec3 r = atEnd ? r1 : r0;

  gl_Position = vec4(pos / (0.5 * u_viewport) * c.w, c.z, c.w);
  v_h = dot(r, u_eye) + u_bias;
  v_color = i_color;
  v_across = side * reach;
  v_half = halfWidth;
}
`;

export const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_h;
in float v_across;
in float v_half;
uniform float u_pixel;
out vec4 outColor;
void main() {
  // Exact coverage of a one-pixel box filter by the stripe [-half, +half]: thin lines get dim, not jagged.
  float lo = max(v_across - 0.5 * u_pixel, -v_half);
  float hi = min(v_across + 0.5 * u_pixel, v_half);
  float coverage = clamp((hi - lo) / u_pixel, 0.0, 1.0);
  float visible = clamp(v_h / max(fwidth(v_h), 1e-9) + 0.5, 0.0, 1.0);
  float a = v_color.a * coverage * visible;
  outColor = vec4(v_color.rgb * a, a);
}
`;
