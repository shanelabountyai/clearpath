import type { Language } from '../messaging/language';

/**
 * Every word on the client's door, in every language the practice writes in.
 *
 * The reminder is translated and the page it points at is the other half of the
 * same sentence. A Spanish message saying "let us know if you are coming" that
 * links to an English page with two English buttons is a loop the client cannot
 * complete — and this feature's fee rests on them completing it, which makes an
 * untranslated door a way of charging somebody for a language barrier.
 *
 * It is a flat dictionary rather than an i18n library on purpose. There are two
 * languages and about twenty strings; a library would add a build step, a
 * runtime, a lookup that fails silently on a missing key, and a place for
 * copy to live that is not next to the rule about what copy may say. The
 * `Record<Language, ...>` type is the completeness check — a missing language
 * is a type error rather than a page that renders `undefined` at somebody.
 *
 * Everything here passes the same deny-list the messages do. The door is behind
 * a token, but a token arrives in a message on a phone, and the page is one tap
 * from a lock screen.
 */
export interface PortalCopy {
  greeting: (firstName: string) => string;
  intro: string;
  askedNotice: string;
  confirmedNotice: string;
  declinedNotice: string;
  nothingBooked: string;
  invalidLink: string;
  expiredLink: string;
  linkHelp: string;
  with: (clinician: string) => string;
  byVideo: string;
  alreadyConfirmed: string;
  confirmButton: string;
  declineButton: string;
  /** The fee disclosure, which has to be exact in both. */
  feeWarning: (windowHours: number, fee: string) => string;
  feeConfirmButton: string;
  feeKeepLink: string;
  reasonLabel: string;
  /** Separates the request from the cancellation directly above it. */
  rescheduleLead: string;
  askToChange: string;
  changePending: string;
  footer: string;
  cadenceHeading: string;
  cadenceHelp: string;
  cadenceSave: string;
  cadenceSaved: string;
  cadences: Record<'full' | 'day_before' | 'day_of', string>;
  reasons: Record<'cannot_make_it' | 'need_a_different_time' | 'prefer_earlier' | 'prefer_later', string>;
}

export const PORTAL_COPY: Record<Language, PortalCopy> = {
  en: {
    greeting: (firstName) => `Hello ${firstName}`,
    intro:
      'Your upcoming appointments. To change one, choose a reason and someone will '
      + 'call you — nothing moves until you have spoken to them.',
    askedNotice: 'Thank you — someone will be in touch about that appointment.',
    confirmedNotice: 'Thank you — we have you down for that one.',
    declinedNotice: 'That is cancelled. Reply to the message you received to rebook.',
    nothingBooked:
      'You have nothing booked at the moment. Reply to the message you received to '
      + 'arrange something.',
    invalidLink: 'This link is not valid',
    expiredLink: 'This link has expired',
    linkHelp: 'Reply to the message you received and someone will send you a new one.',
    with: (clinician) => `With ${clinician}`,
    byVideo: 'by video',
    alreadyConfirmed: 'You have confirmed this one.',
    confirmButton: 'Yes, I will be there',
    declineButton: 'I cannot make it',
    feeWarning: (windowHours, fee) =>
      `Cancelling within ${windowHours} hours of the appointment is charged at ${fee}. `
      + 'Do you still want to cancel it?',
    feeConfirmButton: 'Yes, cancel it',
    feeKeepLink: 'Keep the appointment',
    reasonLabel: 'Reason',
    rescheduleLead: 'Or, if you would rather keep it and move it:',
    askToChange: 'Ask to change this',
    changePending: 'You have asked to change this one. Someone will call you.',
    footer: 'This link is personal to you. Please do not forward it.',
    cadenceHeading: 'How many reminders you get',
    // Says what it does *not* do, because the question this control makes
    // somebody ask is "can I stop them altogether", and the honest answer is a
    // phone call rather than a setting a forwarded link could reach.
    cadenceHelp:
      'You will still get at least one message before each appointment. To stop them '
      + 'entirely, or to change where they are sent, please call us — that is not '
      + 'something this page can do.',
    cadenceSave: 'Save',
    cadenceSaved: 'Saved — that is how many you will get from now on.',
    cadences: {
      full: 'All three: five days, the day before, and the day of',
      day_before: 'One, the day before',
      day_of: 'One, on the day',
    },
    reasons: {
      cannot_make_it: 'I cannot make this time',
      need_a_different_time: 'I need a different time',
      prefer_earlier: 'I would prefer something earlier',
      prefer_later: 'I would prefer something later',
    },
  },
  es: {
    greeting: (firstName) => `Hola ${firstName}`,
    intro:
      'Sus próximas citas. Para cambiar una, elija un motivo y alguien le llamará — '
      + 'nada se mueve hasta que haya hablado con esa persona.',
    askedNotice: 'Gracias — alguien se pondrá en contacto sobre esa cita.',
    confirmedNotice: 'Gracias — le esperamos.',
    declinedNotice: 'Esa cita queda cancelada. Responda al mensaje que recibió para reservar otra.',
    nothingBooked:
      'No tiene ninguna cita reservada en este momento. Responda al mensaje que recibió '
      + 'para concertar una.',
    invalidLink: 'Este enlace no es válido',
    expiredLink: 'Este enlace ha caducado',
    linkHelp: 'Responda al mensaje que recibió y alguien le enviará uno nuevo.',
    with: (clinician) => `Con ${clinician}`,
    byVideo: 'por videollamada',
    alreadyConfirmed: 'Ya ha confirmado esta cita.',
    confirmButton: 'Sí, allí estaré',
    declineButton: 'No puedo asistir',
    // The figure and the window stay numbers in both, so the one sentence with
    // money in it cannot be got wrong by a translation.
    feeWarning: (windowHours, fee) =>
      `Cancelar dentro de las ${windowHours} horas previas a la cita conlleva un cargo de ${fee}. `
      + '¿Aún desea cancelarla?',
    feeConfirmButton: 'Sí, cancelarla',
    feeKeepLink: 'Mantener la cita',
    reasonLabel: 'Motivo',
    rescheduleLead: 'O, si prefiere mantenerla y cambiarla de hora:',
    askToChange: 'Pedir un cambio',
    changePending: 'Ha pedido cambiar esta cita. Alguien le llamará.',
    footer: 'Este enlace es personal. Por favor no lo reenvíe.',
    cadenceHeading: 'Cuántos recordatorios recibe',
    cadenceHelp:
      'Siempre recibirá al menos un mensaje antes de cada cita. Para dejar de recibirlos '
      + 'por completo, o para cambiar a dónde se envían, por favor llámenos — eso no es '
      + 'algo que esta página pueda hacer.',
    cadenceSave: 'Guardar',
    cadenceSaved: 'Guardado — así es como los recibirá a partir de ahora.',
    cadences: {
      full: 'Los tres: cinco días antes, el día anterior y el mismo día',
      day_before: 'Uno, el día anterior',
      day_of: 'Uno, el mismo día',
    },
    reasons: {
      cannot_make_it: 'No puedo a esta hora',
      need_a_different_time: 'Necesito otra hora',
      prefer_earlier: 'Preferiría una hora más temprano',
      prefer_later: 'Preferiría una hora más tarde',
    },
  },
};
