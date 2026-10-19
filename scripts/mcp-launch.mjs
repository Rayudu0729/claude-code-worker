// Plugin entry for the MCP server: make sure node_modules is installed, then start cc-mcp.mjs.
import { ensureDeps } from './ensure-deps.mjs'

try { ensureDeps() } catch (e) {
  process.stderr.write(`${e.message}\n`)
  process.exit(1)
}
await import('../cc-mcp.mjs')
