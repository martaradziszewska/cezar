import { describe, expect, it } from 'vitest'

import { formatJson } from './format-json'

describe('formatJson', () => {
  it('re-indents a misaligned document with the file’s own indent', () => {
    const input = '{\n  "theme": "dark",\n  "permissions": {\n    "allow": ["Bash(git push:*)"]\n   },\n  "sandbox": {"x": []}}'
    expect(formatJson(input)).toBe(
      '{\n  "theme": "dark",\n  "permissions": {\n    "allow": [\n      "Bash(git push:*)"\n    ]\n  },\n  "sandbox": {\n    "x": []\n  }\n}',
    )
  })

  it('keeps tab indentation and a trailing newline', () => {
    expect(formatJson('{\n\t"a": {"b": 1}}\n')).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n')
  })

  it('copies values verbatim: big integers, escapes, structural chars inside strings', () => {
    const input = '{"n": 12345678901234567890, "s": "a\\"{,}:[]\\\\", "e": 1E+2}'
    expect(formatJson(input)).toBe(
      '{\n  "n": 12345678901234567890,\n  "s": "a\\"{,}:[]\\\\",\n  "e": 1E+2\n}',
    )
  })

  it('returns null for invalid or empty input so the caller saves it untouched', () => {
    expect(formatJson('{"a": 1,}')).toBeNull()
    expect(formatJson('// c\n{}')).toBeNull()
    expect(formatJson('  ')).toBeNull()
  })

  it('is idempotent', () => {
    const once = formatJson('{"a":[1,{"b":null}],"c":{}}')!
    expect(formatJson(once)).toBe(once)
  })
})
