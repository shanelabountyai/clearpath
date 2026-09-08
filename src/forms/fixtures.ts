import type { LocalizedText, TemplateSchema } from './schema';
import type { ScoringRules } from './scoring';

/**
 * Instruments the practice uses. Written here rather than in the seed so the
 * tests and the seeded data score identically — a fixture that drifts from what
 * the app ships is a test that proves nothing.
 *
 * These are original instruments for a synthetic practice. Real screeners are
 * licensed material; a learning project has no business shipping one — and a
 * translated one even less, since a validated instrument is validated in the
 * language it was validated in. Writing both halves here is honest precisely
 * because neither half claims to be a clinical instrument.
 */

/** Shorthand: every question is written as the pair, never as a string. */
const t = (en: string, es: string): LocalizedText => ({ en, es });

const LIKERT = [
  { value: 0, label: t('Not at all', 'Nunca') },
  { value: 1, label: t('Several days', 'Varios días') },
  { value: 2, label: t('More than half the days', 'Más de la mitad de los días') },
  { value: 3, label: t('Nearly every day', 'Casi todos los días') },
];

const ITEMS: [string, LocalizedText][] = [
  ['item_1', t('Little interest or pleasure in doing things', 'Poco interés o placer en hacer las cosas')],
  ['item_2', t('Feeling down or hopeless', 'Sentirse decaído o sin esperanza')],
  ['item_3', t(
    'Trouble falling asleep, staying asleep, or sleeping too much',
    'Dificultad para dormirse, para seguir durmiendo, o dormir demasiado',
  )],
  ['item_4', t('Feeling tired or having little energy', 'Sentirse cansado o con poca energía')],
  ['item_5', t('Poor appetite or overeating', 'Poco apetito o comer en exceso')],
  ['item_6', t(
    'Feeling bad about yourself, or that you have let people down',
    'Sentirse mal consigo mismo, o que le ha fallado a los demás',
  )],
  ['item_7', t('Trouble concentrating', 'Dificultad para concentrarse')],
  ['item_8', t(
    'Moving or speaking noticeably slowly, or being restless',
    'Moverse o hablar notablemente despacio, o estar inquieto',
  )],
  ['item_9', t(
    'Thoughts that you would be better off not here, or of hurting yourself',
    'Pensamientos de que estaría mejor no estando aquí, o de hacerse daño',
  )],
];

export const wellbeingCheckIn: { schema: TemplateSchema; scoring: ScoringRules } = {
  schema: {
    title: t('Wellbeing Check-In', 'Cuestionario de bienestar'),
    intro: t(
      'Over the last two weeks, how often have you been bothered by any of the following?',
      'Durante las últimas dos semanas, ¿con qué frecuencia le han molestado los siguientes problemas?',
    ),
    fields: [
      ...ITEMS.map(([key, label]) => ({
        key, label, type: 'scale' as const, required: true, min: 0, max: 3, options: LIKERT,
      })),
      {
        key: 'difficulty',
        label: t(
          'If you checked any of the above, how difficult have they made things for you?',
          'Si marcó alguno de los anteriores, ¿qué tan difíciles le han hecho las cosas?',
        ),
        type: 'single_select' as const,
        options: [
          { value: 'not', label: t('Not difficult at all', 'Nada difíciles') },
          { value: 'somewhat', label: t('Somewhat difficult', 'Algo difíciles') },
          { value: 'very', label: t('Very difficult', 'Muy difíciles') },
          { value: 'extremely', label: t('Extremely difficult', 'Extremadamente difíciles') },
        ],
      },
      {
        key: 'anything_else',
        label: t(
          'Anything you would like your clinician to know before your session?',
          '¿Algo que quisiera que su especialista sepa antes de su sesión?',
        ),
        type: 'long_text' as const,
      },
    ],
  },
  scoring: {
    numericFields: ITEMS.map(([key]) => key),
    thresholds: [
      { id: 'minimal', min: 0, label: 'Minimal' },
      { id: 'mild', min: 5, label: 'Mild' },
      { id: 'moderate', min: 10, label: 'Moderate', alert: true },
      { id: 'moderately_severe', min: 15, label: 'Moderately severe', alert: true },
      { id: 'severe', min: 20, label: 'Severe', alert: true },
    ],
    // Any answer above "not at all" on item 9 reaches the clinician today,
    // whatever the total says. This is the reason critical items exist.
    criticalItems: [{ id: 'item_9', field: 'item_9', gte: 1 }],
  },
};

export const intakeForm: { schema: TemplateSchema; scoring: null } = {
  schema: {
    title: t('New Client Intake', 'Formulario de ingreso'),
    fields: [
      { key: 'preferred_name', label: t('What would you like to be called?', '¿Cómo le gustaría que le llamemos?'), type: 'short_text', required: true },
      { key: 'pronouns', label: t('Your pronouns', 'Sus pronombres'), type: 'short_text' },
      { key: 'referral', label: t('How did you hear about us?', '¿Cómo supo de nosotros?'), type: 'single_select', options: [
        { value: 'gp', label: t('A doctor', 'Un médico') },
        { value: 'friend', label: t('Someone I know', 'Alguien que conozco') },
        { value: 'search', label: t('I searched online', 'Busqué en internet') },
        { value: 'other', label: t('Something else', 'Otra cosa') },
      ] },
      { key: 'referral_other', label: t('Tell us more', 'Cuéntenos más'), type: 'short_text', showIf: { field: 'referral', equals: 'other' } },
      { key: 'prior_therapy', label: t('Have you worked with a therapist before?', '¿Ha trabajado antes con un terapeuta?'), type: 'boolean', required: true },
      { key: 'prior_therapy_when', label: t('Roughly when was that?', '¿Aproximadamente cuándo fue eso?'), type: 'short_text', showIf: { field: 'prior_therapy', equals: true } },
      { key: 'prior_therapy_helpful', label: t('What was helpful, or unhelpful, about it?', '¿Qué le sirvió, o qué no le sirvió, de esa experiencia?'), type: 'long_text', showIf: { field: 'prior_therapy', equals: true } },
      { key: 'goals', label: t('What would you like to be different?', '¿Qué le gustaría que fuera diferente?'), type: 'long_text', required: true },
      { key: 'medications', label: t('Any medications you take regularly', 'Medicamentos que toma con regularidad'), type: 'long_text' },
      { key: 'emergency_contact', label: t('Someone we can contact in an emergency', 'Alguien a quien podamos contactar en una emergencia'), type: 'short_text', required: true },
    ],
  },
  scoring: null,
};

/**
 * The consent form, and the reason this whole item exists.
 *
 * A client agreeing to a cancellation fee in a language they do not read has
 * not agreed to anything. Everything else in the portal is a convenience;
 * this is the one screen where comprehension is the point of the screen.
 *
 * The cancellation window is written into the question because it is what the
 * client is signing, and `PracticeSettings.lateCancelWindowHours` is what the
 * practice enforces. They are the same number today and a template revision is
 * how they stay that way — the consent a client signed must keep saying what
 * they were actually shown, which is exactly why templates version.
 */
export const consentToTreat: { schema: TemplateSchema; scoring: null } = {
  schema: {
    title: t('Consent to Treatment', 'Consentimiento para el tratamiento'),
    intro: t(
      'This agreement covers what to expect, how your information is handled, and the limits of confidentiality.',
      'Este acuerdo explica qué esperar, cómo se maneja su información, y los límites de la confidencialidad.',
    ),
    fields: [
      { key: 'read_policies', label: t('I have read the practice policies', 'He leído las políticas de la consulta'), type: 'boolean', required: true },
      { key: 'understand_limits', label: t('I understand the limits of confidentiality', 'Entiendo los límites de la confidencialidad'), type: 'boolean', required: true },
      { key: 'cancellation_policy', label: t('I understand the 24-hour cancellation policy', 'Entiendo la política de cancelación de 24 horas'), type: 'boolean', required: true },
      { key: 'signature', label: t('Type your full name to sign', 'Escriba su nombre completo para firmar'), type: 'signature', required: true },
    ],
  },
  scoring: null,
};

export const TEMPLATES = [
  { key: 'intake', name: 'New Client Intake', kind: 'intake' as const, ...intakeForm },
  { key: 'consent-to-treat', name: 'Consent to Treatment', kind: 'consent' as const, ...consentToTreat },
  { key: 'wellbeing-check-in', name: 'Wellbeing Check-In', kind: 'screener' as const, ...wellbeingCheckIn },
];
