export class CVTailor {
  /**
   * Build a match map between JD requirements and CV evidence.
   * @returns {{ requirement, type, status, evidence, allowedToMention }[]}
   */
  buildMatchMap(cvData, jdData, confirmedSkills = []) {
    const cvText = cvData.rawText || '';
    const cvLower = cvText.toLowerCase();
    const confirmedEntries = (Array.isArray(confirmedSkills) ? confirmedSkills : [])
      .map(skill => String(skill || '').trim())
      .filter(Boolean);
    const confirmedByKey = new Map();
    for (const skill of confirmedEntries) {
      const key = this._normaliseText(skill);
      if (key && !confirmedByKey.has(key)) confirmedByKey.set(key, skill);
    }
    const confirmedSet = new Set(confirmedByKey.keys());

    // Flatten all CV text sources for searching
    const cvSources = [
      cvData.summary || '',
      ...(cvData.skills || []),
      ...((cvData.experience || []).flatMap(e => [
        e.title || '', e.company || '',
        ...(e.responsibilities || [])
      ])),
      ...(cvData.certifications || []),
      ...(cvData.achievements || []),
    ];

    const allRequirements = [
      ...(jdData.requiredSkills  || []).map(r => ({ req: r, type: 'required' })),
      ...(jdData.preferredSkills || []).map(r => ({ req: r, type: 'preferred' })),
      ...(jdData.tools           || []).map(r => ({ req: r, type: 'tool' })),
      ...(jdData.softSkills      || []).map(r => ({ req: r, type: 'soft' })),
    ];

    // Deduplicate exact repeats only. Keep standalone tools even if they also
    // appear inside a longer compound requirement, because the compound may be
    // only partially supported while the atomic tool is legitimately supported.
    const reqTexts = allRequirements.map(r => r.req.toLowerCase().trim());
    const deduped = allRequirements.filter(({ req }, i) => {
      const key = req.toLowerCase().trim();
      if (reqTexts.indexOf(key) < i) return false; // exact duplicate, already seen
      return true;
    });

    for (const skill of confirmedByKey.values()) {
      const key = this._normaliseText(skill);
      if (!deduped.some(({ req }) => this._normaliseText(req) === key)) {
        deduped.push({ req: skill, type: 'user_confirmed' });
      }
    }

    return deduped.map(({ req, type }) => {
      const confirmedByUser = confirmedSet.has(this._normaliseText(req));
      const evidence = this._findEvidence(req, cvSources);
      const coreTokens = this._getCoreTokens(req);
      const supportedCoreTokens = coreTokens.filter(tok =>
        cvSources.some(source => source && this._normaliseText(source).includes(tok))
      );
      const fullySupported = coreTokens.length === 0 || supportedCoreTokens.length === coreTokens.length;
      const isAtomicRequirement = coreTokens.length <= 1;
      let status;
      if (confirmedByUser) {
        status = 'user_confirmed';
      } else if (!fullySupported) {
        status = 'missing';
      } else if (evidence.length >= 2) {
        status = 'strong_match';
      } else if (evidence.length === 1 || (isAtomicRequirement && this._hasAdjacentTech(req, cvLower))) {
        status = 'partial_match';
      } else {
        status = 'missing';
      }
      return {
        requirement: req,
        type,
        status,
        evidence: confirmedByUser ? ['Confirmed by user during missing skills review'] : evidence,
        allowedToMention: status !== 'missing',
        confirmedByUser,
      };
    });
  }

  /** Returns a summary score and categorised lists. */
  buildMatchSummary(matchMap) {
    const required = matchMap.filter(m => m.type === 'required');
    const strong   = matchMap.filter(m => m.status === 'strong_match');
    const partial  = matchMap.filter(m => m.status === 'partial_match');
    const confirmed = matchMap.filter(m => m.status === 'user_confirmed');
    const missing  = matchMap.filter(m => m.status === 'missing');

    // Score: weight required matches more heavily
    const reqTotal    = required.length || 1;
    const reqMatched  = required.filter(m => m.status !== 'missing').length;
    const allTotal    = matchMap.length || 1;
    const allMatched  = strong.length + confirmed.length + partial.length * 0.5;

    const score = Math.round(
      ((reqMatched / reqTotal) * 0.7 + (allMatched / allTotal) * 0.3) * 100
    );

    return {
      score:                   Math.min(100, score),
      strongMatches:           strong.map(m => m.requirement),
      partialMatches:          partial.map(m => m.requirement),
      confirmedAdditions:      confirmed.map(m => m.requirement),
      unsupportedRequirements: missing.map(m => m.requirement),
    };
  }

  /**
   * Build system + user prompts for the LLM tailoring call.
   * @returns {{ systemPrompt: string, userPrompt: string, temperature: number }}
   */
  buildTailoringPrompt(cvData, jdData, matchMap) {
    const contactFields = this._getLockedContactFields(cvData.contactInfo);
    const lockedFields = [
      ...contactFields,
      ...((cvData.experience || []).map(e => `Company: "${e.company}" | Job title: "${e.title}" | Dates: "${e.dates}"`)),
      ...((cvData.education  || []).map(e => `Institution: "${e.institution}" | Degree: "${e.degree}" | Dates: "${e.dates}"`)),
      ...((cvData.certifications || []).map(c => `Certification: "${c}"`)),
    ].filter(Boolean);

    const systemPrompt = `You are a professional CV editor. Your task is to tailor the candidate's CV for the target role while preserving every factual detail.

LOCKED FIELDS — do NOT alter any of these under any circumstances:
${lockedFields.map(f => `  • ${f}`).join('\n')}

STRICT RULES:
1. Never invent metrics, achievements, or skills that are not present in the original CV.
2. Never claim proficiency in a technology or skill marked as missing in the match report.
3. Preserve every locked field exactly as written — same spelling, capitalisation, and format.
4. Do not add new employment entries, new education entries, or new certifications.
5. Do not remove any role or educational entry.
6. Exact product/tool names from the JD or user-confirmed review may be added to skills, summaries, or bullets only when supported by the original CV or match report.
7. If the JD mentions an unsupported tool, you may emphasize adjacent supported experience instead, but do not name the unsupported tool as a candidate skill.
8. Do not write meta phrases such as "Tailored for", "customized for", "aligned to this job", or "for this application".
9. Do not mention the target company name in the CV body unless it already appears in the original CV as part of the candidate's history.
10. Never rename historical job titles to the target role title. Keep every previous job title exactly as shown in LOCKED FIELDS.
11. You may add a short "Focus:" line below a preserved job title when that role's original bullets support the target-role positioning.

WHAT YOU MAY DO:
• Update the professional headline / title line (the short descriptor directly below the candidate's name, e.g. "Senior Frontend Engineer") to match the target role title exactly.
• Rewrite the professional summary to align with the target role and seniority level.
• Reorder the skills list to surface the most relevant supported skills first, and de-emphasize less relevant skills by moving them lower or shortening them.
• Rephrase existing responsibility bullets using vocabulary from the job description, as long as the underlying meaning is unchanged.
• Reorder bullets within a role to put the most relevant ones first.
• Expand or compress bullet points within the bounds of what the original bullet states.
• Include every user-confirmed addition in the skills/core competencies section.
• Add truthful role-positioning lines in the form "Focus: ..." under existing role titles when supported by that role's original responsibilities.`;

    const supported = matchMap.filter(m => m.allowedToMention).map(m => m.requirement);
    const unsupported = matchMap.filter(m => !m.allowedToMention).map(m => m.requirement);
    const confirmed = matchMap.filter(m => m.confirmedByUser).map(m => m.requirement);
    const topResponsibilities = (jdData.responsibilities || []).slice(0, 8);
    const topRequired = (jdData.requiredSkills || []).slice(0, 15);
    const topTools = (jdData.tools || []).slice(0, 20);
    const topKeywords = (jdData.atsKeywords || []).slice(0, 20);

    const userPrompt = `TARGET ROLE
  Job title:  ${jdData.jobTitle || 'Not specified'}
  Company:    ${jdData.company  || 'Not specified'}
  Seniority:  ${jdData.seniority}

REQUIRED SKILLS (up to 15)
${topRequired.map(s => `  • ${s}`).join('\n') || '  (none listed)'}

TECHNOLOGIES / ATS KEYWORDS FROM THE JD
${topTools.length ? topTools.map(s => `  • ${s}`).join('\n') : '  (none listed)'}
${topKeywords.length ? `\nRepeated JD keywords:\n${topKeywords.map(s => `  • ${s}`).join('\n')}` : ''}

MATCH REPORT
  Supported requirements (you MAY reference these):
${supported.length ? supported.map(s => `    ✓ ${s}`).join('\n') : '    (none)'}

  User-confirmed additions (not found in the uploaded CV, but the user says they have real experience):
${confirmed.length ? confirmed.map(s => `    + ${s}`).join('\n') : '    (none)'}

  Unsupported requirements (do NOT claim these):
${unsupported.length ? unsupported.map(s => `    ✗ ${s}`).join('\n') : '    (none)'}

KEY RESPONSIBILITIES TO HIGHLIGHT (up to 8)
${topResponsibilities.map(r => `  • ${r}`).join('\n') || '  (none listed)'}

ORIGINAL CV
${cvData.rawText}

INSTRUCTION
1. The professional headline/title line near the top of the CV MUST be exactly: "${jdData.jobTitle || 'the target role'}".
2. Rewrite the professional summary so it clearly positions the candidate for this exact role and domain without saying it was tailored for a company or application. It must mention only supported evidence from the CV.
3. Reorder and rename skills/competencies so supported JD-relevant items appear first, especially supported technologies, methods, domain terms, and operational practices from the JD.
4. For each relevant role: preserve the official job title exactly, then add one short "Focus:" line below it when the original responsibilities support the target role. Example: "Focus: MLOps, platform reliability, cloud infrastructure, automation, and production diagnostics".
5. For each role: rewrite relevant bullets with JD vocabulary (same meaning, aligned language), reorder bullets so the strongest target-role evidence comes first, and make Infra/MLOps/platform evidence obvious when supported.
6. Include every user-confirmed addition in the skills/core competencies section. You may also use them in the summary when natural, but do not attach them to a specific employer, project, metric, certification, or achievement unless that context exists in the original CV.
7. Preserve all locked fields exactly — same spelling, capitalisation, and punctuation.
8. The final CV must read like a polished CV for "${jdData.jobTitle || 'the target role'}", not like a generic CV and not like generated marketing copy.

Output the complete tailored CV text with no preamble, no commentary, and no markdown code fences. Begin directly with the candidate's name.`;

    return { systemPrompt, userPrompt, temperature: 0.3 };
  }

  enforceTargetHeadline(tailoredText, jobTitle) {
    const title = String(jobTitle || '').trim();
    if (!title || !tailoredText) return tailoredText;

    const lines = String(tailoredText).split('\n');
    const firstTextIdx = lines.findIndex(l => l.trim());
    if (firstTextIdx === -1) return tailoredText;

    let i = firstTextIdx + 1;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || this._isHeaderContactLine(line) || this._isLikelyLocationLine(line)) {
        i++;
        continue;
      }
      break;
    }

    if (i >= lines.length) {
      lines.push('', title);
      return lines.join('\n');
    }

    if (this._isLikelySectionHeader(lines[i])) {
      lines.splice(i, 0, title, '');
    } else {
      lines[i] = title;
    }

    return lines.join('\n');
  }

  removeTailoringMetaPhrases(tailoredText, company = '') {
    if (!tailoredText) return tailoredText;

    const companyName = this._escapeRegExp(String(company || '').trim());
    const genericCompanyPattern = companyName || '[A-Z][A-Za-z0-9&.,\\- ]{1,80}';

    return String(tailoredText)
      .split('\n')
      .map(line => line
        .replace(new RegExp(`\\bTailored\\s+for\\s+${genericCompanyPattern}\\s+using\\s+`, 'gi'), 'Experienced in ')
        .replace(new RegExp(`\\bTailored\\s+for\\s+${genericCompanyPattern}\\s*(?:role|position|application)?\\s*[:\\-–—]?\\s*`, 'gi'), '')
        .replace(/\b(?:customi[sz]ed|optimised|optimized)\s+for\s+(?:this\s+)?(?:role|position|job|application)\s*[:\-–—]?\s*/gi, '')
        .replace(/\bAligned\s+to\s+(?:this\s+)?(?:role|position|job|application)\s*[:\-–—]?\s*/gi, '')
      )
      .join('\n');
  }

  ensureConfirmedSkillsIncluded(tailoredText, confirmedSkills = []) {
    if (!tailoredText) return tailoredText;

    const skills = this._uniqueDisplaySkills(confirmedSkills);
    if (skills.length === 0) return tailoredText;

    const existingText = this._normaliseText(tailoredText);
    const missing = skills.filter(skill => !existingText.includes(this._normaliseText(skill)));
    if (missing.length === 0) return tailoredText;

    const lines = String(tailoredText).split('\n');
    const headingIdx = lines.findIndex(line =>
      /^(core\s+competenc(?:y|ies)|technical\s+skills?|skills|technologies|tools|expertise)\s*[:\-]?$/i
        .test(line.trim())
    );

    if (headingIdx === -1) {
      return `${tailoredText.trim()}\n\nTechnical Skills\n${missing.join(', ')}`;
    }

    let insertIdx = headingIdx + 1;
    while (insertIdx < lines.length && !lines[insertIdx].trim()) insertIdx++;

    if (insertIdx >= lines.length || this._isLikelySectionHeader(lines[insertIdx])) {
      lines.splice(headingIdx + 1, 0, missing.join(', '));
      return lines.join('\n');
    }

    const current = lines[insertIdx].trim();
    const prefix = /^[-•]\s+/.test(current) ? current.match(/^[-•]\s+/)[0] : '';
    const body = prefix ? current.replace(/^[-•]\s+/, '') : current;
    const separator = body && !/[,:;]\s*$/.test(body) ? ', ' : ' ';
    lines[insertIdx] = `${prefix}${body}${separator}${missing.join(', ')}`.trimEnd();
    return lines.join('\n');
  }

  /**
   * Rule-based validation that locked fields were not altered.
   * @returns {string[]} warnings
   */
  validateTailoredCV(originalCvData, tailoredText) {
    if (!tailoredText) return [];
    const warnings = [];
    const t = tailoredText;

    // Company names
    for (const exp of (originalCvData.experience || [])) {
      if (exp.company && !t.includes(exp.company)) {
        warnings.push(`Company name may have changed or been removed: "${exp.company}"`);
      }
    }

    // Job titles
    for (const exp of (originalCvData.experience || [])) {
      if (exp.title && !t.includes(exp.title)) {
        warnings.push(`Job title may have changed or been removed: "${exp.title}"`);
      }
    }

    // Education institutions
    for (const edu of (originalCvData.education || [])) {
      if (edu.institution && !t.includes(edu.institution)) {
        warnings.push(`Education institution may have changed or been removed: "${edu.institution}"`);
      }
    }

    // Contact details
    for (const field of this._getLockedContactFields(originalCvData.contactInfo)) {
      const m = field.match(/^([^:]+): "(.+)"$/);
      if (!m) continue;
      const [, label, value] = m;
      if (value && !t.includes(value)) {
        warnings.push(`${label} may have changed or been removed: "${value}"`);
      }
    }

    // New metrics not in the original
    const originalText = originalCvData.rawText || '';
    const metricRe = /(\d+%|\$[\d,]+|\b\d+x\b)/g;
    const originalMetrics = new Set((originalText.match(metricRe) || []));
    const tailoredMetrics = t.match(metricRe) || [];
    for (const metric of tailoredMetrics) {
      if (!originalMetrics.has(metric)) {
        warnings.push(`New metric detected that was not in the original CV: "${metric}"`);
      }
    }

    return warnings;
  }

  /**
   * Detect which sections changed between original and tailored text.
   * @returns {string[]} section names
   */
  detectChangedSections(originalText, tailoredText) {
    const changed = [];
    const sectionPatterns = {
      summary:         /(?:summary|profile|about|objective)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|education|skills|work|employment))/i,
      skills:          /(?:skills|technologies|competencies|expertise)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|education|certifications|projects|$))/i,
      experience:      /(?:experience|employment|work\s*history)[:\s]*\n([\s\S]*?)(?=\n\s*(?:education|skills|certifications|projects|$))/i,
      education:       /(?:education|academic|qualifications)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|skills|certifications|projects|$))/i,
      certifications:  /(?:certifications?|licenses?|credentials)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|education|skills|projects|$))/i,
    };

    for (const [section, re] of Object.entries(sectionPatterns)) {
      const origMatch    = (originalText  || '').match(re);
      const tailoredMatch = (tailoredText || '').match(re);
      const origContent    = origMatch    ? origMatch[1].trim()    : '';
      const tailoredContent = tailoredMatch ? tailoredMatch[1].trim() : '';
      if (origContent !== tailoredContent) {
        changed.push(section);
      }
    }

    return changed;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  _getLockedContactFields(contactInfo = {}) {
    const fields = [
      ['Full name', contactInfo.name],
      ['Email address', contactInfo.email],
      ['Phone number', contactInfo.phone],
      ['LinkedIn URL', contactInfo.linkedin],
      ['GitHub URL', contactInfo.github],
      ['Website URL', contactInfo.website],
      ['Twitter/X URL', contactInfo.twitter],
      ['Portfolio URL', contactInfo.portfolio],
    ];
    return fields
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([label, value]) => `${label}: "${value.trim()}"`);
  }

  _uniqueDisplaySkills(skills = []) {
    const seen = new Set();
    const result = [];
    for (const skill of Array.isArray(skills) ? skills : []) {
      const clean = String(skill || '').trim().replace(/\s+/g, ' ');
      const key = this._normaliseText(clean);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(clean);
    }
    return result;
  }

  _getCoreTokens(requirement) {
    const NOISE = this._noiseWords();
    const needle = this._normaliseText(requirement);
    if (!needle) return [];
    return [...new Set(
      needle
        .split(/\s+/)
        .filter(t => t.length >= 3 && !NOISE.has(t))
    )];
  }

  _noiseWords() {
    return new Set([
      'years','year','experience','exp','strong','solid','good','deep','excellent',
      'proven','minimum','least','required','knowledge','familiarity','understanding',
      'proficiency','proficient','ability','skill','skills','background','working',
      'hands','on','with','and','or','in','of','the','a','an','to','for','at','by',
      'have','has','ideally','preferably','including','such','as','use','using',
      'demonstrate','demonstrated','equivalent',
    ]);
  }

  _normaliseText(text) {
    return String(text || '').toLowerCase().replace(/[^\w\s.+#]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  _escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _isHeaderContactLine(line) {
    return /[\w.+-]+@[\w-]+\.\w+/.test(line)
      || /https?:\/\//i.test(line)
      || /^(linkedin|github|website|portfolio|personal\s+website|personal\s+site)$/i.test(line)
      || /(?:\+\d[\d\s\-.()]{5,}|\b\d{3,5}[\s\-.]\d{3,5}[\s\-.]\d{3,6}\b)/.test(line);
  }

  _isLikelyLocationLine(line) {
    return line.length <= 80
      && /,/.test(line)
      && /\b(uk|united kingdom|usa|united states|belgium|canada|germany|france|ireland|netherlands|remote)\b/i.test(line)
      && !/\b(engineer|developer|manager|architect|support|mlops|devops|sre|data|platform)\b/i.test(line);
  }

  _isLikelySectionHeader(line) {
    return /^(professional\s+summary|core\s+competenc(?:y|ies)|professional\s+experience|technical\s+skills?|education|certifications?\s*(?:&|and)\s*awards?|technical\s+leadership|achievements?|projects?)\s*[:\-]?$/i
      .test(String(line || '').trim());
  }

  /** Find CV source snippets that mention the requirement. */
  _findEvidence(requirement, cvSources) {
    // Noise words common in long-form JD requirements that aren't the actual skill
    const needle = this._normaliseText(requirement);
    if (!needle) return [];

    const allTokens = needle.split(/\s+/).filter(t => t.length >= 2);
    const coreTokens = this._getCoreTokens(requirement);
    const evidence = [];

    for (const source of cvSources) {
      if (!source) continue;
      const lower = this._normaliseText(source);

      // Full phrase match (strongest signal)
      if (lower.includes(needle)) {
        evidence.push(source.trim().slice(0, 150));
        continue;
      }
      // All core tokens present in same source (good signal for multi-word requirements)
      if (coreTokens.length >= 2 && coreTokens.every(tok => lower.includes(tok))) {
        evidence.push(source.trim().slice(0, 150));
        continue;
      }
      // Atomic long-form requirement: "X years experience with React" → "React".
      // Compound requirements must be fully supported before evidence is accepted.
      if (coreTokens.length === 1 && allTokens.length > coreTokens.length && lower.includes(coreTokens[0])) {
        evidence.push(source.trim().slice(0, 150));
      }
    }

    return [...new Set(evidence)].slice(0, 5);
  }

  /**
   * Suggest domain-common tools not already present in the JD or CV.
   * @returns {string[]} up to 12 tool names
   */
  suggestDomainSkills(jdData, cvData) {
    const domain = this._detectDomain(jdData);
    if (!domain) return [];

    const domainTools = this._getDomainTools(domain);

    // Build a set of everything already mentioned in the JD (case-insensitive)
    const inJd = new Set([
      ...(jdData.tools          || []).map(t => t.toLowerCase()),
      ...(jdData.requiredSkills  || []).map(s => s.toLowerCase()),
      ...(jdData.preferredSkills || []).map(s => s.toLowerCase()),
    ]);

    const cvLower = (cvData?.rawText || '').toLowerCase();

    return domainTools.filter(tool => {
      const low = tool.toLowerCase();
      if (inJd.has(low)) return false;
      // Partial match: if any word of the tool name appears in the JD set, skip
      if (low.split(/\s+/).some(w => w.length >= 4 && inJd.has(w))) return false;
      if (cvLower.includes(low)) return false;
      return true;
    }).slice(0, 12);
  }

  _detectDomain(jdData) {
    const title   = (jdData.jobTitle || '').toLowerCase();
    const tools   = (jdData.tools || []).map(t => t.toLowerCase()).join(' ');
    const req     = (jdData.requiredSkills || []).map(s => s.toLowerCase()).join(' ');
    const combined = `${title} ${tools} ${req}`;

    if (/\b(mlops|ml\s+platform|ml\s+engineer|machine\s+learning\s+engineer|ml\s+infrastructure|ai\s+platform)\b/.test(combined) ||
        /\b(kubeflow|kfp|mlflow|seldon|bentoml|triton|skypi|dcgm|zenml|metaflow|clearml)\b/.test(combined))
      return 'mlops';

    if (/\b(data\s+engineer|data\s+platform|etl|elt|data\s+pipeline|analytics\s+engineer)\b/.test(combined) ||
        /\b(dbt|airflow|dagster|prefect|flink|iceberg|delta\s+lake)\b/.test(combined))
      return 'data_engineering';

    if (/\b(devops|platform\s+engineer|sre|site\s+reliability|infrastructure\s+engineer|cloud\s+engineer)\b/.test(combined) ||
        /\b(terraform|ansible|argocd|crossplane|pulumi|karpenter|keda|fluxcd)\b/.test(combined))
      return 'devops';

    if (/\b(data\s+scientist|machine\s+learning|deep\s+learning|ml\s+researcher|ai\s+scientist|research\s+engineer)\b/.test(combined) ||
        /\b(pytorch|tensorflow|wandb|optuna|hugging\s*face|transformers)\b/.test(combined))
      return 'ml_scientist';

    if (/\b(frontend|front-end|ui\s+engineer|web\s+developer)\b/.test(combined) ||
        /\b(react|nextjs|vue|angular|svelte)\b/.test(combined))
      return 'frontend';

    if (/\b(backend|back-end|api\s+engineer|server[- ]?side|microservices)\b/.test(combined))
      return 'backend';

    if (/\b(cloud\s+architect|solutions\s+architect|aws\s+architect|gcp\s+architect)\b/.test(combined))
      return 'cloud';

    return null;
  }

  _getDomainTools(domain) {
    const MAP = {
      mlops: [
        'MLflow', 'DVC', 'Kubeflow', 'KFP', 'Seldon', 'BentoML', 'Triton',
        'Ray', 'SkyPilot', 'DCGM', 'Feast', 'ZenML', 'Metaflow', 'ClearML',
        'Argo Workflows', 'ArgoCD', 'WandB', 'Evidently', 'Prefect', 'Dagster',
        'AWS CDK', 'Vertex AI', 'SageMaker', 'Azure ML', 'ONNX', 'vLLM', 'Karpenter',
      ],
      data_engineering: [
        'Apache Spark', 'Apache Kafka', 'Apache Flink', 'dbt', 'Airflow', 'Prefect',
        'Dagster', 'Delta Lake', 'Apache Iceberg', 'Great Expectations', 'dlt',
        'Fivetran', 'Airbyte', 'Snowflake', 'BigQuery', 'Redshift', 'DuckDB',
        'Polars', 'OpenLineage', 'Trino',
      ],
      devops: [
        'Terraform', 'Ansible', 'Helm', 'ArgoCD', 'FluxCD', 'Crossplane',
        'AWS CDK', 'Pulumi', 'Datadog', 'Prometheus', 'Grafana', 'OpenTelemetry',
        'GitHub Actions', 'Vault', 'Consul', 'Istio', 'Linkerd', 'Karpenter', 'KEDA',
      ],
      ml_scientist: [
        'MLflow', 'WandB', 'DVC', 'ONNX', 'TensorFlow', 'PyTorch', 'Hugging Face',
        'scikit-learn', 'Optuna', 'Ray Tune', 'Dask', 'Polars', 'LangChain', 'LlamaIndex',
        'Feast', 'Evidently', 'BentoML', 'Triton', 'vLLM',
      ],
      frontend: [
        'TypeScript', 'React', 'Next.js', 'Tailwind CSS', 'Vite', 'Storybook',
        'Cypress', 'Playwright', 'Redux', 'Zustand', 'React Query', 'GraphQL',
        'Turborepo', 'Nx', 'Radix UI', 'shadcn/ui',
      ],
      backend: [
        'Node.js', 'NestJS', 'PostgreSQL', 'Redis', 'Docker', 'Kubernetes',
        'GraphQL', 'gRPC', 'Kafka', 'RabbitMQ', 'Elasticsearch', 'OpenTelemetry',
        'Terraform', 'Helm', 'GitHub Actions',
      ],
      cloud: [
        'AWS CDK', 'Terraform', 'Pulumi', 'CloudFormation', 'Ansible',
        'Datadog', 'Prometheus', 'Grafana', 'OpenTelemetry', 'Istio',
        'ArgoCD', 'Helm', 'Karpenter', 'KEDA', 'Vault', 'Crossplane',
      ],
    };
    return MAP[domain] || [];
  }

  /** Detect adjacent/related tech as a signal for partial_match. */
  _hasAdjacentTech(requirement, cvLower) {
    const adjacency = {
      'react':      ['vue', 'angular', 'svelte', 'next.js', 'nuxt'],
      'vue':        ['react', 'angular', 'svelte'],
      'angular':    ['react', 'vue', 'typescript'],
      'node.js':    ['express', 'nestjs', 'javascript', 'deno'],
      'postgresql': ['mysql', 'sql', 'mariadb', 'database'],
      'mongodb':    ['nosql', 'dynamodb', 'database'],
      'kubernetes': ['docker', 'helm', 'container'],
      'aws':        ['gcp', 'azure', 'cloud'],
      'python':     ['django', 'flask', 'fastapi'],
      'java':       ['spring', 'maven', 'gradle'],
      'tensorflow': ['pytorch', 'keras', 'machine learning'],
    };

    const key = requirement.toLowerCase().replace(/[^\w.]/g, '');
    const related = adjacency[key];
    if (!related) return false;
    return related.some(r => cvLower.includes(r));
  }
}

export default CVTailor;
