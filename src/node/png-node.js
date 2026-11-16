import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { parsePng, unfilterToRgba, encodePng } from '../core/png.js';

export async function readPng(path) {
  const bytes = await readFile(path);
  const parsed = parsePng(bytes);
  const raw = inflateSync(parsed.compressed);
  const rgba = unfilterToRgba(parsed, raw);
  return { width: parsed.width, height: parsed.height, rgba };
}

export async function writePng(path, rgba, width, height) {
  const bytes = await encodePng(rgba, width, height, async (raw) => deflateSync(raw, { level: 9 }));
  await writeFile(path, bytes);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
