(function () {
  const ACTIVE_KEY = 'activeTailoredDocument';
  const RECORD_PREFIX = 'tailoredDocument:';
  const OBSOLETE_KEYS = [
    'tailoredCvExport',
    'tailoredCvContactUrls',
    'tailoredCvLinkAnnotations',
    'tailoredCvStructured',
  ];
  let writeQueue = Promise.resolve();

  function serialized(operation) {
    const result = writeQueue.then(operation, operation);
    writeQueue = result.catch(() => {});
    return result;
  }

  function recordKey(documentId, revision) {
    return `${RECORD_PREFIX}${documentId}:${revision}`;
  }

  function valid(document, expected = {}) {
    return document?.schemaVersion === 1
      && typeof document.documentId === 'string'
      && Number.isInteger(document.revision)
      && document.revision > 0
      && document.skeleton && document.content
      && typeof document.renderedText === 'string'
      && (!expected.documentId || document.documentId === expected.documentId)
      && (!expected.revision || document.revision === expected.revision);
  }

  function create(result, metadata = {}) {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      documentId: crypto.randomUUID(),
      revision: 1,
      skeleton: result.skeleton || result.structuredCv?.skeleton,
      content: result.content || result.structuredCv?.content,
      renderedText: String(result.renderedText || result.tailoredCvText || ''),
      audit: result.audit || { status: 'passed', recovered: false },
      metadata,
      updatedAt: now,
    };
  }

  async function saveNew(document) {
    if (!valid(document)) throw new Error('Invalid tailored document');
    return serialized(async () => {
      const key = recordKey(document.documentId, document.revision);
      const existing = await chrome.storage.local.get(key);
      if (existing[key]) throw new Error('Tailored document revisions are immutable');
      await chrome.storage.local.set({ [ACTIVE_KEY]: document, [key]: document });
      await chrome.storage.local.remove(OBSOLETE_KEYS);
      return document;
    });
  }

  // Optimistic revision check prevents a delayed textarea save from replacing
  // a newer edit or a newly generated document.
  async function saveReviewedText(documentId, expectedRevision, renderedText) {
    return saveRevision(documentId, expectedRevision, {
      renderedText: String(renderedText),
      audit: current => ({
        ...current.audit, edited: true, provenance: 'user-authored-reviewed-text',
        editedClaimsEvidence: 'not-asserted',
      }),
    });
  }

  async function saveRevision(documentId, expectedRevision, changes) {
    return serialized(async () => {
      const stored = await chrome.storage.local.get(ACTIVE_KEY);
      const current = stored[ACTIVE_KEY];
      if (!valid(current, { documentId, revision: expectedRevision })) return null;
      const next = {
        ...current,
        revision: current.revision + 1,
        ...changes,
        audit: typeof changes.audit === 'function' ? changes.audit(current) : (changes.audit || current.audit),
        updatedAt: new Date().toISOString(),
      };
      const key = recordKey(next.documentId, next.revision);
      const existing = await chrome.storage.local.get(key);
      if (existing[key]) throw new Error('Tailored document revisions are immutable');
      await chrome.storage.local.set({ [ACTIVE_KEY]: next, [key]: next });
      await chrome.storage.local.remove(OBSOLETE_KEYS);
      return next;
    });
  }

  async function loadActive() {
    const result = await chrome.storage.local.get(ACTIVE_KEY);
    return valid(result[ACTIVE_KEY]) ? result[ACTIVE_KEY] : null;
  }

  async function loadRevision(documentId, revision) {
    const key = recordKey(documentId, revision);
    const result = await chrome.storage.local.get(key);
    return valid(result[key], { documentId, revision }) ? result[key] : null;
  }

  async function clearActive(documentId, revision) {
    return serialized(async () => {
      if (documentId || revision) {
        const stored = await chrome.storage.local.get(ACTIVE_KEY);
        if (!valid(stored[ACTIVE_KEY], { documentId, revision })) return false;
      }
      await chrome.storage.local.remove(ACTIVE_KEY);
      return true;
    });
  }

  globalThis.TailoredDocumentStore = {
    ACTIVE_KEY, OBSOLETE_KEYS, clearActive, create, loadActive, loadRevision, saveNew, saveRevision, saveReviewedText, valid,
  };
})();
