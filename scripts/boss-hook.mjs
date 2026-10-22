// UserPromptSubmit hook: in a main (non-worker) session, remind Claude on every message to act as
// the boss and hand implementation work to Claude Code Workers. Skills are only picked by their
// description, so without this the session often just does the work itself.
import fs from 'node:fs'

// Workers are started with CC_BRIDGE_WORKER set; they must do the work, not delegate it.
if (process.env.CC_BRIDGE_WORKER) process.exit(0)

let prompt = ''
try { prompt = String(JSON.parse(fs.readFileSync(0, 'utf8')).prompt ?? '') } catch {}
// The plugin's own commands already say what to do.
if (/^\s*\/(cli-workers:)?(worker-run|workers)\b/.test(prompt)) process.exit(0)

const additionalContext = '[cli-workers boss mode] You are the boss session. If this message asks for implementation ' +
  'work (build, add, fix, change, refactor, migrate, write tests, make a build pass), invoke the cli-workers:worker-boss ' +
  'skill and delegate the work to Claude Code Workers with the cc_* tools instead of editing code yourself. When a worker ' +
  'asks something, act as its senior engineer: investigate the code yourself, then give one decisive answer. Questions, ' +
  'explanations, reading code, reviews and one-line edits: handle them directly.'

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }))
