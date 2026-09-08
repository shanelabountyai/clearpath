'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '../../../src/db';
import { publishTemplate } from '../../../src/forms/service';
import { requireSession } from '../../../src/session';
import type { FieldDef, TemplateSchema } from '../../../src/forms/schema';
import { LANGUAGES, type Language } from '../../../src/strings';
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

  /**
   * One input per language, and a blank one is kept as blank.
   *
   * The tempting alternative — falling back to the English when the Spanish is
   * empty — is the exact failure the messaging deny-list was built to stop, one
   * layer up: it produces a form that *looks* translated, sends without
   * complaint, and puts English questions in front of a Spanish-speaking
   * client. Left empty, `missingLanguages` sees it and `issueForm` refuses,
   * which is a practice manager with a list of keys instead of a client with a
   * form they cannot read.
   */
  const labelFrom = (prefix: string, fallback?: Record<Language, string>) =>
    Object.fromEntries(
      LANGUAGES.map((l) => [l, String(formData.get(`${prefix}:${l}`) ?? fallback?.[l] ?? '').trim()]),
    ) as Record<Language, string>;

  const fields: FieldDef[] = schema.fields.map((f) => ({
    ...f,
    label: labelFrom(`label:${f.key}`, f.label),
    required: formData.get(`required:${f.key}`) === 'on',
  }));

  const newKey = String(formData.get('newFieldKey') ?? '').trim();
  const newLabel = labelFrom('newFieldLabel');
  if (newKey && newLabel.en && !fields.some((f) => f.key === newKey)) {
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
