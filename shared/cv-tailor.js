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

  /**
   * Build prompts for a Groq semantic match call.
   * The LLM finds CV evidence for each JD requirement using semantic equivalence,
   * not just lexical overlap. Falls back to buildMatchMap() on any failure.
   */
  buildSemanticMatchPrompt(cvData, jdData, confirmedSkills = []) {
    const confirmed = (Array.isArray(confirmedSkills) ? confirmedSkills : [])
      .map(s => String(s || '').trim()).filter(Boolean);

    const reqs = [
      ...(jdData.requiredSkills  || []).slice(0, 20).map(r => ({ req: r, type: 'required' })),
      ...(jdData.preferredSkills || []).slice(0, 15).map(r => ({ req: r, type: 'preferred' })),
      ...(jdData.tools           || []).slice(0, 20).map(r => ({ req: r, type: 'tool' })),
      ...(jdData.softSkills      || []).slice(0, 10).map(r => ({ req: r, type: 'soft' })),
    ];
    const seen = new Set();
    const deduped = reqs.filter(({ req }) => {
      const k = this._normaliseText(req);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const reqList = deduped.map((r, i) => `${i + 1}. [${r.type}] ${r.req}`).join('\n');
    const cvText  = (cvData.rawText || '').slice(0, 8000);
    const confirmedList = confirmed.length
      ? confirmed.map(s => `  - ${s}`).join('\n')
      : '  (none)';

    const systemPrompt = `You are a CV evidence analyst. Match job description requirements to CV content using semantic understanding — not just keyword matching. Return ONLY valid JSON, no preamble, no markdown fences.`;

    const userPrompt = `For each numbered JD requirement, find the strongest supporting evidence in the CV text. Use semantic equivalence: "stakeholder workshops" supports "pre-sales engagement"; "customer success" supports "client-facing communication"; "CI/CD pipelines" supports "deployment automation". Be strict — do not invent evidence that is not in the CV.

JD REQUIREMENTS:
${reqList || '(none)'}

USER-CONFIRMED SKILLS (candidate attests to these — include regardless of CV text):
${confirmedList}

CV TEXT:
${cvText}

Return a JSON array. Each item must have exactly these fields:
{
  "requirement": "<exact text from numbered list above>",
  "type": "required" | "preferred" | "tool" | "soft",
  "status": "strong_match" | "partial_match" | "missing",
  "evidence": ["<direct quote or close paraphrase from CV, max 120 chars, max 3 items>"],
  "allowedToMention": true | false,
  "confirmedByUser": false
}

Status rules:
- strong_match: clear direct or semantic evidence in 2+ CV passages
- partial_match: indirect/semantic evidence, or 1 supporting CV passage
- missing: no evidence in CV — do not guess
- allowedToMention: true when status is strong_match or partial_match, false when missing

Also append one item per user-confirmed skill: status "user_confirmed", allowedToMention true, confirmedByUser true, evidence ["Confirmed by user during missing skills review"], type "user_confirmed".`;

    return { systemPrompt, userPrompt };
  }

  /**
   * Parse and validate the LLM's semantic match JSON.
   * Ensures all user-confirmed skills are present.
   * Returns null if the result is unusable (caller falls back to lexical matchMap).
   */
  mergeSemanticMatchResult(llmJson, jdData, confirmedSkills = []) {
    if (!Array.isArray(llmJson) || llmJson.length === 0) return null;

    const confirmed = (Array.isArray(confirmedSkills) ? confirmedSkills : [])
      .map(s => String(s || '').trim()).filter(Boolean);
    const confirmedKeys = new Set(confirmed.map(s => this._normaliseText(s)));
    const VALID_STATUSES = new Set(['strong_match', 'partial_match', 'missing', 'user_confirmed']);

    const result = [];
    const seenReqs = new Set();

    for (const item of llmJson) {
      if (!item || typeof item.requirement !== 'string' || !item.requirement.trim()) continue;
      const key = this._normaliseText(item.requirement);
      if (seenReqs.has(key)) continue;
      seenReqs.add(key);

      const confirmedByUser = Boolean(item.confirmedByUser) || confirmedKeys.has(key);
      const rawStatus = VALID_STATUSES.has(item.status) ? item.status : 'missing';
      const status = confirmedByUser ? 'user_confirmed' : rawStatus;
      const allowedToMention = status !== 'missing';
      const evidence = confirmedByUser
        ? ['Confirmed by user during missing skills review']
        : (Array.isArray(item.evidence)
            ? item.evidence.filter(e => typeof e === 'string' && e.trim()).slice(0, 3)
            : []);

      result.push({
        requirement:     item.requirement.trim(),
        type:            typeof item.type === 'string' ? item.type : 'required',
        status,
        evidence,
        allowedToMention,
        confirmedByUser,
      });
    }

    // Ensure every user-confirmed skill appears even if the LLM omitted it
    for (const skill of confirmed) {
      const key = this._normaliseText(skill);
      if (!seenReqs.has(key)) {
        result.push({
          requirement:     skill,
          type:            'user_confirmed',
          status:          'user_confirmed',
          evidence:        ['Confirmed by user during missing skills review'],
          allowedToMention: true,
          confirmedByUser:  true,
        });
        seenReqs.add(key);
      }
    }

    return result.length > 0 ? result : null;
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
12. Skills/core competencies must be concise CV skill phrases only. Never paste full JD requirements, education requirements, years-of-experience requirements, or sentences such as "X years of experience in..." into the skills section.

WHAT YOU MAY DO:
• Update the professional headline / title line (the short descriptor directly below the candidate's name, e.g. "Senior Frontend Engineer") to match the target role title exactly.
• Rewrite the professional summary to align with the target role and seniority level.
• Reorder the skills list to surface the most relevant supported skills first, and de-emphasize less relevant skills by moving them lower or shortening them.
• Rephrase existing responsibility bullets using vocabulary from the job description, as long as the underlying meaning is unchanged.
• Reorder bullets within a role to put the most relevant ones first.
• Expand or compress bullet points within the bounds of what the original bullet states.
• Include every user-confirmed addition in the skills/core competencies section as short phrases only.
• Add truthful role-positioning lines in the form "Focus: ..." under existing role titles when supported by that role's original responsibilities.`;

    const supported = matchMap.filter(m => m.allowedToMention).map(m => m.requirement);
    const unsupported = matchMap.filter(m => !m.allowedToMention).map(m => m.requirement);
    const confirmed = matchMap.filter(m => m.confirmedByUser).map(m => m.requirement);
    const topResponsibilities = (jdData.responsibilities || []).slice(0, 8);
    const topRequired = (jdData.requiredSkills || []).slice(0, 15);
    const topTools = (jdData.tools || []).slice(0, 20);
    const topKeywords = (jdData.atsKeywords || []).slice(0, 20);
    const tailoringPlan = this.buildTailoringPlan(cvData, jdData, matchMap);

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

TAILORING BLUEPRINT
  Target positioning: ${tailoringPlan.targetPositioning}
  Highest-value supported keywords:
${tailoringPlan.supportedKeywords.length ? tailoringPlan.supportedKeywords.map(s => `    • ${s}`).join('\n') : '    (none)'}
  Suggested role focus lines:
${tailoringPlan.roleFocusLines.length ? tailoringPlan.roleFocusLines.map(r => `    • ${r.company} / ${r.title}: ${r.focus}`).join('\n') : '    (none)'}
  Quality bar:
    • The CV must visibly prioritize the target role, not just lightly swap keywords.
    • Summary, skills, focus lines, and the first bullets under each relevant role must all point toward the target role.
    • Unsupported JD tools may appear only in the missing-skills/review context, never as claimed candidate experience.

ORIGINAL CV
${cvData.rawText}

HARVARD FORMAT — apply this structure exactly:
  Line 1:  Candidate full name (as-is from original CV)
  Line 2:  ${jdData.jobTitle || 'Target role title'} (job title, no label prefix)
  Lines 3+: Contact details one per line (email, phone, LinkedIn, location)
  [blank line]
  PROFESSIONAL SUMMARY
  [summary paragraph]
  [blank line]
  CORE COMPETENCIES
  Category Label: Skill A, Skill B, Skill C
  Category Label: Skill D, Skill E
  (each category on its own line, no bullet characters, no "Additional Relevant Skills" catch-all)
  [blank line]
  PROFESSIONAL EXPERIENCE
  Company Name                  Month Year – Month Year
  Job Title
  Focus: [one-line positioning, when supported]
  • Bullet one
  • Bullet two
  [blank line]
  EDUCATION / CERTIFICATIONS (as in original CV)

INSTRUCTION
1. HEADER: Job title on line 2 immediately below the candidate name, before any contact lines.
2. Rewrite the professional summary so it clearly positions the candidate for this exact role and domain without saying it was tailored for a company or application. It must mention only supported evidence from the CV.
3. CORE COMPETENCIES: Use 4–7 named categories (e.g. "Cloud & Platform Engineering: AWS, GCP, Azure"). Each category on its own line with no bullet prefix. Do NOT include an "Additional Relevant Skills" or "Additional Skills" section — place every skill in a named category or omit it. No duplicate skills across categories.
4. For each relevant role: preserve the official job title exactly, then add one short "Focus:" line below it when the original responsibilities support the target role.
5. For each role: rewrite relevant bullets with JD vocabulary (same meaning, aligned language), reorder bullets so the strongest target-role evidence comes first.
6. Include every user-confirmed addition in the skills/core competencies section as concise skill names. You may also use them in the summary when natural, but do not attach them to a specific employer, project, metric, certification, or achievement unless that context exists in the original CV.
7. Preserve all locked fields exactly — same spelling, capitalisation, and punctuation.
8. The final CV must read like a polished CV for "${jdData.jobTitle || 'the target role'}", not like a generic CV and not like generated marketing copy.

Output the complete tailored CV text with no preamble, no commentary, and no markdown code fences. Begin directly with the candidate's name.`;

    return { systemPrompt, userPrompt, temperature: 0.3 };
  }

  buildTailoredCvAuditPrompt(cvData, jdData, matchMap = [], tailoredText = '', confirmedSkills = []) {
    const supported = (matchMap || [])
      .filter(m => m.allowedToMention)
      .map(m => ({
        requirement: m.requirement,
        evidence: Array.isArray(m.evidence) ? m.evidence.slice(0, 3) : [],
        confirmedByUser: Boolean(m.confirmedByUser),
      }));
    const unsupported = (matchMap || [])
      .filter(m => !m.allowedToMention)
      .map(m => m.requirement)
      .filter(Boolean);

    const systemPrompt = `You are a strict CV truth-auditor.

Your job is to remove unsupported claims from a tailored CV. You are not improving style. You are checking evidence.

Rules:
- Return the complete corrected CV text only.
- Preserve locked facts from the original CV: names, employers, job titles, dates, education, certifications, contact details.
- Every skill, claim, achievement, tool, methodology, domain phrase, and focus line in the corrected CV must be supported by either:
  1. the ORIGINAL CV text,
  2. a SUPPORTED REQUIREMENT with evidence,
  3. a USER-CONFIRMED addition.
- If a phrase only appears in the JD or target role and has no support, remove it.
- Never paste JD requirement prose into the skills section.
- Skills sections must contain short skill phrases only, not sentences, years-of-experience requirements, commute/location requirements, education requirements, or phrases like "track record of...".
- Do not add new content. Delete or simplify unsupported content.`;

    const supportedLines = supported.map(item => {
      const evidence = item.confirmedByUser
        ? 'User-confirmed addition'
        : (item.evidence.length
            ? item.evidence.map(e => `"${e}"`).join(' | ')
            : 'No direct CV citation; keep only if visibly supported by ORIGINAL CV');
      return `  ✓ ${item.requirement}\n    Evidence: ${evidence}`;
    });

    const userPrompt = `TARGET ROLE
  Job title: ${jdData?.jobTitle || 'Not specified'}
  Company: ${jdData?.company || 'Not specified'}

SUPPORTED REQUIREMENTS / CLAIMS ALLOWED IN THE CV
${supportedLines.length ? supportedLines.join('\n') : '  (none)'}

USER-CONFIRMED ADDITIONS
${this._uniqueDisplaySkills(confirmedSkills).length ? this._uniqueDisplaySkills(confirmedSkills).map(s => `  + ${s}`).join('\n') : '  (none)'}

UNSUPPORTED JD REQUIREMENTS / CLAIMS TO REMOVE IF PRESENT
${unsupported.length ? unsupported.map(s => `  ✗ ${s}`).join('\n') : '  (none)'}

ORIGINAL CV — source of truth
${cvData?.rawText || ''}

TAILORED CV TO AUDIT
${tailoredText || ''}

AUDIT INSTRUCTION
Return a corrected complete CV. Remove any unsupported JD-only skills, methods, responsibilities, tools, metrics, commute/location requirements, years-of-experience requirements, degree requirements, and sales/role requirements that are not evidenced by the original CV or confirmed additions.`;

    return { systemPrompt, userPrompt, temperature: 0.1 };
  }

  buildTailoringPlan(cvData, jdData, matchMap = []) {
    const domain = jdData.domain || this._detectDomain(jdData);
    const domainLabel = jdData.targetPositioning || {
      mlops: 'MLOps, AI/ML platform engineering, production reliability, and automation',
      data_engineering: 'data engineering, data pipelines, platform reliability, and automation',
      devops: 'DevOps, cloud infrastructure, platform reliability, and automation',
      ml_scientist: 'machine learning, experimentation, model development, and AI tooling',
      frontend: 'frontend engineering, product delivery, UI quality, and modern web tooling',
      backend: 'backend engineering, APIs, distributed systems, and service reliability',
      cloud: 'cloud architecture, infrastructure automation, security, and reliability',
      solution_engineering: 'customer-facing technical leadership, enterprise SaaS solution delivery, POC/POV execution, and pre-sales technical engagement',
    }[domain] || `${jdData.jobTitle || 'the target role'} responsibilities, supported technologies, and relevant achievements`;

    const supportedKeywords = this._rankSupportedKeywords(matchMap, jdData).slice(0, 18);

    // When Groq has already provided targetPositioning, the regex focus-line
    // suggestions would mislead the tailoring LLM with hardcoded tech categories.
    // Let the tailoring LLM derive focus lines from targetPositioning instead.
    const roleFocusLines = jdData.targetPositioning
      ? []
      : (cvData.experience || [])
          .map(exp => {
            const focus = this._buildRoleFocus(exp, jdData, matchMap);
            return focus ? { company: exp.company || '', title: exp.title || '', focus } : null;
          })
          .filter(Boolean);

    return {
      domain,
      targetPositioning: domainLabel,
      supportedKeywords,
      roleFocusLines,
    };
  }

  finalizeTailoredCV(rawText, { cvData, jdData, matchMap = [], confirmedSkills = [] } = {}) {
    return this.cleanSkillsSection(
      this.ensureRoleFocusLines(
        this.ensureConfirmedSkillsIncluded(
          this.removeTailoringMetaPhrases(
            this.enforceTargetHeadline(rawText, jdData?.jobTitle),
            jdData?.company
          ),
          confirmedSkills
        ),
        cvData,
        jdData,
        matchMap
      ),
      matchMap,
      confirmedSkills,
      jdData
    );
  }

  enforceTargetHeadline(tailoredText, jobTitle) {
    const title = String(jobTitle || '').trim();
    if (!title || !tailoredText) return tailoredText;

    const lines = String(tailoredText).split('\n');
    const firstTextIdx = lines.findIndex(l => l.trim());
    if (firstTextIdx === -1) return tailoredText;

    // Find end of header block (first section header)
    let headerEnd = lines.length;
    for (let j = firstTextIdx + 1; j < lines.length; j++) {
      if (this._isLikelySectionHeader(lines[j].trim())) { headerEnd = j; break; }
    }

    const normalise = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const titleNorm = normalise(title);

    // Remove any existing title line(s) from the header block (scan backwards to
    // avoid index shifting issues) so we don't end up with duplicates.
    for (let j = headerEnd - 1; j > firstTextIdx; j--) {
      if (normalise(lines[j]) === titleNorm) {
        lines.splice(j, 1);
        headerEnd--;
      }
    }

    // Insert the title immediately after the name line so it sits above contact
    // details — Harvard format: Name → Title → contact info → section headers.
    lines.splice(firstTextIdx + 1, 0, title);
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

  ensureRoleFocusLines(tailoredText, cvData = {}, jdData = {}, matchMap = []) {
    if (!tailoredText) return tailoredText;

    const lines = String(tailoredText).split('\n');
    let searchFrom = 0;

    for (const exp of (cvData.experience || [])) {
      const focus = this._buildRoleFocus(exp, jdData, matchMap);
      if (!focus || !exp.title) continue;

      const titleIdx = this._findTitleLineIndex(lines, exp.title, searchFrom);
      if (titleIdx === -1) continue;

      const nextMeaningfulIdx = this._nextMeaningfulLineIndex(lines, titleIdx + 1);
      if (nextMeaningfulIdx !== -1 && /^focus\s*:/i.test(lines[nextMeaningfulIdx].trim())) {
        searchFrom = nextMeaningfulIdx + 1;
        continue;
      }

      lines.splice(titleIdx + 1, 0, `Focus: ${focus}`);
      searchFrom = titleIdx + 2;
    }

    return lines.join('\n');
  }

  cleanSkillsSection(tailoredText, matchMap = [], confirmedSkills = [], jdData = {}) {
    if (!tailoredText) return tailoredText;

    const lines = String(tailoredText).split('\n');
    const cleaned = [];
    let i = 0;

    while (i < lines.length) {
      cleaned.push(lines[i]);

      if (!this._isSkillsSectionHeader(lines[i])) {
        i++;
        continue;
      }

      i++;
      const sectionLines = [];
      while (i < lines.length && !this._isLikelySectionHeader(lines[i])) {
        sectionLines.push(lines[i]);
        i++;
      }

      const skillLines = this._normaliseSkillSectionLines(sectionLines, matchMap, confirmedSkills, jdData);
      cleaned.push(...skillLines);
      continue;
    }

    return cleaned.join('\n');
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

  validateTailoringQuality(originalCvData, jdData, matchMap, tailoredText, confirmedSkills = []) {
    if (!tailoredText) return [];
    const warnings = [];
    const normalisedOutput = this._normaliseText(tailoredText);
    const normalisedOriginal = this._normaliseText(originalCvData?.rawText || '');

    const jobTitle = String(jdData?.jobTitle || '').trim();
    if (jobTitle && !normalisedOutput.includes(this._normaliseText(jobTitle))) {
      warnings.push(`Target job title may be missing from the tailored CV headline: "${jobTitle}"`);
    }

    for (const skill of this._uniqueDisplaySkills(confirmedSkills)) {
      if (!normalisedOutput.includes(this._normaliseText(skill))) {
        warnings.push(`User-confirmed skill was not included in the tailored CV: "${skill}"`);
      }
    }

    for (const exp of (originalCvData?.experience || [])) {
      const focus = this._buildRoleFocus(exp, jdData, matchMap);
      if (!focus || !exp.title) continue;
      const titleIdx = this._findTitleLineIndex(String(tailoredText).split('\n'), exp.title, 0);
      if (titleIdx !== -1) {
        const afterTitle = String(tailoredText).split('\n').slice(titleIdx + 1, titleIdx + 4).join('\n');
        if (!/^focus\s*:/im.test(afterTitle)) {
          warnings.push(`Role focus line may be missing under "${exp.title}"`);
        }
      }
    }

    for (const item of (matchMap || []).filter(m => !m.allowedToMention)) {
      for (const candidate of this._extractAtomicSkillCandidates(item.requirement)) {
        const key = this._normaliseText(candidate);
        if (!key || normalisedOriginal.includes(key)) continue;
        if (normalisedOutput.includes(key)) {
          warnings.push(`Unsupported JD skill/tool may have been claimed without CV evidence or user confirmation: "${candidate}"`);
        }
      }
    }

    return [...new Set(warnings)];
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

  _rankSupportedKeywords(matchMap = [], jdData = {}) {
    const targetText = this._normaliseText([
      jdData.jobTitle,
      ...(jdData.requiredSkills || []),
      ...(jdData.tools || []),
      ...(jdData.responsibilities || []),
      ...(jdData.atsKeywords || []),
    ].join(' '));

    return this._uniqueDisplaySkills(
      (matchMap || [])
        .filter(m => m.allowedToMention)
        .map(m => m.requirement)
        .flatMap(item => this._splitSkillLine(String(item || '')))
        .map(item => this._cleanSkillItem(item))
        .filter(item => this._isUsefulSkillItem(item))
        .filter(item => !this._isJdRequirementProse(item))
        .sort((a, b) => {
          const aTarget = targetText.includes(this._normaliseText(a)) ? 1 : 0;
          const bTarget = targetText.includes(this._normaliseText(b)) ? 1 : 0;
          return bTarget - aTarget || a.length - b.length;
        })
    );
  }

  _buildRoleFocus(exp = {}, jdData = {}, matchMap = []) {
    const roleText = this._normaliseText([
      exp.title,
      exp.company,
      ...(exp.responsibilities || []),
    ].join(' '));
    if (!roleText) return '';

    const targetText = this._normaliseText([
      jdData.jobTitle,
      ...(jdData.requiredSkills || []),
      ...(jdData.preferredSkills || []),
      ...(jdData.tools || []),
      ...(jdData.responsibilities || []),
      ...(jdData.atsKeywords || []),
    ].join(' '));

    const supportedText = this._normaliseText(
      (matchMap || [])
        .filter(m => m.allowedToMention)
        .map(m => m.requirement)
        .join(' ')
    );
    const combinedTarget = `${targetText} ${supportedText}`;

    const categories = [
      {
        label: 'pre-sales technical engagement and POC/POV delivery',
        evidence: /\b(poc|pov|proof of concept|proof of value|demo|technical selling|pre-sales|champion|value engineering|rfp|rfi|business value)\b/,
        target: /\b(poc|pov|demo|pre-sales|solution engineer|technical sales|enterprise saas|business value|champion|selling)\b/,
      },
      {
        label: 'customer-facing technical leadership and enterprise SaaS delivery',
        evidence: /\b(customer.facing|technical support|enterprise support|customer success|escalation|tier [34]|complex platform|issue resolution|saas deployment|enterprise)\b/,
        target: /\b(customer.facing|technical leadership|enterprise|customer success|solution engineer|account|saas|enterprise saas)\b/,
      },
      {
        label: 'solution architecture and systems integration',
        evidence: /\b(solution architect|architecture|api integration|systems? integration|platform integration|cicd integration|pipeline|security scanning)\b/,
        target: /\b(solution architect|integration|architecture|api|platform|cicd|security|compliance|systems?)\b/,
      },
      {
        label: 'MLOps and AI platform enablement',
        evidence: /\b(mlops|machine learning| ai | llm|model|cody|langchain|openai|ai-powered|security scanning)\b/,
        target: /\b(mlops|machine learning| ai | llm|model|vertex|mlflow|pytorch|tensorflow|agent|data science)\b/,
      },
      {
        label: 'cloud infrastructure',
        evidence: /\b(aws|azure|gcp|cloud|infrastructure|deployment|environment|configuration|terraform|iac)\b/,
        target: /\b(aws|azure|gcp|cloud|infrastructure|terraform|iac|gke|cloud run|platform)\b/,
      },
      {
        label: 'platform reliability',
        evidence: /\b(reliability|stability|production|incident|sla|on-call|root cause|rca|remediation|systemic|availability)\b/,
        target: /\b(reliability|stability|production|incident|monitor|scale|platform|sre|availability)\b/,
      },
      {
        label: 'automation',
        evidence: /\b(automation|automate|python|script|scripting|tooling|workflow|manual effort)\b/,
        target: /\b(automation|python|script|scripting|workflow|tooling|enable)\b/,
      },
      {
        label: 'production diagnostics',
        evidence: /\b(diagnostic|troubleshoot|investigation|debug|log analysis|reproduction|performance|issue resolution)\b/,
        target: /\b(diagnostic|troubleshoot|monitor|performance|reliability|production|quality)\b/,
      },
      {
        label: 'CI/CD and release engineering',
        evidence: /\b(ci\/cd|pipeline|github actions|gitlab|jenkins|circleci|buildkite|release|deployment)\b/,
        target: /\b(ci\/cd|pipeline|gitlab|github actions|release|deployment|ship)\b/,
      },
      {
        label: 'containerization and orchestration',
        evidence: /\b(kubernetes|docker|container|gke|helm)\b/,
        target: /\b(kubernetes|docker|container|gke|helm|orchestration)\b/,
      },
      {
        label: 'observability and monitoring',
        evidence: /\b(monitoring|observability|grafana|prometheus|datadog|new relic|logs?|metrics|alert)\b/,
        target: /\b(monitoring|observability|grafana|prometheus|datadog|new relic|logs?|metrics|alert)\b/,
      },
      {
        label: 'data pipelines and quality',
        evidence: /\b(data pipeline|etl|airflow|bigquery|dataflow|sql|data quality|database)\b/,
        target: /\b(data pipeline|etl|airflow|bigquery|dataflow|sql|data quality|data platform)\b/,
      },
      {
        label: 'security platform engineering',
        evidence: /\b(security|semgrep|scan|false positive|vulnerabilit|sast|pipeline instability)\b/,
        target: /\b(security|scan|compliance|vulnerabilit|sast|secure)\b/,
      },
      {
        label: 'engineering enablement',
        evidence: /\b(mentor|guidance|documentation|runbook|knowledge base|framework|enable|training|standard|process)\b/,
        target: /\b(enable|guidance|mentor|documentation|framework|team|collaborat|knowledge)\b/,
      },
    ];

    const matches = categories
      .map((category, index) => {
        const hasEvidence = category.evidence.test(roleText);
        if (!hasEvidence) return null;
        const targetScore = category.target.test(combinedTarget) ? 2 : 0;
        const evidenceScore = category.evidence.test(supportedText) ? 1 : 0;
        return { ...category, index, score: targetScore + evidenceScore };
      })
      .filter(Boolean)
      .filter(item => item.score > 0);

    const selected = matches
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 5)
      .map(item => item.label);

    if (selected.length < 2) return '';
    return this._formatList(selected);
  }

  _formatList(items = []) {
    const unique = this._uniqueDisplaySkills(items);
    if (unique.length <= 2) return unique.join(' and ');
    return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
  }

  _findTitleLineIndex(lines, title, start = 0) {
    const titleKey = this._normaliseText(title);
    if (!titleKey) return -1;
    for (let i = Math.max(0, start); i < lines.length; i++) {
      const line = this._normaliseText(lines[i]);
      if (!line) continue;
      if (line === titleKey) return i;
      if (line === this._normaliseText(`Position: ${title}`)) return i;
      if (/^position\s+/.test(line) && line.includes(titleKey)) return i;
      if (line.startsWith(titleKey) && line.length <= titleKey.length + 80) return i;
      if (line.includes(titleKey) && line.length <= titleKey.length + 20) return i;
    }
    return -1;
  }

  _nextMeaningfulLineIndex(lines, start = 0) {
    for (let i = Math.max(0, start); i < lines.length; i++) {
      if (String(lines[i] || '').trim()) return i;
    }
    return -1;
  }

  _extractAtomicSkillCandidates(requirement) {
    const cleaned = this._cleanSkillItem(requirement);
    if (!this._isUsefulSkillItem(cleaned)) return [];
    if (this._isJdRequirementProse(cleaned)) return [];
    const tokens = this._getCoreTokens(cleaned);
    if (tokens.length > 4) return [];
    return [cleaned];
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

  _isSkillsSectionHeader(line) {
    return /^(core\s+competenc(?:y|ies)|technical\s+skills?|skills|technologies|tools|expertise)\s*[:\-]?$/i
      .test(String(line || '').trim());
  }

  _normaliseSkillSectionLines(sectionLines, matchMap = [], confirmedSkills = [], jdData = {}) {
    const rawItems = [];
    for (const line of sectionLines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      const body = trimmed.replace(/^[-•*●▪◦–—]\s*/, '').trim();
      if (!body) continue;
      rawItems.push(...this._splitSkillLine(body));
    }

    const allowedSeed = [
      ...((matchMap || []).filter(m => m.allowedToMention).map(m => m.requirement)),
      ...(confirmedSkills || []),
    ];
    const allowedPhrases = this._uniqueDisplaySkills(
      allowedSeed.flatMap(item => this._splitSkillLine(String(item || '')))
    );

    const compactItems = [];
    for (const item of rawItems) {
      const cleaned = this._cleanSkillItem(item);
      for (const split of this._splitSkillValues(cleaned)) {
        const skill = this._cleanSkillItem(split);
        if (this._isUsefulSkillItem(skill)) compactItems.push(skill);
      }
    }

    for (const item of allowedPhrases) {
      const cleaned = this._cleanSkillItem(item);
      for (const split of this._splitSkillValues(cleaned)) {
        const skill = this._cleanSkillItem(split);
        if (this._isUsefulSkillItem(skill)) compactItems.push(skill);
      }
    }

    const unique = this._uniqueDisplaySkills(compactItems)
      .filter(item => !this._isJdRequirementProse(item))
      .filter(item => !this._isRequirementFragment(item));

    const grouped = this._buildGroupedSkills(unique, jdData);
    if (grouped.length > 0) return grouped;

    if (unique.length === 0) return [];
    return unique.slice(0, 18).map(item => `- ${item}`);
  }

  _splitSkillLine(line) {
    let text = String(line || '')
      .replace(/\)\s*(?=[A-Z][A-Za-z ]{2,30}:)/g, ') ')
      .replace(/([a-z)])(?=[A-Z][A-Za-z ]{2,30}:)/g, '$1, ')
      .replace(/\((?:e\.g\.|eg),?\s*([^)]+)\)/gi, ', $1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return [];

    const labelled = [...text.matchAll(/(?:^|[.;,]\s*)([A-Z][A-Za-z0-9/& -]{2,56}):\s*([\s\S]*?)(?=(?:[.;,]\s*[A-Z][A-Za-z0-9/& -]{2,56}:)|$)/g)];
    if (labelled.length >= 1) {
      return labelled.flatMap(([, , value]) => this._splitSkillValues(value));
    }

    return text
      .split(/\s*(?:;|\n|•)\s*/)
      .flatMap(part => part.split(/\s*,\s*/))
      .flatMap(part => part.split(/\s+\band\b\s+(?=[A-Z][A-Za-z0-9+#/. -]{2,40}$)/i))
      .map(part => part.trim())
      .filter(Boolean);
  }

  _splitSkillValues(value) {
    return String(value || '')
      .replace(/\((?:e\.g\.|eg),?\s*([^)]+)\)/gi, ', $1')
      .split(/\s*,\s*|\s+\/\s+|\s+\|\s+/)
      .map(part => part.trim())
      .filter(Boolean);
  }

  _cleanSkillItem(item) {
    return String(item || '')
      .replace(/^[-•*●▪◦–—]\s*/, '')
      .replace(/\.\s*Strong experience with version control systems,\s*particularly\s+Git/gi, ', Git')
      .replace(/\b(?:strong|solid|excellent|deep)\s+(?:knowledge|understanding|experience)\s+of\s+/gi, '')
      .replace(/\bproficiency\s+in\s+/gi, '')
      .replace(/\bexpertise\s+in\s+/gi, '')
      .replace(/\bfamiliarity\s+with\s+/gi, '')
      .replace(/\bexperience\s+with\s+/gi, '')
      .replace(/\bpython\s+and\s+scripting\s+for\s+automation\b/gi, 'Python, automation')
      .replace(/\bcontainerization\s+with\s+Docker\s+and\s+orchestration\s+with\s+Kubernetes\b/gi, 'Docker, Kubernetes')
      .replace(/\bstructured\s+sales\s+methodolog(?:y|ies)\s+(MEDDPICC|MEDDICC|MEDDIC)\b/gi, '$1')
      .replace(/\bworld[- ]class\s+demos\b/gi, 'technical demos')
      .replace(/^(?:and|or)\s+/i, '')
      .replace(/^POCs$/i, 'POC')
      .replace(/^POVs$/i, 'POV')
      .replace(/^(?:minimum|preferred)\s+qualifications?\s*:\s*/i, '')
      .replace(/^(?:technical\s+stack|programming\s*&\s*scripting|security\s+mindset|ethical\s+ai\s+knowledge|education|experience)\s*:\s*/i, '')
      .replace(/^[A-Z][A-Za-z0-9/& -]{2,56}:\s*/, '')
      .replace(/\b(?:e\.g\.|eg)\.?,?\s*/gi, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([),.;:])/g, '$1')
      .replace(/[.,;]\s*$/, '')
      .trim();
  }

  _isUsefulSkillItem(item) {
    const text = String(item || '').trim();
    if (!text || text.length < 2 || text.length > 140) return false;
    if (this._isJdRequirementProse(text)) return false;
    if (/^(?:strong|solid|excellent|deep)\s+(?:technical|business|communication)\b/i.test(text)) return false;
    if (/^(?:co?m|similar|or\s+similar)$/i.test(text)) return false;
    if (/^\(?\+?\d*\+?\s*(?:year|yr|month)/i.test(text)) return false;
    if (/:\s*\(?\d+\s*(?:year|yr|month)/i.test(text)) return false;
    if (/\b(?:bachelor|master|degree|related field|advanced degree|certification[s]?\s+in)\b/i.test(text)) return false;
    return /[A-Za-z]/.test(text);
  }

  _isJdRequirementProse(item) {
    const text = String(item || '').trim();
    return text.length > 160
      || /\b\d+\+?\s+years?\s+of\s+experience\b/i.test(text)
      || /\b\d+\+?\s+years?\s+(in|of|with|at)\b/i.test(text)
      || /^\+\s*years?\s+(in|of|with|at)\b/i.test(text)
      || /\bat least\s+\d+\s+years?\b/i.test(text)
      || /\bwillingness\s+to\b/i.test(text)
      || /\btrack\s+record\s+of\b/i.test(text)
      || /\bselling\s+complex\s+enterprise\s+saas\b/i.test(text)
      || /\b(?:based\s+in|able\s+to\s+commute|commute\s+to|days?\s+per\s+week|willing(?:ness)?\s+to\s+(?:travel|commute|relocate))\b/i.test(text)
      || /\b(highly preferred|required|minimum qualifications?|preferred qualifications?|related field|equivalent practical experience)\b/i.test(text)
      || /\bdeploying and managing\b/i.test(text)
      || /\bor other relevant standards\b/i.test(text)
      || /\b(?:developing|architecting|designing|utilizing|ensuring|prioritizing|foster|evaluate|maintains?)\b.{20,}/i.test(text);
  }

  _isRequirementFragment(item) {
    const text = String(item || '').trim();
    if (!text) return true;
    if (/^(?:years?|experience|ability|minimum qualifications?|preferred qualifications?)\b/i.test(text)) return true;
    if (/^(?:developing|architecting|designing|utilizing|ensuring|prioritizing|fostering|managing|selling|closing|negotiating|sourcing|delivering)\b/i.test(text)) return true;
    if (/^(?:willingness|track\s+record|commitment|based\s+in|able\s+to|and\s+world[- ]?class)\b/i.test(text)) return true;
    if (/^(?:strong|solid|excellent|deep)\s+(?:technical|business|communication)\b/i.test(text)) return true;
    if (/^(?:co?m|similar|or\s+similar)$/i.test(text)) return true;
    if (/\b(?:commute|days?\s+per\s+week|or\s+similar)\b/i.test(text)) return true;
    if (/\b(?:with experience in|technical customer-facing role)\b/i.test(text)) return true;
    if (/\b(?:bachelor|master|phd|degree|science, technology, engineering, mathematics)\b/i.test(text)) return true;
    if (text.split(/\s+/).length > 12 && !/:/.test(text)) return true;
    return false;
  }

  _buildGroupedSkills(items = [], jdData = {}) {
    // When the LLM has provided skill categories for this specific role, use them
    // directly instead of the hardcoded tech-only buckets.
    if (Array.isArray(jdData.skillCategories) && jdData.skillCategories.length > 0) {
      return this._buildGroupedSkillsFromLLMCategories(items, jdData.skillCategories);
    }

    const domain = jdData.domain || this._detectDomain(jdData);
    const isSolutionEngineering = domain === 'solution_engineering';
    const buckets = isSolutionEngineering ? [
      { label: 'Pre-Sales & Solution Engineering', terms: ['POC', 'POV', 'proof of concept', 'proof of value', 'technical demo', 'demo', 'RFP', 'RFI', 'solution selling', 'technical selling', 'pre-sales', 'value engineering', 'business value'] },
      { label: 'Customer Engagement & Success', terms: ['customer success', 'customer-facing', 'enterprise SaaS', 'stakeholder alignment', 'executive engagement', 'champion building', 'account management', 'customer onboarding', 'renewal', 'expansion'] },
      { label: 'Technical Architecture & Integration', terms: ['solution architecture', 'systems integration', 'API integration', 'REST APIs', 'cloud architecture', 'Docker', 'Kubernetes', 'CI/CD', 'GitHub Actions', 'security scanning'] },
      { label: 'Cloud & Platform Engineering', terms: ['AWS', 'Azure', 'GCP', 'cloud infrastructure', 'Infrastructure as Code', 'Terraform', 'platform reliability'] },
      { label: 'Programming & Automation', terms: ['Python', 'Go', 'automation', 'scripting', 'tooling', 'Bash'] },
      { label: 'CI/CD & DevOps', terms: ['GitLab CI', 'Jenkins', 'CircleCI', 'Buildkite', 'Azure DevOps', 'pipeline', 'deployment'] },
      { label: 'Leadership & Stakeholder Management', terms: ['technical leadership', 'stakeholder management', 'cross-functional collaboration', 'willingness to travel', 'sales partnership', 'team leadership', 'mentorship', 'executive communication', 'change management', 'release governance', 'compliance'] },
    ] : [
      { label: 'AI & GenAI Systems', terms: ['Generative AI', 'AI solutions', 'RAG systems', 'multi-agent workflows', 'agentic systems', 'ReAct', 'tool-calling', 'context engineering', 'explainability', 'transparency'] },
      { label: 'Cloud & Platform Engineering', terms: ['Google Cloud', 'GCP', 'Vertex AI', 'AWS', 'Azure', 'cloud infrastructure', 'platform reliability', 'production reliability', 'engineering enablement', 'Terraform', 'Pulumi', 'Infrastructure as Code', 'IaC'] },
      { label: 'Programming & Automation', terms: ['Python', 'Go', 'Bash', 'PowerShell', 'automation', 'scripting', 'FastAPI', 'Flask', 'Git', 'version control'] },
      { label: 'MLOps & ML Lifecycle', terms: ['MLOps', 'MLflow', 'DVC', 'model registry', 'experiment tracking', 'artifact versioning', 'reproducible training workflows'] },
      { label: 'Model Serving & Infrastructure', terms: ['KServe', 'SageMaker', 'BentoML', 'Docker', 'Kubernetes', 'K8s', 'Kubeflow Pipelines', 'container orchestration'] },
      { label: 'CI/CD & Delivery', terms: ['GitHub Actions', 'GitLab CI', 'Jenkins', 'CircleCI', 'Azure DevOps', 'ArgoCD', 'Argo Workflows', 'Prefect', 'DevOps', 'Release Governance', 'Change Management'] },
      { label: 'Observability & Reliability', terms: ['Prometheus', 'Grafana', 'logging', 'log analysis', 'distributed tracing', 'incident response', 'RCA', 'runbooks', 'on-call', 'monitoring', 'performance tuning', 'diagnostics', 'alerting'] },
      { label: 'Leadership & Stakeholder Management', terms: ['people management', 'technical mentorship', 'technical hiring', 'stakeholder management', 'sales partnership', 'engineering leadership', 'technical lead', 'team leadership', 'customer-facing technical leadership'] },
    ];

    const itemKeys = new Map(this._uniqueDisplaySkills(items).map(item => [this._normaliseText(item), item]));
    const jdText = this._normaliseText([
      jdData.jobTitle,
      ...(jdData.requiredSkills || []),
      ...(jdData.preferredSkills || []),
      ...(jdData.tools || []),
      ...(jdData.responsibilities || []),
      ...(jdData.atsKeywords || []),
    ].join(' '));

    const used = new Set();
    const lines = [];

    for (const bucket of buckets) {
      const matched = [];
      for (const term of bucket.terms) {
        const key = this._normaliseText(term);
        const existing = itemKeys.get(key);
        if (existing && !used.has(key)) {
          matched.push(existing);
          used.add(key);
        } else if (jdText.includes(key) && itemKeys.has(key) && !used.has(key)) {
          matched.push(itemKeys.get(key));
          used.add(key);
        }
      }

      for (const item of itemKeys.values()) {
        const key = this._normaliseText(item);
        if (used.has(key)) continue;
        if (this._skillBelongsInBucket(item, bucket.label)) {
          matched.push(item);
          used.add(key);
        }
      }

      const cleaned = this._uniqueDisplaySkills(matched).slice(0, 8);
      if (cleaned.length > 0) lines.push(`${bucket.label}: ${cleaned.join(', ')}`);
    }

    return lines;
  }

  /**
   * Build grouped skill lines using LLM-provided categories.
   * Categories come from jdData.skillCategories: { label, skills }[]
   * Items are CV-supported skills from the matchMap.
   */
  _buildGroupedSkillsFromLLMCategories(items = [], categories = []) {
    const itemKeys = new Map(
      this._uniqueDisplaySkills(items).map(item => [this._normaliseText(item), item])
    );
    const used = new Set();
    const lines = [];

    for (const cat of categories) {
      const catSkills = Array.isArray(cat.skills) ? cat.skills : [];
      const matched = [];

      // Direct term matches
      for (const term of catSkills) {
        const key = this._normaliseText(term);
        if (itemKeys.has(key) && !used.has(key)) {
          matched.push(itemKeys.get(key));
          used.add(key);
        }
      }

      // Fuzzy: CV item whose normalized text contains or is contained by a category term
      for (const [key, item] of itemKeys) {
        if (used.has(key)) continue;
        const fits = catSkills.some(term => {
          const t = this._normaliseText(term);
          return t.length >= 3 && (key.includes(t) || t.includes(key));
        });
        if (fits) {
          matched.push(item);
          used.add(key);
        }
      }

      const cleaned = this._uniqueDisplaySkills(matched)
        .filter(item => !this._isRequirementFragment(item))
        .slice(0, 8);
      if (cleaned.length > 0) lines.push(`${cat.label}: ${cleaned.join(', ')}`);
    }

    return lines;
  }

  _skillBelongsInBucket(item, bucketLabel) {
    const text = this._normaliseText(item);
    const patterns = {
      'AI & GenAI Systems': /\b(genai|generative ai|rag|agent|react|tool calling|context engineering|explainability|ai solutions?)\b/,
      'Cloud & Platform Engineering': /\b(gcp|google cloud|vertex|aws|azure|cloud|platform|infrastructure|reliability|enablement|performance.tun|diagnostic|terraform|pulumi|iac)\b/,
      'Programming & Automation': /\b(python|golang|go|bash|powershell|automation|scripting|fastapi|flask|git|version.?control)\b/,
      'MLOps & ML Lifecycle': /\b(mlops|mlflow|dvc|model registry|experiment|artifact|training workflow)\b/,
      'Model Serving & Infrastructure': /\b(kserve|sagemaker|bentoml|docker|kubernetes|k8s|kubeflow|serving|container)\b/,
      'CI/CD & Delivery': /\b(ci.?cd|github actions|gitlab|jenkins|circleci|azure devops|argocd|argo|prefect|delivery|devops|release|change management|governance|compliance)\b/,
      'CI/CD & DevOps': /\b(ci.?cd|github actions|gitlab|jenkins|circleci|azure devops|buildkite|pipeline|deployment|devops|release|change management)\b/,
      'Observability & Reliability': /\b(prometheus|grafana|log|tracing|incident|rca|runbook|on.?call|observability|monitoring|performance|diagnostic|alert)\b/,
      'Leadership & Stakeholder Management': /\b(people management|mentorship|hiring|stakeholder|sales|leadership|technical lead|customer.?facing|team|travel|executive|communication|change management)\b/,
      'Pre-Sales & Solution Engineering': /\b(poc|pov|proof of concept|proof of value|demo|rfp|rfi|pre.?sales|value engineering|solution selling|technical selling|business value|champion)\b/,
      'Customer Engagement & Success': /\b(customer success|customer.?facing|enterprise saas|stakeholder|account management|onboarding|renewal|expansion|executive engagement)\b/,
      'Technical Architecture & Integration': /\b(solution architecture|systems? integration|api.?integration|rest api|cloud architecture|docker|kubernetes|k8s|ci.?cd|security scanning)\b/,
    };
    return patterns[bucketLabel]?.test(text) || false;
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

    if (/\b(cloud\s+architect|solutions?\s+architect|aws\s+architect|gcp\s+architect)\b/.test(combined) &&
        !/\b(solutions?\s+engineer|pre[- ]?sales|sales\s+engineer|technical\s+account)\b/.test(combined))
      return 'cloud';

    if (/\b(solutions?\s+engineer|pre[- ]?sales|sales\s+engineer|technical\s+account\s+manager|tam|customer\s+success\s+engineer|field\s+engineer|value\s+engineer|solution\s+consultant|technical\s+sales|solutions?\s+architect)\b/.test(combined) ||
        /\b(poc|pov|proof\s+of\s+concept|proof\s+of\s+value|technical\s+selling|enterprise\s+saas|demo|champion|stakeholder\s+alignment)\b/.test(combined))
      return 'solution_engineering';

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
      solution_engineering: [
        'Salesforce', 'Gong', 'Outreach', 'Loom', 'Notion', 'Confluence',
        'Miro', 'Slack', 'Zoom', 'Chorus', 'HubSpot', 'Jira',
        'Docker', 'Kubernetes', 'GitHub Actions', 'CI/CD', 'REST APIs',
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
