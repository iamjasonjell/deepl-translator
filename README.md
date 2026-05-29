# DeepL DOCX Translator

Upload an English DOCX and receive translations into DE, FR, IT, ES, JA, KO, ZH as a ZIP.

## Setup

```bash
cd D:\deepl-translator
npm install
copy .env.example .env
# Edit .env and add your DEEPL_API_KEY
npm start
# Open http://localhost:3000
```

## Environment

```
DEEPL_API_KEY=your-key-here
```

Get a free key at https://www.deepl.com/pro-api — free tier supports up to 500,000 characters/month.

The key is stored server-side only and never sent to the browser.

## Output ZIP structure

```
de-de/filename_de-de.docx
fr-fr/filename_fr-fr.docx
it-it/filename_it-it.docx
es-xn/filename_es-xn.docx
ja-jp/filename_ja-jp.docx
ko-kr/filename_ko-kr.docx
zh-cn/filename_zh-cn.docx
```

## Vercel deployment

```bash
npm install -g vercel
vercel
```

**Important:** The translation polling loop can run up to 5 minutes per language.
- Vercel Hobby plan: 10s function timeout — not sufficient for document translation
- Vercel Pro plan: set `maxDuration: 300` in vercel.json (already configured)
- Recommended alternative: Railway, Render, or Fly.io (persistent servers, no timeout issues)

## Stack

- Express.js backend
- Plain HTML/CSS/JS frontend (no frameworks)
- DeepL Document API (3-step: upload → poll → download)
- archiver for ZIP packaging
- multer for file uploads
- Node.js 18+ native `fetch` and `FormData` (no extra HTTP client deps)

## Notes

- Max file size: 50MB (DeepL free tier limit: 10MB per document)
- Languages processed sequentially — one at a time to stay within API rate limits
- If one language fails, others continue and the ZIP includes all successful results
