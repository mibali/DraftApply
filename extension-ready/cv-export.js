(async () => {
  const { tailoredCvExport } = await chrome.storage.local.get('tailoredCvExport');

  const loading = document.getElementById('loading');
  const content = document.getElementById('cv-content');

  if (!tailoredCvExport) {
    loading.textContent = 'No CV found — please generate a tailored CV first.';
    return;
  }

  await chrome.storage.local.remove('tailoredCvExport');

  loading.hidden = true;
  content.textContent = tailoredCvExport;
  content.hidden = false;
})();
