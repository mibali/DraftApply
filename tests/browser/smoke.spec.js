import { test, expect } from './extension.fixture.js';

const CV = 'Jane Example\nSenior Engineer\nFive years building JavaScript systems and deterministic browser automation.';

async function popup(extension) {
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  return page;
}

async function saveCv(page) {
  await page.locator('#cv-text').fill(CV);
  await page.locator('#save-cv-btn').click();
  await expect(page.locator('#cv-loaded-section')).toBeVisible();
}

async function activate(extension, popupPage, jobPage) {
  await jobPage.bringToFront();
  // The test manifest auto-injects only on the loopback fixture. If startup
  // raced navigation, exercise the popup's explicit activation path.
  if (await popupPage.locator('#activate-btn').isVisible()) await popupPage.locator('#activate-btn').click();
  await expect(jobPage.locator('.da-field-btn-overlay')).toHaveCount(1);
}

test('popup saves and reloads CV, then activates content on an arbitrary page', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const first = await popup(extension);
  await saveCv(first);
  await first.reload();
  await expect(first.locator('#cv-loaded-section')).toBeVisible();
  const stored = await extension.worker.evaluate(() => chrome.storage.local.get('cvText'));
  expect(stored.cvText).toBe(CV);
  await activate(extension, first, job);
});

test('atomic validated answers gate insertion and requests are structured and authenticated', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension);
  await saveCv(pop);
  await activate(extension, pop, job);
  const field = job.locator('#application-answer');
  await field.focus();
  await job.locator('.da-field-btn-overlay').click();
  const insert = job.locator('#da-btn-insert');
  await expect(insert).toBeDisabled();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await expect(insert).toBeEnabled();
  await insert.click();
  await expect(field).toHaveValue('I built deterministic JavaScript tooling at scale.');
  const generate = extension.calls.find(call => call.url === '/api/generate');
  expect(generate.authorization).toBe('Bearer browser-token');
  expect(generate.body).toMatchObject({ cvText: CV });
  expect(generate.body).not.toHaveProperty('stream');
  expect(generate.body.question).toContain('Why are you a good fit');
  expect(extension.calls.some(call => call.url === '/api/register')).toBe(true);
});

test('iframe answer stays bound to its launching field when focus moves', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/iframe-job`);
  const pop = await popup(extension); await saveCv(pop); await job.bringToFront();
  if (await pop.locator('#activate-btn').isVisible()) await pop.locator('#activate-btn').click();
  const frame = job.frameLocator('#application-frame');
  await expect(frame.locator('.da-field-btn-overlay')).toHaveCount(2);
  await frame.locator('#a').focus();
  await frame.locator('.da-field-btn-overlay').first().click();
  await frame.locator('#b').focus();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.', { timeout: 7000 });
  await job.locator('#da-btn-insert').click();
  await expect(frame.locator('#a')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await expect(frame.locator('#b')).toHaveValue('');
});

test('iframe rerendered target rejects insertion without redirecting it', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/iframe-job`);
  const pop = await popup(extension); await saveCv(pop); await job.bringToFront();
  if (await pop.locator('#activate-btn').isVisible()) await pop.locator('#activate-btn').click();
  const frame = job.frameLocator('#application-frame');
  await expect(frame.locator('.da-field-btn-overlay')).toHaveCount(2);
  await frame.locator('#a').focus(); await frame.locator('.da-field-btn-overlay').first().click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.', { timeout: 7000 });
  await frame.locator('#a').evaluate(el => el.replaceWith(Object.assign(document.createElement('textarea'), { id: 'a' })));
  await job.locator('#da-btn-insert').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await expect(frame.locator('#a')).toHaveValue('');
  await expect(frame.locator('#b')).toHaveValue('');
});

test('iframe navigation invalidates the launching document nonce and keeps the answer recoverable', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/iframe-job`);
  const pop = await popup(extension); await saveCv(pop); await job.bringToFront();
  const frame = job.frameLocator('#application-frame');
  await expect(frame.locator('.da-field-btn-overlay')).toHaveCount(2);
  await frame.locator('#a').focus(); await frame.locator('.da-field-btn-overlay').first().click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.', { timeout: 7000 });
  await job.locator('#application-frame').evaluate(frameEl => { frameEl.src = `/iframe-form?reload=${Date.now()}`; });
  await expect(frame.locator('.da-field-btn-overlay')).toHaveCount(2);
  await job.locator('#da-btn-insert').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await expect(job.locator('.da-notification')).toContainText('still here to copy');
  await expect(frame.locator('#a')).toHaveValue('');
  await expect(job.locator('#da-btn-copy')).toBeVisible();
});

test('overlapping requests from two iframes stay isolated and parent structured context wins', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/two-iframe-job`);
  const pop = await popup(extension); await saveCv(pop); await job.bringToFront();
  const a = job.frameLocator('#frame-a'); const b = job.frameLocator('#frame-b');
  await expect(a.locator('.da-field-btn-overlay')).toHaveCount(1);
  await expect(b.locator('.da-field-btn-overlay')).toHaveCount(1);
  await a.locator('#answer').focus(); await a.locator('.da-field-btn-overlay').click();
  await b.locator('.da-field-btn-overlay').dispatchEvent('click');
  await expect(job.locator('#da-answer-output')).toHaveValue('Answer for iframe B.', { timeout: 7000 });
  await job.locator('#da-btn-insert').click();
  await expect(a.locator('#answer')).toHaveValue('');
  await expect(b.locator('#answer')).toHaveValue('Answer for iframe B.');
  const calls = extension.calls.filter(call => call.url === '/api/generate' && /OVERLAP/.test(call.body?.question || ''));
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const call of calls) {
    expect(call.body.jobDescription).toContain('PARENT STRUCTURED CONTEXT');
    expect(call.body.jobDescription).not.toContain('Generic application form');
    expect(call.body.jdContextQuality).toBe('structured');
  }
});

test('stale saved JD is rejected across a different host/job identity seam', async ({ extension }) => {
  await extension.worker.evaluate(async ({ sourceUrl }) => chrome.storage.local.set({ tailorCvDraft: {
    jobTitle: 'Old Data Engineer', company: 'Old Company',
    jobDescription: 'STALE SAVED JD MUST NOT BE SENT', sourceUrl, updatedAt: new Date().toISOString(),
  } }), { sourceUrl: 'https://old-company.example/jobs/123' });
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/generic-job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  const before = extension.calls.filter(call => call.url === '/api/generate').length;
  await job.locator('#application-answer').focus(); await job.locator('.da-field-btn-overlay').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('A job description is required for a tailored answer. Paste the JD above, then generate again.');
  expect(extension.calls.filter(call => call.url === '/api/generate')).toHaveLength(before);
});

test('a pasted JD replaces the frozen session context for regeneration', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/generic-job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus(); await job.locator('.da-field-btn-overlay').click();
  await expect(job.locator('#da-jd-paste-area')).toBeVisible();
  const pastedJd = 'USER PROVIDED JD: Build reliable JavaScript browser automation, diagnose extension races, and own production quality for job applicants.';
  await job.locator('#da-jd-input').fill(pastedJd);
  await job.locator('#da-jd-confirm').click();
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  const call = extension.calls.filter(entry => entry.url === '/api/generate').at(-1);
  expect(call.body.jobDescription).toContain('USER PROVIDED JD');
  expect(call.body.jdContextQuality).toBe('user_provided');
});

test('SPA navigation invalidates a generated answer session even when the field remains mounted', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  const field = job.locator('#application-answer');
  await field.focus(); await job.locator('.da-field-btn-overlay').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await job.evaluate(() => history.pushState({}, '', '/job?job=next'));
  await expect(job.locator('#da-btn-insert')).toBeDisabled();
  await expect(field).toHaveValue('');
});

test('field controls follow live editability, reveal changes, navigation, and BFCache restoration', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend', `
    <textarea id="native" style="width:400px;height:80px"></textarea>
    <textarea id="readonly" readonly style="width:400px;height:80px"></textarea>
    <textarea id="disabled" disabled style="width:400px;height:80px"></textarea>
    <div id="false-role" role="textbox" style="width:400px;height:80px">Do not rewrite me</div>
    <div id="editable" role="textbox" contenteditable="true" style="width:400px;height:80px"></div>
    <textarea id="revealed" hidden style="width:400px;height:80px"></textarea>`));
  await expect(job.locator('.da-field-btn-overlay')).toHaveCount(3);
  await expect(job.locator('#false-role')).toHaveText('Do not rewrite me');

  await job.locator('#revealed').evaluate(field => field.hidden = false);
  await expect(job.locator('.da-field-btn-overlay')).toHaveCount(4);
  await job.locator('#revealed').evaluate(field => field.hidden = true);
  await expect(job.locator('.da-field-btn-overlay')).toHaveCount(3);
  await job.locator('#revealed').evaluate(field => field.hidden = false);
  await expect(job.locator('.da-field-btn-overlay')).toHaveCount(4);

  const field = job.locator('#native');
  await field.focus();
  await job.locator('.da-field-btn-overlay.da-btn-visible').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await field.evaluate(element => element.readOnly = true);
  await job.locator('#da-btn-insert').click({ force: true });
  await expect(field).toHaveValue('');
  await expect(job.locator('.da-notification')).toContainText('no longer editable');

  await job.evaluate(() => history.pushState({}, '', '/job?job=field-reliability'));
  await expect(job.locator('#draftapply-modal')).toBeHidden();
  await expect(job.locator('#da-answer-output')).toHaveValue('');

  await job.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(job.locator('#draftapply-modal')).toHaveCount(1);
  await expect(job.locator('.da-field-btn-overlay')).toHaveCount(3);
});

test('conservative field limits cover native and high-confidence local forms while ignoring words and unrelated numbers', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  const scenarios = [
    { html: '<textarea id="limit-field" maxlength="91"></textarea>', expected: 91 },
    { html: '<textarea id="limit-field" aria-describedby="help"></textarea><span id="help">Maximum 82 characters</span>', expected: 82 },
    { html: '<label>Up to 73 characters<textarea id="limit-field"></textarea></label>', expected: 73 },
    { html: '<label>Up to 72 chars<textarea id="limit-field"></textarea></label>', expected: 72 },
    { html: '<label><textarea id="limit-field"></textarea><span>7 of 64 characters</span></label>', expected: 64 },
    { html: '<label><textarea id="limit-field"></textarea><span>55 characters remaining</span></label>', value: '12345', expected: 60 },
    { html: '<label>Question 1 of 3<textarea id="limit-field"></textarea></label>', expected: null },
    { html: '<label>Maximum 20 words · 2,000 applicants<textarea id="limit-field"></textarea></label>', expected: null },
  ];
  for (const scenario of scenarios) {
    await job.reload();
    // Install each scenario after reload so the real MutationObserver discovers it.
    await job.locator('main').evaluate((main, html) => main.insertAdjacentHTML(
      'beforeend', `<div class="limit-case">${html.replace('<textarea ', '<textarea style="width:500px;height:120px" ')}</div>`
    ), scenario.html);
    const field = job.locator('#limit-field');
    if (scenario.value) await field.fill(scenario.value);
    await field.focus();
    await expect(job.locator('.da-field-btn-overlay')).toHaveCount(2);
    await job.locator('.da-field-btn-overlay').last().dispatchEvent('click');
    if (scenario.expected) await expect(job.locator('#da-char-hint')).toContainText(String(scenario.expected));
    else await expect(job.locator('#da-char-hint')).toHaveText('');
  }
  // Tightening after generation remains independently enforced.
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await job.locator('#limit-field').evaluate(el => { el.setAttribute('aria-describedby', 'answer-help'); el.insertAdjacentHTML('afterend', '<span id="answer-help">maximum 20 characters</span>'); });
  await job.locator('#answer-help').evaluate(el => { el.textContent = 'maximum 20 characters'; });
  await job.locator('#da-btn-insert').click();
  await expect(job.locator('#da-btn-insert')).toBeDisabled();
  await expect(job.locator('#limit-field')).toHaveValue('');
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
});

test('explicit site rejection leaves the generated answer visible and copyable', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  const field = job.locator('#application-answer');
  await field.evaluate(el => el.addEventListener('input', () => { el.value = ''; }));
  await field.focus(); await job.locator('.da-field-btn-overlay').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await job.locator('#da-btn-insert').click();
  await expect(job.locator('.da-notification')).toContainText('rejected the insert');
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await expect(job.locator('#da-btn-copy')).toBeVisible();
  await expect(job.locator('#da-btn-copy')).toBeEnabled();
  await job.locator('#da-btn-copy').click();
  await expect(job.locator('#da-btn-copy')).toHaveText('✓ Copied');
});

test('a replaced local field offers copy fallback instead of a dead Insert button', async ({ extension }) => {
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: extension.origin });
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  const field = job.locator('#application-answer');
  await field.focus(); await job.locator('.da-field-btn-overlay').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await field.evaluate(el => {
    el.remove();
    window.__draftapplyMutationChurn = setInterval(() => {
      const node = document.createElement('span');
      document.body.appendChild(node);
      node.remove();
    }, 5);
  });
  const insert = job.locator('#da-btn-insert');
  await job.waitForTimeout(50);
  expect(await insert.isEnabled()).toBe(true);
  expect(await insert.textContent()).toBe('Copy Answer');
  await job.evaluate(() => clearInterval(window.__draftapplyMutationChurn));
  await insert.click();
  await expect(job.locator('.da-notification')).toContainText('copied to clipboard');
  await expect.poll(() => job.evaluate(() => navigator.clipboard.readText()))
    .toBe('I built deterministic JavaScript tooling at scale.');
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
});

test('JSON contact answers and review-state drafts remain usable', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus();
  await job.locator('.da-field-btn-overlay').click();

  await job.locator('#da-question-preview').fill('Email');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('jane@example.com');
  await expect(job.locator('#da-btn-insert')).toBeEnabled();

  await job.locator('#da-question-preview').fill('REVIEW: Short introduction');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await expect(job.locator('#da-verify-badge')).toContainText('Read this one');
  await expect(job.locator('#da-btn-insert')).toBeEnabled();
  await job.locator('#da-btn-insert').click();
  await expect(job.locator('#application-answer')).toHaveValue('I built deterministic JavaScript tooling at scale.');
});

test('missing validation requires an edit and inserts the reviewed text', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus();
  await job.locator('.da-field-btn-overlay').click();
  await job.locator('#da-question-preview').fill('MISSING VALIDATION: Short introduction');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-btn-insert')).toHaveText('Edit Answer Above First');
  await job.locator('#da-answer-output').fill('I reviewed and edited this answer.');
  await expect(job.locator('#da-btn-insert')).toBeEnabled();
  await job.locator('#da-btn-insert').click();
  await expect(job.locator('#application-answer')).toHaveValue('I reviewed and edited this answer.');
});

test('rate limits retain an actionable retry delay', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus();
  await job.locator('.da-field-btn-overlay').click();
  await job.locator('#da-question-preview').fill('RATE LIMIT: Short introduction');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('Error: Rate limit reached — you can try again in 30 seconds.');
});

test('malformed service responses produce an actionable retry message', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus();
  await job.locator('.da-field-btn-overlay').click();
  await job.locator('#da-question-preview').fill('INVALID RESPONSE: Short introduction');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('Error: DraftApply received an invalid response. Please try again.');
});

test('a long atomic request survives the MV3 worker idle window', async ({ extension }) => {
  test.setTimeout(50_000);
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus();
  await job.locator('.da-field-btn-overlay').click();
  await job.locator('#da-question-preview').fill('SLOW WORKER: Short introduction');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.', { timeout: 40_000 });
  await expect(job.locator('#da-btn-insert')).toBeEnabled();
});

test('stopping a request prevents its late response from replacing cancellation', async ({ extension }) => {
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus();
  await job.locator('.da-field-btn-overlay').click();
  await job.locator('#da-question-preview').fill('SLOW CANCEL: Short introduction');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-loading')).toBeVisible();
  await job.locator('#da-btn-stop').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('Cancelled.');
  await job.waitForTimeout(5500);
  await expect(job.locator('#da-answer-output')).toHaveValue('Cancelled.');
});

test('an older operation cannot hide the active generation spinner', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus(); await job.locator('.da-field-btn-overlay').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('I built deterministic JavaScript tooling at scale.');
  await job.locator('#da-question-preview').fill('OVERLAP B');
  await job.locator('#da-btn-regenerate').click();
  await job.locator('#da-question-preview').fill('OVERLAP A');
  await job.locator('#da-btn-regenerate').click();
  await job.waitForTimeout(150);
  await expect(job.locator('#da-loading')).toBeVisible();
  await expect(job.locator('#da-answer-output')).toHaveValue('Answer for iframe A.', { timeout: 2000 });
  await expect(job.locator('#da-loading')).toBeHidden();
});

test('a block final remains non-insertable', async ({ extension }) => {
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: extension.origin });
  const job = await extension.context.newPage();
  await job.goto(`${extension.origin}/job`);
  const pop = await popup(extension); await saveCv(pop); await activate(extension, pop, job);
  await job.locator('#application-answer').focus();
  await job.locator('.da-field-btn-overlay').click();
  await job.locator('#da-question-preview').fill('BLOCK this unsupported answer');
  await job.locator('#da-btn-regenerate').click();
  await expect(job.locator('#da-answer-output')).toHaveValue('This unsupported claim must not be inserted.');
  // Unverified model output remains visible for review but cannot be inserted
  // unchanged. Explicit user editing is the recovery path.
  const insertBtn = job.locator('#da-btn-insert');
  await expect(insertBtn).toBeDisabled();
  await expect(insertBtn).toHaveText('Edit Answer Above First');
  await expect(job.locator('#da-verify-badge')).toContainText('could not verify part of this answer');
  await expect(job.locator('#application-answer')).toHaveValue('');
  await job.locator('#da-btn-copy').click();
  await expect(job.locator('#da-btn-copy')).toHaveText('✓ Copied');
  await expect.poll(() => job.evaluate(() => navigator.clipboard.readText()))
    .toBe('This unsupported claim must not be inserted.');
  await job.locator('#da-answer-output').fill('I edited this into my own answer.');
  await expect(insertBtn).toBeEnabled();
  // Reverting to the exact blocked model output must restore the block rather
  // than treating an input event itself as proof of user authorship.
  await job.locator('#da-answer-output').fill('This unsupported claim must not be inserted.');
  await expect(insertBtn).toBeDisabled();
  await job.locator('#da-answer-output').fill('I edited this into my own answer.');
  await expect(insertBtn).toBeEnabled();
});

test('structured CV export renders role content and downloads Word', async ({ extension }) => {
  const documentId = 'browser-document';
  const document = {
    schemaVersion: 1,
    documentId,
    revision: 1,
    renderedText: 'Jane Example\nSenior Software Engineer\nBuilt reliable JavaScript systems.\n• Unicode café → shipped\nhttps://portfolio.example.test',
    audit: { status: 'passed', recovered: false },
    updatedAt: new Date().toISOString(),
    metadata: { linkAnnotations: [{ text: 'https://portfolio.example.test', url: 'https://portfolio.example.test' }] },
    skeleton: { name: 'Jane Example', headline: 'Senior Software Engineer', roles: [{ id: 'role-1', company: 'Acme', title: 'Senior Engineer', dates: '2021–Present' }] },
    content: { summary: 'Deterministic browser automation specialist. https://portfolio.example.test', roles: [{ id: 'role-1', bullets: ['Built reliable JavaScript systems — Unicode café.'] }], skills: ['JavaScript'] },
  };
  await extension.worker.evaluate(async tailoredDocument => chrome.storage.local.set({
    activeTailoredDocument: tailoredDocument,
    [`tailoredDocument:${tailoredDocument.documentId}:${tailoredDocument.revision}`]: tailoredDocument,
    tailoredCvExport: 'obsolete payload must be ignored',
  }), document);
  const page = await extension.context.newPage();
  const url = `chrome-extension://${extension.extensionId}/cv-export.html?documentId=${documentId}&revision=1`;
  await page.goto(url);
  await expect(page.locator('#cv-content')).toContainText('Senior Engineer');
  await expect(page.locator('#cv-content')).toContainText('Built reliable JavaScript systems');
  await page.reload();
  await expect(page.locator('#cv-content')).toContainText('Built reliable JavaScript systems');
  const concurrent = await extension.context.newPage();
  await concurrent.goto(url);
  await expect(concurrent.locator('#cv-content')).toContainText('Senior Engineer');
  await page.screenshot({ path: 'specs/remaining-reliability/assets/slice03-export.png', fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#word-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/Jane Example CV\.docx$/);
  const file = await download.createReadStream();
  const chunks = [];
  for await (const chunk of file) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']) {
    expect(zip.file(required), required).toBeTruthy();
  }
  const xml = await zip.file('word/document.xml').async('string');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  expect(xml).toContain('Built reliable JavaScript systems');
  expect(xml).toContain('Unicode café');
  expect(xml).toContain('Acme');
  expect(xml).toContain('2021–Present');
  expect(xml).toContain('w:numPr');
  expect(rels).toContain('https://portfolio.example.test');
});

test('reviewed text survives popup close and reopens as the exact export revision', async ({ extension }) => {
  const document = {
    schemaVersion: 1, documentId: 'edited-document', revision: 1,
    skeleton: { name: 'Zoë Example', roles: [] },
    content: { summary: 'Original summary', roles: [] },
    renderedText: 'Zoë Example\nOriginal summary',
    audit: { status: 'passed', recovered: false }, metadata: {}, updatedAt: new Date().toISOString(),
  };
  await extension.worker.evaluate(async value => chrome.storage.local.set({
    activeTailoredDocument: value,
    [`tailoredDocument:${value.documentId}:1`]: value,
  }), document);
  const reviewedText = 'Zoë Example\nReviewed summary\n• Exact café → bullet';
  const firstPopup = await popup(extension);
  const saved = await firstPopup.evaluate(async ({ id, text }) => TailoredDocumentStore.saveReviewedText(id, 1, text), { id: document.documentId, text: reviewedText });
  expect(saved.revision).toBe(2);
  await firstPopup.close();

  const reopenedPopup = await popup(extension);
  expect(await reopenedPopup.evaluate(async () => (await TailoredDocumentStore.loadActive()).renderedText)).toBe(reviewedText);
  await reopenedPopup.close();
  const exportPage = await extension.context.newPage();
  await exportPage.goto(`chrome-extension://${extension.extensionId}/cv-export.html?documentId=${document.documentId}&revision=2`);
  await expect(exportPage.locator('#cv-content')).toContainText('Reviewed summary');
  await expect(exportPage.locator('#cv-content')).toContainText('Exact café → bullet');
  await expect(exportPage.locator('#cv-content')).not.toContainText('Original summary');
});

test('a tailored document is not restored after the JD changes on the same job URL', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/job`);
  const sourceUrl = job.url();
  const oldJd = 'Old job description requiring legacy platform support and maintenance ownership.';
  const newJd = 'New job description requiring browser automation, extension reliability, and race-free embedded forms.';
  const sourceCv = 'Jane Example\nSenior Software Engineer\nJavaScript browser automation and reliable extension systems.';
  const fingerprint = value => {
    const text = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return String(hash);
  };
  const document = {
    schemaVersion: 1, documentId: 'stale-job-document', revision: 1,
    skeleton: { name: 'Jane Example', roles: [] }, content: { summary: 'OLD TAILORED OUTPUT', roles: [] },
    renderedText: 'OLD TAILORED OUTPUT', audit: { status: 'passed', recovered: false },
    metadata: { source: {
      sourceUrl, jobTitle: 'Senior Software Engineer', company: 'Acme Corporation',
      jdFingerprint: fingerprint(oldJd), cvFingerprint: fingerprint(sourceCv),
    } },
    updatedAt: new Date().toISOString(),
  };
  await extension.worker.evaluate(async ({ document, sourceUrl, sourceCv, newJd }) => chrome.storage.local.set({
    cvText: sourceCv,
    activeTailoredDocument: document,
    [`tailoredDocument:${document.documentId}:1`]: document,
    tailorCvDraft: {
      jobTitle: 'Senior Software Engineer', company: 'Acme Corporation', jobDescription: newJd,
      sourceUrl, updatedAt: new Date().toISOString(),
    },
  }), { document, sourceUrl, sourceCv, newJd });
  const pop = await popup(extension);
  await job.bringToFront();
  await pop.locator('#tailor-open-btn').click();
  await expect(pop.locator('#tailor-output')).not.toHaveValue('OLD TAILORED OUTPUT');
  await expect(pop.locator('#tailor-generate-btn')).toBeVisible();
});

test('replacing the source CV invalidates its tailored document and export actions', async ({ extension }) => {
  const job = await extension.context.newPage(); await job.goto(`${extension.origin}/job`);
  const sourceUrl = job.url();
  const sourceCv = 'Jane Example\nSenior Software Engineer\nBuilt reliable browser automation and extension systems for production users.';
  const replacementCv = 'Alex Example\nProduct Designer\nDesigned accessible application journeys and reusable design systems for web products.';
  const jd = 'Senior software engineer role requiring browser automation, extension reliability, and production JavaScript ownership.';
  const fingerprint = value => {
    const text = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return String(hash);
  };
  const document = {
    schemaVersion: 1, documentId: 'source-cv-document', revision: 1,
    skeleton: { name: 'Jane Example', roles: [] }, content: { summary: 'TAILORED FROM JANE CV', roles: [] },
    renderedText: 'TAILORED FROM JANE CV', audit: { status: 'passed', recovered: false },
    metadata: { source: {
      sourceUrl, jobTitle: 'Senior Software Engineer', company: 'Acme Corporation',
      jdFingerprint: fingerprint(jd), cvFingerprint: fingerprint(sourceCv),
    }, review: { warnings: [] } },
    updatedAt: new Date().toISOString(),
  };
  await extension.worker.evaluate(async ({ document, sourceUrl, sourceCv, jd }) => chrome.storage.local.set({
    cvText: sourceCv,
    activeTailoredDocument: document,
    [`tailoredDocument:${document.documentId}:1`]: document,
    tailorCvDraft: {
      jobTitle: 'Senior Software Engineer', company: 'Acme Corporation', jobDescription: jd,
      sourceUrl, updatedAt: new Date().toISOString(),
    },
  }), { document, sourceUrl, sourceCv, jd });

  const pop = await popup(extension);
  await job.bringToFront();
  await pop.locator('#tailor-open-btn').click();
  await expect(pop.locator('#tailor-output')).toHaveValue('TAILORED FROM JANE CV');
  await pop.locator('#tailor-back-btn').click();
  await pop.locator('#change-cv-btn').click();
  await pop.locator('#cv-text').fill(replacementCv);
  await pop.locator('#save-cv-btn').click();

  await expect.poll(() => extension.worker.evaluate(async () => (await chrome.storage.local.get('activeTailoredDocument')).activeTailoredDocument)).toBeUndefined();
  await expect(pop.locator('#tailor-output-wrap')).toBeHidden();
  await expect(pop.locator('#tailor-action-row')).toBeHidden();
});
