import { copyFileSync } from "node:fs";
import { build } from "esbuild";

const absWorkingDir = import.meta.dirname;

// Apps Script only runs top-level functions, so re-expose the bundle's exports.
await build({
  absWorkingDir,
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  globalName: "gs",
  target: "es2020",
  outfile: "dist/main.js",
  footer: {
    js: "function checkMeetings() { gs.checkMeetings(); }\nfunction installTrigger() { gs.installTrigger(); }",
  },
});
copyFileSync(`${absWorkingDir}/appsscript.json`, `${absWorkingDir}/dist/appsscript.json`);
