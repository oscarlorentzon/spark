/**
 * WebGL 2.0 GLenum constants, from the specification's IDL:
 * https://registry.khronos.org/webgl/specs/latest/2.0/#3.7
 *
 * Node has no WebGL2RenderingContext to read them from, so `satisfies` checks
 * each value against the type the DOM lib declares.
 */
export const GL_CONSTANTS = {
  PIXEL_PACK_BUFFER: 0x88eb,
  STREAM_READ: 0x88e1,
  COLOR_ATTACHMENT0: 0x8ce0,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
  ALREADY_SIGNALED: 0x911a,
  TIMEOUT_EXPIRED: 0x911b,
  WAIT_FAILED: 0x911d,
} as const satisfies Pick<
  WebGL2RenderingContext,
  | "PIXEL_PACK_BUFFER"
  | "STREAM_READ"
  | "COLOR_ATTACHMENT0"
  | "RGBA"
  | "UNSIGNED_BYTE"
  | "SYNC_GPU_COMMANDS_COMPLETE"
  | "ALREADY_SIGNALED"
  | "TIMEOUT_EXPIRED"
  | "WAIT_FAILED"
>;
