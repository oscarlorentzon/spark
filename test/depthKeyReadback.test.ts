import assert from "node:assert/strict";
import test from "node:test";
import {
  type DepthKeyLayer,
  DepthKeyReadback,
  type PackReadGL,
  getDepthKeyLayers,
} from "../src/DepthKeyReadback.js";
import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "../src/defines.js";
import { GL_CONSTANTS } from "./glConstants.js";

function fakeGl() {
  const calls: string[] = [];
  const waits: number[][] = [];
  const reads: Uint8Array[] = [];
  const live = new Set<object>();
  let packBound: object | null = null;
  let signalled = false;
  let failed = false;
  let fenced = true;

  const gl = {
    ...GL_CONSTANTS,
    calls,
    waits,
    reads,
    live,
    get packBound() {
      return packBound;
    },
    signal: () => {
      signalled = true;
    },
    fail: () => {
      failed = true;
    },
    withoutFences: () => {
      fenced = false;
    },
    createBuffer() {
      const buffer = {};
      live.add(buffer);
      calls.push("createBuffer");
      return buffer;
    },
    deleteBuffer(buffer: object) {
      live.delete(buffer);
    },
    bindBuffer(target: number, buffer: object | null) {
      if (target === GL_CONSTANTS.PIXEL_PACK_BUFFER) {
        packBound = buffer;
      }
    },
    bufferData: () => calls.push("bufferData"),
    readBuffer: () => {},
    readPixels: () => calls.push("readPixels"),
    fenceSync() {
      if (!fenced) {
        return null;
      }
      const sync = {};
      live.add(sync);
      calls.push("fenceSync");
      return sync;
    },
    deleteSync(sync: object) {
      live.delete(sync);
      calls.push("deleteSync");
    },
    flush: () => calls.push("flush"),
    clientWaitSync(_sync: object, flags: number, timeout: number) {
      waits.push([flags, timeout]);
      if (failed) {
        return GL_CONSTANTS.WAIT_FAILED;
      }
      return signalled
        ? GL_CONSTANTS.ALREADY_SIGNALED
        : GL_CONSTANTS.TIMEOUT_EXPIRED;
    },
    getBufferSubData(_target: number, _offset: number, into: Uint8Array) {
      reads.push(into);
      calls.push("getBufferSubData");
    },
  };
  return gl satisfies PackReadGL & Record<string, unknown>;
}

const SPLATS_PER_LAYER = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
// Fewer rows than a layer holds, so the second layer is only partly filled.
const PARTIAL_ROWS = 100;
const TWO_LAYERS: DepthKeyLayer[] = [
  { layer: 0, rows: SPLAT_TEX_HEIGHT, byteOffset: 0 },
  {
    layer: 1,
    rows: PARTIAL_ROWS,
    byteOffset: SPLATS_PER_LAYER * Uint32Array.BYTES_PER_ELEMENT,
  },
];
const bytesOf = (layer: DepthKeyLayer) =>
  SPLAT_TEX_WIDTH * layer.rows * Uint32Array.BYTES_PER_ELEMENT;

const issue = (
  readback: DepthKeyReadback,
  layers = TWO_LAYERS,
  bindLayer: (layer: number) => void = () => {},
) =>
  readback.issue({
    layers,
    attachment: 2,
    bindLayer,
  });

const destinationFor = (layers: DepthKeyLayer[]) => {
  const last = layers[layers.length - 1];
  return new Uint8Array(last.byteOffset + bytesOf(last));
};

test("issue fences every layer once and leaves nothing bound", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  const bound: number[] = [];

  assert.equal(
    issue(readback, TWO_LAYERS, (l) => bound.push(l)),
    true,
  );

  assert.equal(readback.isPending(), true);
  assert.deepEqual(bound, [0, 1], "binds each layer's framebuffer");
  assert.equal(gl.calls.filter((c) => c === "readPixels").length, 2);
  assert.equal(gl.calls.filter((c) => c === "fenceSync").length, 1);
  assert.equal(gl.packBound, null, "pack buffer unbound");
  assert.ok(
    gl.calls.indexOf("fenceSync") < gl.calls.indexOf("flush"),
    "flushes after fencing, or the fence may never be submitted",
  );
});

test("nothing is read back until the fence signals", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  issue(readback);

  assert.equal(readback.poll(), "pending");
  assert.equal(readback.poll(), "pending");
  assert.ok(!gl.calls.includes("getBufferSubData"), "no read while in flight");
  assert.deepEqual(
    gl.waits[0],
    [0, 0],
    "polls without flags and without waiting",
  );

  gl.signal();
  assert.equal(readback.poll(), "ready");
});

test("copyInto takes each layer at its own offset, then releases", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  issue(readback);
  gl.signal();
  readback.poll();

  readback.copyInto(destinationFor(TWO_LAYERS));

  assert.deepEqual(
    gl.reads.map((r) => [r.byteOffset, r.byteLength]),
    TWO_LAYERS.map((l) => [l.byteOffset, bytesOf(l)]),
  );
  assert.equal(gl.packBound, null, "pack buffer unbound");
  assert.equal(readback.isPending(), false);
  assert.equal(readback.poll(), "idle");
});

test("pack buffers are reused, and respecified before each read", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  const layers = [TWO_LAYERS[0]];
  const destination = destinationFor(layers);

  for (let i = 0; i < 3; i++) {
    issue(readback, layers);
    gl.signal();
    readback.poll();
    readback.copyInto(destination);
  }

  assert.equal(gl.calls.filter((c) => c === "createBuffer").length, 1);
  // Respecifying orphans the previous contents and sizes the buffer to this
  // read, which is what keeps the driver's readback shadow copy valid.
  assert.equal(gl.calls.filter((c) => c === "bufferData").length, 3);
});

test("a failed fence releases the read so another may be issued", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  issue(readback);

  gl.fail();
  assert.equal(readback.poll(), "failed");
  assert.equal(readback.isPending(), false);
  assert.ok(gl.calls.includes("deleteSync"));
  assert.doesNotThrow(() => issue(readback));
});

test("a context that gives no fence leaves nothing pending", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  gl.withoutFences();

  assert.equal(issue(readback), false);
  assert.equal(readback.isPending(), false);
  assert.equal(readback.poll(), "idle");
});

test("issuing twice without taking the keys is a programming error", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  issue(readback);

  assert.throws(() => issue(readback), /already in flight/);
});

test("no layers means nothing is fenced", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);

  assert.equal(issue(readback, []), false);
  assert.equal(readback.isPending(), false);
  assert.ok(!gl.calls.includes("fenceSync"));
});

test("dispose drops the pack buffers and any fence held", () => {
  const gl = fakeGl();
  const readback = new DepthKeyReadback(gl);
  issue(readback);
  assert.equal(gl.live.size, 3, "two pack buffers and a fence");

  readback.dispose();

  assert.equal(gl.live.size, 0);
  assert.equal(readback.isPending(), false);
});

test("getDepthKeyLayers splits a read on layer boundaries", () => {
  const full = { layer: 0, rows: SPLAT_TEX_HEIGHT, byteOffset: 0 };

  assert.deepEqual(getDepthKeyLayers(0), []);
  assert.deepEqual(getDepthKeyLayers(1), [{ ...full, rows: 1 }]);
  assert.deepEqual(getDepthKeyLayers(SPLATS_PER_LAYER), [full]);
  assert.deepEqual(getDepthKeyLayers(SPLATS_PER_LAYER + 1), [
    full,
    {
      layer: 1,
      rows: 1,
      byteOffset: SPLATS_PER_LAYER * Uint32Array.BYTES_PER_ELEMENT,
    },
  ]);
});
