import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

function storeHarness(initial = {}) {
  const values = structuredClone(initial);
  const code = fs.readFileSync(new URL('../extension-ready/tailored-document.js', import.meta.url), 'utf8');
  const sandbox = {
    crypto: webcrypto,
    structuredClone,
    chrome: { storage: { local: {
      async get(keys) {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter(key => key in values).map(key => [key, structuredClone(values[key])]));
      },
      async set(next) { Object.assign(values, structuredClone(next)); },
      async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key]; },
    } } },
  };
  vm.runInNewContext(code, sandbox);
  return { api: sandbox.TailoredDocumentStore, values };
}

const result = {
  schemaVersion: 1,
  skeleton: { name: 'Zoë Example', roles: [] },
  content: { summary: 'Reliable systems', roles: [] },
  renderedText: 'Zoë Example\n• Reliable systems → shipped',
  audit: { status: 'passed', recovered: false },
};

describe('durable tailored document storage', () => {
  it('persists exact reviewed text while retaining safe structured source and sacred data', async () => {
    const sacred = { cvText: 'source', cvLinkAnnotations: [{ text: 'Portfolio' }], userProfileLinks: ['https://example.test'], applicationFacts: { skill: 'JS' }, confirmedSkills: ['JS'] };
    const { api, values } = storeHarness({ ...sacred, tailoredCvExport: 'obsolete' });
    const original = await api.saveNew(api.create(result));
    const editedText = 'Zoë Example\n• User-edited Unicode → café';
    const edited = await api.saveReviewedText(original.documentId, original.revision, editedText);

    expect(edited.renderedText).toBe(editedText);
    expect(edited.revision).toBe(2);
    expect(edited.skeleton).toEqual(original.skeleton);
    expect(edited.content).toEqual(original.content);
    expect(edited.audit.provenance).toBe('user-authored-reviewed-text');
    expect(values.tailoredCvExport).toBeUndefined();
    for (const [key, value] of Object.entries(sacred)) expect(values[key]).toEqual(value);
    expect((await api.loadRevision(original.documentId, 1)).renderedText).toBe(result.renderedText);
    expect((await api.loadRevision(original.documentId, 2)).renderedText).toBe(editedText);
  });

  it('rejects stale save ordering and edits to an obsolete document', async () => {
    const { api } = storeHarness();
    const first = await api.saveNew(api.create(result));
    const newer = await api.saveReviewedText(first.documentId, 1, 'newer');
    expect(await api.saveReviewedText(first.documentId, 1, 'stale')).toBeNull();
    const replacement = await api.saveNew(api.create(result));
    expect(await api.saveReviewedText(newer.documentId, newer.revision, 'wrong document')).toBeNull();
    expect((await api.loadActive()).documentId).toBe(replacement.documentId);
  });

  it('serializes concurrent saves so only one revision can win', async () => {
    const { api } = storeHarness();
    const first = await api.saveNew(api.create(result));
    const saves = await Promise.all([
      api.saveReviewedText(first.documentId, first.revision, 'first edit'),
      api.saveReviewedText(first.documentId, first.revision, 'second edit'),
    ]);

    expect(saves.filter(Boolean)).toHaveLength(1);
    expect((await api.loadActive()).renderedText).toBe(saves.find(Boolean).renderedText);
    expect((await api.loadRevision(first.documentId, 1)).renderedText).toBe(result.renderedText);
  });

  it('invalidates the active document without deleting its immutable revision history', async () => {
    const { api } = storeHarness();
    const document = await api.saveNew(api.create(result));

    await api.clearActive();

    expect(await api.loadActive()).toBeNull();
    expect((await api.loadRevision(document.documentId, document.revision)).renderedText).toBe(result.renderedText);
  });
});
