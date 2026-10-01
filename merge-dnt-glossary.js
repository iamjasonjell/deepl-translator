// Merge english-scrape terminology + glossary_build/dnt_global.txt into the DeepL glossary (DNT wins).
// PUT replaces each dictionary whole. Dry run by default; pass --upload to apply. Backs up current entries to the OS temp dir first.
require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const fs = require('fs')
const ROOT = __dirname
const ID = process.env.DEEPL_GLOSSARY_ID
const key = process.env.DEEPL_API_KEY
const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
const h = { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' }
const upload = process.argv.includes('--upload')
const SRC = { es: 'es-xn', fr: 'fr-fr', it: 'it-it', ja: 'ja-jp', zh: 'zh-cn' }

const clean = s => s.split(/\s+/).join(' ').trim()
const dnt = fs.readFileSync(`${ROOT}/glossary_build/dnt_global.txt`, 'utf8').replace(/^\uFEFF/, '')
  .split(/\r?\n/).map(clean).filter(t => t && !t.startsWith('#'))
const dntLower = new Set(dnt.map(t => t.toLowerCase()))

;(async () => {
  for (const [lang, loc] of Object.entries(SRC)) {
    // backup current dictionary
    const cur = await fetch(`${base}/v3/glossaries/${ID}/entries?source_lang=en&target_lang=${lang}`, { headers: h })
    const curData = await cur.json()
    fs.writeFileSync(`${require('os').tmpdir()}/backup-${ID.slice(0, 8)}-en-${lang}.json`, JSON.stringify(curData))
    const terms = new Map()
    for (const line of fs.readFileSync(`${ROOT}/english-scrape/glossary_${loc}.tsv`, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const p = line.split('\t')
      if (p.length === 2 && p[0].trim() && p[1].trim()) terms.set(p[0].trim(), p[1].trim())
    }
    const overridden = [...terms.keys()].filter(s => dntLower.has(s.toLowerCase()))
    for (const s of overridden) terms.delete(s)
    for (const t of dnt) terms.set(t, t)
    const entries = [...terms].map(([s, t]) => `${s}\t${t}`).join('\n')
    console.log(`en-${lang}: ${terms.size} entries (${dnt.length} DNT${overridden.length ? `, overrode: ${overridden.join(' | ')}` : ''})`)
    if (!upload) continue
    const r = await fetch(`${base}/v3/glossaries/${ID}/dictionaries`, { method: 'PUT', headers: h,
      body: JSON.stringify({ source_lang: 'en', target_lang: lang, entries, entries_format: 'tsv' }) })
    console.log(`  upload: ${r.status} ${r.ok ? JSON.stringify(await r.json()) : await r.text()}`)
  }
  const g = await (await fetch(`${base}/v3/glossaries/${ID}`, { headers: h })).json()
  console.log(`\n${g.name} ${ID}:`, g.dictionaries.map(d => `${d.target_lang}=${d.entry_count}`).join(', '))
})()
