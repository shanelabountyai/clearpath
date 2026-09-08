-- Form question text becomes a language pair.
--
-- `FieldDef.label`, `help`, option labels and the template `intro` were plain
-- strings; they are now `{ "en": ..., "es": ... }`. This has to be a data
-- migration rather than a reseed because a submission renders against the
-- template *version* it was answered on — leaving old versions holding bare
-- strings would blank out the labels on every historical submission, which is
-- precisely the failure template versioning exists to prevent.
--
-- The Spanish half is written empty, not copied from the English. An empty
-- string is what `missingLanguages` reports and what makes `issueForm` refuse
-- to send that template to a Spanish-speaking client — the honest state, since
-- nobody has translated these rows. Copying the English across would produce a
-- template that passes the gate and sends English to somebody who cannot read
-- it, which is the exact failure this whole change exists to close.

DO $$
DECLARE
  tpl        RECORD;
  frec       RECORD;
  orec       RECORD;
  s          jsonb;
  fv         jsonb;
  ov         jsonb;
  new_fields jsonb;
  new_opts   jsonb;
BEGIN
  FOR tpl IN SELECT id, "schema" FROM "FormTemplate" LOOP
    s := tpl."schema";

    IF jsonb_typeof(s -> 'intro') = 'string' THEN
      s := jsonb_set(s, '{intro}', jsonb_build_object('en', s -> 'intro', 'es', '""'::jsonb));
    END IF;

    new_fields := '[]'::jsonb;
    FOR frec IN SELECT value FROM jsonb_array_elements(COALESCE(s -> 'fields', '[]'::jsonb)) LOOP
      fv := frec.value;

      IF jsonb_typeof(fv -> 'label') = 'string' THEN
        fv := jsonb_set(fv, '{label}', jsonb_build_object('en', fv -> 'label', 'es', '""'::jsonb));
      END IF;
      IF jsonb_typeof(fv -> 'help') = 'string' THEN
        fv := jsonb_set(fv, '{help}', jsonb_build_object('en', fv -> 'help', 'es', '""'::jsonb));
      END IF;

      IF jsonb_typeof(fv -> 'options') = 'array' THEN
        new_opts := '[]'::jsonb;
        FOR orec IN SELECT value FROM jsonb_array_elements(fv -> 'options') LOOP
          ov := orec.value;
          IF jsonb_typeof(ov -> 'label') = 'string' THEN
            ov := jsonb_set(ov, '{label}', jsonb_build_object('en', ov -> 'label', 'es', '""'::jsonb));
          END IF;
          new_opts := new_opts || jsonb_build_array(ov);
        END LOOP;
        fv := jsonb_set(fv, '{options}', new_opts);
      END IF;

      new_fields := new_fields || jsonb_build_array(fv);
    END LOOP;

    UPDATE "FormTemplate" SET "schema" = jsonb_set(s, '{fields}', new_fields) WHERE id = tpl.id;
  END LOOP;
END $$;
