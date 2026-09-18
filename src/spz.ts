import { ExtSplats } from "./ExtSplats";
import { PackedSplats } from "./PackedSplats";
import { getSplatFileType, getSplatFileTypeFromPath } from "./SplatLoader";
import type { SplatFileType } from "./defines";

import {
  decode_to_gsplatarray,
  extsplats_to_gsplatarray,
  packedsplats_to_gsplatarray,
} from "spark-rs";

export type TranscodeSpzFileInput = {
  fileBytes: Uint8Array;
  fileType?: SplatFileType;
  pathOrUrl?: string;
  transform?: { translate?: number[]; quaternion?: number[]; scale?: number };
};

export type TranscodeSpzInput = {
  inputs: TranscodeSpzFileInput[];
  maxSh?: number;
  clipXyz?: { min: number[]; max: number[] };
  fractionalBits?: number;
  opacityThreshold?: number;
};

export async function transcodeSpz(input: TranscodeSpzInput) {
  const splatArrays = [];
  const {
    inputs,
    clipXyz,
    maxSh,
    fractionalBits = 12,
    opacityThreshold,
  } = input;
  for (const input of inputs) {
    const scale = input.transform?.scale ?? 1;
    const quaternion = input.transform?.quaternion ?? [0, 0, 0, 1];
    const translate = input.transform?.translate ?? [0, 0, 0];
    const clip = clipXyz ? [...clipXyz.min, ...clipXyz.max] : undefined;

    let fileType = input.fileType;
    if (!fileType) {
      fileType = getSplatFileType(input.fileBytes);
      if (!fileType && input.pathOrUrl) {
        fileType = getSplatFileTypeFromPath(input.pathOrUrl);
      }
    }
    const decoder = decode_to_gsplatarray(fileType, input.pathOrUrl);
    const fileBytes = input.fileBytes;
    const CHUNK_SIZE = 1048576; // 1 MB
    for (let i = 0; i < fileBytes.length; i += CHUNK_SIZE) {
      decoder.push(
        fileBytes.subarray(i, Math.min(i + CHUNK_SIZE, fileBytes.length)),
      );
    }
    const decoded = decoder.finish();

    decoded.transform({
      translation: translate,
      rotation: quaternion,
      scale,
      clip,
      opacityThreshold: opacityThreshold ?? 0,
    });

    splatArrays.push(decoded);
  }

  // Combine decoded splat arrays
  const finalSplats = splatArrays[0];
  for (let i = 1; i < splatArrays.length; i++) {
    finalSplats.concat(splatArrays[i]);
  }

  const spzBytes = finalSplats.encode_to_spz(maxSh ?? 3, fractionalBits);

  return { fileBytes: spzBytes, clippedCount: 0 };
}

export function writeSpz(
  splats: PackedSplats | ExtSplats,
  maxSh?: number,
  fractionalBits?: number,
) {
  const shDegree = maxSh ?? 3;
  const bits = fractionalBits ?? 12;

  if (splats instanceof ExtSplats) {
    const gsplats = extsplats_to_gsplatarray(
      splats.numSplats,
      splats.extArrays[0],
      splats.extArrays[1],
      splats.extra,
    );
    return { fileBytes: gsplats.encode_to_spz(shDegree, bits) };
  }

  if (splats instanceof PackedSplats) {
    if (!splats.packedArray) {
      throw new Error("PackedSplats has no splat data");
    }
    const gsplats = packedsplats_to_gsplatarray(
      splats.numSplats,
      splats.packedArray,
      splats.extra,
      splats.splatEncoding,
    );
    return { fileBytes: gsplats.encode_to_spz(shDegree, bits) };
  }

  throw new Error("writeSpz requires PackedSplats or ExtSplats");
}
