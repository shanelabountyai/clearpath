/**
 * What the practice may write to a client in, and what it must never say in
 * any of them.
 *
 * The deny-list has been the messaging module's whole argument since the first
 * commit: a reminder arrives on a lock screen, in a shared inbox, on a phone
 * somebody else picks up, so it says when and where and never why. That
 * argument was English-only, which meant a Spanish-speaking client got the
 * protection of a list that did not contain the word "terapia" — the gap named
 * in P2 and closed here.
 *
 * Two decisions shape this file.
 *
 * **A body must be discreet in every language the practice ships, not only in
 * the client's own.** The person who reads a lock screen is whoever is
 * standing there, and a practice serving two languages has clients whose
 * partners, parents and roommates read the other one. Checking only the
 * client's list would protect them from their own language and nobody else's.
 * It also catches the false friend for free: a word that is innocuous in
 * Spanish and disclosing in English is caught without anybody having to notice
 * the coincidence.
 *
 * **Comparison is accent-insensitive**, because people type without accents and
 * a deny-list that misses "depresion" is a deny-list with a hole in it shaped
 * exactly like an ordinary keyboard.
 */

export type Language = 'en' | 'es';

/** Every language with a complete set of bodies. A test enforces "complete". */
export const LANGUAGES: readonly Language[] = ['en', 'es'];

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  es: 'Spanish',
};

/**
 * Lower-case and strip diacritics, so "Depresión", "depresion" and "DEPRESION"
 * are one word to every check in this module.
 *
 * This is also why the English list gained nothing on translation day and the
 * Spanish list still catches English text: `clínic` normalises to `clinic`,
 * which the English list never had — an accent-folding side effect that closed
 * a real gap rather than a cosmetic one.
 */
export const normalise = (text: string): string =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Words that must never reach a client-facing message, per language.
 *
 * Deliberately blunt: every entry is a substring match, so a false positive
 * costs somebody a rewrite and a false negative costs a client their privacy.
 * Entries are written normalised — no accents — because that is what they are
 * compared against.
 */
export const DENY_LISTS: Record<Language, readonly string[]> = {
  en: [
    'therapy', 'therapist', 'therapeutic',
    'counseling', 'counselling', 'counselor', 'counsellor',
    'psychiatr', 'psycholog', 'psychotherapy',
    'mental health', 'behavioral health', 'behavioural health',
    'depression', 'depressive', 'anxiety', 'trauma', 'ptsd', 'bipolar',
    'addiction', 'substance', 'suicide', 'self-harm', 'crisis',
    'diagnosis', 'diagnostic', 'treatment plan', 'clinical',
    'intake', 'screener', 'screening', 'assessment',
    'supervis', 'progress note', 'process note',
  ],
  /**
   * The Spanish list, and it is not a translation of the English one.
   *
   * `consejeria` and `consejo` are separate words that both disclose;
   * `trastorno` has no single English entry above it; and `tratamiento` is
   * listed bare where English lists `treatment plan`, because "su tratamiento"
   * on a lock screen says as much as the full phrase does. Translating the
   * English list word for word would have produced a shorter and worse one.
   */
  es: [
    'terapia', 'terapeuta', 'terapeutic',
    'consejeria', 'consejero', 'consejera', 'consejo psicologico',
    'psiquiatr', 'psicolog', 'psicoterapia',
    'salud mental', 'salud conductual',
    'depresion', 'depresiv', 'ansiedad', 'trauma', 'tept', 'bipolar',
    'adiccion', 'adicto', 'sustancia', 'suicidio', 'suicida', 'autolesion',
    'diagnostic', 'tratamiento', 'clinic',
    'admision', 'cuestionario', 'evaluacion', 'trastorno',
    'supervis', 'nota de progreso', 'nota de proceso', 'historia clinica',
  ],
};

/**
 * Every denied term across every shipped language, as one set.
 *
 * The union rather than a lookup, for the reason at the top of this file: the
 * question a body has to answer is not "is this discreet in the language it is
 * written in" but "is this discreet to whoever picks up the phone".
 */
export const ALL_DENIED: readonly string[] = [
  ...new Set(LANGUAGES.flatMap((l) => DENY_LISTS[l])),
];

/** Weekday names, so a Spanish reminder does not say "Tuesday". */
export const WEEKDAY_NAMES: Record<Language, readonly string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};
