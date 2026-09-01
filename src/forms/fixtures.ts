import type { TemplateSchema } from './schema.js';
import type { ScoringRules } from './scoring.js';

/**
 * Instruments the practice uses. Written here rather than in the seed so the
 * tests and the seeded data score identically — a fixture that drifts from what
 * the app ships is a test that proves nothing.
 *
 * These are original instruments for a synthetic practice. Real screeners are
 * licensed material; a learning project has no business shipping one.
 */

const LIKERT = [
  { value: 0, label: 'Not at all' },
  { value: 1, label: 'Several days' },
  { value: 2, label: 'More than half the days' },
  { value: 3, label: 'Nearly every day' },
];

const ITEMS: [string, string][] = [
  ['item_1', 'Little interest or pleasure in doing things'],
  ['item_2', 'Feeling down or hopeless'],
  ['item_3', 'Trouble falling asleep, staying asleep, or sleeping too much'],
  ['item_4', 'Feeling tired or having little energy'],
  ['item_5', 'Poor appetite or overeating'],
  ['item_6', 'Feeling bad about yourself, or that you have let people down'],
  ['item_7', 'Trouble concentrating'],
  ['item_8', 'Moving or speaking noticeably slowly, or being restless'],
  ['item_9', 'Thoughts that you would be better off not here, or of hurting yourself'],
];

export const wellbeingCheckIn: { schema: TemplateSchema; scoring: ScoringRules } = {
  schema: {
    intro: 'Over the last two weeks, how often have you been bothered by any of the following?',
    fields: [
      ...ITEMS.map(([key, label]) => ({
        key, label, type: 'scale' as const, required: true, min: 0, max: 3, options: LIKERT,
      })),
      {
        key: 'difficulty',
        label: 'If you checked any of the above, how difficult have they made things for you?',
        type: 'single_select' as const,
        options: [
          { value: 'not', label: 'Not difficult at all' },
          { value: 'somewhat', label: 'Somewhat difficult' },
          { value: 'very', label: 'Very difficult' },
          { value: 'extremely', label: 'Extremely difficult' },
        ],
      },
      {
        key: 'anything_else',
        label: 'Anything you would like your clinician to know before your session?',
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
    fields: [
      { key: 'preferred_name', label: 'What would you like to be called?', type: 'short_text', required: true },
      { key: 'pronouns', label: 'Your pronouns', type: 'short_text' },
      { key: 'referral', label: 'How did you hear about us?', type: 'single_select', options: [
        { value: 'gp', label: 'A doctor' }, { value: 'friend', label: 'Someone I know' },
        { value: 'search', label: 'I searched online' }, { value: 'other', label: 'Something else' },
      ] },
      { key: 'referral_other', label: 'Tell us more', type: 'short_text', showIf: { field: 'referral', equals: 'other' } },
      { key: 'prior_therapy', label: 'Have you worked with a therapist before?', type: 'boolean', required: true },
      { key: 'prior_therapy_when', label: 'Roughly when was that?', type: 'short_text', showIf: { field: 'prior_therapy', equals: true } },
      { key: 'prior_therapy_helpful', label: 'What was helpful, or unhelpful, about it?', type: 'long_text', showIf: { field: 'prior_therapy', equals: true } },
      { key: 'goals', label: 'What would you like to be different?', type: 'long_text', required: true },
      { key: 'medications', label: 'Any medications you take regularly', type: 'long_text' },
      { key: 'emergency_contact', label: 'Someone we can contact in an emergency', type: 'short_text', required: true },
    ],
  },
  scoring: null,
};

export const consentToTreat: { schema: TemplateSchema; scoring: null } = {
  schema: {
    intro:
      'This agreement covers what to expect, how your information is handled, and the limits of confidentiality.',
    fields: [
      { key: 'read_policies', label: 'I have read the practice policies', type: 'boolean', required: true },
      { key: 'understand_limits', label: 'I understand the limits of confidentiality', type: 'boolean', required: true },
      { key: 'cancellation_policy', label: 'I understand the 24-hour cancellation policy', type: 'boolean', required: true },
      { key: 'signature', label: 'Type your full name to sign', type: 'signature', required: true },
    ],
  },
  scoring: null,
};

export const TEMPLATES = [
  { key: 'intake', name: 'New Client Intake', kind: 'intake' as const, ...intakeForm },
  { key: 'consent-to-treat', name: 'Consent to Treatment', kind: 'consent' as const, ...consentToTreat },
  { key: 'wellbeing-check-in', name: 'Wellbeing Check-In', kind: 'screener' as const, ...wellbeingCheckIn },
];
