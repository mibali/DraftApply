export class CVTailor {
  /**
   * Build a match map between JD requirements and CV evidence.
   * @returns {{ requirement, type, status, evidence, allowedToMention }[]}
   */
  buildMatchMap(cvData, jdData) {
    const cvText = cvData.rawText || '';
    const cvLower = cvText.toLowerCase();

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
      ...(jdData.softSkills      || []).map(r => ({ req: r, type: 'soft' })),
    ];

    // Deduplicate: remove exact duplicates and bare keywords already embedded in a longer entry
    const reqTexts = allRequirements.map(r => r.req.toLowerCase().trim());
    const deduped = allRequirements.filter(({ req }, i) => {
      const key = req.toLowerCase().trim();
      if (reqTexts.indexOf(key) < i) return false; // exact duplicate, already seen
      // Short bare keyword whose text is already captured by a longer requirement
      if (key.length <= 25 && reqTexts.some((other, j) => j !== i && other !== key && other.includes(key) && other.length > key.length)) return false;
      return true;
    });

    return deduped.map(({ req, type }) => {
      const evidence = this._findEvidence(req, cvSources);
      const coreTokens = this._getCoreTokens(req);
      const supportedCoreTokens = coreTokens.filter(tok =>
        cvSources.some(source => source && this._normaliseText(source).includes(tok))
      );
      const fullySupported = coreTokens.length === 0 || supportedCoreTokens.length === coreTokens.length;
      const isAtomicRequirement = coreTokens.length <= 1;
      let status;
      if (!fullySupported) {
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
        evidence,
        allowedToMention: status !== 'missing',
      };
    });
  }

  /** Returns a summary score and categorised lists. */
  buildMatchSummary(matchMap) {
    const required = matchMap.filter(m => m.type === 'required');
    const strong   = matchMap.filter(m => m.status === 'strong_match');
    const partial  = matchMap.filter(m => m.status === 'partial_match');
    const missing  = matchMap.filter(m => m.status === 'missing');

    // Score: weight required matches more heavily
    const reqTotal    = required.length || 1;
    const reqMatched  = required.filter(m => m.status !== 'missing').length;
    const allTotal    = matchMap.length || 1;
    const allMatched  = strong.length + partial.length * 0.5;

    const score = Math.round(
      ((reqMatched / reqTotal) * 0.7 + (allMatched / allTotal) * 0.3) * 100
    );

    return {
      score:                   Math.min(100, score),
      strongMatches:           strong.map(m => m.requirement),
      partialMatches:          partial.map(m => m.requirement),
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

WHAT YOU MAY DO:
• Update the professional headline / title line (the short descriptor directly below the candidate's name, e.g. "Senior Frontend Engineer") to match the target role title exactly.
• Rewrite the professional summary to align with the target role and seniority level.
• Reorder the skills list to surface the most relevant skills first.
• Rephrase existing responsibility bullets using vocabulary from the job description, as long as the underlying meaning is unchanged.
• Reorder bullets within a role to put the most relevant ones first.
• Expand or compress bullet points within the bounds of what the original bullet states.`;

    const supported = matchMap.filter(m => m.allowedToMention).map(m => m.requirement);
    const unsupported = matchMap.filter(m => !m.allowedToMention).map(m => m.requirement);
    const topResponsibilities = (jdData.responsibilities || []).slice(0, 8);
    const topRequired = (jdData.requiredSkills || []).slice(0, 15);

    const userPrompt = `TARGET ROLE
  Job title:  ${jdData.jobTitle || 'Not specified'}
  Company:    ${jdData.company  || 'Not specified'}
  Seniority:  ${jdData.seniority}

REQUIRED SKILLS (up to 15)
${topRequired.map(s => `  • ${s}`).join('\n') || '  (none listed)'}

MATCH REPORT
  Supported requirements (you MAY reference these):
${supported.length ? supported.map(s => `    ✓ ${s}`).join('\n') : '    (none)'}

  Unsupported requirements (do NOT claim these):
${unsupported.length ? unsupported.map(s => `    ✗ ${s}`).join('\n') : '    (none)'}

KEY RESPONSIBILITIES TO HIGHLIGHT (up to 8)
${topResponsibilities.map(r => `  • ${r}`).join('\n') || '  (none listed)'}

ORIGINAL CV
${cvData.rawText}

INSTRUCTION
1. If the CV has a professional headline/title below the name, update it to: "${jdData.jobTitle || 'the target role'}".
2. Rewrite the professional summary targeting this role.
3. Reorder skills so the most JD-relevant appear first.
4. For each role: rewrite relevant bullets with JD vocabulary (same meaning, aligned language), reorder bullets so most relevant come first.
5. Preserve all locked fields exactly — same spelling, capitalisation, and punctuation.

Output the complete tailored CV text with no preamble, no commentary, and no markdown code fences. Begin directly with the candidate's name.`;

    return { systemPrompt, userPrompt, temperature: 0.3 };
  }

  /**
   * Rule-based validation that locked fields were not altered.
   * @returns {string[]} warnings
   */
  validateTailoredCV(originalCvData, tailoredText) {
    const warnings = [];
    const t = tailoredText || '';

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
