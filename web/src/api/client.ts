import createClient from 'openapi-fetch'
import type { paths } from './schema'

/**
 * One typed client for the whole application.
 *
 * Paths, query parameters and response bodies are all typed from
 * `schema.d.ts`, which is generated from the Python application's own OpenAPI
 * document. A renamed backend field is therefore a compile error here rather
 * than an `undefined` in a chart.
 *
 * Relative base URL: Vite proxies `/api` to 127.0.0.1:8000 in development,
 * and the application is local-only, so there is no origin to configure.
 */
export const api = createClient<paths>({ baseUrl: '/' })
