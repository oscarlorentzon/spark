import { SPLAT_TEX_HEIGHT, SPLAT_TEX_WIDTH } from "./defines";

/** The WebGL2 context members this module calls. */
export type PackReadGL = Pick<
  WebGL2RenderingContext,
  | "createBuffer"
  | "deleteBuffer"
  | "bindBuffer"
  | "bufferData"
  | "readBuffer"
  | "readPixels"
  | "flush"
  | "getBufferSubData"
  | "fenceSync"
  | "deleteSync"
  | "clientWaitSync"
  | "PIXEL_PACK_BUFFER"
  | "STREAM_READ"
  | "COLOR_ATTACHMENT0"
  | "RGBA"
  | "UNSIGNED_BYTE"
  | "SYNC_GPU_COMMANDS_COMPLETE"
  | "TIMEOUT_EXPIRED"
  | "WAIT_FAILED"
>;

export type DepthKeyLayer = {
  // Accumulator layer to read from.
  layer: number;
  // Rows of that layer this entry covers.
  rows: number;
  // Where the layer's bytes start in the destination.
  byteOffset: number;
};

export type DepthKeyIssue = {
  // Layers to read, in order.
  layers: DepthKeyLayer[];
  // Colour attachment index holding the keys.
  attachment: number;
  // Binds the framebuffer for a layer. Pass the renderer's own binding, so its
  // state cache stays correct.
  bindLayer: (layer: number) => void;
};

export type DepthKeyStatus = "idle" | "pending" | "ready" | "failed";

/**
 * Split a read of `numSplats` keys into one entry per accumulator layer.
 *
 * Only one layer can be read at a time, so each is read as whole rows and
 * written at its own offset in the destination.
 */
export function getDepthKeyLayers(numSplats: number): DepthKeyLayer[] {
  const splatsPerLayer = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
  const layerCount = Math.ceil(numSplats / splatsPerLayer);
  const layers: DepthKeyLayer[] = [];
  for (let layer = 0; layer < layerCount; layer++) {
    const firstSplat = layer * splatsPerLayer;
    const rows = Math.min(
      SPLAT_TEX_HEIGHT,
      Math.ceil((numSplats - firstSplat) / SPLAT_TEX_WIDTH),
    );
    layers.push({
      layer,
      rows,
      byteOffset: firstSplat * Uint32Array.BYTES_PER_ELEMENT,
    });
  }
  return layers;
}

/**
 * Asynchronous readback of splat sort keys from a layered RGBA8 attachment.
 *
 * Holds one read at a time: issue it, poll until it reports ready, then take
 * the bytes with copyInto.
 */
export class DepthKeyReadback {
  private readonly gl: PackReadGL;
  private pbos: { buffer: WebGLBuffer; bytes: number }[] = [];
  private sync: WebGLSync | null = null;
  private inFlight: { pbo: WebGLBuffer; byteOffset: number; bytes: number }[] =
    [];

  constructor(gl: PackReadGL) {
    this.gl = gl;
  }

  /** Whether a read is waiting on the GPU. */
  isPending(): boolean {
    return this.sync !== null;
  }

  /**
   * Copy the keys into pack buffers and fence them. Returns false when nothing
   * is pending, either because there was nothing to read or the context gave no
   * fence.
   */
  issue({ layers, attachment, bindLayer }: DepthKeyIssue): boolean {
    if (this.isPending()) {
      throw new Error("DepthKeyReadback: a read is already in flight");
    }
    if (layers.length === 0) {
      return false;
    }
    const gl = this.gl;
    this.inFlight = [];

    for (const { layer, rows, byteOffset } of layers) {
      // One key per splat: one RGBA8 texel, four bytes like a uint32.
      const bytes = SPLAT_TEX_WIDTH * rows * Uint32Array.BYTES_PER_ELEMENT;
      let slot = this.pbos[layer];
      if (!slot) {
        const buffer = gl.createBuffer();
        if (!buffer) {
          throw new Error("DepthKeyReadback: could not create a pack buffer");
        }
        slot = { buffer, bytes: 0 };
        this.pbos[layer] = slot;
      }

      bindLayer(layer);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      // Respecified before each read: Chrome shadow-copies a written READ-usage
      // buffer so copyInto need not wait, and drops the copy on a second write.
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      slot.bytes = bytes;
      gl.readPixels(0, 0, SPLAT_TEX_WIDTH, rows, gl.RGBA, gl.UNSIGNED_BYTE, 0);

      this.inFlight.push({ pbo: slot.buffer, byteOffset, bytes });
    }

    // The binding is context state, so any later readPixels would write here.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      this.inFlight = [];
      return false;
    }
    // Flush submits the queued commands to the driver, fence included. An
    // unsubmitted fence never signals.
    gl.flush();
    this.sync = sync;
    return true;
  }

  /**
   * Report whether the keys are readable, without waiting.
   *
   * "failed" releases the read so another can be issued. "ready" holds the bytes
   * until copyInto takes them.
   */
  poll(): DepthKeyStatus {
    const sync = this.sync;
    if (!sync) {
      return "idle";
    }
    // Flags are 0: the fence was flushed when issued, so nothing needs
    // submitting here.
    const status = this.gl.clientWaitSync(sync, 0, 0);
    if (status === this.gl.TIMEOUT_EXPIRED) {
      return "pending";
    }
    if (status === this.gl.WAIT_FAILED) {
      this.release();
      return "failed";
    }
    return "ready";
  }

  /**
   * Take the fenced bytes into `destination` and release the read. Only valid
   * after poll returned "ready".
   */
  copyInto(destination: Uint8Array) {
    const gl = this.gl;
    for (const { pbo, byteOffset, bytes } of this.inFlight) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.getBufferSubData(
        gl.PIXEL_PACK_BUFFER,
        0,
        destination.subarray(byteOffset, byteOffset + bytes),
      );
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.release();
  }

  /** Drop the pack buffers and any fence still held. */
  dispose() {
    this.release();
    for (const slot of this.pbos) {
      if (slot) {
        this.gl.deleteBuffer(slot.buffer);
      }
    }
    this.pbos = [];
  }

  private release() {
    if (this.sync) {
      this.gl.deleteSync(this.sync);
      this.sync = null;
    }
    this.inFlight = [];
  }
}
