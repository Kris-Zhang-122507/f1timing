// Run `npm run bump` before pushing a new version: it stamps every file reference
// with a new ?v= number so browsers load the new files instead of cached old ones.
import { readFileSync, writeFileSync } from "node:fs";
const v = Date.now().toString(36);
for (const f of ["public/index.html", "public/app.js", "public/strategy.js"]) {
  const s = readFileSync(f, "utf8").replace(/\?v=[\w]+/g, `?v=${v}`);
  writeFileSync(f, s);
}
console.log(`Stamped version ${v}`);
