require('dotenv').config()
const express = require('express')
const multer = require('multer')
const archiver = require('archiver')
const JSZip = require('jszip')
const path = require('path')
const crypto = require('crypto')

const app = express()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || file.originalname.toLowerCase().endsWith('.docx')
    cb(ok ? null : new Error('Only DOCX files are supported'), ok)
  },
})

// ── Language config ───────────────────────────────────────────────────────────
const LANGUAGES = {
  'de-de': { deepl: 'DE',  name: 'German' },
  'fr-fr': { deepl: 'FR',  name: 'French' },
  'it-it': { deepl: 'IT',  name: 'Italian' },
  'es-xn': { deepl: 'ES',  name: 'Spanish' },
  'ja-jp': { deepl: 'JA',  name: 'Japanese' },
  'ko-kr': { deepl: 'KO',  name: 'Korean' },
  'zh-cn': { deepl: 'ZH', name: 'Chinese (Simplified)' },
}

// Free keys end in :fx — paid/developer keys use the main endpoint
const DEEPL_BASE = process.env.DEEPL_API_KEY?.endsWith(':fx')
  ? 'https://api-free.deepl.com'
  : 'https://api.deepl.com'

// ── In-memory job store ───────────────────────────────────────────────────────
// jobId → { filename, fileBuffer, languages: [{locale, name, status, error, buffer}] }
const jobs = new Map()

// ── Adapted from evident-translation-qa gemini-retry pattern ─────────────────
async function withRetry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const msg = String(err.message || '')
      const retryable = msg.includes('503') || msg.includes('429') || msg.includes('overloaded')
      if (retryable && i < attempts - 1) {
        await sleep((i + 1) * 4000)
        continue
      }
      throw err
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── DeepL Document API (3-step flow) ─────────────────────────────────────────
async function translateDocument(fileBuffer, originalFilename, targetLocale) {
  const apiKey = process.env.DEEPL_API_KEY
  if (!apiKey) throw new Error('DEEPL_API_KEY is not configured')

  const deeplLang = LANGUAGES[targetLocale]?.deepl
  if (!deeplLang) throw new Error(`Unknown locale: ${targetLocale}`)

  const tag = `[DeepL:${targetLocale}]`

  // Step 1 — upload
  const { document_id, document_key } = await withRetry(async () => {
    const fd = new FormData()
    fd.append(
      'file',
      new Blob([fileBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      originalFilename,
    )
    fd.append('target_lang', deeplLang)

    console.log(`${tag} uploading to ${DEEPL_BASE} target_lang=${deeplLang}`)
    const res = await fetch(`${DEEPL_BASE}/v2/document`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status))
      throw new Error(`Upload failed (${res.status}): ${text}`)
    }
    const data = await res.json()
    console.log(`${tag} upload ok document_id=${data.document_id}`)
    return data
  })

  // Step 2 — poll until done (max 150 polls = ~5 minutes)
  for (let poll = 0; poll < 150; poll++) {
    await sleep(2000)

    const statusRes = await fetch(`${DEEPL_BASE}/v2/document/${document_id}`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ document_key }),
      signal: AbortSignal.timeout(15000),
    })

    if (!statusRes.ok) throw new Error(`Status check failed (${statusRes.status})`)

    const statusData = await statusRes.json()
    console.log(`${tag} poll ${poll + 1}: ${JSON.stringify(statusData)}`)
    const { status, error_message } = statusData
    if (status === 'done') break
    if (status === 'error') throw new Error(error_message || 'DeepL returned error status')
    if (poll === 149) throw new Error('Translation timed out after 5 minutes')
  }

  // Step 3 — download
  console.log(`${tag} downloading result`)
  const dlRes = await fetch(`${DEEPL_BASE}/v2/document/${document_id}/result`, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ document_key }),
    signal: AbortSignal.timeout(60000),
  })

  console.log(`${tag} download response ${dlRes.status} content-type=${dlRes.headers.get('content-type')}`)
  if (!dlRes.ok) {
    const body = await dlRes.text().catch(() => '')
    throw new Error(`Download failed (${dlRes.status}): ${body}`)
  }
  return Buffer.from(await dlRes.arrayBuffer())
}

// ── DOCX text extraction (adapted from QA project document-extractor pattern) ─
async function extractDocxText(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const xmlFile = zip.files['word/document.xml']
    if (!xmlFile) return ''
    const xml = await xmlFile.async('string')
    return xml
      .replace(/<w:p\b[^>]*/g, '\n')   // paragraph → newline
      .replace(/<[^>]+>/g, '')           // strip all tags
      .replace(/\n{3,}/g, '\n\n')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim()
  } catch {
    return ''
  }
}

// ── Gemini review (adapted from QA project runHolisticPageQA prompt) ──────────
const GEMINI_MODEL = 'gemini-2.5-flash-lite'
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta'

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  return withRetry(async () => {
    const res = await fetch(
      `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
        }),
        signal: AbortSignal.timeout(30000),
      }
    )
    if (!res.ok) {
      const txt = await res.text().catch(() => res.status)
      throw new Error(`Gemini ${res.status}: ${txt}`)
    }
    const data = await res.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null
  })
}

async function reviewTranslation(enText, translatedText, langName, locale) {
  const prompt = `You are a translation reviewer for Evident Scientific, a life science microscopy company.

Review this translation from English to ${langName} (${locale}).

ENGLISH SOURCE:
${enText.slice(0, 6000)}

${langName.toUpperCase()} TRANSLATION:
${translatedText.slice(0, 6000)}

Identify the most significant translation issues. Return at most 10 issues.

Rules:
- "Olympus" used as a current brand name should be "Evident" (historical references are fine)
- Product model numbers must stay in English: FV4000, FV5000, BX53, IX83, CX43, etc.
- Scientific/microscopy terms should use standard ${langName} equivalents used in peer-reviewed literature
- Flag unnatural phrasing that reads as machine-translated to a native ${langName} scientific professional

For each issue provide a concrete fix — not a description of the problem, the actual corrected ${langName} text.

Return ONLY valid JSON (no markdown):
{"issues":[{"severity":"critical|high|medium|low","type":"terminology|untranslated|brand_misuse|unnatural_phrasing|missing_content","flagged_text":"...","suggestion":"..."}]}`

  try {
    const raw = await callGemini(prompt)
    if (!raw) return []
    const cleaned = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
    const parsed = JSON.parse(cleaned)
    return parsed.issues ?? []
  } catch {
    return []
  }
}

// ── Compile single Markdown recommendations report for all languages ───────────
async function generateReviewReport(job, enText) {
  const lines = [
    `# Translation Review Report`,
    ``,
    `**Document:** ${job.originalFilename}`,
    `**Generated:** ${new Date().toUTCString()}`,
    `**Languages reviewed:** ${job.languages.filter(l => l.status === 'done').map(l => l.name).join(', ')}`,
    ``,
    `---`,
    ``,
  ]

  for (const lang of job.languages) {
    lines.push(`## ${lang.name} (${lang.locale})`)
    lines.push('')

    if (lang.status !== 'done' || !lang.buffer) {
      lines.push(`_Translation failed — no review available._`)
      lines.push('', '---', '')
      continue
    }

    const translatedText = await extractDocxText(lang.buffer)
    if (!translatedText) {
      lines.push(`_Could not extract text for review._`)
      lines.push('', '---', '')
      continue
    }

    const issues = await reviewTranslation(enText, translatedText, lang.name, lang.locale)

    if (!issues.length) {
      lines.push(`✅ No significant issues found.`)
    } else {
      const order = { critical: 0, high: 1, medium: 2, low: 3 }
      issues.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4))

      issues.forEach((issue, i) => {
        const badge = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[issue.severity] ?? '⚪'
        lines.push(`### ${badge} Issue ${i + 1} — ${issue.type ?? 'unspecified'} (${issue.severity})`)
        lines.push('')
        if (issue.flagged_text) lines.push(`**Flagged:** ${issue.flagged_text}`)
        if (issue.suggestion)   lines.push(`**Suggestion:** ${issue.suggestion}`)
        lines.push('')
      })
    }

    lines.push('---', '')
  }

  return lines.join('\n')
}

// ── Background processor ──────────────────────────────────────────────────────
async function processJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return

  // Extract English source text before we free the buffer
  const enText = await extractDocxText(job.fileBuffer)

  // Phase 1 — translate each language via DeepL
  for (const lang of job.languages) {
    lang.status = 'translating'
    try {
      lang.buffer = await translateDocument(job.fileBuffer, job.originalFilename, lang.locale)
      lang.status = 'translated'  // intermediate — review comes next
    } catch (err) {
      lang.status = 'error'
      lang.error = err.message
      console.error(`[${jobId}] ${lang.locale} translation failed:`, err.message)
    }
  }

  job.fileBuffer = null  // free source buffer

  // Phase 2 — Gemini review (only if API key configured)
  if (process.env.GEMINI_API_KEY && enText) {
    for (const lang of job.languages) {
      if (lang.status !== 'translated') continue
      lang.status = 'reviewing'
    }

    try {
      job.reviewReport = await generateReviewReport(job, enText)
    } catch (err) {
      console.error(`[${jobId}] Review failed:`, err.message)
      job.reviewReport = `# Translation Review Report\n\n_Review could not be completed: ${err.message}_\n`
    }
  }

  // Mark all translated languages as done
  for (const lang of job.languages) {
    if (lang.status === 'translated' || lang.status === 'reviewing') {
      lang.status = 'done'
    }
  }

  job.completedAt = Date.now()
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')))

// POST /api/translate — upload file, start job
app.post('/api/translate', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No DOCX file provided' })
  if (!process.env.DEEPL_API_KEY) return res.status(500).json({ error: 'DEEPL_API_KEY not configured on server' })

  let selected
  try {
    selected = JSON.parse(req.body.languages || '[]')
  } catch {
    return res.status(400).json({ error: 'Invalid languages payload' })
  }
  if (!Array.isArray(selected) || selected.length === 0) {
    return res.status(400).json({ error: 'Select at least one language' })
  }

  const invalid = selected.filter(l => !LANGUAGES[l])
  if (invalid.length) return res.status(400).json({ error: `Unknown locales: ${invalid.join(', ')}` })

  const jobId = crypto.randomUUID()
  const baseName = req.file.originalname.replace(/\.docx$/i, '')

  jobs.set(jobId, {
    id: jobId,
    filename: baseName,
    originalFilename: req.file.originalname,
    fileBuffer: req.file.buffer,
    languages: selected.map(locale => ({
      locale,
      name: LANGUAGES[locale].name,
      status: 'waiting',
      error: null,
      buffer: null,
    })),
    startedAt: Date.now(),
    completedAt: null,
  })

  res.json({ jobId })

  // Fire-and-forget — works on local Node.js; see README for Vercel notes
  processJob(jobId).catch(console.error)
})

// GET /api/status/:jobId — poll job state
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  const allDone = job.languages.every(l => l.status === 'done' || l.status === 'error')

  res.json({
    id: job.id,
    filename: job.filename,
    languages: job.languages.map(({ locale, name, status, error }) => ({ locale, name, status, error })),
    allDone,
    hasReview: !!job.reviewReport,
    completedAt: job.completedAt,
  })
})

// GET /api/download/:jobId — stream ZIP
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'Job not found' })

  const allDone = job.languages.every(l => l.status === 'done' || l.status === 'error')
  if (!allDone) return res.status(400).json({ error: 'Translations still in progress' })

  const hasResults = job.languages.some(l => l.status === 'done' && l.buffer)
  if (!hasResults) return res.status(400).json({ error: 'No successful translations to download' })

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}_translations.zip"`)

  const archive = archiver('zip', { zlib: { level: 6 } })
  archive.on('error', err => { console.error('Archive error:', err); res.end() })
  archive.pipe(res)

  // Translated DOCX files
  for (const lang of job.languages) {
    if (lang.status === 'done' && lang.buffer) {
      archive.append(lang.buffer, {
        name: `${lang.locale}/${job.filename}_${lang.locale}.docx`,
      })
    }
  }

  // Gemini review report — single file covering all languages
  if (job.reviewReport) {
    archive.append(Buffer.from(job.reviewReport, 'utf8'), {
      name: `${job.filename}_recommendations.md`,
    })
  }

  archive.finalize()
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`DeepL Translator running → http://localhost:${PORT}`))

module.exports = app
