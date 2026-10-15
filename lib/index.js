/**
 * @local/reverse-skill-tools
 *
 * Wraps every SKILL.md shipped by `@dhicoc/dsh-reverse-skill` as a native DSH
 * tool. The upstream pack remains a skill provider; this plugin is additive and
 * re-exposes each skill as a directly callable tool:
 *
 *   - discovery is data-driven: it walks the upstream package's `skills/` and
 *     `CTF-Sandbox-Orchestrator/` trees recursively, so nested sub-skills
 *     (pentest-tools/src-hunter, reverse-engineering/dsl-vm-reverse, ...) are found.
 *   - tool name = skill `name` normalized to snake_case (`ida-reverse` -> `ida_reverse`).
 *   - tool description = the skill's own frontmatter `description`.
 *   - calling the tool returns that skill's full SKILL.md body (YAML frontmatter
 *     stripped), so the model gets the methodology inline and follows it directly.
 *   - `reverse_skill_index` lists every wrapped tool with a one-line trigger summary.
 *
 * The upstream package root is resolved from the DSH profile at mount time and
 * delivered as `config.upstreamRoot` (see cordis.patch.yml), so this module never
 * guesses a checkout or profiles path.
 * @module @local/reverse-skill-tools
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'reverse-skill-tools'
export const inject = ['tools']

// --- Minimal YAML frontmatter reader (faithful to the upstream pack). ---------
// Handles UTF-8 BOM, CRLF, `---` delimiters, `metadata:user-invocable`, `key: |`
// / `key: >` block scalars (several upstream SKILL.md files use them), and simple
// quoted scalars.
const BLOCK_SCALAR = /^([|>])[+-]?\d*$/

function readBlockScalar(lines, start, style) {
  const raw = []
  let i = start
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      raw.push('')
      continue
    }
    if (!/^[ \t]/.test(line)) break
    raw.push(line)
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const indents = raw.filter((l) => l !== '').map((l) => l.match(/^[ \t]*/)[0].length)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  const text = raw.map((l) => (l === '' ? '' : l.slice(indent)))
  if (style === '|') return { value: text.join('\n').trim(), next: i }
  const folded = text.map((l, idx) => (l === '' ? '\n' : idx === 0 ? l : ` ${l}`)).join('')
  return { value: folded.replace(/\n{3,}/g, '\n\n').trim(), next: i }
}

function parseFrontmatter(text) {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!src.startsWith('---')) return { fm: {}, body: text }
  const end = src.indexOf('\n---', 3)
  if (end === -1) return { fm: {}, body: text }
  const fmText = src.slice(3, end)
  const body = src.slice(end + 4)
  const fm = {}
  let metaUserInvocable
  const lines = fmText.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === 'metadata:') {
      let j = i + 1
      while (j < lines.length && /^\s/.test(lines[j])) {
        const m = lines[j].match(/user-invocable:\s*"?([^"\n]+)"?/)
        if (m) metaUserInvocable = m[1].trim()
        j += 1
      }
      i = j - 1
      continue
    }
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/)
    if (m) {
      const key = m[1]
      const value = m[2].trim()
      if (BLOCK_SCALAR.test(value)) {
        const block = readBlockScalar(lines, i + 1, value[0])
        fm[key] = block.value
        i = block.next - 1
        continue
      }
      fm[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  if (metaUserInvocable !== undefined) fm['user-invocable'] = metaUserInvocable
  return { fm, body }
}

// --- Discovery -----------------------------------------------------------------

/** Recursively collect every SKILL.md path below `root`; unreadable dirs are skipped. */
function collectSkillFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'SKILL.md') out.push(p)
    }
  }
  walk(root)
  return out
}

/** `ida-reverse` -> `ida_reverse`; collapses any run of non-alphanumerics. */
function normalizeToolName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** Collapse a (possibly multi-line) description into one compact trigger summary. */
function indexSummary(description, max = 140) {
  const one = description.split('\n').map((s) => s.trim()).filter(Boolean).join(' ')
  return one.length > max ? `${one.slice(0, max)}…` : one
}

// --- Plugin --------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const upstreamRoot = config.upstreamRoot
  if (typeof upstreamRoot !== 'string' || upstreamRoot === '') {
    throw new Error('reverse-skill-tools: config.upstreamRoot is required (set it in cordis.patch.yml)')
  }

  const files = [
    ...collectSkillFiles(join(upstreamRoot, 'skills')),
    ...collectSkillFiles(join(upstreamRoot, 'CTF-Sandbox-Orchestrator')),
  ]

  const seen = new Set()
  const registry = []
  let count = 0
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { fm, body } = parseFrontmatter(text)
    const skillName = typeof fm.name === 'string' ? fm.name : ''
    if (skillName === '') continue

    const toolName = normalizeToolName(skillName)
    if (toolName === '' || seen.has(toolName)) continue
    seen.add(toolName)

    const ownDescription = typeof fm.description === 'string' && fm.description.trim() !== ''
      ? fm.description
      : `Reverse-engineering / security specialist skill "${skillName}".`
    const description = `${ownDescription}\n\nReturns the complete "${skillName}" SKILL.md methodology when invoked.`

    try {
      ctx.tools.register(defineTool({
        name: toolName,
        description,
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        timeoutMs: 30_000,
        execute(_args, exec) {
          exec.signal.throwIfAborted()
          return body
        },
        presentCall: () => ({ card: 'generic', title: `reverse-skill · ${skillName}`, kind: 'other' }),
      }))
      registry.push({ tool: toolName, skill: skillName, description: ownDescription })
      count += 1
    } catch (error) {
      // A collision with an existing native tool would throw here; skip it rather
      // than failing the whole bundle mount.
      try {
        ctx.logger?.warn?.(`reverse-skill-tools: skipped ${skillName}: %s`, error)
      } catch {
        console.error(`reverse-skill-tools: skipped ${skillName}:`, error)
      }
    }
  }

  // Aggregate index: lets the model find the right specialist tool by name.
  try {
    ctx.tools.register(defineTool({
      name: 'reverse_skill_index',
      description: 'List every reverse-skill native tool (reverse engineering / security / CTF specialists) with its one-line trigger summary. Use it to pick the right tool when the exact tool name is unknown.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 30_000,
      execute(_args, exec) {
        exec.signal.throwIfAborted()
        const lines = registry.map((r) => `- ${r.tool} (${r.skill}) — ${indexSummary(r.description)}`)
        return `reverse-skill native tools (${registry.length}):\n${lines.join('\n')}`
      },
      presentCall: () => ({ card: 'generic', title: 'reverse-skill index', kind: 'other' }),
    }))
  } catch (error) {
    try {
      ctx.logger?.warn?.(`reverse-skill-tools: register reverse_skill_index failed: %s`, error)
    } catch {
      console.error('reverse-skill-tools: register reverse_skill_index failed:', error)
    }
  }

  try {
    ctx.logger?.info?.(`reverse-skill-tools: registered ${count} native tools (+ reverse_skill_index) from ${upstreamRoot}`)
  } catch {
    console.error(`reverse-skill-tools: registered ${count} native tools (+ reverse_skill_index) from ${upstreamRoot}`)
  }
}