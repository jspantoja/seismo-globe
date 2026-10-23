import { GlobeCamera, type Pov } from './camera';
import { GlobeControls, type ControlEvents } from './controls';
import { loadImageFirst, makeBuffer, makeProgram, parseColor, type Program } from './glcore';
import { GLOBE_FRAG, GLOBE_VERT } from './shaders';

/**
 * The globe engine: a WebGL2 canvas, a camera, input, and a stack of layers drawn over the planet.
 *
 * Fluidity rules it follows:
 *   - it draws only when something changed (camera moved, layer animating, data changed) — an idle
 *     globe costs nothing;
 *   - while only layers animate (pulsing rings) it caps itself at 30 frames per second;
 *   - the resolution follows the device pixel ratio, capped, and can be scaled down;
 *   - if the browser takes the GPU away (context lost) it rebuilds everything when it comes back.
 */

export class EngineUnsupportedError extends Error {
  constructor(message = 'WebGL2 is not available') {
    super(message);
    this.name = 'EngineUnsupportedError';
  }
}

export interface FrameContext {
  gl: WebGL2RenderingContext;
  camera: GlobeCamera;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Drawing-buffer pixels per CSS pixel. */
  pixelRatio: number;
  /** performance.now() of this frame. */
  now: number;
}

/** What a layer can ask of the engine that holds it. */
export interface LayerHost {
  /** Draw a new frame (many requests in the same tick draw once). */
  requestRender(): void;
}

export interface EngineLayer {
  /** Called when the layer is added: keep `host` to ask for a frame when the layer's data changes. */
  attach?(host: LayerHost): void;
  /**
   * Called once the GL context exists and again, with the new context, after a lost one comes back:
   * (re)build GPU resources here from data kept on the CPU. Handles from before the loss are dead:
   * overwrite them, do not delete them.
   */
  init(gl: WebGL2RenderingContext): void;
  draw(frame: FrameContext): void;
  /** True while the layer needs a new frame every tick (an animation). */
  animating?(): boolean;
  dispose(gl: WebGL2RenderingContext): void;
}

export interface EngineOptions {
  /** Equirectangular earth texture: the first URL that loads wins. */
  textureUrls?: string[];
  atmosphereColor?: string;
  /** Height of the atmosphere in globe radii. */
  atmosphereAltitude?: number;
  maxPixelRatio?: number;
  /** Wrap the draw calls so the engine can count them (for measuring). */
  countDrawCalls?: boolean;
  onPov?: (pov: Pov) => void;
  onTextureError?: (err: unknown) => void;
}

export interface EngineStats {
  frames: number;
  /** Draw calls issued by the last frame (only when countDrawCalls is on). */
  drawCalls: number;
  /** Smoothed JS time spent in render(), in milliseconds. */
  cpuMs: number;
  /** Frames per second over the last second of continuous drawing. */
  fps: number;
  contextLosses: number;
}

const LAYER_ONLY_INTERVAL_MS = 33;
const PLACEHOLDER_RGB: [number, number, number] = [10, 18, 34];

export class GlobeEngine {
  readonly canvas: HTMLCanvasElement;
  readonly camera = new GlobeCamera();
  readonly controls: GlobeControls;
  readonly stats: EngineStats = { frames: 0, drawCalls: 0, cpuMs: 0, fps: 0, contextLosses: 0 };

  onPov?: (pov: Pov) => void;

  private gl!: WebGL2RenderingContext;
  private program!: Program;
  private quad: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private texture: WebGLTexture | null = null;
  private earthImage: HTMLImageElement | null = null;
  private layers: EngineLayer[] = [];

  private raf = 0;
  private dirty = true;
  private lost = false;
  private destroyed = false;
  private lastRender = 0;
  private lastPov: Pov | null = null;
  private fpsWindowStart = 0;
  private fpsWindowFrames = 0;
  private continuous = false;

  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;
  private readonly maxPixelRatio: number;
  private renderScale = 1;
  private resizeObserver: ResizeObserver | null = null;
  private hoverCursor: string | null = null;
  private dragging = false;
  private drawCalls = 0;
  private readonly atmColor: [number, number, number];
  private readonly atmHeight: number;
  private readonly options: EngineOptions;

  constructor(private readonly container: HTMLElement, options: EngineOptions = {}) {
    this.options = options;
    this.onPov = options.onPov;
    this.maxPixelRatio = options.maxPixelRatio ?? 2;
    const c = parseColor(options.atmosphereColor ?? '#4fd1c5');
    this.atmColor = [c[0], c[1], c[2]];
    this.atmHeight = options.atmosphereAltitude ?? 0.15;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-engine', 'globe');
    canvas.setAttribute('role', 'img');
    canvas.style.cssText = 'display:block;width:100%;height:100%;outline-offset:-2px;';
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new EngineUnsupportedError();
    this.canvas = canvas;
    this.gl = gl;
    if (options.countDrawCalls) this.countDraws(gl);

    container.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.controls = new GlobeControls(canvas, this.camera, () => this.requestRender(), {
      dragging: (active) => {
        this.dragging = active;
        this.updateCursor();
      },
    });
    this.updateCursor();

    this.initGL();
    this.measure();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.measure();
        this.requestRender();
      });
      this.resizeObserver.observe(container);
    }
    this.loadTexture();
    this.requestRender();
  }

  // ------------------------------------------------------------------ public API

  /** Replaces the handlers for taps, hover and so on. */
  setEvents(events: ControlEvents): void {
    this.controls.events = events;
  }

  addLayer(layer: EngineLayer): void {
    this.layers.push(layer);
    layer.attach?.({ requestRender: () => this.requestRender() });
    if (!this.lost) layer.init(this.gl);
    this.requestRender();
  }

  removeLayer(layer: EngineLayer): void {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (!this.lost) layer.dispose(this.gl);
    this.requestRender();
  }

  /** Asks for a frame. Many calls in the same tick draw once. */
  requestRender(): void {
    this.dirty = true;
    if (this.raf || this.destroyed || this.lost) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  flyTo(pov: Pov, durationMs: number): void {
    this.camera.flyTo(pov, durationMs, performance.now());
    this.requestRender();
  }

  setCursor(cursor: string | null): void {
    this.hoverCursor = cursor;
    this.updateCursor();
  }

  /** Scales the drawing-buffer resolution relative to the device (1 = native, capped by maxPixelRatio). */
  setRenderScale(scale: number): void {
    const s = Math.min(1, Math.max(0.4, scale));
    if (s === this.renderScale) return;
    this.renderScale = s;
    this.measure();
    this.requestRender();
  }

  get size(): { width: number; height: number; pixelRatio: number } {
    return { width: this.cssWidth, height: this.cssHeight, pixelRatio: this.pixelRatio };
  }

  get glContext(): WebGL2RenderingContext {
    return this.gl;
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** Draws immediately (tests and screenshots need the frame now, not on the next tick). */
  renderNow(): void {
    if (this.lost || this.destroyed) return;
    this.render(performance.now());
  }

  /** Draws now and reads one pixel of the drawing buffer, in CSS pixels from the top-left. RGBA, 0-255, not premultiplied. */
  readPixel(x: number, y: number): [number, number, number, number] {
    this.renderNow();
    const gl = this.gl;
    const px = Math.min(this.canvas.width - 1, Math.max(0, Math.round(x * (this.canvas.width / this.cssWidth))));
    const py = Math.min(this.canvas.height - 1, Math.max(0, Math.round((this.cssHeight - y) * (this.canvas.height / this.cssHeight))));
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0], out[1], out[2], out[3]];
  }

  /** Test hook: makes the browser drop the GL context, and gives it back after `restoreAfterMs`. */
  debugLoseContext(restoreAfterMs = 50): void {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (!ext) return;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), restoreAfterMs);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (!this.lost) {
      for (const layer of this.layers) layer.dispose(this.gl);
      this.releaseGL();
    }
    this.layers = [];
    // Hand the GPU context back now: browsers allow only a handful of live contexts per page.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }

  // ------------------------------------------------------------------ GL resources

  private initGL(): void {
    const gl = this.gl;
    this.program = makeProgram(gl, 'globe', GLOBE_VERT, GLOBE_FRAG, [
      'u_extent',
      'u_right',
      'u_up',
      'u_back',
      'u_alt',
      'u_tan',
      'u_viewProj',
      'u_tex',
      'u_atmColor',
      'u_atmH',
    ]);
    this.quad = makeBuffer(gl, gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.uploadTexture();
  }

  private releaseGL(): void {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.quad) gl.deleteBuffer(this.quad);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program.handle);
    this.texture = null;
    this.quad = null;
    this.vao = null;
  }

  private uploadTexture(): void {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.earthImage) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, this.earthImage);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
      }
    } else {
      const px = new Uint8Array([PLACEHOLDER_RGB[0], PLACEHOLDER_RGB[1], PLACEHOLDER_RGB[2], 255]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = tex;
  }

  private loadTexture(): void {
    const urls = this.options.textureUrls;
    if (!urls || urls.length === 0) return;
    loadImageFirst(urls)
      .then((img) => {
        if (this.destroyed) return;
        this.earthImage = img;
        if (!this.lost) {
          this.uploadTexture();
          this.requestRender();
        }
      })
      .catch((err) => this.options.onTextureError?.(err));
  }

  private countDraws(gl: WebGL2RenderingContext): void {
    const wrap = <K extends 'drawArrays' | 'drawElements' | 'drawArraysInstanced' | 'drawElementsInstanced'>(name: K) => {
      const original = gl[name].bind(gl) as (...args: unknown[]) => void;
      (gl as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        this.drawCalls++;
        original(...args);
      };
    };
    wrap('drawArrays');
    wrap('drawElements');
    wrap('drawArraysInstanced');
    wrap('drawElementsInstanced');
  }

  // ------------------------------------------------------------------ context loss

  private onContextLost = (ev: Event): void => {
    ev.preventDefault(); // we want it back
    this.lost = true;
    this.stats.contextLosses++;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    // Every GPU object died with the context: forget the handles (deleting them now would be an error).
    this.texture = null;
    this.quad = null;
    this.vao = null;
  };

  private onContextRestored = (): void => {
    if (this.destroyed) return;
    this.lost = false;
    this.initGL();
    for (const layer of this.layers) layer.init(this.gl);
    this.requestRender();
  };

  // ------------------------------------------------------------------ size

  private measure(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(this.maxPixelRatio, window.devicePixelRatio || 1) * this.renderScale;
    this.cssWidth = w;
    this.cssHeight = h;
    this.pixelRatio = dpr;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.camera.setViewport(w, h);
  }

  private updateCursor(): void {
    this.canvas.style.cursor = this.dragging ? 'grabbing' : this.hoverCursor ?? 'grab';
  }

  // ------------------------------------------------------------------ loop

  private layersAnimating(): boolean {
    for (const layer of this.layers) if (layer.animating?.()) return true;
    return false;
  }

  private frame = (): void => {
    this.raf = 0;
    if (this.destroyed || this.lost) return;
    const now = performance.now();
    const moved = this.camera.update(now);
    const layerAnim = this.layersAnimating();
    const cameraAnim = this.camera.animating;
    const mustDraw = this.dirty || moved;

    if (mustDraw || (layerAnim && now - this.lastRender >= LAYER_ONLY_INTERVAL_MS)) {
      this.dirty = false;
      this.render(now);
    }

    this.trackFps(now, mustDraw || layerAnim || cameraAnim);

    if (cameraAnim || layerAnim || this.dirty) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  private trackFps(now: number, active: boolean): void {
    if (!active) {
      this.continuous = false;
      return;
    }
    if (!this.continuous) {
      this.continuous = true;
      this.fpsWindowStart = now;
      this.fpsWindowFrames = 0;
    }
    this.fpsWindowFrames++;
    const span = now - this.fpsWindowStart;
    if (span >= 1000) {
      this.stats.fps = (this.fpsWindowFrames * 1000) / span;
      this.fpsWindowStart = now;
      this.fpsWindowFrames = 0;
    }
  }

  private emitPov(): void {
    if (!this.onPov) return;
    const pov = this.camera.pov();
    const last = this.lastPov;
    if (last && Math.abs(last.lat - pov.lat) < 1e-9 && Math.abs(last.lng - pov.lng) < 1e-9 && Math.abs(last.altitude - pov.altitude) < 1e-9) return;
    this.lastPov = pov;
    this.onPov(pov);
  }

  // ------------------------------------------------------------------ drawing

  private render(now: number): void {
    const t0 = performance.now();
    const gl = this.gl;
    const cam = this.camera;
    this.drawCalls = 0;
    this.lastRender = now;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.drawGlobe();

    const frame: FrameContext = { gl, camera: cam, width: this.cssWidth, height: this.cssHeight, pixelRatio: this.pixelRatio, now };
    for (const layer of this.layers) layer.draw(frame);

    this.stats.frames++;
    this.stats.drawCalls = this.drawCalls;
    const cost = performance.now() - t0;
    this.stats.cpuMs = this.stats.frames === 1 ? cost : this.stats.cpuMs * 0.9 + cost * 0.1;
    this.emitPov();
  }

  private drawGlobe(): void {
    const gl = this.gl;
    const cam = this.camera;
    const prog = this.program;
    const u = prog.uniforms;
    const tanHalf = Math.tan(cam.fovY / 2);

    // Bounding quad of the planet plus its atmosphere, in normalised device coordinates.
    const reach = 1 + this.atmHeight;
    let ex = 1;
    let ey = 1;
    if (cam.distance > reach * 1.0001) {
      const tanAngle = Math.tan(Math.asin(reach / cam.distance));
      ex = Math.min(1, (tanAngle / (tanHalf * cam.aspect)) * 1.04 + 0.01);
      ey = Math.min(1, (tanAngle / tanHalf) * 1.04 + 0.01);
    }

    gl.useProgram(prog.handle);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform2f(u.u_extent, ex, ey);
    gl.uniform3f(u.u_right, cam.right[0], cam.right[1], cam.right[2]);
    gl.uniform3f(u.u_up, cam.up[0], cam.up[1], cam.up[2]);
    gl.uniform3f(u.u_back, cam.back[0], cam.back[1], cam.back[2]);
    gl.uniform1f(u.u_alt, cam.altitude);
    gl.uniform2f(u.u_tan, tanHalf * cam.aspect, tanHalf);
    gl.uniformMatrix4fv(u.u_viewProj, false, cam.viewProjection());
    gl.uniform3f(u.u_atmColor, this.atmColor[0], this.atmColor[1], this.atmColor[2]);
    gl.uniform1f(u.u_atmH, this.atmHeight);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
