import assert from 'node:assert/strict';
import { GlobeCamera } from '../engine/camera';
import type { FrameContext, LayerHost } from '../engine/engine';
import { MarkerLayer, pointVisible } from '../engine/markers';
import { geoToVec } from '../engine/math';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const W = 1440;
const H = 900;

function cameraOver(lat: number, lng: number, altitude: number): GlobeCamera {
  const cam = new GlobeCamera();
  cam.setViewport(W, H);
  cam.setPov({ lat, lng, altitude });
  return cam;
}

// --- the camera's exact projection agrees with the matrices
{
  for (const alt of [3, 1, 0.3, 0.05]) {
    const cam = cameraOver(12, 34, alt);
    cam.rotateBy(cam.back, 0.4);
    for (const [lat, lng] of [[12, 34], [13, 36], [10, 30], [16, 33]] as const) {
      const p = geoToVec(lat, lng, 1.02);
      const a = cam.project(p);
      const b = cam.projectExact(p);
      close(b.x, a.x, 0.05 + alt * 0.01, `altitude ${alt}: x`);
      close(b.y, a.y, 0.05 + alt * 0.01, `altitude ${alt}: y`);
      close(b.depth, a.depth, 1e-4, `altitude ${alt}: depth`);
      close(b.w, a.w, 1e-6, `altitude ${alt}: w`);
    }
  }
  const cam = cameraOver(0, 0, 2);
  const behind = cam.projectExact([0, 0, 10]);
  assert.ok(Number.isNaN(behind.x) && behind.depth === 2, 'a point behind the camera is flagged');
}

// --- visibility: the segment from the eye must not cross the globe
{
  const eye: [number, number, number] = [0, 0, 3];
  assert.equal(pointVisible(eye, [0, 0, 1]), true, 'the point right under the camera');
  assert.equal(pointVisible(eye, [0, 0, -1]), false, 'the antipode');
  const surf = (deg: number, r = 1): [number, number, number] => [r * Math.sin(deg * (Math.PI / 180)), 0, r * Math.cos(deg * (Math.PI / 180))];
  const limb = (Math.acos(1 / 3) * 180) / Math.PI; // 70.5 degrees
  assert.equal(pointVisible(eye, surf(limb - 1)), true, 'just inside the limb');
  assert.equal(pointVisible(eye, surf(limb + 1)), false, 'just beyond the limb');
  // above the surface a point is seen from further round than a point on it
  assert.equal(pointVisible(eye, surf(limb + 1, 1.05)), true, 'a marker 5% above the surface still peeks over the limb');
  assert.equal(pointVisible(eye, surf(limb + 12, 1.05)), true, 'in the sky beyond the limb, a point 5% up is still in view');
  assert.equal(pointVisible(eye, surf(limb + 40, 1.05)), false, 'but well round the back it is hidden');
  // a case where the point is on the far side of the polar plane of the eye yet still seen
  assert.equal(pointVisible([0, 0, 2], [1.449, 0, 0.388]), true, 'radius 1.5 at 75 degrees from a camera at distance 2');
  assert.equal(pointVisible([0, 0, 2], [0.966, 0, 0.2588]), false, 'the same direction on the surface is hidden');
  assert.equal(pointVisible(eye, eye), true, 'a point at the eye');
}

// --- a minimal DOM, enough for the layer's bookkeeping
/** An element's style object where assigning cssText fills the properties, as in a browser. */
function fakeStyle(): Record<string, string> {
  const style: Record<string, string> = {};
  Object.defineProperty(style, 'cssText', {
    enumerable: false,
    set(text: string) {
      for (const decl of text.split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) style[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
      }
    },
  });
  return style;
}

class FakeEl {
  style: Record<string, string> = fakeStyle();
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  removed = false;
  ownerDocument = { createElement: (_: string) => new FakeEl() };
  constructor(public tag = 'div') {}
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
}
const overlay = new FakeEl();
let renders = 0;
const host: LayerHost = { requestRender: () => void renders++, overlay: overlay as unknown as HTMLElement };
const frame = (camera: GlobeCamera, pixelRatio = 1): FrameContext => ({ gl: null as any, camera, width: W, height: H, pixelRatio, now: 0 });

{
  const layer = new MarkerLayer();
  let built = 0;
  const mk = (id: string, lat: number, lng: number, altitude?: number) => ({ id, lat, lng, altitude, create: () => (built++, new FakeEl('span') as unknown as HTMLElement) });

  // markers given before the layer is attached wait for it
  layer.setMarkers([mk('a', 0, 0)]);
  assert.equal(layer.count, 0);
  layer.attach(host);
  assert.equal(layer.count, 1, 'created on attach');
  assert.equal(built, 1);
  assert.equal(overlay.children.length, 1);
  assert.ok(renders > 0, 'a frame was requested');

  layer.setMarkers([mk('a', 0, 0), mk('far', 0, 180), mk('side', 0, 20)]);
  assert.equal(built, 3, "'a' is not built again");
  assert.equal(overlay.children.length, 3);

  const cam = cameraOver(0, 0, 2);
  layer.draw(frame(cam));
  const wa = layer.elementOf('a') as unknown as FakeEl;
  assert.equal(layer.isHidden('a'), false);
  assert.equal(wa.style.visibility, 'visible');
  const expected = cam.projectExact(geoToVec(0, 0, 1.02));
  assert.equal(wa.style.transform, `translate(${Math.round(expected.x)}px, ${Math.round(expected.y)}px)`, 'at its projected position');
  assert.equal(layer.isHidden('far'), true, 'the far side of the globe hides its marker');
  assert.equal((layer.elementOf('far') as unknown as FakeEl).style.visibility, 'hidden');
  assert.equal(layer.isHidden('side'), false);

  // whole device pixels
  layer.draw(frame(cam, 2));
  const m = /translate\(([\d.]+)px, ([\d.]+)px\)/.exec(wa.style.transform)!;
  close(Number(m[1]) * 2, Math.round(Number(m[1]) * 2), 1e-9, 'x snaps to a device pixel');
  close(Number(m[2]) * 2, Math.round(Number(m[2]) * 2), 1e-9, 'y snaps to a device pixel');

  // the view turns: the marker that was behind comes round, the one in front goes away
  const turned = cameraOver(0, 180, 2);
  layer.draw(frame(turned));
  assert.equal(layer.isHidden('far'), false, 'now facing the camera');
  assert.equal(layer.isHidden('a'), true, 'and the other one is behind');
  const farPos = turned.projectExact(geoToVec(0, 180, 1.02));
  close(farPos.x, W / 2, 1e-6, 'centred');

  // same ids keep their elements when the list changes; others are removed
  const before = layer.elementOf('far');
  layer.setMarkers([mk('far', 0, 180), mk('new', 40, 40, 0.05)]);
  assert.equal(layer.elementOf('far'), before, 'the same wrapper');
  assert.equal(layer.count, 2);
  assert.equal(layer.elementOf('a'), null);
  assert.equal(wa.removed, true, 'removed from the page');
  assert.equal(overlay.children.length, 2);

  // a marker that moves (same id, new place) is repositioned
  layer.setMarkers([mk('far', 0, 170), mk('new', 40, 40, 0.05)]);
  layer.draw(frame(turned));
  const moved = turned.projectExact(geoToVec(0, 170, 1.02));
  assert.equal((layer.elementOf('far') as unknown as FakeEl).style.transform, `translate(${Math.round(moved.x)}px, ${Math.round(moved.y)}px)`);

  // nothing to do with no markers; dispose cleans up
  layer.dispose();
  assert.equal(layer.count, 0);
  assert.equal(overlay.children.length, 0);
  assert.doesNotThrow(() => layer.draw(frame(cam)));
}

console.log('engineMarkers tests: ok');
