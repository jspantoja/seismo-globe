/**
 * Thin helpers over the WebGL2 API: compiling programs (with readable errors), buffers, and
 * loading images with fallbacks. Nothing here knows about globes.
 */

export interface Program {
  handle: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`${label}: could not create a shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'no log';
    gl.deleteShader(shader);
    // Number the source lines so a log such as "ERROR: 0:42" can be found at a glance.
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(3)} ${l}`)
      .join('\n');
    throw new Error(`${label}: ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed to compile\n${log}\n${numbered}`);
  }
  return shader;
}

export function makeProgram(
  gl: WebGL2RenderingContext,
  label: string,
  vertexSource: string,
  fragmentSource: string,
  uniformNames: string[]
): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, label);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, label);
  const handle = gl.createProgram();
  if (!handle) throw new Error(`${label}: could not create a program`);
  gl.attachShader(handle, vs);
  gl.attachShader(handle, fs);
  gl.linkProgram(handle);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(handle) ?? 'no log';
    gl.deleteProgram(handle);
    throw new Error(`${label}: program failed to link\n${log}`);
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(handle, name);
  return { handle, uniforms };
}

export function makeBuffer(
  gl: WebGL2RenderingContext,
  target: number,
  data: ArrayBufferView | number,
  usage: number = gl.STATIC_DRAW
): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('could not create a buffer');
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data as ArrayBufferView, usage);
  return buffer;
}

/** Parses "#rgb", "#rrggbb" or "rgba(r, g, b, a)" / "rgb(r, g, b)" into 0–1 components. */
export function parseColor(css: string): [number, number, number, number] {
  const s = css.trim();
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, a];
  }
  const hsl = /^hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (hsl) {
    const h = (Number(hsl[1]) % 360) / 360;
    const sat = Number(hsl[2]) / 100;
    const l = Number(hsl[3]) / 100;
    const a = hsl[4] === undefined ? 1 : hsl[4].endsWith('%') ? parseFloat(hsl[4]) / 100 : parseFloat(hsl[4]);
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const f = (t: number) => {
      const x = (t + 1) % 1;
      return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3), a];
  }
  return [1, 0, 1, 1]; // magenta: an unmistakable "unparsed colour"
}

/** Loads an image from the first URL that works. Rejects when none does. */
export async function loadImageFirst(urls: string[], timeoutMs = 15000): Promise<HTMLImageElement> {
  let lastError: unknown = new Error('no image URLs');
  for (const url of urls) {
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const timer = setTimeout(() => {
          img.src = '';
          reject(new Error(`timeout loading ${url}`));
        }, timeoutMs);
        img.onload = () => {
          clearTimeout(timer);
          resolve(img);
        };
        img.onerror = () => {
          clearTimeout(timer);
          reject(new Error(`could not load ${url}`));
        };
        img.src = url;
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
