import { defineConfig } from "tsdown";

export default defineConfig({
  name: "dsh-ssh-workspace/real-smoke",
  entry: { manager: "src/manager.ts" },
  outDir: ".real-smoke-lib",
  format: "esm",
  platform: "node",
  target: "es2022",
  fixedExtension: true,
  dts: true,
  clean: true,
  sourcemap: false,
  deps: {
    neverBundle: [/^node:/, "ssh2"],
  },
});
