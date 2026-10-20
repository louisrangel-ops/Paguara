import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ACCEPTED_AT_SIGNUP, LEGAL_VERSION } from '../../src/legal/legal-documents';

type Doc = { slug: string; title: string; accept: boolean; sections: [string, unknown[]][] };
const sandbox: { window: { LEGAL?: { version: string; docs: Doc[] } } } = { window: {} };
runInNewContext(readFileSync(join(__dirname, '../../public/assets/legal.js'), 'utf8'), sandbox);
const legal = sandbox.window.LEGAL!;

test('la versión de los textos de la web es la que el servidor registra al aceptar', () => {
  assert.equal(legal.version, LEGAL_VERSION);
});

test('los documentos que se aceptan al registrarse existen y están marcados como aceptables', () => {
  const accepted = [...legal.docs.filter((d) => d.accept).map((d) => d.slug)].sort(); // copia: el arreglo viene de otro contexto de vm
  assert.deepEqual(accepted, [...ACCEPTED_AT_SIGNUP].sort());
});

test('cada documento tiene slug único y secciones con contenido', () => {
  const slugs = legal.docs.map((d) => d.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const d of legal.docs) {
    assert.match(d.slug, /^[a-z-]+$/);
    assert.ok(d.sections.length > 0, d.slug);
    for (const [h, blocks] of d.sections) assert.ok(h && blocks.length > 0, `${d.slug}: ${h}`);
  }
});
