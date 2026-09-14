/** The WebGL2 context members this module calls. */
export type SyncGL = Pick<
  WebGL2RenderingContext,
  | "fenceSync"
  | "deleteSync"
  | "clientWaitSync"
  | "SYNC_GPU_COMMANDS_COMPLETE"
  | "TIMEOUT_EXPIRED"
>;

export type FrameFenceGateOptions = {
  // Frames that may be queued at once, 0 disables the gate.
  maxFramesInFlight?: number;
  // Hard bound on retained fences, reached only by a loop that fences frames
  // without ever asking to issue one.
  maxFences?: number;
  // While true the gate lets everything through and takes no fences, for a
  // presentation model that paces frames itself.
  bypass?: () => boolean;
};

/**
 * Bounds how many frames may be queued to the GPU at once.
 *
 * Ask canIssueFrame before starting a frame and call noteFrameEnd after it. A
 * loop told no should skip the frame entirely, leaving the previous one on
 * screen.
 */
export class FrameFenceGate {
  /** Frames that may be queued at once, 0 disables the gate. */
  maxFramesInFlight: number;

  private readonly gl: SyncGL;
  private readonly maxFences: number;
  private readonly bypass: () => boolean;
  private fences: WebGLSync[] = [];
  private lastFrame = -1;

  constructor(gl: SyncGL, options: FrameFenceGateOptions = {}) {
    const {
      maxFramesInFlight = 2,
      maxFences = 8,
      bypass = () => false,
    } = options;
    this.gl = gl;
    this.maxFramesInFlight = maxFramesInFlight;
    this.maxFences = maxFences;
    this.bypass = bypass;
  }

  /** Frames queued to the GPU as of the last check. */
  getFramesInFlight(): number {
    return this.fences.length;
  }

  /**
   * Whether another frame may be issued. Retires fences the GPU has passed, so
   * calling it is what lets the queue drain.
   */
  canIssueFrame(): boolean {
    if (!this.isActive()) {
      return true;
    }
    this.retire();
    return this.fences.length < this.maxFramesInFlight;
  }

  /**
   * Fence the frame just issued. `frameId` deduplicates: a frame may draw the
   * gate's owner more than once.
   */
  noteFrameEnd(frameId: number) {
    if (!this.isActive() || frameId === this.lastFrame) {
      return;
    }
    this.lastFrame = frameId;
    const sync = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync) {
      this.fences.push(sync);
    }
    // Also retired here, so a loop that never calls canIssueFrame degrades to
    // no gate rather than to a leak.
    this.retire();
  }

  /** Drop every fence held. */
  dispose() {
    for (const sync of this.fences) {
      this.gl.deleteSync(sync);
    }
    this.fences = [];
  }

  private isActive(): boolean {
    return this.maxFramesInFlight > 0 && !this.bypass();
  }

  private retire() {
    const gl = this.gl;
    while (this.fences.length > 0) {
      // WAIT_FAILED retires too: after a context loss the fence will never
      // signal, and keeping it would wedge the gate shut.
      if (gl.clientWaitSync(this.fences[0], 0, 0) === gl.TIMEOUT_EXPIRED) {
        break;
      }
      gl.deleteSync(this.fences[0]);
      this.fences.shift();
    }
    while (this.fences.length > this.maxFences) {
      const sync = this.fences.shift();
      if (sync) {
        gl.deleteSync(sync);
      }
    }
  }
}
