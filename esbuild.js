const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const extension = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
  });

  // Scripts of the full-page views (analytics, availability); they run in the
  // webview, so they are bundled for the browser with their libraries.
  const webviews = await esbuild.context({
    entryPoints: ["webview/analytics.js"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    target: "es2020",
    outdir: "dist/webview",
    logLevel: "info",
  });

  const contexts = [extension, webviews];
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[esbuild] watching...");
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
