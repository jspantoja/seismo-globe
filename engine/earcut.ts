/**
 * Polygon triangulation by ear clipping, with holes, for the globe's fills.
 *
 * The idea is the classic one: walk the ring, cut off every "ear" (a corner whose triangle
 * contains no other vertex), and for big polygons keep the vertices in a z-order (Morton) curve
 * so that "does any vertex lie inside this triangle" only looks at the few that are near it.
 * Holes are joined to the outline by a zero-width bridge, which turns the polygon with holes
 * into a single ring. When a polygon is not simple (rings that touch, slivers) the clipper
 * falls back to fixing local self-intersections and then to splitting the ring in two.
 *
 * Input: flat coordinates [x0, y0, x1, y1, ...] and the vertex index at which each hole starts.
 * Output: triangles as triples of vertex indices (of the input order).
 */

class Node {
  i: number;
  x: number;
  y: number;
  prev!: Node;
  next!: Node;
  z = 0;
  prevZ: Node | null = null;
  nextZ: Node | null = null;
  steiner = false;
  constructor(i: number, x: number, y: number) {
    this.i = i;
    this.x = x;
    this.y = y;
  }
}

export function triangulate(data: ArrayLike<number>, holeIndices: number[] = []): number[] {
  const hasHoles = holeIndices.length > 0;
  const outerLen = hasHoles ? holeIndices[0] * 2 : data.length;
  let outer = linkedList(data, 0, outerLen, true);
  const triangles: number[] = [];
  if (!outer || outer.next === outer.prev) return triangles;

  let minX = 0;
  let minY = 0;
  let invSize = 0;
  if (hasHoles) outer = eliminateHoles(data, holeIndices, outer);

  // Many vertices: index them along a z-order curve (see isEarHashed).
  if (data.length > 80 * 2) {
    minX = Infinity;
    minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < outerLen; i += 2) {
      const x = data[i];
      const y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const size = Math.max(maxX - minX, maxY - minY);
    invSize = size !== 0 ? 32767 / size : 0;
  }

  earcutLinked(outer, triangles, minX, minY, invSize, 0);
  return triangles;
}

/** Twice the signed area of a flat ring; positive when it runs clockwise in a y-up plane. */
function signedArea(data: ArrayLike<number>, start: number, end: number): number {
  let sum = 0;
  for (let i = start, j = end - 2; i < end; i += 2) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}

/** A circular doubly linked list of the ring, in the requested winding. */
function linkedList(data: ArrayLike<number>, start: number, end: number, clockwise: boolean): Node | undefined {
  let last: Node | undefined;
  if (clockwise === signedArea(data, start, end) > 0) {
    for (let i = start; i < end; i += 2) last = insertNode(i / 2, data[i], data[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertNode(i / 2, data[i], data[i + 1], last);
  }
  if (last && equals(last, last.next)) {
    removeNode(last);
    last = last.next;
  }
  return last;
}

/** Removes repeated points and points in the middle of a straight run. */
function filterPoints(start: Node | undefined, end?: Node): Node | undefined {
  if (!start) return start;
  if (!end) end = start;
  let p = start;
  let again: boolean;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);
  return end;
}

function earcutLinked(ear: Node | undefined, triangles: number[], minX: number, minY: number, invSize: number, pass: number): void {
  if (!ear) return;
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);

  let stop = ear;
  while (ear!.prev !== ear!.next) {
    const prev: Node = ear!.prev;
    const next: Node = ear!.next;
    if (invSize ? isEarHashed(ear!, minX, minY, invSize) : isEar(ear!)) {
      triangles.push(prev.i, ear!.i, next.i);
      removeNode(ear!);
      // Skipping the next vertex leads to fewer sliver triangles.
      ear = next.next;
      stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      // No ears left: try again after cleaning, then cure small self-intersections, then split.
      if (!pass) {
        earcutLinked(filterPoints(ear), triangles, minX, minY, invSize, 1);
      } else if (pass === 1) {
        const cured = cureLocalIntersections(filterPoints(ear)!, triangles);
        earcutLinked(cured, triangles, minX, minY, invSize, 2);
      } else if (pass === 2) {
        splitEarcut(ear, triangles, minX, minY, invSize);
      }
      break;
    }
  }
}

function isEar(ear: Node): boolean {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  if (area(a, b, c) >= 0) return false; // a reflex corner cannot be an ear

  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx;
  const y0 = ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy;
  const x1 = ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx;
  const y1 = ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy;

  let p = c.next;
  while (p !== a) {
    if (
      p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 &&
      pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.x, p.y) &&
      area(p.prev, p, p.next) >= 0
    ) {
      return false;
    }
    p = p.next;
  }
  return true;
}

function isEarHashed(ear: Node, minX: number, minY: number, invSize: number): boolean {
  const a = ear.prev;
  const b = ear;
  const c = ear.next;
  if (area(a, b, c) >= 0) return false;

  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx;
  const y0 = ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy;
  const x1 = ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx;
  const y1 = ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy;

  const minZ = zOrder(x0, y0, minX, minY, invSize);
  const maxZ = zOrder(x1, y1, minX, minY, invSize);

  let p = ear.prevZ;
  let n = ear.nextZ;

  // Look in both directions along the curve, within the triangle's z-range.
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (
      p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
      pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0
    ) {
      return false;
    }
    p = p.prevZ;
    if (
      n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
      pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0
    ) {
      return false;
    }
    n = n.nextZ;
  }
  while (p && p.z >= minZ) {
    if (
      p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
      pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0
    ) {
      return false;
    }
    p = p.prevZ;
  }
  while (n && n.z <= maxZ) {
    if (
      n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
      pointInTriangleExceptFirst(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0
    ) {
      return false;
    }
    n = n.nextZ;
  }
  return true;
}

/** Fixes small self-intersections: two edges that cross are replaced by one triangle. */
function cureLocalIntersections(start: Node, triangles: number[]): Node | undefined {
  let p = start;
  do {
    const a = p.prev;
    const b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      removeNode(p);
      removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

/** Last resort: cut the ring in two along a valid diagonal and triangulate each half. */
function splitEarcut(start: Node, triangles: number[], minX: number, minY: number, invSize: number): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next)!;
        c = filterPoints(c, c.next)!;
        earcutLinked(a, triangles, minX, minY, invSize, 0);
        earcutLinked(c, triangles, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

/** Joins every hole to the outline (leftmost hole first), producing one ring. */
function eliminateHoles(data: ArrayLike<number>, holeIndices: number[], outerNode: Node): Node {
  const queue: Node[] = [];
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i] * 2;
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * 2 : data.length;
    const list = linkedList(data, start, end, false);
    if (!list) continue;
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort(compareXYSlope);
  for (const hole of queue) outerNode = eliminateHole(hole, outerNode);
  return outerNode;
}

function compareXYSlope(a: Node, b: Node): number {
  let result = a.x - b.x;
  if (result === 0) {
    result = a.y - b.y;
    if (result === 0) {
      const aSlope = (a.next.y - a.y) / (a.next.x - a.x);
      const bSlope = (b.next.y - b.y) / (b.next.x - b.x);
      result = aSlope - bSlope;
    }
  }
  return result;
}

function eliminateHole(hole: Node, outerNode: Node): Node {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  // Drop any collinear points the bridge created.
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next) as Node;
}

/** The outline vertex a hole should be joined to: the one visible from the hole's leftmost point. */
function findHoleBridge(hole: Node, outerNode: Node): Node | null {
  let p = outerNode;
  const hx = hole.x;
  const hy = hole.y;
  let qx = -Infinity;
  let m: Node | null = null;

  // Cast a ray to the left from the hole's point: the nearest outline edge it meets.
  if (equals(hole, p)) return p;
  do {
    if (equals(hole, p.next)) return p.next;
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m; // the hole touches the outline
      }
    }
    p = p.next;
  } while (p !== outerNode);

  if (!m) return null;

  // Among the vertices inside the triangle (hole point, ray hit, m), take the one with the
  // smallest angle to the ray: that one is visible from the hole.
  const stop = m;
  const mx = m.x;
  const my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (
      hx >= p.x && p.x >= mx && hx !== p.x &&
      pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)
    ) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (
        locallyInside(p, hole) &&
        (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))
      ) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function sectorContainsSector(m: Node, p: Node): boolean {
  return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

// ---------------------------------------------------------------------------
// z-order curve
// ---------------------------------------------------------------------------

function indexCurve(start: Node, minX: number, minY: number, invSize: number): void {
  let p = start;
  do {
    if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize);
    p.prevZ = p.prev;
    p.nextZ = p.next;
    p = p.next;
  } while (p !== start);
  p.prevZ!.nextZ = null;
  p.prevZ = null;
  sortLinked(p);
}

/** Merge sort of the z-order linked list (Simon Tatham's algorithm for linked lists). */
function sortLinked(list: Node): Node {
  let numMerges: number;
  let inSize = 1;
  let tail: Node | null;
  do {
    let p: Node | null = list;
    let head: Node | null = null;
    tail = null;
    numMerges = 0;
    while (p) {
      numMerges++;
      let q: Node | null = p;
      let pSize = 0;
      for (let i = 0; i < inSize; i++) {
        pSize++;
        q = q!.nextZ;
        if (!q) break;
      }
      let qSize = inSize;
      while (pSize > 0 || (qSize > 0 && q)) {
        let e: Node;
        if (pSize !== 0 && (qSize === 0 || !q || p!.z <= q.z)) {
          e = p!;
          p = p!.nextZ;
          pSize--;
        } else {
          e = q!;
          q = q!.nextZ;
          qSize--;
        }
        if (tail) tail.nextZ = e;
        else head = e;
        e.prevZ = tail;
        tail = e;
      }
      p = q;
    }
    tail!.nextZ = null;
    list = head!;
    inSize *= 2;
  } while (numMerges > 1);
  return list;
}

function zOrder(x0: number, y0: number, minX: number, minY: number, invSize: number): number {
  let x = ((x0 - minX) * invSize) | 0;
  let y = ((y0 - minY) * invSize) | 0;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  y = (y | (y << 8)) & 0x00ff00ff;
  y = (y | (y << 4)) & 0x0f0f0f0f;
  y = (y | (y << 2)) & 0x33333333;
  y = (y | (y << 1)) & 0x55555555;
  return x | (y << 1);
}

function getLeftmost(start: Node): Node {
  let p = start;
  let leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);
  return leftmost;
}

// ---------------------------------------------------------------------------
// geometry predicates
// ---------------------------------------------------------------------------

function pointInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return (
    (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
    (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
    (bx - px) * (cy - py) >= (cx - px) * (by - py)
  );
}

function pointInTriangleExceptFirst(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return !(ax === px && ay === py) && pointInTriangle(ax, ay, bx, by, cx, cy, px, py);
}

/** Can a and b be joined by a diagonal that stays inside the polygon? */
function isValidDiagonal(a: Node, b: Node): boolean {
  return (
    (a.next.i !== b.i &&
      a.prev.i !== b.i &&
      !intersectsPolygon(a, b) &&
      ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
        (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))) // zero-length diagonal
  );
}

/** Twice the signed area of the triangle p, q, r (negative: p→q→r turns clockwise in the earcut convention). */
function area(p: Node, q: Node, r: Node): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function equals(p1: Node, p2: Node): boolean {
  return p1.x === p2.x && p1.y === p2.y;
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = sign(area(p1, q1, p2));
  const o2 = sign(area(p1, q1, q2));
  const o3 = sign(area(p2, q2, p1));
  const o4 = sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function onSegment(p: Node, q: Node, r: Node): boolean {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

function middleInside(a: Node, b: Node): boolean {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) / 2;
  const py = (a.y + b.y) / 2;
  do {
    if (p.y > py !== p.next.y > py && p.next.y !== p.y && px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x) {
      inside = !inside;
    }
    p = p.next;
  } while (p !== a);
  return inside;
}

/** Splits the ring in two by linking a and b; returns the new node that starts the second ring. */
function splitPolygon(a: Node, b: Node): Node {
  const a2 = new Node(a.i, a.x, a.y);
  const b2 = new Node(b.i, b.x, b.y);
  const an = a.next;
  const bp = b.prev;
  a.next = b;
  b.prev = a;
  a2.next = an;
  an.prev = a2;
  b2.next = a2;
  a2.prev = b2;
  bp.next = b2;
  b2.prev = bp;
  return b2;
}

function insertNode(i: number, x: number, y: number, last: Node | undefined): Node {
  const p = new Node(i, x, y);
  if (!last) {
    p.prev = p;
    p.next = p;
  } else {
    p.next = last.next;
    p.prev = last;
    last.next.prev = p;
    last.next = p;
  }
  return p;
}

function removeNode(p: Node): void {
  p.next.prev = p.prev;
  p.prev.next = p.next;
  if (p.prevZ) p.prevZ.nextZ = p.nextZ;
  if (p.nextZ) p.nextZ.prevZ = p.prevZ;
}

// ---------------------------------------------------------------------------
// checking a triangulation
// ---------------------------------------------------------------------------

/** Absolute area of a polygon (outline minus holes), for comparing against a triangulation. */
export function polygonArea(data: ArrayLike<number>, holeIndices: number[] = []): number {
  const hasHoles = holeIndices.length > 0;
  const outerLen = hasHoles ? holeIndices[0] * 2 : data.length;
  let total = Math.abs(signedArea(data, 0, outerLen)) / 2;
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i] * 2;
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * 2 : data.length;
    total -= Math.abs(signedArea(data, start, end)) / 2;
  }
  return total;
}

/** Total area of a triangle list. */
export function trianglesArea(data: ArrayLike<number>, triangles: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i] * 2;
    const b = triangles[i + 1] * 2;
    const c = triangles[i + 2] * 2;
    total += Math.abs((data[a] - data[c]) * (data[b + 1] - data[a + 1]) - (data[a] - data[b]) * (data[c + 1] - data[a + 1]));
  }
  return total / 2;
}
