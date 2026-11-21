# Tercüme Paneli

By Elmir Gulusoy

Web dashboard for notary document translation (Turkish ⇄ Azerbaijani).

- `index.html`: the dashboard (upload, review, approve, Word download, glossary, settings)
- `core.js`: shared logic (checks, glossary, Word export), also used by the Supabase Edge Function `nt-process`

Backend: Supabase (tables `nt_*`, storage bucket `nt-docs`, edge function `nt-process`) + Groq API.
