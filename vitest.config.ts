import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Les tests HTTP partagent une même base PostgreSQL : un fichier à la fois.
    fileParallelism: false,
  },
})
