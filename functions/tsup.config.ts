import { defineConfig } from 'tsup';

// @vrp/shared は tsconfig の paths で解決し、バンドルに含める（デプロイ先で workspace 依存を解決させない）
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  noExternal: ['@vrp/shared'],
});
