'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '../../../src/db';
import { publishTemplate } from '../../../src/forms/service';
import { requireSession } from '../../../src/session';
import type { FieldDef, TemplateSchema } from '../../../src/forms/schema';
import type { ScoringRules } from '../../../src/forms/scoring';

/**
 * Publishing a revision creates a new version and leaves every existing
 * submission pointing at the one it was answered on. There is deliberately no
 * "edit in place": that is the operation that would silently rewrite history.
 */
export async function publishRevision(formData: FormData) {
  const { actor } = await requireSession();
  const templateId = String(formData.get('templateId'));

  const current = await prisma.formTemplate.findUniqueOrThrow({ where: { id: templateId } });
  const schema = current.schema as unknown as TemplateSchema;

  const fields: FieldDef[] = schema.fields.map((f) => ({
    ...f,
    label: String(formData.get(`label:${f.key}`) ?? f.label),
    required: formData.get(`required:${f.key}`) === 'on',
  }));

  const newKey = String(formData.get('newFieldKey') ?? '').trim();
  const newLabel = String(formData.get('newFieldLabel') ?? '').trim();
  if (newKey && newLabel && !fields.some((f) => f.key === newKey)) {
    fields.push({
      key: newKey.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
      label: newLabel,
      type: String(formData.get('newFieldType') ?? 'short_text') as FieldDef['type'],
    });
  }

  const removed = new Set(formData.getAll('remove').map(String));
  const next = fields.filter((f) => !removed.has(f.key));

  const published = await publishTemplate(actor, {
    key: current.key,
    name: String(formData.get('name') ?? current.name),
    kind: current.kind,
    schema: { ...schema, fields: next },
    scoring: (current.scoring ?? null) as ScoringRules | null,
  });

  revalidatePath('/forms');
  redirect(`/forms?template=${published.id}`);
}
