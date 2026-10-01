// One-time script: creates a multilingual DeepL glossary from the TSVs in
// english-scrape/, and prints the resulting glossary_id to put in .env.
require('dotenv').config()
const fs = require('fs')
const path = require('path')

const apiKey = process.env.DEEPL_API_KEY
if (!apiKey) throw new Error('DEEPL_API_KEY is not set')
const base = apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'

const SOURCE_LANG = (process.env.SOURCE_LANG || 'EN').toLowerCase()

// locale -> glossary target_lang code (lowercase, generic — DeepL glossaries
// don't support regional variants like pt-pt or zh-hans, only the base code)
const GLOSSARY_DIR = path.join(__dirname, 'english-scrape')
const SOURCES = {
  'glossary_ja-jp.tsv': 'ja',
  'glossary_zh-cn.tsv': 'zh',
  'glossary_es-xn.tsv': 'es',
  'glossary_fr-fr.tsv': 'fr',
  'glossary_it-it.tsv': 'it',
}

const dictionaries = Object.entries(SOURCES).map(([file, target_lang]) => {
  const entries = fs.readFileSync(path.join(GLOSSARY_DIR, file), 'utf8').trim()
  const count = entries.split('\n').length
  console.log(`[glossary] ${file} -> ${SOURCE_LANG}->${target_lang} (${count} entries)`)
  return { source_lang: SOURCE_LANG, target_lang, entries, entries_format: 'tsv' }
})

async function main() {
  const name = `Evident DOCX Translator (${new Date().toISOString().slice(0, 10)})`
  const res = await fetch(`${base}/v3/glossaries`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dictionaries }),
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    console.error(`[glossary] create FAILED (${res.status}):`, JSON.stringify(body, null, 2))
    process.exit(1)
  }

  console.log(`\n[glossary] created glossary_id=${body.glossary_id}`)
  for (const d of body.dictionaries || []) {
    console.log(`  ${d.source_lang}->${d.target_lang}: entry_count=${d.entry_count}`)
  }
  console.log(`\nSet this in .env and in production:\nDEEPL_GLOSSARY_ID=${body.glossary_id}`)
}

main().catch(err => { console.error(err); process.exit(1) })
