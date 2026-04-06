import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  plugins: [
    // SWC is required because @coinbase/agentkit's @CreateAction decorator
    // relies on `emitDecoratorMetadata` (Reflect.getMetadata). esbuild —
    // vitest's default transformer — does not emit that metadata, so
    // importing any file with @CreateAction throws
    //   "Failed to get parameters for action method ..."
    // at class-decoration time. SWC honors both experimentalDecorators
    // and emitDecoratorMetadata per its `jsc.transform.legacyDecorator`
    // + `jsc.transform.decoratorMetadata` config.
    swc.vite({
      jsc: {
        parser: {
          syntax: "typescript",
          decorators: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: "es2022",
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    pool: "forks",
    isolate: true,
    testTimeout: 30_000,
    setupFiles: ["test/setup.ts"],
  },
});
