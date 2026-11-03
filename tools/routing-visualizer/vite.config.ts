import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 配置文件位于 ../../config，开发服务器需要允许访问仓库根目录。
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  server: { fs: { allow: [repoRoot] } },
  build: { outDir: 'dist', target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
})
