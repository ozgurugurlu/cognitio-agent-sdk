import { defineConfig } from "@solidjs/start/config"
import tailwindcss from "@tailwindcss/vite"

const nitroConfig = (() => {
  const target = process.env.COGNITIO_DEPLOYMENT_TARGET
  if (target === "cloudflare") {
    return {
      compatibilityDate: "2024-09-19",
      preset: "cloudflare_module",
      cloudflare: {
        nodeCompat: true,
      },
    }
  }
  return {}
})()

export default defineConfig({
  server: {
    ...nitroConfig,
    baseURL: process.env.COGNITIO_BASE_URL,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: true,
    },
    worker: {
      format: "es",
    },
  },
})
