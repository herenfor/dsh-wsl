// Release documentation consistency only. Real acceptance still requires reading the latest use-side results.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import assert from 'node:assert/strict'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const evidence = JSON.parse(readFileSync(join(root, 'docs/compatibility.json'), 'utf8'))
const { testedDshVersions: versions, latestAcceptance: acceptance } = evidence
assert.ok(Array.isArray(versions) && versions.length > 0)
assert.equal(new Set(versions).size, versions.length)
for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+(?:-[\w-]+(?:\.[\w-]+)*)?$/)
for (const key of ['date', 'pluginVersion', 'desktopDshVersion', 'wslDshVersion', 'scope', 'limits']) assert.ok(acceptance[key], `missing acceptance field: ${key}`)
assert.ok(versions.includes(acceptance.desktopDshVersion) && versions.includes(acceptance.wslDshVersion))
for (const relative of ['README.md', 'README.zh.md', 'experiments/mirror/mirror/README.md', 'experiments/mirror/mirror/README.zh.md']) {
  const text = readFileSync(join(root, relative), 'utf8')
  const declarations = text.split('\n').filter(line => /Tested (?:only )?with DSH|在 DSH .*上测试过/.test(line))
  assert.ok(declarations.length, `missing tested-version declaration: ${relative}`)
  for (const line of declarations) {
    const listed = [...new Set(line.match(/\d+\.\d+\.\d+(?:-[\w-]+(?:\.[\w-]+)*)?/g) ?? [])]
    assert.deepEqual(listed, versions, `tested versions differ in ${relative}`)
  }
}
console.log(`Documented tested DSH versions: ${versions.join(', ')}`)
console.log(`Latest live acceptance: ${acceptance.date}, plugin ${acceptance.pluginVersion}, Desktop ${acceptance.desktopDshVersion}, WSL ${acceptance.wslDshVersion}`)
console.log(`Scope: ${acceptance.scope}\nLimits: ${acceptance.limits}`)
console.log('Before publishing, compare this record with the latest use-side acceptance; this check does not run live verification.')
