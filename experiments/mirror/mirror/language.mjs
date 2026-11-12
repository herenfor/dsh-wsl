// The language the page shows, for text the Host writes itself (setup commands, prompts, errors). The page names its
// active DSH locale id on every request it makes to this plugin's routes; the latest one wins.
//
// Text is given as translations by language id ({ zh, en, ... }); adding a language means adding its entry where
// the text is written. A language without one falls back to its base language, then to English.

export const LANGUAGE_HEADER = 'x-dsh-wsl-language'
let current = 'en'

/** Note the locale id a request names. */
export function noteLanguage(req) {
  const value = req?.headers?.[LANGUAGE_HEADER]
  if (typeof value === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value)) current = value
  return current
}

/** The latest locale id the page named. */
export const language = () => current

/** The translation for a locale id: the id itself, its base language (zh-CN → zh), or English. */
export function inLanguage(id, texts) {
  const lower = String(id ?? '').toLowerCase()
  return texts[lower] ?? texts[lower.split('-')[0]] ?? texts.en
}

/** The translation for the latest language the page named. */
export const pick = (texts) => inLanguage(current, texts)
