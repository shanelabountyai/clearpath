import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Forbidden } from '../errors';
import { actor, makeClient, makeUser, resetDb } from '../test/harness';
import { publishTemplate, issueForm, submitForm } from './service';
import { wellbeingCheckIn } from './fixtures';
import { screenerTrends, trendSeries, type TrendInput } from './trends';
import type { ScoringRules } from './scoring';

const RULES: ScoringRules = {
  thresholds: [
    { id: 'minimal', min: 0, label: 'Minimal' },
    { id: 'moderate', min: 10, label: 'Moderate', alert: true },
    { id: 'severe', min: 20, label: 'Severe', alert: true },
  ],
};

const point = (
  o: Omit<Partial<TrendInput>, 'at' | 'total'> & { total: number | null; at: string },
): TrendInput => ({
  submissionId: `s-${o.at}`,
  templateVersion: 1,
  needsReview: false,
  ...o,
  at: new Date(o.at),
});

describe('a series over one instrument', () => {
  it('orders oldest first, whatever order it was handed', () => {
    const series = trendSeries(
      [point({ at: '2026-03-01', total: 4 }), point({ at: '2026-01-01', total: 12 }), point({ at: '2026-02-01', total: 8 })],
      RULES,
    );
    expect(series.map((p) => p.total)).toEqual([12, 8, 4]);
  });

  it('labels each total with the band it falls in', () => {
    const series = trendSeries(
      [point({ at: '2026-01-01', total: 4 }), point({ at: '2026-02-01', total: 14 }), point({ at: '2026-03-01', total: 22 })],
      RULES,
    );
    expect(series.map((p) => p.band?.id)).toEqual(['minimal', 'moderate', 'severe']);
  });

  it('gives the first point no delta, because there is nothing behind it', () => {
    const [first] = trendSeries([point({ at: '2026-01-01', total: 12 })], RULES);
    expect(first!.delta).toBeNull();
    expect(first!.comparableToPrevious).toBe(false);
  });

  it('reports the change between consecutive points', () => {
    const series = trendSeries(
      [point({ at: '2026-01-01', total: 12 }), point({ at: '2026-02-01', total: 7 })],
      RULES,
    );
    expect(series[1]!.delta).toBe(-5);
  });

  it('notes when a point crossed into another band', () => {
    const series = trendSeries(
      [point({ at: '2026-01-01', total: 12 }), point({ at: '2026-02-01', total: 9 }), point({ at: '2026-03-01', total: 8 })],
      RULES,
    );
    expect(series[1]!.bandChanged).toBe(true);
    expect(series[2]!.bandChanged).toBe(false);
  });

  it('leaves unscored submissions out rather than plotting them as zero', () => {
    const series = trendSeries(
      [point({ at: '2026-01-01', total: 12 }), point({ at: '2026-02-01', total: null })],
      RULES,
    );
    expect(series).toHaveLength(1);
  });
});

describe('a scoring revision breaks the line', () => {
  it('refuses a delta across a version change', () => {
    const series = trendSeries(
      [
        point({ at: '2026-01-01', total: 12, templateVersion: 1 }),
        point({ at: '2026-02-01', total: 6, templateVersion: 2 }),
      ],
      RULES,
    );
    expect(series[1]!.delta).toBeNull();
    expect(series[1]!.comparableToPrevious).toBe(false);
  });

  it('does not call a rules edit a band change either', () => {
    const series = trendSeries(
      [
        point({ at: '2026-01-01', total: 22, templateVersion: 1 }),
        point({ at: '2026-02-01', total: 4, templateVersion: 2 }),
      ],
      RULES,
    );
    expect(series[1]!.bandChanged).toBe(false);
  });

  it('resumes comparing once two points share a version again', () => {
    const series = trendSeries(
      [
        point({ at: '2026-01-01', total: 12, templateVersion: 1 }),
        point({ at: '2026-02-01', total: 6, templateVersion: 2 }),
        point({ at: '2026-03-01', total: 9, templateVersion: 2 }),
      ],
      RULES,
    );
    expect(series[2]!.delta).toBe(3);
    expect(series[2]!.comparableToPrevious).toBe(true);
  });
});

describe('who can see a client trend', () => {
  const KEY = 'wellbeing-check-in';
  const answers = (item1: number) => ({
    item_1: item1, item_2: 0, item_3: 0, item_4: 0, item_5: 0,
    item_6: 0, item_7: 0, item_8: 0, item_9: 0,
  });

  let admin: Awaited<ReturnType<typeof makeUser>>;
  let desk: Awaited<ReturnType<typeof makeUser>>;
  let mine: Awaited<ReturnType<typeof makeUser>>;
  let boss: Awaited<ReturnType<typeof makeUser>>;
  let supervisor: Awaited<ReturnType<typeof makeUser>>;
  let associate: Awaited<ReturnType<typeof makeUser>>;
  let client: Awaited<ReturnType<typeof makeClient>>;

  const answer = async (key: string, item1: number) => {
    const { token } = await issueForm(actor(desk), { clientId: client.id, templateKey: key });
    await submitForm(token, answers(item1));
  };

  beforeEach(async () => {
    await resetDb();
    admin = await makeUser('admin');
    desk = await makeUser('front_desk');
    boss = await makeUser('admin');
    supervisor = await makeUser('supervisor');
    associate = await makeUser('associate', { supervisorId: supervisor.id });
    mine = await makeUser('therapist');
    client = await makeClient(mine.id);

    await publishTemplate(actor(admin), {
      key: KEY, name: 'Wellbeing Check-In', kind: 'screener', ...wellbeingCheckIn,
    });
  });

  afterAll(async () => {
    await resetDb();
    await prisma.$disconnect();
  });

  it('shows the treating clinician their own client', async () => {
    await answer(KEY, 2);
    const trends = await screenerTrends(actor(mine), client.id);
    expect(trends).toHaveLength(1);
    expect(trends[0]!.points).toHaveLength(1);
    expect(trends[0]!.points[0]!.total).toBe(2);
  });

  it('builds the series in submission order', async () => {
    await answer(KEY, 3);
    await answer(KEY, 1);
    const [trend] = await screenerTrends(actor(mine), client.id);
    expect(trend!.points.map((p) => p.total)).toEqual([3, 1]);
    expect(trend!.points[1]!.delta).toBe(-2);
  });

  it('refuses front desk, who never sees a score', async () => {
    await expect(screenerTrends(actor(desk), client.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it('refuses the practice manager even in a break-glass session', async () => {
    await expect(
      screenerTrends(actor(boss, 'audit request'), client.id),
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it('refuses a clinician who does not treat this client', async () => {
    const other = await makeUser('therapist');
    await expect(screenerTrends(actor(other), client.id)).rejects.toBeInstanceOf(Forbidden);
  });

  it("reaches a supervisee's client, the same as the rest of that record", async () => {
    const theirs = await makeClient(associate.id);
    await expect(screenerTrends(actor(supervisor), theirs.id)).resolves.toEqual([]);
  });

  it('logs the read like any other clinical read', async () => {
    await screenerTrends(actor(mine), client.id);
    const row = await prisma.auditEvent.findFirst({
      where: { actorId: mine.id, resource: 'form_submission', action: 'read' },
    });
    expect(row?.clientId).toBe(client.id);
  });

  it('separates instruments instead of drawing them on one line', async () => {
    await publishTemplate(actor(admin), {
      key: 'sleep-check', name: 'Sleep check', kind: 'screener', ...wellbeingCheckIn,
    });
    await answer(KEY, 2);
    await answer('sleep-check', 1);

    const trends = await screenerTrends(actor(mine), client.id);
    expect(trends.map((t) => t.templateKey).sort()).toEqual(['sleep-check', KEY]);
    expect(trends.every((t) => t.points.length === 1)).toBe(true);
  });

  it('does not mark a series whose instrument never moved', async () => {
    // The positive case below is the one that was asserted. Without this, a
    // `spansVersions` that was simply always true would satisfy the suite —
    // and every trend would then refuse to draw the deltas it exists to draw.
    await answer(KEY, 3);
    await answer(KEY, 1);

    const [trend] = await screenerTrends(actor(mine), client.id);
    expect(trend!.spansVersions).toBe(false);
    expect(trend!.points[1]!.comparableToPrevious).toBe(true);
  });

  it('marks a series whose instrument was revised underneath it', async () => {
    await answer(KEY, 3);
    await publishTemplate(actor(admin), {
      key: KEY, name: 'Wellbeing Check-In', kind: 'screener', ...wellbeingCheckIn,
    });
    await answer(KEY, 1);

    const [trend] = await screenerTrends(actor(mine), client.id);
    expect(trend!.spansVersions).toBe(true);
    expect(trend!.points[1]!.delta).toBeNull();
    expect(trend!.points[1]!.comparableToPrevious).toBe(false);
  });
});
