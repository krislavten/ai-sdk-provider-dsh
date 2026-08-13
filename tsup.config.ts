import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  // Copies runtime/cordis.yml → dist/cordis.yml so the packaged provider can
  // spawn the bundled dsh runtime by resolving its own config path.
  publicDir: "runtime",
});
