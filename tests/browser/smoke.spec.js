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

test('validated SSE finals gate insertion and requests are structured and authenticated', async ({ extension }) => {
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
  expect(generate.body).toMatchObject({ cvText: CV, stream: true });
  expect(generate.body.question).toContain('Why are you a good fit');
  expect(extension.calls.some(call => call.url === '/api/register')).toBe(true);
});

test('a block final remains non-insertable', async ({ extension }) => {
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
  await expect(insertBtn).toHaveText('Insert Answer');
  await expect(job.locator('#application-answer')).toHaveValue('');
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
  await extension.worker.evaluate(async () => chrome.storage.local.set({
    tailoredCvExport: 'Jane Example\nSenior Software Engineer\nAcme-focused experience',
    tailoredCvStructured: {
      skeleton: { name: 'Jane Example', headline: 'Senior Software Engineer', roles: [{ id: 'role-1', company: 'Acme', title: 'Senior Engineer', dates: '2021–Present' }] },
      content: { summary: 'Deterministic browser automation specialist.', roles: [{ id: 'role-1', bullets: ['Built reliable JavaScript systems.'] }], skills: ['JavaScript'] },
    },
  }));
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.extensionId}/cv-export.html`);
  await expect(page.locator('#cv-content')).toContainText('Senior Engineer');
  await expect(page.locator('#cv-content')).toContainText('Built reliable JavaScript systems');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#word-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/Jane Example CV\.doc$/);
});
