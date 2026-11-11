import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
const root = new URL("../", import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of [
  "index.html",
  "styles.css",
  "app.js",
  "domain.js",
  "sync.js",
  "service-worker.js",
  "manifest.webmanifest",
]) {
  await cp(new URL(file, root), new URL(file, output));
}

await cp(new URL("icons/", root), new URL("icons/", output), { recursive: true });
await writeFile(new URL(".nojekyll", output), "");
console.log("CasaThomaz static PWA built in dist/.");
