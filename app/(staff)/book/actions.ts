'use server';

import { redirect } from 'next/navigation';
import { prisma } from '../../../src/db';
import { Conflict } from '../../../src/errors';
import { requireSession } from '../../../src/session';
import { bookAppointment, materialiseSeries } from '../../../src/scheduling/booking';
import { queueToClient } from '../../../src/messaging/outbox';
import { weekdayOf, zonedToUtc } from '../../../src/time';
import type { AppointmentType } from '../../../src/scheduling/recurrence';
import { systemClock } from '@/src/clock';

type Modality = 'in_person' | 'telehealth';

/**
 * Book a one-off, or start a standing series.
 *
 * A recurring booking creates the pattern and materialises it to the practice's
 * horizon in one go, so front desk sees the whole run of weeks immediately
 * rather than trusting that a job will fill them in later. Weeks the practice
 * cannot honour come back as `skipped` and are reported rather than swallowed.
 */
export async function book(formData: FormData) {
  const { actor } = await requireSession();

  const clientId = String(formData.get('clientId'));
  const clinicianId = String(formData.get('clinicianId'));
  const date = String(formData.get('date'));
  const startMinute = Number(formData.get('startMinute'));
  const type = String(formData.get('type') ?? 'standard') as AppointmentType;
  const modality = String(formData.get('modality') ?? 'in_person') as Modality;
  const recurrence = String(formData.get('recurrence') ?? 'once');

  const back = (params: Record<string, string>) =>
    redirect(`/book?${new URLSearchParams({ clientId, clinicianId, date, type, modality, ...params })}`);

  try {
    if (recurrence === 'once') {
      const appt = await bookAppointment(actor, { clientId, clinicianId, date, startMinute, type, modality });
      await queueToClient({
        clientId, templateKey: 'appointment_confirmed',
        scheduledFor: systemClock.now(), startAt: appt.startAt,
      });
      redirect(`/appointments/${appt.id}`);
    }

    const series = await prisma.appointmentSeries.create({
      data: {
        clientId, clinicianId, type, modality,
        frequency: recurrence === 'biweekly' ? 'biweekly' : 'weekly',
        weekday: weekdayOf(date),
        startMinute,
        startDate: zonedToUtc(date, 12 * 60),
      },
    });
    const run = await materialiseSeries(actor, series.id, { from: date });
    back({
      booked: String(run.created.length),
      skipped: run.skipped.join(','),
      seriesId: series.id,
    });
  } catch (e) {
    if (e instanceof Conflict) back({ error: e.message });
    throw e;
  }
}
