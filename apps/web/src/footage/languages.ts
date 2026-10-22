/** What is spoken in the clips: the transcription needs it (it never guesses). ISO 639-1, as the API takes it. */
export const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
];

/** The browser's language when the transcription knows it, English otherwise. */
export const browserLanguage = () => {
  const code = navigator.language.slice(0, 2).toLowerCase();
  return LANGUAGES.some(([c]) => c === code) ? code : LANGUAGES[0]![0];
};
