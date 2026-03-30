import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.AI_PROXY_TARGET?.trim()
  const proxyApiKey = env.AI_PROXY_API_KEY?.trim()

  return {
    plugins: [react()],
    server: proxyTarget
      ? {
          proxy: {
            '/api/ai': {
              target: proxyTarget,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api\/ai/, ''),
              headers: proxyApiKey
                ? {
                    Authorization: `Bearer ${proxyApiKey}`,
                  }
                : undefined,
            },
          },
        }
      : undefined,
  }
})
