import { minutesToHHMM, utcToZoned, WEEKDAYS } from './time';

/**
 * Everything a client reads, in the language the practice writes them in.
 *
 * The messaging side learned this rule first (see `DENY_LISTS` in
 * `messaging/outbox.ts`): a language is a pair, and shipping half of it is
 * worse than shipping none, because the half that is missing fails silently.
 * The same applies here for a different reason. A reminder that arrives in
 * Spanish and links to a door written in English is not a partly-translated
 * feature — it is a client agreeing to a cancellation fee they were not shown
 * in a language they read, which is the one screen where comprehension is
 * load-bearing rather than polite.
 *
 * So `Record<Language, ...>` again, over every client-facing string at once:
 * a new language does not compile until it answers for all of them. The
 * templates, the deny-list and this dictionary are one unit with three files.
 *
 * Staff strings are deliberately absent. The practice works in one language;
 * this is about the people who did not choose it.
 */
export type Language = 'en' | 'es';
export const LANGUAGES = ['en', 'es'] as const;

/** Weekday names in the language the text around them is written in. */
export const WEEKDAY_NAMES: Record<Language, readonly string[]> = {
  en: WEEKDAYS,
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};

/**
 * `es-US`, not `es-ES`. A US practice bills a US client in dollars whichever
 * language it writes them in, and `es-ES` would render the fee with a euro
 * sign — a currency error dressed up as a translation.
 */
const MONEY_LOCALE: Record<Language, string> = { en: 'en-US', es: 'es-US' };

export const moneyIn = (language: Language, cents: number) =>
  new Intl.NumberFormat(MONEY_LOCALE[language], { style: 'currency', currency: 'USD' }).format(cents / 100);

/** "Tuesday 15:00" / "martes 15:00". Same clock, translated day. */
export const whenLabel = (language: Language, startAt: Date) => {
  const when = utcToZoned(startAt);
  return `${WEEKDAY_NAMES[language][when.weekday]} ${minutesToHHMM(when.minutes)}`;
};

/** Long form, for a list the client is reading rather than a one-line reminder. */
export const whenLong = (language: Language, startAt: Date) => {
  const when = utcToZoned(startAt);
  return `${WEEKDAY_NAMES[language][when.weekday]} ${when.date}, ${minutesToHHMM(when.minutes)}`;
};

/**
 * The four reasons, in both languages. The codes are the same four the portal
 * has always used — a decline and a reschedule request ask the same question,
 * and translating was never a reason to grow a second vocabulary.
 *
 * Declared here rather than imported from `portal/service` because this file
 * is reached from a `'use client'` component, and that module pulls in Prisma.
 * The page is where the two are checked against each other.
 */
type RescheduleReason = 'cannot_make_it' | 'need_a_different_time' | 'prefer_earlier' | 'prefer_later';

interface Strings {
  /** Tab titles. Read on a lock screen and over a shoulder, so they say nothing. */
  portalTitle: string;
  formTitle: string;
  doneTitle: string;

  linkInvalid: string;
  linkExpired: string;
  linkHelp: string;
  formAlreadySent: string;
  formLinkHelp: string;
  footer: string;

  greeting: (firstName: string) => string;
  portalIntro: string;
  noticeAsked: string;
  noticeConfirmed: string;
  noticeDeclined: string;
  nothingBooked: string;

  withClinician: (name: string) => string;
  byVideo: string;
  alreadyConfirmed: string;
  feeWarning: (hours: number, fee: string) => string;
  confirmYes: string;
  confirmNo: string;
  cancelYes: string;
  cancelKeep: string;
  changePending: string;
  changeAsk: string;
  reasonLabel: string;
  reasonBlank: string;
  reasons: Record<RescheduleReason, string>;

  formIntro: string;
  formSubmit: string;
  formSubmitting: string;
  formSaveLater: string;
  formSaved: string;
  chooseOne: string;
  yes: string;
  no: string;
  doneHeading: string;
  doneBody: string;
  doneClose: string;

  /**
   * Client-facing error copy, keyed by the service's `Conflict` code rather
   * than translated from its message. A service message is written for a log
   * and an engineer; echoing one to a client was always the wrong shape, and
   * a second language is what makes that obvious instead of merely untidy.
   */
  errors: Record<'already_submitted' | 'expired' | 'invalid' | 'unknown', string>;
}

export const UI: Record<Language, Strings> = {
  en: {
    portalTitle: 'Your appointments',
    formTitle: 'A form to complete',
    doneTitle: 'Sent',

    linkInvalid: 'This link is not valid',
    linkExpired: 'This link has expired',
    linkHelp: 'Reply to the message you received and someone will send you a new one.',
    formAlreadySent: 'This form has already been sent',
    formLinkHelp:
      'If you think you still need to complete something, reply to the message you received and someone will send a new link.',
    footer: 'This link is personal to you. Please do not forward it.',

    greeting: (firstName) => `Hello ${firstName}`,
    portalIntro:
      'Your upcoming appointments. To change one, choose a reason and someone will call you — nothing moves until you have spoken to them.',
    noticeAsked: 'Thank you — someone will be in touch about that appointment.',
    noticeConfirmed: 'Thank you — we have you down for that one.',
    noticeDeclined: 'That is cancelled. Reply to the message you received to rebook.',
    nothingBooked:
      'You have nothing booked at the moment. Reply to the message you received to arrange something.',

    withClinician: (name) => `With ${name}`,
    byVideo: 'by video',
    alreadyConfirmed: 'You have confirmed this one.',
    feeWarning: (hours, fee) =>
      `Cancelling within ${hours} hours of the appointment is charged at ${fee}. Do you still want to cancel it?`,
    confirmYes: 'Yes, I will be there',
    confirmNo: 'I cannot make it',
    cancelYes: 'Yes, cancel it',
    cancelKeep: 'Keep the appointment',
    changePending: 'You have asked to change this one. Someone will call you.',
    changeAsk: 'Ask to change this',
    reasonLabel: 'Reason',
    reasonBlank: 'Reason (optional)',
    reasons: {
      cannot_make_it: 'I cannot make this time',
      need_a_different_time: 'I need a different time',
      prefer_earlier: 'I would prefer something earlier',
      prefer_later: 'I would prefer something later',
    },

    formIntro:
      'Your answers go to your clinician. You can stop partway and come back using the same link.',
    formSubmit: 'Send to the practice',
    formSubmitting: 'Sending…',
    formSaveLater: 'Save and finish later',
    formSaved: 'Saved. Your link will bring you back here.',
    chooseOne: 'Choose one…',
    yes: 'Yes',
    no: 'No',
    doneHeading: 'Thank you — that has been sent.',
    doneBody:
      'Your answers have gone to your clinician and they will have read them before you next meet. There is nothing else you need to do.',
    doneClose: 'You can close this page. The link will not open again.',

    errors: {
      already_submitted: 'You have already sent this one. There is nothing left to do.',
      expired: 'This link has expired. Reply to the message you received and someone will send a new one.',
      invalid: 'Some questions still need an answer. The ones marked * cannot be left blank.',
      unknown: 'That did not go through. Please try again, or reply to the message you received.',
    },
  },
  es: {
    portalTitle: 'Sus citas',
    formTitle: 'Un formulario para completar',
    doneTitle: 'Enviado',

    linkInvalid: 'Este enlace no es válido',
    linkExpired: 'Este enlace ha vencido',
    linkHelp: 'Responda al mensaje que recibió y le enviaremos uno nuevo.',
    formAlreadySent: 'Este formulario ya fue enviado',
    formLinkHelp:
      'Si cree que todavía tiene algo pendiente por completar, responda al mensaje que recibió y le enviaremos un enlace nuevo.',
    footer: 'Este enlace es personal. Por favor no lo reenvíe.',

    greeting: (firstName) => `Hola ${firstName}`,
    portalIntro:
      'Sus próximas citas. Para cambiar una, elija un motivo y alguien le llamará — nada se mueve hasta que haya hablado con esa persona.',
    noticeAsked: 'Gracias — alguien se comunicará con usted sobre esa cita.',
    noticeConfirmed: 'Gracias — le tenemos anotado para esa.',
    noticeDeclined: 'Esa cita queda cancelada. Responda al mensaje que recibió para programar otra.',
    nothingBooked:
      'En este momento no tiene ninguna cita programada. Responda al mensaje que recibió para programar una.',

    withClinician: (name) => `Con ${name}`,
    byVideo: 'por video',
    alreadyConfirmed: 'Usted ya confirmó esta cita.',
    feeWarning: (hours, fee) =>
      `Cancelar dentro de las ${hours} horas previas a la cita tiene un cargo de ${fee}. ¿Aun así desea cancelarla?`,
    confirmYes: 'Sí, allí estaré',
    confirmNo: 'No puedo asistir',
    cancelYes: 'Sí, cancelarla',
    cancelKeep: 'Conservar la cita',
    changePending: 'Usted pidió cambiar esta cita. Alguien le llamará.',
    changeAsk: 'Pedir un cambio',
    reasonLabel: 'Motivo',
    reasonBlank: 'Motivo (opcional)',
    reasons: {
      cannot_make_it: 'No puedo a esta hora',
      need_a_different_time: 'Necesito otro horario',
      prefer_earlier: 'Preferiría algo más temprano',
      prefer_later: 'Preferiría algo más tarde',
    },

    formIntro:
      'Sus respuestas van a su especialista. Puede detenerse a medio camino y volver con el mismo enlace.',
    formSubmit: 'Enviar a la consulta',
    formSubmitting: 'Enviando…',
    formSaveLater: 'Guardar y terminar más tarde',
    formSaved: 'Guardado. Su enlace le traerá de vuelta aquí.',
    chooseOne: 'Elija una opción…',
    yes: 'Sí',
    no: 'No',
    doneHeading: 'Gracias — eso ya fue enviado.',
    doneBody:
      'Sus respuestas llegaron a su especialista y las habrá leído antes de que se vean la próxima vez. No hay nada más que deba hacer.',
    doneClose: 'Puede cerrar esta página. El enlace no volverá a abrirse.',

    errors: {
      already_submitted: 'Usted ya envió este formulario. No queda nada por hacer.',
      expired: 'Este enlace ha vencido. Responda al mensaje que recibió y le enviaremos uno nuevo.',
      invalid: 'Todavía faltan respuestas. Las preguntas marcadas con * no pueden quedar en blanco.',
      unknown: 'No se pudo enviar. Inténtelo de nuevo o responda al mensaje que recibió.',
    },
  },
};
