#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METADATA_MARKERS = new Set([
  0xe1, // APP1: EXIF / XMP
  0xe3,
  0xe4,
  0xe5,
  0xe6,
  0xe7,
  0xe8,
  0xe9,
  0xea,
  0xeb,
  0xec,
  0xed, // APP13: IPTC / Photoshop
  0xef,
  0xfe, // COM
]);

// APP0 (JFIF), APP2 (ICC) and APP14 (Adobe transform) can affect how decoders
// interpret colour. They are intentionally retained; the privacy/editorial
// metadata classes above are removed.

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function markerName(marker) {
  if (marker >= 0xe0 && marker <= 0xef) return `APP${marker - 0xe0}`;
  if (marker === 0xfe) return "COM";
  return `0x${marker.toString(16).padStart(2, "0")}`;
}

export function inspectJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("input is not a JPEG (missing SOI marker)");
  }

  let offset = 2;
  let frame;
  let scanOffset = -1;
  const metadata = [];

  while (offset < bytes.length) {
    const markerStart = offset;
    if (bytes[offset] !== 0xff) {
      throw new Error(`malformed JPEG marker at byte ${offset}`);
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error("truncated JPEG marker");

    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xda) {
      if (offset + 2 > bytes.length) throw new Error("truncated SOS marker");
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error("invalid SOS length");
      scanOffset = markerStart;
      break;
    }

    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) throw new Error(`truncated ${markerName(marker)} length`);

    const length = bytes.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.length) {
      throw new Error(`invalid ${markerName(marker)} segment length`);
    }

    if (METADATA_MARKERS.has(marker)) metadata.push(markerName(marker));
    if (SOF_MARKERS.has(marker)) {
      if (length < 8) throw new Error("invalid SOF segment");
      frame = {
        precision: bytes[offset + 2],
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
        components: bytes[offset + 7],
      };
    }
    offset = segmentEnd;
  }

  if (!frame) throw new Error("JPEG has no supported Start of Frame marker");
  if (scanOffset < 0) throw new Error("JPEG has no Start of Scan marker");
  return {
    ...frame,
    metadata,
    scanOffset,
    scanSha256: sha256(bytes.subarray(scanOffset)),
  };
}

export function stripJpegMetadata(bytes) {
  const before = inspectJpeg(bytes);
  const chunks = [bytes.subarray(0, 2)];
  let offset = 2;

  while (offset < before.scanOffset) {
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      if (!METADATA_MARKERS.has(marker)) chunks.push(bytes.subarray(markerStart, offset));
      continue;
    }
    const length = bytes.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (!METADATA_MARKERS.has(marker)) chunks.push(bytes.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }

  chunks.push(bytes.subarray(before.scanOffset));
  const sanitized = Buffer.concat(chunks);
  const after = inspectJpeg(sanitized);
  if (after.metadata.length !== 0) throw new Error(`metadata remains: ${after.metadata.join(", ")}`);
  if (
    before.width !== after.width ||
    before.height !== after.height ||
    before.components !== after.components ||
    before.precision !== after.precision ||
    before.scanSha256 !== after.scanSha256
  ) {
    throw new Error("lossless invariant failed: frame geometry or compressed scan payload changed");
  }
  return { sanitized, before, after };
}

function parseArgs(argv) {
  const args = [...argv];
  const input = args.shift();
  if (!input) {
    throw new Error(
      "usage: node scripts/sanitize-jpeg-metadata.mjs <jpeg> (--in-place | --verify-only) [--expect WIDTHxHEIGHTxCOMPONENTS]",
    );
  }
  const mode = args.includes("--in-place") ? "sanitize" : args.includes("--verify-only") ? "verify" : undefined;
  if (!mode || (args.includes("--in-place") && args.includes("--verify-only"))) {
    throw new Error("choose exactly one mode: --in-place or --verify-only");
  }
  const expectIndex = args.indexOf("--expect");
  const expect = expectIndex >= 0 ? args[expectIndex + 1] : undefined;
  if (expectIndex >= 0 && !expect) throw new Error("--expect requires WIDTHxHEIGHTxCOMPONENTS");
  const unknown = args.filter((arg, index) => {
    if (arg === "--in-place" || arg === "--verify-only" || arg === "--expect") return false;
    return index !== expectIndex + 1;
  });
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  return { input: resolve(input), mode, expect };
}

function verifyExpected(info, expected) {
  if (!expected) return;
  const match = /^(\d+)x(\d+)x(\d+)$/.exec(expected);
  if (!match) throw new Error("--expect must use WIDTHxHEIGHTxCOMPONENTS, for example 1600x900x3");
  const [, width, height, components] = match.map(Number);
  if (info.width !== width || info.height !== height || info.components !== components) {
    throw new Error(
      `frame mismatch: got ${info.width}x${info.height}x${info.components}, expected ${expected}`,
    );
  }
}

function main() {
  const { input, mode, expect } = parseArgs(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const projectRelative = relative(root, input);
  if (projectRelative.startsWith("..") || isAbsolute(projectRelative)) {
    throw new Error("JPEG path must resolve inside this repository");
  }
  const bytes = readFileSync(input);
  if (mode === "verify") {
    const info = inspectJpeg(bytes);
    verifyExpected(info, expect);
    if (info.metadata.length) throw new Error(`metadata remains: ${info.metadata.join(", ")}`);
    console.log(
      JSON.stringify({ file: input, width: info.width, height: info.height, components: info.components, metadata: [], scanSha256: info.scanSha256 }),
    );
    return;
  }

  const { sanitized, before, after } = stripJpegMetadata(bytes);
  verifyExpected(after, expect);
  const temp = resolve(dirname(input), `.sanitize-${process.pid}-${Date.now()}.jpg`);
  try {
    writeFileSync(temp, sanitized, { flag: "wx" });
    renameSync(temp, input);
  } finally {
    try {
      unlinkSync(temp);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  console.log(
    JSON.stringify({
      file: input,
      removed: before.metadata,
      width: after.width,
      height: after.height,
      components: after.components,
      scanSha256Before: before.scanSha256,
      scanSha256After: after.scanSha256,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
