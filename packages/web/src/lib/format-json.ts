/**
 * Re-indent a JSON document, touching whitespace only: every string, number and literal is copied
 * byte-for-byte (no JSON.parse round-trip), so big integers, escapes, key order and duplicate keys
 * survive. Returns `null` when the text is not valid JSON, so the caller saves it as typed and the
 * server's own validation reports the error.
 */
export function formatJson(text: string): string | null {
  if (text.trim() === '') return null
  try {
    JSON.parse(text)
  } catch {
    return null
  }
  const unit = detectIndent(text)
  let out = ''
  let depth = 0
  const newline = () => '\n' + unit.repeat(depth)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']'
      const next = nextNonSpace(text, i + 1)
      if (text[next] === close) {
        out += ch + close
        i = next
      } else {
        depth++
        out += ch + newline()
      }
    } else if (ch === '}' || ch === ']') {
      depth--
      out += newline() + ch
    } else if (ch === ',') {
      out += ',' + newline()
    } else if (ch === ':') {
      out += ': '
    } else if (!/\s/.test(ch)) {
      out += ch
    }
  }
  return out + (text.endsWith('\n') ? '\n' : '')
}

function nextNonSpace(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text[i]!)) i++
  return i
}

/** Keep the file's own indent (first indented line), defaulting to two spaces. */
function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text)
  if (!m) return '  '
  return m[1]!.startsWith('\t') ? '\t' : ' '.repeat(Math.min(m[1]!.length, 8))
}
