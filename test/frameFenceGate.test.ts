import assert from "node:assert/strict";
import test from "node:test";
import { FrameFenceGate, type SyncGL } from "../src/FrameFenceGate.js";
import { GL_CONSTANTS } from "./glConstants.js";

function fakeGl() {
  const live = new Set<object>();
  const signalled = new Set<object>();
  let failed = false;

  const gl = {
    ...GL_CONSTANTS,
    live,
    signal: (sync: object) => signalled.add(sync),
    signalAll: () => {
      for (const sync of live) {
        signalled.add(sync);
      }
    },
    fail: () => {
      failed = true;
    },
    fenceSync() {
      const sync = {};
      live.add(sync);
      return sync;
    },
    deleteSync(sync: object) {
      live.delete(sync);
    },
    clientWaitSync(sync: object) {
      if (failed) {
        return GL_CONSTANTS.WAIT_FAILED;
      }
      return signalled.has(sync)
        ? GL_CONSTANTS.ALREADY_SIGNALED
        : GL_CONSTANTS.TIMEOUT_EXPIRED;
    },
  };
  return gl satisfies SyncGL & Record<string, unknown>;
}

// Mirrors MAX_FRAMES_IN_FLIGHT in src/SparkRenderer.ts, which is private to
// that module.
const CAP = 2;
// Both arbitrary: a hard bound above any cap used here, and a frame count far
// past every bound in the file.
const HARD_BOUND = 4;
const MANY_FRAMES = 50;

/** One loop iteration: ask, and if allowed, render and fence. */
function frame(gate: FrameFenceGate, id: number): boolean {
  const issue = gate.canIssueFrame();
  if (issue) {
    gate.noteFrameEnd(id);
  }
  return issue;
}

test("issues up to the cap, then waits", () => {
  const gate = new FrameFenceGate(fakeGl(), { maxFramesInFlight: CAP });

  assert.equal(frame(gate, 1), true);
  assert.equal(frame(gate, 2), true);
  assert.equal(gate.getFramesInFlight(), CAP);
  assert.equal(frame(gate, 3), false);
  assert.equal(frame(gate, 4), false);
  assert.equal(gate.getFramesInFlight(), CAP, "a skipped frame takes no fence");
});

test("a completed frame frees exactly one slot, oldest first", () => {
  const gl = fakeGl();
  const gate = new FrameFenceGate(gl, { maxFramesInFlight: CAP });

  frame(gate, 1);
  const oldest = [...gl.live][0];
  frame(gate, 2);
  gl.signal(oldest);

  assert.equal(frame(gate, 3), true, "the freed slot is taken");
  assert.equal(gate.getFramesInFlight(), CAP);
  assert.ok(!gl.live.has(oldest), "retired fence deleted");
  assert.equal(frame(gate, 4), false, "and only one slot was freed");
});

test("lowering the cap applies from the next frame", () => {
  const gl = fakeGl();
  const gate = new FrameFenceGate(gl, { maxFramesInFlight: CAP });

  frame(gate, 1);
  frame(gate, 2);
  gate.maxFramesInFlight = 1;

  assert.equal(gate.canIssueFrame(), false, "two in flight, one allowed");
  gl.signalAll();
  assert.equal(gate.canIssueFrame(), true, "both retire, then one may issue");
});

test("zero disables the gate and takes no fences", () => {
  const gl = fakeGl();
  const gate = new FrameFenceGate(gl, { maxFramesInFlight: 0 });

  for (let i = 0; i < MANY_FRAMES; i++) {
    assert.equal(frame(gate, i), true);
  }
  assert.equal(gate.getFramesInFlight(), 0);
  assert.equal(gl.live.size, 0);
});

test("a session takes the gate out of the way while it owns the loop", () => {
  const gl = fakeGl();
  let presenting = false;
  const gate = new FrameFenceGate(gl, {
    maxFramesInFlight: CAP,
    bypass: () => presenting,
  });

  frame(gate, 1);
  frame(gate, 2);
  assert.equal(gate.canIssueFrame(), false, "capped before the session");

  presenting = true;
  for (let i = 0; i < MANY_FRAMES; i++) {
    assert.equal(
      frame(gate, CAP + 1 + i),
      true,
      "never skips while presenting",
    );
  }
  assert.equal(gate.getFramesInFlight(), CAP, "and takes no further fences");

  gl.signalAll();
  presenting = false;
  assert.equal(gate.canIssueFrame(), true);
  assert.equal(
    gate.getFramesInFlight(),
    0,
    "fences from before the session retired",
  );
  assert.equal(gl.live.size, 0);
});

test("a loop that fences but never asks is bounded, not leaked", () => {
  const gl = fakeGl();
  const gate = new FrameFenceGate(gl, {
    maxFramesInFlight: CAP,
    maxFences: HARD_BOUND,
  });

  for (let i = 0; i < MANY_FRAMES; i++) {
    gate.noteFrameEnd(i);
  }

  assert.equal(gate.getFramesInFlight(), HARD_BOUND);
  assert.equal(gl.live.size, HARD_BOUND, "no sync objects leaked");
});

test("one fence per frame however often the owner is drawn", () => {
  const gate = new FrameFenceGate(fakeGl(), { maxFramesInFlight: CAP });
  const frameId = 7; // Arbitrary: only that it repeats matters.

  gate.noteFrameEnd(frameId);
  gate.noteFrameEnd(frameId);
  gate.noteFrameEnd(frameId);

  assert.equal(gate.getFramesInFlight(), 1);
});

test("a failed fence retires rather than wedging the gate shut", () => {
  const gl = fakeGl();
  const gate = new FrameFenceGate(gl, { maxFramesInFlight: 1 });

  frame(gate, 1);
  assert.equal(gate.canIssueFrame(), false);

  gl.fail();
  assert.equal(gate.canIssueFrame(), true, "a lost context must not stall");
  assert.equal(gate.getFramesInFlight(), 0);
});

test("dispose drops every fence held", () => {
  const gl = fakeGl();
  const gate = new FrameFenceGate(gl, { maxFramesInFlight: HARD_BOUND });

  gate.noteFrameEnd(1);
  gate.noteFrameEnd(2);

  gate.dispose();

  assert.equal(gl.live.size, 0);
  assert.equal(gate.getFramesInFlight(), 0);
});
