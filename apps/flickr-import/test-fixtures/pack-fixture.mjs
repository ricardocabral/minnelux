import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { metadataFirst, metadataLater, originalParts } from "./fixture.mjs";

const photo = await readFile(new URL("./photo.jpg", import.meta.url));
const video = await readFile(new URL("./video.mp4", import.meta.url));
const output = await mkdtemp(join(resolve(process.argv[2] ?? tmpdir()), "minnelux-flickr-"));
const entries = [
  [metadataFirst.id, metadataFirst.sidecars.map(({ name, json }) => [name, JSON.stringify(json)])],
  [metadataLater.id, [["albums.json", JSON.stringify({ albums: metadataLater.albums })]]],
  ...originalParts(photo, video).map(({ id, media }) => [id, media.map(({ name, bytes }) => [name, bytes])]),
];

const staging = join(output, "staging");
await mkdir(staging);
try {
  for (const [partId, files] of entries) {
    for (const [name, bytes] of files) await writeFile(join(staging, name), bytes);
    execFileSync("zip", ["-q", "-X", join(output, `${partId}.zip`), ...files.map(([name]) => name)], {
      cwd: staging,
    });
  }
} finally {
  await rm(staging, { recursive: true });
}
console.log(output);
