import { createRequire } from 'module';
import { RoleProfileService } from './role-profile-service.js';
import { buildGroundingContext, isTextSupported } from './grounding-harness.js';

const _require = createRequire(import.meta.url);
const _semanticConceptGroups = _require('./data-sources/semantic-concepts.json');

export class CVTailor {
  constructor(roleProfiles = new RoleProfileService()) {
    this.roleProfiles = roleProfiles;
  }

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
      const directEvidence = this._findEvidence(req, cvSources);
      // Always run semantic matching — direct evidence and semantic aliases are
      // complementary. Direct matching catches exact/token overlap; semantic
      // matching catches outcome equivalences (e.g. "cut onboarding time" matches
      // a JD requirement for "reduce time-to-value"). Deduplication below ensures
      // the same bullet never appears twice.
      const semanticEvidence = this._findSemanticEvidence(req, cvSources);
      const evidence = [...new Set([...directEvidence, ...semanticEvidence])].slice(0, 5);
      const coreTokens = this._getCoreTokens(req);
      const supportedCoreTokens = coreTokens.filter(tok =>
        cvSources.some(source => source && (
          this._normaliseText(source).includes(tok) ||
          this._semanticTokenSupported(tok, source)
        ))
      );
      const semanticSupported = semanticEvidence.length > 0;
      // Semantic aliases are useful transferable evidence, but they do not
      // authorize claiming an exact named skill. Authorization requires direct
      // CV evidence or explicit user confirmation.
      const directlySupported = directEvidence.length > 0;
      const isAtomicRequirement = coreTokens.length <= 1;
      let status;
      if (confirmedByUser) {
        status = 'user_confirmed';
      } else if (!directlySupported) {
        status = 'missing';
      } else if (evidence.length >= 2) {
        status = 'strong_match';
      } else if (evidence.length === 1 || semanticSupported || (isAtomicRequirement && this._hasAdjacentTech(req, cvLower))) {
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
  buildTailoringPrompt(cvData, jdData, matchMap, { domainRisk = null } = {}) {
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
• Add truthful role-positioning lines in the form "Focus: ..." under existing role titles when supported by that role's original responsibilities.

RECRUITER SCREENING GATE — this is the construction standard, not an afterthought:
Before writing the final CV, internally ask: "Would this CV credibly pass a 30-second recruiter screen for this exact role?"
If the honest answer is no, rewrite the CV before returning it.
A credible 30-second screen means:
• The headline, summary, Core Competencies, Focus lines, and first bullets under relevant roles all tell the same target-role story.
• The target role is proven through Professional Experience, not only through a skills list.
• The most important supported JD requirements are visible in the summary and/or first relevant experience bullets.
• Unsupported JD requirements are not claimed, and adjacent transferable experience is framed honestly.
• The CV reads like a real candidate with a relevant background, not a keyword-stuffed rewrite.`;

    const supported = matchMap.filter(m => m.allowedToMention).map(m => m.requirement);
    const unsupported = matchMap.filter(m => !m.allowedToMention).map(m => m.requirement);
    const confirmed = matchMap.filter(m => m.confirmedByUser).map(m => m.requirement);
    const topResponsibilities = (jdData.responsibilities || []).slice(0, 8);
    const topRequired = (jdData.requiredSkills || []).slice(0, 15);
    const topTools = (jdData.tools || []).slice(0, 20);
    const topKeywords = (jdData.atsKeywords || []).slice(0, 20);
    const tailoringPlan = this.buildTailoringPlan(cvData, jdData, matchMap);
    const roleCredibilityGuidance = this._buildRoleCredibilityGuidance(jdData);
    const domainRiskGuidance = this._buildDomainRiskGuidance(domainRisk);
    const matchStrength = this.calcMatchStrength(matchMap);
    const confidenceInstruction = {
      strong:  'MATCH LEVEL: STRONG — the CV covers most requirements. Write with confidence. Use assertive, achievement-led language for supported claims.',
      moderate:'MATCH LEVEL: MODERATE — the CV covers some requirements. Write confidently where supported; frame unsupported areas honestly as transferable experience.',
      weak:    'MATCH LEVEL: WEAK — the CV has limited direct matches. Focus on genuine transferable evidence. Do not overstate. Be specific about what IS supported and honest about what is not.',
      unknown: '',
    }[matchStrength.level] || '';

    const userPrompt = `TARGET ROLE
  Job title:  ${jdData.jobTitle || 'Not specified'}
  Company:    ${jdData.company  || 'Not specified'}
  Seniority:  ${jdData.seniority}
${confidenceInstruction ? `\n${confidenceInstruction}\n` : ''}
REQUIRED SKILLS (up to 15)
${topRequired.map(s => `  • ${s}`).join('\n') || '  (none listed)'}

TECHNOLOGIES / ATS KEYWORDS FROM THE JD
${topTools.length ? topTools.map(s => `  • ${s}`).join('\n') : '  (none listed)'}
${topKeywords.length ? `\nRepeated JD keywords:\n${topKeywords.map(s => `  • ${s}`).join('\n')}` : ''}

MATCH REPORT (${matchStrength.supportedCount}/${matchStrength.totalCount} requirements supported)
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

RECRUITER SCREENING QUESTION
  Build the CV so the answer is YES to:
  "Would this CV credibly pass a 30-second recruiter screen for this exact role?"

  To pass that screen:
    • The professional summary must explain why this candidate is credible for ${jdData.jobTitle || 'the target role'} using supported CV evidence.
    • Core Competencies must be scan-friendly and role-specific, but not a dumping ground for JD keywords.
    • Professional Experience must carry the proof: first bullets under relevant roles should show supported evidence for the JD's most important requirements.
    • If the candidate lacks direct evidence for a requirement, do not fake it. Show adjacent transferable evidence or omit it.
    • If the CV would only pass an ATS keyword scan but fail a human recruiter read, rewrite it before final output.
${roleCredibilityGuidance ? `\nROLE CREDIBILITY CHECK\n${roleCredibilityGuidance}` : ''}
${domainRiskGuidance ? `\nDOMAIN REVIEW CHECK\n${domainRiskGuidance}` : ''}

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
  Pre-Sales Execution: POC/POV Delivery, Technical Demos, RFP/RFI Response, MEDDPICC
  Cloud & Architecture: AWS, Azure, GCP, Solution Architecture, API Integration
  DevOps & Delivery: CI/CD, GitHub Actions, Docker, Kubernetes, Terraform
  Programming & Automation: Python, Bash, REST APIs, Scripting
  Stakeholder Engagement: Executive Communication, Cross-functional Collaboration, Change Management
  (5–7 categories, each on its own line, no bullet prefix — this is the required format)
  [blank line]
  PROFESSIONAL EXPERIENCE
  Company Name                  Month Year – Month Year
  Job Title
  Focus: [one-line positioning, when supported]
  • Bullet one (most relevant to target role — lead with impact or scale)
  • Bullet two
  • Bullet three
  • Bullet four (optional — include only if it adds distinct supported proof)
  [blank line]
  EDUCATION / CERTIFICATIONS (as in original CV)

INSTRUCTION
1. HEADER: Job title on line 2 immediately below the candidate name, before any contact lines.
2. Rewrite the professional summary so it clearly positions the candidate for this exact role and domain without saying it was tailored for a company or application. It must mention only supported evidence from the CV.
3. CORE COMPETENCIES: MANDATORY — output exactly 5–7 named categories (never fewer than 5 for senior roles). Each category on its own line, NO bullet prefix, NO dash, format exactly: "Category Label: Skill A, Skill B, Skill C, Skill D" — aim for 3–6 skills per category. Cover both technical and business domains appropriate to the role (e.g. for a Solution Architect: Pre-Sales Execution, Cloud & Architecture, Integration & APIs, DevOps & Delivery, Sales Methodology, Stakeholder Engagement, Programming & Scripting). Every category label must be UNIQUE and descriptive — never repeat a label, and never use catch-all labels such as "Additional Technical Skills", "Additional Relevant Skills", "Additional Skills", "Other Skills", or "Miscellaneous". If skills do not fit an existing category, name a specific new category for them (e.g. "Data Quality & Validation", "Observability & Monitoring"). No duplicate skills across categories.
4. For each relevant role: preserve the official job title exactly, then add one short "Focus:" line when the original responsibilities support the target role. The "Focus:" line must sit IMMEDIATELY below the job title line, ABOVE the first bullet — never after or between bullets.
5. For each role: output a concise evidence set, usually 3–5 bullets for the three most recent or most relevant roles and 2–3 bullets for older roles. Do not remove any role entry. Rewrite each selected bullet using JD vocabulary (same meaning, aligned language) and reorder them so the strongest target-role evidence comes first. A senior/relevant role with only 1–2 bullets will fail a recruiter screen; if a role has fewer than 3 useful bullets, split its densest original bullet into separate bullets — one fact per bullet, same facts, no invented claims — wherever the original content honestly supports it. Do not include duplicate or low-signal bullets merely to preserve volume.
5b. LINE DISCIPLINE: every bullet, competency category, and summary sentence must be output on ONE single line — never hard-wrap, never split a sentence or hyphenated word across lines (the renderer handles wrapping).
6. Include every user-confirmed addition in the skills/core competencies section as concise skill names. You may also use them in the summary when natural, but do not attach them to a specific employer, project, metric, certification, or achievement unless that context exists in the original CV.
7. Preserve all locked fields exactly — same spelling, capitalisation, and punctuation.
8. The final CV must read like a polished CV for "${jdData.jobTitle || 'the target role'}", not like a generic CV and not like generated marketing copy.
9. Do not make the CV merely keyword-compatible. If the target role is architectural or customer-facing, the summary and first relevant bullets must show supported design authority, technical discovery, stakeholder alignment, implementation planning, or enterprise customer evidence from the original CV.
10. Final internal check before output: if a recruiter scanning for "${jdData.jobTitle || 'the target role'}" would not immediately see credible role evidence in the summary, Core Competencies, and first relevant experience bullets, rewrite those sections using only supported evidence.

Output the complete tailored CV text with no preamble, no commentary, and no markdown code fences. Begin directly with the candidate's name.`;

    return { systemPrompt, userPrompt, temperature: 0.3 };
  }

  _buildDomainRiskGuidance(domainRisk = null) {
    if (!domainRisk?.detected) return '';
    const profile = domainRisk.primaryProfile?.label || 'Domain-sensitive role';
    const credentialWarnings = Array.isArray(domainRisk.credentialWarnings) ? domainRisk.credentialWarnings : [];
    const reviewPrompts = Array.isArray(domainRisk.reviewPrompts) ? domainRisk.reviewPrompts : [];
    const missingCredentials = [...new Set(credentialWarnings.flatMap(item => item.missingCredentials || []))]
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 8);

    const lines = [`Profile: ${profile}.`];
    if (missingCredentials.length > 0) {
      lines.push(`Do not add or imply these credentials unless present in the original CV or user-confirmed: ${missingCredentials.join(', ')}.`);
    }
    if (reviewPrompts.length > 0) {
      lines.push(`Review prompts: ${reviewPrompts.slice(0, 3).join(' | ')}`);
    }
    lines.push('For regulated licenses, clearances, clinical authority, flight ratings, trade cards, publications, grants, or portfolio proof, preserve only supported facts and omit unsupported claims.');
    return lines.join('\n');
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

    const systemPrompt = `You are a strict CV truth-auditor. Your only job is to remove unsupported content and then reposition the remaining supported evidence — nothing more.

PERMITTED ACTIONS (in this exact priority order):
1. REMOVE any content not evidenced by the ORIGINAL CV, the SUPPORTED REQUIREMENTS list, or USER-CONFIRMED additions.
2. REORDER existing supported bullets, skills, or sections so the most role-relevant evidence appears first.
3. REFOCUS summary, Core Competencies, and Focus lines by recombining language already present in the ORIGINAL CV or SUPPORTED REQUIREMENTS — do not introduce new wording.

FORBIDDEN:
- Do not add any new skill, tool, phrase, metric, claim, or sentence that does not appear verbatim in the ORIGINAL CV or SUPPORTED REQUIREMENTS.
- Do not introduce improvements, suggestions, or language the candidate has not already demonstrated.
- Do not paste JD requirement prose into the skills section.

ALWAYS PRESERVE:
- Every locked fact: names, employers, historical job titles, dates, education, certifications, contact details.
- Every experience bullet from the ORIGINAL CV must remain. Do not remove a bullet because it was reworded; only remove a bullet if it contains a specific metric, tool, or claim that does not exist anywhere in the ORIGINAL CV and is not in the SUPPORTED REQUIREMENTS list.
- Skills sections must contain short skill phrases only — not sentences, years-of-experience requirements, location requirements, education requirements, or prose like "track record of...".

FORMATTING (preserve exactly while auditing):
- Every bullet, competency category, and sentence stays on ONE line — never hard-wrap or split a sentence or word across lines.
- "Focus:" lines stay immediately below their job title line, above the first bullet.
- Competency category labels stay unique — never emit two categories with the same label and never use catch-all labels like "Additional Technical Skills".

Return the complete corrected CV text only.`;

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
Step 1 — REMOVE: Delete any skill, tool, phrase, responsibility, metric, or claim that does not appear in the ORIGINAL CV or the SUPPORTED REQUIREMENTS list above.
Step 2 — REORDER: Move the most role-relevant supported evidence earlier within each section (summary, skills, bullets).
Step 3 — REFOCUS: Rewrite the summary and Focus lines using only words and phrases already present in the ORIGINAL CV or SUPPORTED REQUIREMENTS. Do not introduce new language.

Do not add anything new. Return the complete corrected CV.`;

    return { systemPrompt, userPrompt, temperature: 0.2 };
  }

  buildTailoringPlan(cvData, jdData, matchMap = []) {
    const enrichedJd = this.roleProfiles.enrichJDData(jdData || {});
    const domain = enrichedJd.domain || this._detectDomain(enrichedJd);
    const domainLabel = enrichedJd.targetPositioning || {
      mlops: 'MLOps, AI/ML platform engineering, production reliability, and automation',
      data_engineering: 'data engineering, data pipelines, platform reliability, and automation',
      devops: 'DevOps, cloud infrastructure, platform reliability, and automation',
      ml_scientist: 'machine learning, experimentation, model development, and AI tooling',
      frontend: 'frontend engineering, product delivery, UI quality, and modern web tooling',
      backend: 'backend engineering, APIs, distributed systems, and service reliability',
      cloud: 'cloud architecture, infrastructure automation, security, and reliability',
      solution_engineering: 'customer-facing technical leadership, enterprise SaaS solution delivery, POC/POV execution, and pre-sales technical engagement',
    }[domain] || `${enrichedJd.jobTitle || 'the target role'} responsibilities, supported technologies, and relevant achievements`;

    const supportedKeywords = this._rankSupportedKeywords(matchMap, enrichedJd).slice(0, 18);

    // When Groq has already provided targetPositioning, the regex focus-line
    // suggestions would mislead the tailoring LLM with hardcoded tech categories.
    // Let the tailoring LLM derive focus lines from targetPositioning instead.
    const roleFocusLines = enrichedJd.targetPositioning
      ? []
      : (cvData.experience || [])
          .map(exp => {
            const focus = this._buildRoleFocus(exp, enrichedJd, matchMap);
            return focus ? { company: exp.company || '', title: exp.title || '', focus } : null;
          })
          .filter(Boolean);

    return {
      domain,
      targetPositioning: domainLabel,
      supportedKeywords,
      roleFocusLines,
      roleProfile: enrichedJd.roleProfile || null,
    };
  }

  /**
   * Check how many high-frequency JD keywords landed in the tailored CV.
   * Returns missing keywords and a 0–1 coverage fraction.
   *
   * @param {string} tailoredText
   * @param {Object} jdData — enriched JD data with atsKeywords, requiredSkills, tools
   * @returns {{ missingKeywords: string[], coverage: number }}
   */
  checkAtsKeywordCoverage(tailoredText, jdData) {
    if (tailoredText == null || !jdData) return { missingKeywords: [], coverage: 1.0 };

    const candidates = [
      ...(jdData.atsKeywords     || []),
      ...(jdData.requiredSkills  || []).slice(0, 10),
      ...(jdData.tools           || []).slice(0, 10),
    ];
    if (candidates.length === 0) return { missingKeywords: [], coverage: 1.0 };

    const lower = tailoredText.toLowerCase();
    const deduped = [...new Set(candidates.map(k => (k || '').trim().toLowerCase()).filter(Boolean))];
    const missing = deduped.filter(kw => !lower.includes(kw));

    return {
      missingKeywords: missing.slice(0, 10),
      coverage: deduped.length > 0 ? (deduped.length - missing.length) / deduped.length : 1.0,
    };
  }

  /**
   * Compute how strongly the CV matches the JD based on the matchMap.
   * Used to calibrate the confidence of the tailoring and answer prompts.
   *
   * @param {Array} matchMap — output of buildMatchMap()
   * @returns {{ level: 'strong'|'moderate'|'weak'|'unknown', score: number, supportedCount: number, totalCount: number }}
   */
  calcMatchStrength(matchMap) {
    if (!matchMap || matchMap.length === 0) {
      return { level: 'unknown', score: 0, supportedCount: 0, totalCount: 0 };
    }
    const scoreable = matchMap.filter(m => m.type !== 'user_confirmed');
    const total = scoreable.length;
    if (total === 0) return { level: 'unknown', score: 0, supportedCount: 0, totalCount: 0 };

    const supported = scoreable.filter(m => m.allowedToMention).length;
    const score = Math.round((supported / total) * 100) / 100;
    const level = score >= 0.65 ? 'strong' : score >= 0.40 ? 'moderate' : 'weak';
    return { level, score, supportedCount: supported, totalCount: total };
  }

  isValidCvOutput(text) {
    if (!text || text.trim().length < 200) return false;
    if (/AUDIT INSTRUCTION/i.test(text)) return false;
    if (/list supported requirements/i.test(text)) return false;
    if (/USER-CONFIRMED addition/i.test(text)) return false;
    if (/SUPPORTED REQUIREMENT/i.test(text)) return false;
    if (/We need to audit the tailored CV/i.test(text)) return false;
    return /^(PROFESSIONAL SUMMARY|CORE COMPETENCIES|PROFESSIONAL EXPERIENCE|EDUCATION)\s*$/im.test(text);
  }

  _ensureCoreCompetencies(text, matchMap = [], confirmedSkills = [], jdData = {}) {
    if (!text || /^CORE COMPETENCIES\s*$/im.test(text)) return text;

    const allowed = (matchMap || []).filter(r => r.allowedToMention);

    const tools = [...new Set(
      allowed.filter(r => r.type === 'tool').map(r => r.requirement).filter(Boolean)
    )].slice(0, 6);

    const coreSkills = [...new Set(
      allowed
        .filter(r => r.type === 'required' || r.type === 'preferred')
        .map(r => r.requirement)
        .filter(Boolean)
        .filter(s => !/\b(team|communicat|collaborat|stakeholder)\b/i.test(s))
    )].slice(0, 6);

    const softSkills = [...new Set(
      allowed.filter(r => r.type === 'soft').map(r => r.requirement).filter(Boolean)
    )].slice(0, 5);

    const confirmed = [...new Set((confirmedSkills || []).filter(Boolean))];

    const lines = [];
    if (tools.length > 0)      lines.push(`Technical Tools: ${tools.join(', ')}`);
    if (coreSkills.length > 0) lines.push(`Core Skills: ${coreSkills.join(', ')}`);
    if (confirmed.length > 0)  lines.push(`Confirmed Skills: ${confirmed.join(', ')}`);
    if (softSkills.length > 0) lines.push(`Professional Skills: ${softSkills.join(', ')}`);

    if (lines.length < 2) return text;

    const section = `CORE COMPETENCIES\n${lines.join('\n')}`;

    const expIdx = text.search(/^PROFESSIONAL EXPERIENCE\s*$/im);
    if (expIdx !== -1) {
      const before = text.slice(0, expIdx).replace(/\n+$/, '');
      return `${before}\n\n${section}\n\n${text.slice(expIdx)}`;
    }

    return text;
  }

  finalizeTailoredCV(rawText, { cvData, jdData, matchMap = [], confirmedSkills = [] } = {}) {
    // Repair hard-wrapped lines first: LLMs copy the original CV's PDF-extracted
    // line wrapping ("cloud-\nnative"), which every downstream step would
    // otherwise treat as separate lines. Then rejoin split date ranges so every
    // later pass sees date lines as single units.
    const unwrapped = this._joinSplitDateRanges(this.repairHardWrappedLines(rawText));
    const withCoreCompetencies = this._ensureCoreCompetencies(unwrapped, matchMap, confirmedSkills, jdData);
    const cleaned = this.cleanSkillsSection(
      this.ensureRoleFocusLines(
        this.ensureConfirmedSkillsIncluded(
          this.removeTailoringMetaPhrases(
            this.enforceTargetHeadline(withCoreCompetencies, jdData?.jobTitle),
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
    const normalised = this.normaliseRoleFocusPlacement(
      this.restoreLockedExperienceDates(cleaned, cvData),
      cvData
    );
    const deepened = this.ensureExperienceDepth(
      this.consolidateSkillsSections(normalised),
      cvData,
      jdData,
      matchMap
    );
    const dedupedBullets = this.dedupeNearDuplicateExperienceBullets(deepened, cvData);
    const densityNormalised = this.normaliseExperienceBulletDensity(
      dedupedBullets,
      cvData,
      jdData,
      matchMap
    );
    // Parser-independent catch-alls: normaliseRoleFocusPlacement above is
    // anchored to parsed cvData titles, which can miss composite pipe titles
    // ("Cloud Support Engineer | Cloud Service SME"); this pass fixes any
    // Focus: line still stranded below its bullet run, then merges duplicate
    // "Label: skill, skill" category lines the LLM emitted despite the prompt.
    return this.mergeDuplicateSkillCategoryLines(
      this.repairDanglingBulletEndings(
        this.repositionOrphanFocusLines(densityNormalised)
      )
    );
  }

  /**
   * Join lines that were hard-wrapped mid-sentence or mid-word. PDF extraction
   * wraps the original CV text at a fixed width, and the tailoring LLM often
   * preserves those breaks verbatim ("cloud-\nnative model serving").
   * Conservative by design: only joins when the current line is long enough to
   * look wrapped, ends mid-word/mid-clause, and the next line is a lowercase
   * continuation that is not a bullet, header, date, label, or contact line.
   */
  repairHardWrappedLines(text) {
    if (!text) return text;

    const lines = String(text).split('\n');
    const output = [];
    const BULLET_RE = /^[-•*●▪◦–—]\s/;
    const LABEL_RE = /^[A-Za-z][A-Za-z0-9 &/+.\-]{0,48}:\s/;

    const isContinuation = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return false;
      if (BULLET_RE.test(trimmed)) return false;
      if (LABEL_RE.test(trimmed)) return false;
      if (this._isLikelySectionHeader(trimmed)) return false;
      if (this._looksLikeDateLine(trimmed)) return false;
      if (this._isHeaderContactLine(trimmed)) return false;
      return /^[a-z]/.test(trimmed);
    };

    for (const line of lines) {
      const prev = output.length ? output[output.length - 1] : '';
      const prevTrimmed = String(prev || '').trimEnd();

      // Word broken across lines with a hyphen: "cloud-" + "native" —
      // rejoin with no space even when the wrapped fragment is short.
      if (prevTrimmed.length >= 8 && /[a-z]-$/.test(prevTrimmed) && isContinuation(line)) {
        output[output.length - 1] = `${prevTrimmed}${String(line).trim()}`;
        continue;
      }

      if (prevTrimmed.length >= 40 && isContinuation(line)) {
        // Sentence wrapped mid-clause: ends in a letter or comma with no
        // terminal punctuation — rejoin with a single space.
        if (/[a-z,]$/i.test(prevTrimmed) && !/[.!?:;]$/.test(prevTrimmed)) {
          output[output.length - 1] = `${prevTrimmed} ${String(line).trim()}`;
          continue;
        }
      }
      output.push(line);
    }

    return output.join('\n');
  }

  /**
   * Rejoin a date range the model (or two-column PDF extraction) split across
   * lines ("Feb 2024 -" / "Jun 2025") or flattened with a column gap
   * ("Feb 2024 -    Jun 2025", "Feb 2024 - | Jun 2025") into one clean
   * "Feb 2024 - Jun 2025" line. Runs before any entry-structure repair and
   * needs no parsed cvData, so it fixes malformed date lines even for entries
   * the parser failed to match. Both halves must be pure date fragments -
   * ordinary sentences containing years never qualify.
   */
  _joinSplitDateRanges(text) {
    if (!text) return text;

    const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    const RANGE_START_RE = new RegExp(`^(?:${MONTH}\\.?\\s+)?(?:19|20)\\d{2}\\s*(?:-|–|—|to)$`, 'i');
    const RANGE_END_RE = new RegExp(`^(?:(?:${MONTH}\\.?\\s+)?(?:19|20)\\d{2}|present|current)$`, 'i');

    const lines = String(text).split('\n');
    const output = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = String(lines[i] || '').trim();

      // Same-line column flatten: "Feb 2024 -   Jun 2025" / "Feb 2024 - | Jun 2025".
      const flattened = trimmed.match(/^(.+?)\s*(?:\||\t+|\s{2,})\s*(.+)$/);
      if (flattened && RANGE_START_RE.test(flattened[1].trim()) && RANGE_END_RE.test(flattened[2].trim())) {
        output.push(`${flattened[1].trim()} ${flattened[2].trim()}`);
        continue;
      }

      if (RANGE_START_RE.test(trimmed)) {
        let next = i + 1;
        while (next < lines.length && !String(lines[next] || '').trim()) next++;
        const nextTrimmed = next < lines.length ? String(lines[next]).trim() : '';
        if (RANGE_END_RE.test(nextTrimmed)) {
          output.push(`${trimmed} ${nextTrimmed}`);
          i = next;
          continue;
        }
      }

      output.push(lines[i]);
    }

    return output.join('\n');
  }

  /**
   * Move any "Focus:" line that ended up below a bullet run to just above that
   * run. Unlike normaliseRoleFocusPlacement this needs no parsed cvData, so it
   * still works when composite pipe titles defeat title matching.
   *
   * A Focus line is only ever meaningful directly under a role title - if it
   * isn't sitting above a bullet run (the case handled above) and the nearest
   * preceding content is a section header instead, it has drifted into an
   * unrelated section (e.g. stranded under "EDUCATION, CERTIFICATIONS &
   * RECOGNITION" because the role it was generated for never matched during
   * entry-boundary detection). There is no reliable way to know which role it
   * belonged to, so drop it rather than render positioning text under the
   * wrong heading.
   */
  repositionOrphanFocusLines(text) {
    if (!text) return text;

    const lines = String(text).split('\n');
    const BULLET_RE = /^[-•*●▪◦–—]\s/;

    for (let i = 0; i < lines.length; i++) {
      if (!/^focus\s*:/i.test(String(lines[i] || '').trim())) continue;

      // Walk back over the bullet run above this line, tolerating blank lines
      // the model sometimes inserts between the final bullet and Focus line.
      let cursor = i - 1;
      while (cursor >= 0 && !String(lines[cursor] || '').trim()) cursor--;

      if (cursor >= 0 && this._isLikelySectionHeader(String(lines[cursor] || '').trim())) {
        lines.splice(i, 1);
        i--;
        continue;
      }

      if (cursor < 0 || !BULLET_RE.test(String(lines[cursor] || '').trim())) continue;

      let runStart = cursor;
      while (runStart > 0 && BULLET_RE.test(String(lines[runStart - 1] || '').trim())) {
        runStart--;
      }

      const [focusLine] = lines.splice(i, 1);
      lines.splice(runStart, 0, focusLine);
    }

    return lines.join('\n');
  }

  repairDanglingBulletEndings(text) {
    if (!text) return text;

    return String(text).split('\n').map(line => {
      const match = String(line || '').match(/^(\s*[-•*●▪◦–—]\s+)(.+)$/);
      if (!match) return line;

      const [, prefix, body] = match;
      // Trim repeatedly until stable: a token-limit truncation can cut a
      // bullet mid-word ("...resilience across production-"), and stripping
      // the hyphenated fragment then exposes a dangling conjunction that
      // needs a second pass ("...resilience across" -> "...resilience").
      let repaired = body;
      let previous;
      do {
        previous = repaired;
        repaired = repaired
          .replace(/\s+\S*[a-z]-$/, '')
          .replace(/\s+\b(?:and|or|with|including|across|for|to|by)\s*$/i, '')
          .replace(/[,\s]+$/, '');
      } while (repaired !== previous);

      if (repaired === body) return line;
      return `${prefix}${repaired}.`;
    }).join('\n');
  }

  /**
   * Merge duplicate "Label: skill, skill, ..." category lines within a
   * skills/competencies section (e.g. two "Additional Technical Skills:"
   * lines) into one line with the union of their items. Scoped to
   * skills-like sections only (never PROFESSIONAL EXPERIENCE etc.) - an
   * experience bullet like "Key results: reduced costs..." matches the same
   * "Label: comma, list" shape as a skill category, and without this scoping
   * two different jobs sharing a generic bullet label would get merged,
   * silently deleting one job's real achievement bullet.
   */
  mergeDuplicateSkillCategoryLines(text) {
    if (!text) return text;

    const lines = String(text).split('\n');
    const CATEGORY_RE = /^([-•*●▪◦–—]\s*)?([A-Za-z][A-Za-z0-9 &/+.\-]{2,48}):\s*(.+)$/;
    const seen = new Map(); // normalised label -> line index of first occurrence
    const removals = [];
    let inSkillsSection = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = String(lines[i] || '').trim();
      if (this._isSkillsSectionHeader(trimmed)) {
        inSkillsSection = true;
        seen.clear();
        continue;
      }
      if (this._isLikelySectionHeader(trimmed)) {
        inSkillsSection = false;
        seen.clear();
        continue;
      }
      if (!inSkillsSection) continue;

      const match = trimmed.match(CATEGORY_RE);
      if (!match) continue;
      const [, , label, value] = match;
      if (/^focus$/i.test(label.trim())) continue;
      if (!value.includes(',')) continue; // not a skill list — leave alone

      const key = this._normaliseText(label);
      if (!seen.has(key)) {
        seen.set(key, i);
        continue;
      }

      // Duplicate label in the same section: merge unique items into the first.
      const firstIdx = seen.get(key);
      const firstMatch = String(lines[firstIdx] || '').trim().match(CATEGORY_RE);
      if (!firstMatch) continue;
      const existingItems = firstMatch[3].split(',').map(s => s.trim()).filter(Boolean);
      const existingKeys = new Set(existingItems.map(s => this._normaliseText(s)));
      const newItems = value.split(',').map(s => s.trim()).filter(Boolean)
        .filter(item => !existingKeys.has(this._normaliseText(item)));

      if (newItems.length > 0) {
        lines[firstIdx] = `${firstMatch[1] || ''}${firstMatch[2]}: ${[...existingItems, ...newItems].join(', ')}`;
      }
      removals.push(i);
    }

    for (const idx of removals.reverse()) {
      lines.splice(idx, 1);
    }

    return lines.join('\n');
  }

  restoreLockedExperienceDates(tailoredText, cvData = {}) {
    if (!tailoredText || !Array.isArray(cvData.experience)) return tailoredText;

    const lines = String(tailoredText).split('\n');
    let searchFrom = 0;

    for (const exp of cvData.experience) {
      const company = String(exp.company || '').trim();
      const title = String(exp.title || '').trim();
      const dates = String(exp.dates || '').trim();
      if (!company || !title || !dates) continue;

      const companyIdx = this._findLineIndexContaining(lines, company, searchFrom);
      const titleIdxForward = companyIdx !== -1
        ? this._findLineIndexContaining(lines, title, companyIdx + 1, companyIdx + 8)
        : -1;

      if (companyIdx !== -1 && titleIdxForward !== -1) {
        // Keep model output in the parser/exporter's expected Harvard shape:
        // company line, exact original dates on the next line, exact job title below.
        const between = lines.slice(companyIdx + 1, titleIdxForward);
        const cleanedBetween = between.filter(line => {
          const trimmed = String(line || '').trim();
          return trimmed && !this._looksLikeDateLine(trimmed);
        });
        lines.splice(companyIdx, titleIdxForward - companyIdx + 1, company, dates, title, ...cleanedBetween);
        // Advance past this entry's ENTIRE rebuilt block (not just its
        // 3-line header) so the next entry's search - and its preNoise
        // safety check below - never sees this entry's own Focus/bullet
        // content as "unsafe to drop" leftover noise.
        searchFrom = companyIdx + 3 + cleanedBetween.length;
        continue;
      }

      // The LLM sometimes reverses the order (title first, company pushed
      // down after the bullets) instead of dropping the header entirely.
      // Only searching forward from company (above) silently skips
      // restoration for these blocks, leaving the reversed structure - and
      // whatever malformed date fragment the LLM put in company's place -
      // in the final output. Search for title first and look for company
      // afterward to catch this case too.
      const titleIdx = this._findLineIndexContaining(lines, title, searchFrom, searchFrom + 8);
      const companyIdxBackward = titleIdx !== -1
        ? this._findLineIndexContaining(lines, company, titleIdx + 1, titleIdx + 12)
        : -1;

      if (titleIdx !== -1 && companyIdxBackward !== -1) {
        const between = lines.slice(titleIdx + 1, companyIdxBackward);
        const cleanedBetween = between.filter(line => {
          const trimmed = String(line || '').trim();
          return trimmed && !this._looksLikeDateLine(trimmed);
        });
        // Walk backward from the title, dropping only a small bounded run of
        // blank/date-fragment lines immediately above it (e.g. a malformed
        // or split date fragment standing in where the company line should
        // have been), stopping at the first line that isn't droppable. A
        // fixed small lookback - not the full distance back to searchFrom -
        // avoids eating unrelated content further back, like the CV's own
        // name/headline sitting before the first experience entry.
        const LOOKBACK = 3;
        const lookbackFloor = Math.max(searchFrom, titleIdx - LOOKBACK);
        let spliceStart = titleIdx;
        for (let i = titleIdx - 1; i >= lookbackFloor; i--) {
          const trimmed = String(lines[i] || '').trim();
          if (!trimmed || this._looksLikeDateLine(trimmed)) {
            spliceStart = i;
          } else {
            break;
          }
        }
        lines.splice(spliceStart, companyIdxBackward - spliceStart + 1, company, dates, title, ...cleanedBetween);
        searchFrom = spliceStart + 3 + cleanedBetween.length;
        continue;
      }

      // Neither direction found a company line at all - common when this
      // entry is a second (or later) stint at the same employer as the
      // previous entry, and the model wrote the company name only once,
      // above the first stint. Harvard-format multi-stint blocks are safest
      // to restore as separate company+dates+title triplets (matching every
      // other entry's shape, which the exporter's rendering depends on)
      // rather than teaching the renderer a "title-only, shared company"
      // sub-entry format. If the title itself can still be located, insert
      // this entry's own canonical company/dates in front of it, dropping
      // any adjacent malformed date fragment the model left in its place.
      if (titleIdx !== -1) {
        const LOOKBACK = 3;
        const lookbackFloor = Math.max(searchFrom, titleIdx - LOOKBACK);
        let spliceStart = titleIdx;
        for (let i = titleIdx - 1; i >= lookbackFloor; i--) {
          const trimmed = String(lines[i] || '').trim();
          if (!trimmed || this._looksLikeDateLine(trimmed)) {
            spliceStart = i;
          } else {
            break;
          }
        }
        let spliceEnd = titleIdx + 1;
        if (this._looksLikeDateLine(String(lines[titleIdx + 1] || '').trim())) {
          spliceEnd = titleIdx + 2;
        }
        lines.splice(spliceStart, spliceEnd - spliceStart, company, dates, title);
        searchFrom = spliceStart + 3;
        continue;
      }

      if (companyIdx !== -1) searchFrom = companyIdx + 1;
    }

    return lines.join('\n');
  }

  normaliseRoleFocusPlacement(tailoredText, cvData = {}) {
    if (!tailoredText || !Array.isArray(cvData.experience) || cvData.experience.length === 0) {
      return tailoredText;
    }

    const lines = String(tailoredText).split('\n');
    const titleKeys = new Set(
      (cvData.experience || [])
        .map(exp => this._normaliseText(exp.title))
        .filter(Boolean)
    );
    const companyKeys = new Set(
      (cvData.experience || [])
        .map(exp => this._normaliseText(exp.company))
        .filter(Boolean)
    );
    let searchFrom = 0;

    for (const exp of (cvData.experience || [])) {
      const title = String(exp.title || '').trim();
      if (!title) continue;

      const titleIdx = this._findTitleLineIndex(lines, title, searchFrom);
      if (titleIdx === -1) continue;

      const entryEnd = this._findRoleEntryEnd(lines, titleIdx, titleKeys, companyKeys, this._normaliseText(exp.company));
      const focusIndices = [];
      for (let i = titleIdx + 1; i < entryEnd; i++) {
        if (/^focus\s*:/i.test(String(lines[i] || '').trim())) {
          focusIndices.push(i);
        }
      }

      if (focusIndices.length === 0) {
        searchFrom = titleIdx + 1;
        continue;
      }

      const focusLine = String(lines[focusIndices[0]] || '').trim();
      for (const idx of [...focusIndices].sort((a, b) => b - a)) {
        lines.splice(idx, 1);
      }
      lines.splice(titleIdx + 1, 0, focusLine);
      searchFrom = titleIdx + 2;
    }

    return lines.join('\n');
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
        // Strip LLM markdown bold/italic formatting — CV text should be plain
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        // Strip "Position:", "Title:", "Role:", "Job Title:" label prefixes
        .replace(/^(position|title|role|job\s*title)\s*:\s*/i, '')
        // Strip tailoring meta-phrases
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

      // Check if a Focus: line already exists anywhere within the next ~10 lines of this role
      // (not just immediately after title) — prevents duplicates when LLM placed it after bullets.
      const roleWindowEnd = Math.min(lines.length, titleIdx + 12);
      const existingFocusIdx = lines
        .slice(titleIdx + 1, roleWindowEnd)
        .findIndex(l => /^focus\s*:/i.test(String(l || '').trim()));
      if (existingFocusIdx !== -1) {
        // Move Focus: to immediately after the title if it's not already there
        const absIdx = titleIdx + 1 + existingFocusIdx;
        const nextMeaningful = this._nextMeaningfulLineIndex(lines, titleIdx + 1);
        if (absIdx !== nextMeaningful) {
          const focusLine = lines.splice(absIdx, 1)[0];
          lines.splice(titleIdx + 1, 0, focusLine);
        }
        searchFrom = titleIdx + 2;
        continue;
      }

      lines.splice(titleIdx + 1, 0, `Focus: ${focus}`);
      searchFrom = titleIdx + 2;
    }

    return this.normaliseRoleFocusPlacement(lines.join('\n'), cvData);
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

    return this.consolidateSkillsSections(cleaned.join('\n'));
  }

  consolidateSkillsSections(tailoredText) {
    if (!tailoredText) return tailoredText;

    const lines = String(tailoredText).split('\n');
    const coreIdx = lines.findIndex(line => /^core\s+competenc(?:y|ies)\s*[:\-]?$/i.test(String(line || '').trim()));
    if (coreIdx === -1) return tailoredText;

    const output = [];
    let i = 0;
    while (i < lines.length) {
      const trimmed = String(lines[i] || '').trim();
      const isExtraSkillsSection = i !== coreIdx
        && /^(technical\s+skills?|skills|technologies|tools|expertise)\s*[:\-]?$/i.test(trimmed);

      if (!isExtraSkillsSection) {
        output.push(lines[i]);
        i++;
        continue;
      }

      i++;
      while (i < lines.length && !this._isLikelySectionHeader(lines[i])) {
        i++;
      }
      while (output.length && !String(output[output.length - 1] || '').trim()) {
        output.pop();
      }
      if (i < lines.length && output.length && String(output[output.length - 1] || '').trim()) {
        output.push('');
      }
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  ensureExperienceDepth(tailoredText, cvData = {}, jdData = {}, matchMap = []) {
    if (!tailoredText || !Array.isArray(cvData?.experience) || cvData.experience.length === 0) {
      return tailoredText;
    }

    const lines = String(tailoredText).split('\n');
    const companyKeys = new Set(
      cvData.experience
        .map(exp => this._normaliseText(exp.company))
        .filter(Boolean)
    );
    let searchFrom = 0;

    for (let expIndex = 0; expIndex < cvData.experience.length; expIndex++) {
      const exp = cvData.experience[expIndex];
      const title = String(exp.title || '').trim();
      const sourceBullets = (exp.responsibilities || [])
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .filter(item => !this._isParserArtefact(item) || this._looksLikeExperienceResponsibility(item));
      if (!title || sourceBullets.length === 0) continue;

      const titleIdx = this._findTitleLineIndex(lines, title, searchFrom);
      if (titleIdx === -1) continue;

      const entryEnd = this._findExperienceEntryEnd(lines, exp, titleIdx, companyKeys);
      const entryBulletLines = lines.slice(titleIdx + 1, entryEnd)
        .map(line => String(line || '').trim())
        .filter(line => /^[-•*●▪◦–—]\s/.test(line));
      const existingBulletKeys = new Set(
        entryBulletLines
          .map(line => this._normaliseBulletForSimilarity(line.replace(/^[-•*●▪◦–—]\s*/, '')))
          .filter(Boolean)
      );
      // Match the bullet character already used in this entry (the template
      // uses "•") instead of hardcoding "-", which would otherwise mix
      // bullet styles within the same generated CV.
      const bulletChar = entryBulletLines[0]?.match(/^([-•*●▪◦–—])/)?.[1] || '•';

      const sourceCandidates = this._uniqueDisplaySkills([
        ...sourceBullets,
        ...this._deriveExperienceDepthBullets(sourceBullets),
      ]);
      const currentCount = existingBulletKeys.size;
      const minimum = Math.min(sourceCandidates.length, expIndex < 3 ? 4 : 3);
      if (currentCount >= minimum) {
        searchFrom = titleIdx + 1;
        continue;
      }

      const needed = minimum - currentCount;
      const additions = this._rankExperienceBulletsForRole(sourceCandidates, jdData, matchMap)
        .filter(item => {
          const key = this._normaliseBulletForSimilarity(item);
          if (!key || existingBulletKeys.has(key)) return false;
          for (const existing of existingBulletKeys) {
            if ((existing.length >= 32 && key.includes(existing)) || (key.length >= 32 && existing.includes(key))) {
              return false;
            }
          }
          return true;
        })
        .slice(0, needed);

      if (additions.length > 0) {
        lines.splice(entryEnd, 0, ...additions.map(item => `${bulletChar} ${item}`));
        searchFrom = entryEnd + additions.length;
      } else {
        searchFrom = titleIdx + 1;
      }
    }

    return lines.join('\n');
  }

  /**
   * Removes bullets within the same experience entry that are near-identical
   * or truncated duplicates of another bullet in that entry - an observed
   * generation artifact where the LLM repeats a bullet, sometimes cut short
   * at a different point, rather than writing a genuinely new one. Nothing
   * else in the pipeline catches this: ensureExperienceDepth only guards
   * against *adding* a duplicate when padding bullet count, it doesn't clean
   * up duplicates the model wrote natively. Keeps the longer/more complete
   * of any two near-duplicate bullets.
   */
  dedupeNearDuplicateExperienceBullets(tailoredText, cvData = {}) {
    if (!tailoredText || !Array.isArray(cvData?.experience) || cvData.experience.length === 0) {
      return tailoredText;
    }

    const lines = String(tailoredText).split('\n');
    const companyKeys = new Set(
      cvData.experience.map(exp => this._normaliseText(exp.company)).filter(Boolean)
    );
    let searchFrom = 0;

    for (const exp of cvData.experience) {
      const title = String(exp.title || '').trim();
      if (!title) continue;

      const titleIdx = this._findTitleLineIndex(lines, title, searchFrom);
      if (titleIdx === -1) continue;

      const entryEnd = this._findExperienceEntryEnd(lines, exp, titleIdx, companyKeys);
      const bulletRows = [];
      for (let i = titleIdx + 1; i < entryEnd; i++) {
        const raw = String(lines[i] || '').trim();
        if (!/^[-•*●▪◦–—]\s/.test(raw)) continue;
        const body = raw.replace(/^[-•*●▪◦–—]\s*/, '').trim();
        bulletRows.push({ index: i, key: this._normaliseBulletForSimilarity(body) });
      }

      const toRemove = new Set();
      for (let i = 0; i < bulletRows.length; i++) {
        if (toRemove.has(bulletRows[i].index)) continue;
        for (let j = i + 1; j < bulletRows.length; j++) {
          if (toRemove.has(bulletRows[j].index)) continue;
          const a = bulletRows[i].key;
          const b = bulletRows[j].key;
          if (!a || !b) continue;
          const isDuplicate = a === b
            || (a.length >= 32 && b.length >= 32 && (a.includes(b) || b.includes(a)));
          if (!isDuplicate) continue;
          const dropIndex = b.length >= a.length ? bulletRows[i].index : bulletRows[j].index;
          toRemove.add(dropIndex);
        }
      }

      for (let i = bulletRows.length - 1; i >= 0; i--) {
        if (toRemove.has(bulletRows[i].index)) lines.splice(bulletRows[i].index, 1);
      }

      searchFrom = titleIdx + 1;
    }

    return lines.join('\n');
  }

  normaliseExperienceBulletDensity(tailoredText, cvData = {}, jdData = {}, matchMap = []) {
    if (!tailoredText || !Array.isArray(cvData?.experience) || cvData.experience.length === 0) {
      return tailoredText;
    }

    const lines = String(tailoredText).split('\n');
    const companyKeys = new Set(
      cvData.experience
        .map(exp => this._normaliseText(exp.company))
        .filter(Boolean)
    );
    let searchFrom = 0;

    for (let expIndex = 0; expIndex < cvData.experience.length; expIndex++) {
      const exp = cvData.experience[expIndex];
      const title = String(exp.title || '').trim();
      if (!title) continue;

      const titleIdx = this._findTitleLineIndex(lines, title, searchFrom);
      if (titleIdx === -1) continue;

      const entryEnd = this._findExperienceEntryEnd(lines, exp, titleIdx, companyKeys);
      const bulletRows = [];
      for (let i = titleIdx + 1; i < entryEnd; i++) {
        const line = String(lines[i] || '').trim();
        if (/^[-•*●▪◦–—]\s/.test(line)) {
          bulletRows.push({
            index: i,
            body: line.replace(/^[-•*●▪◦–—]\s*/, '').trim(),
          });
        }
      }

      const maxBullets = expIndex < 3 ? 5 : 3;
      if (bulletRows.length <= maxBullets) {
        searchFrom = titleIdx + 1;
        continue;
      }

      const keep = new Set(
        bulletRows
          .map(row => ({
            ...row,
            score: this._scoreExperienceBulletForTarget(row.body, jdData, matchMap),
          }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, maxBullets)
          .map(row => row.index)
      );

      for (let i = bulletRows.length - 1; i >= 0; i--) {
        if (!keep.has(bulletRows[i].index)) {
          lines.splice(bulletRows[i].index, 1);
        }
      }

      searchFrom = titleIdx + 1;
    }

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

    // Company names — skip parser artefacts where a job title or bullet ended up
    // stored as the company (e.g. "Position: X" or a string starting with a bullet).
    for (const exp of (originalCvData.experience || [])) {
      const co = exp.company || '';
      if (!co) continue;
      if (/^(position|title|role)\s*:/i.test(co)) continue;        // "Position: X" artefact
      if (/^[•●▪◦\-–—]/.test(co)) continue;                       // bullet artefact
      if (co.length > 80) continue;                                 // too long to be a company name
      if (this._isParserArtefact(co)) continue;                    // prose fragment stored as company
      if (!t.includes(co)) {
        warnings.push(`Company name may have changed or been removed: "${co}"`);
      }
    }

    // Job titles — skip parser artefacts (bullets stored as titles, very long strings)
    for (const exp of (originalCvData.experience || [])) {
      const title = exp.title || '';
      if (!title) continue;
      if (/^[•●▪◦\-–—]/.test(title)) continue;                    // bullet artefact
      if (title.length > 80) continue;                              // sentence stored as title
      if (/^(position|title|role)\s*:/i.test(title)) continue;     // "Position: X" artefact
      if (this._isParserArtefact(title)) continue;                  // prose fragment stored as title
      if (!t.includes(title)) {
        warnings.push(`Job title may have changed or been removed: "${title}"`);
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
      // Skip JD requirement prose the user confirmed (long sentences, "X years of…", etc.)
      // — these can't be inserted verbatim into a CV and would only confuse the user.
      if (this._isJdRequirementProse(skill) || this._isRequirementFragment(skill)) continue;
      if (skill.length > 55) continue;
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

    const competencyLines = this._extractSectionLines(tailoredText, /^core\s+competenc(?:y|ies)$/i, /^(professional\s+experience|experience|employment|work\s+history|education|certifications?|projects?|skills)$/i);
    if (competencyLines.length > 0) {
      if (competencyLines.length < 5) {
        warnings.push(`Core Competencies has only ${competencyLines.length} populated line(s); expected 5–7 concise categories.`);
      }
      if (this._hasBrokenCompetencyLine(competencyLines)) {
        warnings.push('Core Competencies contains a broken or wrapped category line; rebuild the skills section into complete "Category: Skill, Skill" lines.');
      }
      if (competencyLines.some(line => /\bbusiness communication skills\b/i.test(line))) {
        warnings.push('Core Competencies contains weak filler phrasing ("business communication skills"); use concise senior-level phrases such as Stakeholder Communication.');
      }
      if (competencyLines.some(line => /^additional\s+(?:relevant\s+)?skills\s*:/i.test(line))) {
        warnings.push('Core Competencies contains an "Additional Skills" catch-all line; use named categories instead.');
      }
      if (competencyLines.some(line => this._isJdRequirementProse(line) || this._isRequirementFragment(line))) {
        warnings.push('Core Competencies may contain pasted JD requirement prose instead of concise skill phrases.');
      }
    } else {
      warnings.push('Core Competencies section may be missing from the tailored CV.');
    }

    // Generic/common words that appear in almost every CV — not meaningful to flag.
    const GENERIC_SKILL_WORDS = new Set([
      'communication', 'leadership', 'experience', 'skills', 'ability', 'knowledge',
      'collaboration', 'teamwork', 'management', 'delivery', 'development', 'support',
    ]);
    for (const item of (matchMap || []).filter(m => !m.allowedToMention)) {
      for (const candidate of this._extractAtomicSkillCandidates(item.requirement)) {
        const key = this._normaliseText(candidate);
        if (!key || key.length < 4) continue;
        if (GENERIC_SKILL_WORDS.has(key)) continue;
        if (normalisedOriginal.includes(key)) continue;
        if (normalisedOutput.includes(key)) {
          warnings.push(`Unsupported JD skill/tool may have been claimed without CV evidence or user confirmation: "${candidate}"`);
        }
      }
    }

    warnings.push(...this._validateRoleCredibility(originalCvData, jdData, matchMap, tailoredText, confirmedSkills));
    warnings.push(...this.roleProfiles.validateCredibility({
      originalCvData,
      jdData,
      tailoredText,
      confirmedSkills,
    }));

    return [...new Set(warnings)];
  }

  /**
   * Deterministic recruiter screen for the final tailored CV.
   */
  buildRecruiterReview(originalCvData = {}, jdData = {}, matchMap = [], tailoredText = '', warnings = [], confirmedSkills = []) {
    const output = String(tailoredText || '').trim();
    if (!output) {
      return {
        verdict: 'not_ready',
        overallScore: 0,
        roleCredibilityScore: 0,
        jdCoverageScore: 0,
        readyToSend: false,
        recruiterSummary: 'No tailored CV text was produced, so a recruiter screen cannot be completed.',
        sectionScores: {},
        strengths: [],
        risks: ['No tailored CV text was produced.'],
        topFixes: ['Regenerate the tailored CV before exporting or submitting.'],
        coverage: { matched: 0, partial: 0, confirmed: 0, missing: 0, visibleMatched: 0, hiddenMatched: 0, unsupportedVisible: 0 },
        roleFamily: jdData?.roleProfile?.family || jdData?.jobTitle || 'Target role',
      };
    }

    const safeWarnings = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    const profile = jdData?.roleProfile || this.roleProfiles.classify(jdData || {}) || {};
    const roleFamily = profile.family || jdData?.jobTitle || 'Target role';
    const reviewableMatchMap = (matchMap || []).filter(m => !this._isRecruiterLowSignalRequirement(m.requirement, m.type));
    const supported = reviewableMatchMap.filter(m => m.allowedToMention);
    const missing = reviewableMatchMap.filter(m => !m.allowedToMention);
    const requiredMissing = missing.filter(m => m.type === 'required');
    const visibleSupported = supported.filter(m => this._requirementVisibleInText(m.requirement, output));
    const hiddenSupported = supported.filter(m => !this._requirementVisibleInText(m.requirement, output));
    const unsupportedVisible = missing.filter(m => this._requirementVisibleInText(m.requirement, output));

    const headline = this._extractHeadline(output);
    const summaryText = this._extractSectionLines(
      output,
      /^professional\s+summary$/i,
      /^(core\s+competenc(?:y|ies)|professional\s+experience|experience|employment|work\s+history|education|certifications?|skills)$/i
    ).join(' ');
    const competencyLines = this._extractSectionLines(
      output,
      /^core\s+competenc(?:y|ies)$/i,
      /^(professional\s+experience|experience|employment|work\s+history|education|certifications?|projects?|skills)$/i
    );
    const experienceText = this._extractExperienceText(output);
    const proofText = `${summaryText} ${experienceText}`;
    const credibilitySignals = [
      ...(profile.credibilitySignals || []),
      ...(jdData?.credibilitySignals || []),
    ];
    const signalHits = this._uniqueDisplaySkills(credibilitySignals)
      .filter(signal => this._conceptVisibleInText(signal, proofText));
    const visibleInExperience = supported
      .filter(m => this._requirementVisibleInText(m.requirement, experienceText));

    const sectionScores = {
      headline: this._sectionScore(
        this._scoreRecruiterHeadline(headline, jdData),
        headline ? `Headline: ${headline}` : 'Headline is missing or unclear.'
      ),
      summary: this._sectionScore(
        this._scoreRecruiterSummary(summaryText, jdData, profile, signalHits),
        signalHits.length ? `Summary proves ${signalHits.slice(0, 3).join(', ')}.` : 'Summary needs clearer role-specific proof.'
      ),
      coreCompetencies: this._sectionScore(
        this._scoreRecruiterCompetencies(competencyLines, output, supported),
        competencyLines.length ? `${competencyLines.length} competency categories detected.` : 'Core Competencies section is missing.'
      ),
      professionalExperience: this._sectionScore(
        this._scoreRecruiterExperience(experienceText, supported, signalHits),
        visibleInExperience.length ? `${visibleInExperience.length} matched requirement(s) visible in experience.` : 'Experience section needs stronger visible JD evidence.'
      ),
    };

    const roleCredibilityScore = this._clampScore(
      sectionScores.headline.score * 0.18 +
      sectionScores.summary.score * 0.27 +
      sectionScores.coreCompetencies.score * 0.20 +
      sectionScores.professionalExperience.score * 0.35 -
      this._roleCredibilityPenalty(safeWarnings)
    );
    const visibleRatio = supported.length ? visibleSupported.length / supported.length : 1;
    const jdCoverageScore = this._clampScore(
      this._scoreRecruiterMatchCoverage(reviewableMatchMap) * 0.70 +
      visibleRatio * 100 * 0.30 -
      unsupportedVisible.length * 10 -
      Math.max(0, requiredMissing.length - 2) * 4
    );
    const trustScore = this._clampScore(100 - this._recruiterWarningPenalty(safeWarnings) - unsupportedVisible.length * 12);
    const overallScore = this._clampScore(roleCredibilityScore * 0.43 + jdCoverageScore * 0.42 + trustScore * 0.15);
    const highRiskCount = safeWarnings.filter(w =>
      /New metric|Unsupported JD skill|without original CV evidence|not read credibly|under-positioned|implementation-only|broken or wrapped|Company name|Job title|Education institution|Email address|Phone number|LinkedIn|Full name/i.test(w)
    ).length + unsupportedVisible.length;
    const verdict = this._recruiterVerdict(overallScore, highRiskCount);
    const readyToSend = verdict === 'strong' || verdict === 'ready_with_edits';
    const strong = (matchMap || []).filter(m => m.status === 'strong_match');
    const partial = (matchMap || []).filter(m => m.status === 'partial_match');
    const confirmed = (matchMap || []).filter(m => m.status === 'user_confirmed');
    const strengths = this._buildRecruiterStrengths({ signalHits, strong, partial, confirmed, sectionScores, roleFamily });
    const risks = this._buildRecruiterRisks({ requiredMissing, hiddenSupported, unsupportedVisible, warnings: safeWarnings, roleFamily });
    const topFixes = this._buildRecruiterTopFixes({ sectionScores, requiredMissing, hiddenSupported, unsupportedVisible, warnings: safeWarnings, jdData });

    return {
      verdict,
      overallScore,
      roleCredibilityScore,
      jdCoverageScore,
      readyToSend,
      recruiterSummary: this._recruiterSummary(verdict, jdData, roleFamily, overallScore, risks),
      sectionScores,
      strengths,
      risks,
      topFixes,
      coverage: {
        matched: strong.length,
        partial: partial.length,
        confirmed: confirmed.length,
        missing: missing.length,
        visibleMatched: visibleSupported.length,
        hiddenMatched: hiddenSupported.length,
        unsupportedVisible: unsupportedVisible.length,
      },
      roleFamily,
    };
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

  _scoreRecruiterHeadline(headline = '', jdData = {}) {
    const target = String(jdData?.jobTitle || '').trim();
    if (!headline) return 20;
    if (!target) return 75;

    const headlineNorm = this._normaliseText(headline);
    const targetNorm = this._normaliseText(target);
    if (headlineNorm === targetNorm || headlineNorm.includes(targetNorm)) return 100;

    const targetTokens = this._getCoreTokens(target);
    if (targetTokens.length === 0) return 75;
    const hits = targetTokens.filter(tok => headlineNorm.includes(tok)).length;
    const ratio = hits / targetTokens.length;
    if (ratio >= 0.75) return 85;
    if (ratio >= 0.5) return 65;
    return 40;
  }

  _scoreRecruiterSummary(summaryText = '', jdData = {}, profile = {}, signalHits = []) {
    const words = String(summaryText || '').trim().split(/\s+/).filter(Boolean).length;
    if (!words) return 20;

    let score = 45;
    if (words >= 35 && words <= 120) score += 15;
    else if (words >= 20 && words <= 160) score += 8;

    const targetText = this._normaliseText([
      jdData?.jobTitle,
      jdData?.targetPositioning,
      profile?.family,
      ...(jdData?.atsKeywords || []).slice(0, 8),
    ].join(' '));
    const summaryNorm = this._normaliseText(summaryText);
    const targetTokens = [...new Set(targetText.split(/\s+/).filter(t => t.length >= 4 && !this._noiseWords().has(t)))].slice(0, 12);
    const targetHits = targetTokens.filter(tok => summaryNorm.includes(tok)).length;
    if (targetTokens.length > 0) score += Math.min(18, Math.round((targetHits / targetTokens.length) * 18));

    score += Math.min(25, signalHits.length * 9);
    if (/\b(results[- ]driven|dynamic|passionate|hard[- ]working|self[- ]starter)\b/i.test(summaryText)) score -= 8;
    if (/\btailored for|customi[sz]ed for|this application\b/i.test(summaryText)) score -= 20;
    return this._clampScore(score);
  }

  _scoreRecruiterCompetencies(lines = [], output = '', supported = []) {
    if (!lines.length) return 20;

    let score = 25;
    if (lines.length >= 5 && lines.length <= 7) score += 35;
    else if (lines.length >= 4) score += 20;
    else score += 5;

    if (!this._hasBrokenCompetencyLine(lines)) score += 15;
    if (!lines.some(line => /\bbusiness communication skills\b/i.test(line))) score += 8;
    if (!lines.some(line => /^additional\s+(?:relevant\s+)?skills\s*:/i.test(line))) score += 8;
    if (!lines.some(line => this._isJdRequirementProse(line) || this._isRequirementFragment(line))) score += 8;

    const visibleSupported = supported
      .slice(0, 12)
      .filter(item => this._requirementVisibleInText(item.requirement, output));
    if (supported.length > 0) score += Math.min(12, visibleSupported.length * 2);

    return this._clampScore(score);
  }

  _scoreRecruiterExperience(experienceText = '', supported = [], signalHits = []) {
    const words = String(experienceText || '').trim().split(/\s+/).filter(Boolean).length;
    if (!words) return 20;

    let score = words >= 120 ? 48 : 42;
    const visible = supported.filter(item => this._requirementVisibleInText(item.requirement, experienceText));
    score += Math.min(34, visible.length * 6);
    score += Math.min(18, signalHits.length * 6);
    if (/^focus\s*:/im.test(experienceText)) score += 7;
    if (words < 50) score -= 8;
    return this._clampScore(score);
  }

  _sectionScore(score, note = '') {
    const value = this._clampScore(score);
    return {
      score: value,
      status: value >= 80 ? 'strong' : value >= 60 ? 'needs_review' : 'weak',
      note,
    };
  }

  _clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  }

  _requirementVisibleInText(requirement = '', text = '') {
    const source = String(text || '');
    if (!requirement || !source) return false;
    if (this._findEvidence(requirement, [source]).length > 0) return true;
    if (this._findSemanticEvidence(requirement, [source]).length > 0) return true;

    const tokens = this._getCoreTokens(requirement);
    if (tokens.length === 0 || tokens.length > 8) return false;
    const lower = this._normaliseText(source);
    const hits = tokens.filter(tok => lower.includes(tok) || this._semanticTokenSupported(tok, source)).length;
    const needed = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.65);
    return hits >= needed;
  }

  _conceptVisibleInText(concept = '', text = '') {
    if (!concept || !text) return false;
    const lower = this._normaliseText(text);
    const conceptNorm = this._normaliseText(concept);
    if (conceptNorm && lower.includes(conceptNorm)) return true;
    const aliases = this._semanticAliasesForRequirement(concept);
    if (aliases.some(alias => lower.includes(this._normaliseText(alias)))) return true;
    const tokens = this._getCoreTokens(concept);
    if (tokens.length === 0) return false;
    const hits = tokens.filter(tok => lower.includes(tok) || this._semanticTokenSupported(tok, text)).length;
    return hits >= Math.min(tokens.length, 2);
  }

  _scoreRecruiterMatchCoverage(matchMap = []) {
    if (!matchMap.length) return 0;

    const required = matchMap.filter(m => m.type === 'required');
    const strong = matchMap.filter(m => m.status === 'strong_match');
    const partial = matchMap.filter(m => m.status === 'partial_match');
    const confirmed = matchMap.filter(m => m.status === 'user_confirmed');
    const reqTotal = required.length || 1;
    const reqMatched = required.filter(m => m.status !== 'missing').length;
    const allTotal = matchMap.length || 1;
    const allMatched = strong.length + confirmed.length + partial.length * 0.5;
    return this._clampScore(
      ((reqMatched / reqTotal) * 0.7 + (allMatched / allTotal) * 0.3) * 100
    );
  }

  _isRecruiterLowSignalRequirement(requirement = '', type = '') {
    const text = this._normaliseText(requirement);
    if (!text) return true;
    if (/\b\d+\s*\+?\s*years?\b/.test(text)) return true;
    if (/\b(years?|experience|minimum|least|required)\b/.test(text) && text.split(/\s+/).length <= 5) return true;

    const genericSoft = new Set([
      'communication', 'teamwork', 'collaboration', 'leadership', 'ownership',
      'problem solving', 'stakeholder management', 'cross functional collaboration',
    ]);
    if (type === 'soft' && genericSoft.has(text)) return true;
    return false;
  }

  _roleCredibilityPenalty(warnings = []) {
    return warnings.reduce((sum, warning) => {
      if (/not read credibly|under-positioned|implementation-only|skills rather than supported experience|High-risk|without original CV evidence/i.test(warning)) return sum + 10;
      if (/Role focus line|Core Competencies|Target job title/i.test(warning)) return sum + 5;
      return sum;
    }, 0);
  }

  _recruiterWarningPenalty(warnings = []) {
    return warnings.reduce((sum, warning) => {
      if (/New metric|Company name|Job title|Education institution|Email address|Phone number|LinkedIn|Full name/i.test(warning)) return sum + 15;
      if (/Unsupported JD skill|without original CV evidence|not read credibly|under-positioned|implementation-only/i.test(warning)) return sum + 10;
      if (/Core Competencies|Role focus line|User-confirmed skill/i.test(warning)) return sum + 5;
      return sum + 2;
    }, 0);
  }

  _recruiterVerdict(score, highRiskCount = 0) {
    if (score >= 85 && highRiskCount === 0) return 'strong';
    if (score >= 72 && highRiskCount <= 1) return 'ready_with_edits';
    if (score >= 55) return 'borderline';
    return 'not_ready';
  }

  _recruiterSummary(verdict, jdData = {}, roleFamily = 'target role', score = 0, risks = []) {
    const target = jdData?.jobTitle || roleFamily || 'the target role';
    if (verdict === 'strong') {
      return `Strong recruiter fit for ${target}: the CV visibly connects supported experience to the JD and should survive a quick human screen.`;
    }
    if (verdict === 'ready_with_edits') {
      return `Credible for ${target}, but review the flagged edits before sending. Recruiter score: ${score}%.`;
    }
    if (verdict === 'borderline') {
      const reason = risks[0] ? ` Main concern: ${risks[0]}` : '';
      return `Borderline for ${target}: the CV has relevant evidence but does not yet read consistently role-ready.${reason}`;
    }
    return `Not ready for ${target}: the CV needs stronger supported evidence before it is safe to send.`;
  }

  _buildRecruiterStrengths({ signalHits = [], strong = [], partial = [], confirmed = [], sectionScores = {}, roleFamily = 'Target role' }) {
    const strengths = [];
    if (signalHits.length > 0) strengths.push(`Visible ${roleFamily} proof: ${signalHits.slice(0, 4).join(', ')}.`);
    if (strong.length > 0) strengths.push(`Strong evidence for: ${strong.slice(0, 4).map(m => m.requirement).join(', ')}.`);
    if (partial.length > 0) strengths.push(`Transferable evidence for: ${partial.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    if (confirmed.length > 0) strengths.push(`User-confirmed additions included: ${confirmed.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    if (sectionScores.coreCompetencies?.score >= 80) strengths.push('Core Competencies are formatted for fast recruiter scanning.');
    if (sectionScores.professionalExperience?.score >= 80) strengths.push('Professional Experience shows role-relevant evidence, not just skills.');
    return strengths.slice(0, 5);
  }

  _buildRecruiterRisks({ requiredMissing = [], hiddenSupported = [], unsupportedVisible = [], warnings = [], roleFamily = 'Target role' }) {
    const risks = [];
    if (requiredMissing.length > 0) {
      risks.push(`Missing required JD evidence: ${requiredMissing.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    }
    if (hiddenSupported.length > 0) {
      risks.push(`Matched evidence is not visible enough in the final CV: ${hiddenSupported.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    }
    if (unsupportedVisible.length > 0) {
      risks.push(`Unsupported claims appear in the CV: ${unsupportedVisible.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    }
    const credibilityWarning = warnings.find(w => /not read credibly|under-positioned|implementation-only|skills rather than supported experience|High-risk/i.test(w));
    if (credibilityWarning) risks.push(`${roleFamily} credibility risk: ${credibilityWarning}`);
    const accuracyWarning = warnings.find(w => /New metric|Company name|Job title|Education institution|Email address|Phone number|LinkedIn|Full name/i.test(w));
    if (accuracyWarning) risks.push(`Accuracy risk: ${accuracyWarning}`);
    return [...new Set(risks)].slice(0, 5);
  }

  _buildRecruiterTopFixes({ sectionScores = {}, requiredMissing = [], hiddenSupported = [], unsupportedVisible = [], warnings = [], jdData = {} }) {
    const fixes = [];
    const target = jdData?.jobTitle || 'the target role';
    if (sectionScores.headline?.score < 80) fixes.push(`Set the headline directly to "${target}" if that is the role being targeted.`);
    if (sectionScores.summary?.score < 75) fixes.push('Rewrite the summary so it proves the target role with supported evidence from the CV.');
    if (sectionScores.professionalExperience?.score < 75) fixes.push('Move the strongest matching experience bullets to the top of each relevant role.');
    if (sectionScores.coreCompetencies?.score < 75) fixes.push('Rebuild Core Competencies into 5-7 complete "Category: Skill, Skill" lines.');
    if (hiddenSupported.length > 0) fixes.push(`Make matched evidence visible in the final CV: ${hiddenSupported.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    if (requiredMissing.length > 0) fixes.push(`Do not claim missing required skills unless genuinely true: ${requiredMissing.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    if (unsupportedVisible.length > 0) fixes.push(`Remove unsupported JD-only claims: ${unsupportedVisible.slice(0, 3).map(m => m.requirement).join(', ')}.`);
    for (const warning of warnings) {
      if (fixes.length >= 6) break;
      if (/New metric/.test(warning)) fixes.push('Verify or remove any new metrics that were not present in the original CV.');
      else if (/Core Competencies/.test(warning)) fixes.push('Fix the Core Competencies warning before export.');
      else if (/not read credibly|under-positioned|implementation-only/.test(warning)) fixes.push('Strengthen role credibility in the headline, summary, and first relevant experience bullets.');
    }
    return [...new Set(fixes)].slice(0, 6);
  }

  _buildRoleCredibilityGuidance(jdData = {}) {
    return this.roleProfiles.buildCredibilityGuidance(jdData) || '';
  }

  _validateRoleCredibility(originalCvData = {}, jdData = {}, matchMap = [], tailoredText = '', confirmedSkills = []) {
    if (!this._isSolutionArchitectTarget(jdData)) return [];

    const warnings = [];
    const output = String(tailoredText || '');
    const outputNorm = this._normaliseText(output);
    const originalText = String(originalCvData?.rawText || '');
    const confirmedNorm = this._normaliseText([
      ...(confirmedSkills || []),
      ...(matchMap || []).filter(m => m.confirmedByUser).map(m => m.requirement),
    ].join(' '));

    const headline = this._extractHeadline(output);
    if (headline && !/\bsolutions?\s+architect\b/i.test(headline)) {
      warnings.push(`Solution Architect target may be under-positioned in the CV headline: "${headline}"`);
    }

    const summary = this._extractSectionLines(output, /^professional\s+summary$/i, /^(core\s+competenc(?:y|ies)|professional\s+experience|experience|employment|work\s+history|education|certifications?|skills)$/i).join(' ');
    const hasArchitecturalPositioning = /\b(architecture|architectural|solution design|technical discovery|requirements?|stakeholder|customer|implementation plan|integration|roadmap|business outcome|technical leadership)\b/i.test(summary);
    const readsImplementationOnly = /\b(devops|mlops|platform engineering|kubernetes|ci.?cd|container|automation|infrastructure)\b/i.test(summary)
      && !hasArchitecturalPositioning;
    if (!summary || readsImplementationOnly || !hasArchitecturalPositioning) {
      warnings.push('Professional Summary may read as implementation-only; for a Solution Architect role it should show supported architecture, customer, stakeholder, or requirements-to-solution evidence.');
    }

    const competencyLines = this._extractSectionLines(output, /^core\s+competenc(?:y|ies)$/i, /^(professional\s+experience|experience|employment|work\s+history|education|certifications?|projects?|skills)$/i);
    const competencyText = competencyLines.join(' ');
    const highRiskClaims = [
      { label: 'MEDDPICC', pattern: /\bMEDD?P?ICC\b/i, sourcePattern: /\bMEDD?P?ICC\b/i },
      { label: 'RFP/RFI response', pattern: /\bRFP\b|\bRFI\b/i, sourcePattern: /\bRFP\b|\bRFI\b/i },
      { label: 'POC/POV delivery', pattern: /\bPOC\b|\bPOV\b|proof of concept|proof of value/i, sourcePattern: /\bPOC\b|\bPOV\b|proof of concept|proof of value/i },
      { label: 'technical demos', pattern: /\btechnical demos?\b|\bworld[- ]class demos?\b/i, sourcePattern: /\bdemos?\b|technical demos?/i },
      { label: 'solution selling', pattern: /\bsolution selling\b|\btechnical selling\b|\bpre[- ]sales\b/i, sourcePattern: /\bsolution selling\b|\btechnical selling\b|\bpre[- ]sales\b/i },
    ];

    for (const claim of highRiskClaims) {
      if (!claim.pattern.test(competencyText)) continue;
      const supportedByOriginal = claim.sourcePattern.test(originalText);
      const supportedByConfirmation = claim.sourcePattern.test(confirmedNorm);
      if (!supportedByOriginal && !supportedByConfirmation) {
        warnings.push(`Core Competencies claims "${claim.label}" without original CV evidence or user confirmation.`);
      }
    }

    const architectureEvidenceInExperience = /\b(solution architecture|architecture|architected|designed|technical discovery|requirements?|stakeholder|customer-facing|enterprise|integration|implementation plan|roadmap|poc|pov|proof of concept|proof of value|rfp|rfi)\b/i
      .test(this._extractExperienceText(output));
    const architectureEvidenceInOriginal = /\b(solution architecture|architected|technical discovery|requirements?|stakeholder|customer-facing|enterprise|integration|implementation|poc|pov|proof of concept|proof of value|rfp|rfi)\b/i
      .test(originalText);
    if (!architectureEvidenceInExperience && architectureEvidenceInOriginal) {
      warnings.push('Solution Architect evidence from the original CV is not visible in the experience bullets.');
    }
    if (!architectureEvidenceInExperience && !architectureEvidenceInOriginal && /\b(solution architecture|pre[- ]sales|rfp|rfi|medd?picc|poc|pov)\b/i.test(outputNorm)) {
      warnings.push('Tailored CV appears to add Solution Architect/pre-sales positioning mostly as skills rather than supported experience evidence.');
    }

    return warnings;
  }

  _isSolutionArchitectTarget(jdData = {}) {
    const text = [
      jdData.jobTitle,
      jdData.domain,
      jdData.targetPositioning,
      ...(jdData.requiredSkills || []),
      ...(jdData.responsibilities || []),
      ...(jdData.atsKeywords || []),
    ].join(' ');
    return /\bsolutions?\s+architect\b/i.test(text);
  }

  _extractHeadline(text = '') {
    const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) return '';
    for (let i = 1; i < Math.min(lines.length, 8); i++) {
      const line = lines[i];
      if (this._isLikelySectionHeader(line)) return '';
      if (/@|https?:|linkedin|github|\+?\d[\d\s().-]{6,}|,/.test(line)) continue;
      return line;
    }
    return '';
  }

  _extractExperienceText(text = '') {
    const lines = String(text || '').split('\n');
    const start = lines.findIndex(line => /^(professional\s+experience|experience|employment|work\s+history)\s*[:\-]?$/i.test(String(line || '').trim()));
    if (start === -1) return '';

    const collected = [];
    for (const line of lines.slice(start + 1)) {
      const trimmed = String(line || '').trim();
      if (/^(education|certifications?|projects?|skills|core\s+competenc(?:y|ies))\s*[:\-]?$/i.test(trimmed)) break;
      if (trimmed) collected.push(trimmed.replace(/^[-•*●▪◦–—]\s*/, ''));
    }
    return collected.join(' ');
  }

  _hasBrokenCompetencyLine(lines = []) {
    return lines.some((line, idx) => {
      const current = String(line || '').trim();
      const next = String(lines[idx + 1] || '').trim();
      return (current && !/:/.test(current) && /^[A-Za-z/& -]{2,24}\s*:/i.test(next))
        || /\bdev\s*$/i.test(current)
        || /^ops\s*:/i.test(current);
    });
  }

  _joinWrappedSkillSectionLines(sectionLines = []) {
    const joined = [];
    for (let i = 0; i < sectionLines.length; i++) {
      const current = String(sectionLines[i] || '');
      const next = String(sectionLines[i + 1] || '');
      const curTrim = current.trim();
      const nextTrim = next.trim();

      if (curTrim && !/:/.test(curTrim) && /^[A-Za-z/& -]{2,24}\s*:/i.test(nextTrim)) {
        const separator = /[A-Za-z]$/.test(curTrim) && /^[A-Za-z]/.test(nextTrim) ? '' : ' ';
        joined.push(`${curTrim}${separator}${nextTrim}`);
        i++;
        continue;
      }

      joined.push(current);
    }
    return joined;
  }

  _extractSectionLines(text, headingRe, stopHeadingRe) {
    const lines = String(text || '').split('\n');
    const start = lines.findIndex(line => headingRe.test(String(line || '').trim()));
    if (start === -1) return [];

    const collected = [];
    for (const line of lines.slice(start + 1)) {
      const trimmed = String(line || '').trim();
      if (!trimmed) {
        if (collected.length > 0) break;
        continue;
      }
      if (stopHeadingRe.test(trimmed)) break;
      collected.push(trimmed.replace(/^[-•*●▪◦–—]\s*/, ''));
    }
    return collected;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Structured CV generation: locked skeleton + mutable JSON content.
  // Design: docs/structured-cv-generation.md.
  //
  // The model only ever produces the content it is allowed to change
  // (summary, competency lists, per-role focus/bullets); companies, dates,
  // titles, education, and contact details come verbatim from the parsed CV
  // and are rendered by renderTailoredCV's template. The malformed-structure
  // class of bugs (split dates, duplicated company lines, misplaced Focus
  // lines, scrambled education) cannot occur because that structure never
  // round-trips through model output.
  // ══════════════════════════════════════════════════════════════════════

  buildCvSkeleton(cvData = {}, jdData = {}) {
    const contactInfo = cvData?.contactInfo || {};
    const roles = this._sanitiseSkeletonRoles(cvData?.experience || [])
      .map((role, i) => ({
        ...role,
        id: `role_${i}`,
        sourceId: role.sourceId || `experience:${i}`,
        originalBulletEvidence: role.originalBullets.map((text, bulletIndex) => ({
          text,
          sourceIds: role.originalBulletEvidence?.[bulletIndex]?.sourceIds?.length
            ? role.originalBulletEvidence[bulletIndex].sourceIds
            : [role.originalBulletEvidence?.[bulletIndex]?.sourceId || `${role.sourceId || `experience:${i}`}:responsibility:${bulletIndex}`],
        })),
        allowedSourceIds: [...new Set(role.originalBullets.flatMap((_, bulletIndex) =>
          role.originalBulletEvidence?.[bulletIndex]?.sourceIds?.length
            ? role.originalBulletEvidence[bulletIndex].sourceIds
            : [role.originalBulletEvidence?.[bulletIndex]?.sourceId || `${role.sourceId || `experience:${i}`}:responsibility:${bulletIndex}`]
        ))],
      }));

    return {
      name: String(contactInfo.name || '').trim(),
      headline: String(jdData?.jobTitle || '').trim(),
      contacts: this._extractHeaderContactLines(cvData),
      roles,
      projects: this._sanitiseSkeletonProjects(cvData?.projects || []),
      educationLines: this._extractEducationLines(cvData),
    };
  }

  _sanitiseSkeletonProjects(projects = []) {
    const seen = new Set();
    return projects.flatMap((project, index) => {
      const name = String(project?.name || '').trim();
      const url = String(project?.url || '').trim();
      if (!name || name.length > 120 || url.length > 500 || !/^https?:\/\/[^\s]+$/i.test(url)) return [];
      const key = `${name.toLowerCase()}|${url}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const bulletItems = (project.bullets || []).map((value, i) => ({
        text: String(value || '').trim(),
        sourceIds: [project.bulletEvidence?.[i]?.sourceId || `project:${index}:bullet:${i}`],
      })).filter(item => item.text.length >= 8 && item.text.length <= 320);
      const skillItems = (project.skills || []).map((value, i) => ({
        text: String(value || '').trim(),
        sourceIds: [project.skillEvidence?.[i]?.sourceId || `project:${index}:skill:${i}`],
      })).filter(item => item.text && item.text.length <= 64);
      const originalBullets = bulletItems.map(item => item.text);
      const originalBulletEvidence = bulletItems.map(item => ({ text: item.text, sourceIds: item.sourceIds }));
      const skills = skillItems.map(item => item.text);
      const skillEvidence = skillItems.map(item => ({ text: item.text, sourceIds: item.sourceIds }));
      return [{
        id: `project_${index}`,
        sourceId: project.sourceId || `project:${index}`,
        name,
        url,
        originalBullets,
        originalBulletEvidence,
        skills,
        skillEvidence,
      }];
    });
  }

  // The locked skeleton is only as trustworthy as the CV parse, and real
  // source documents (multi-column PDFs, or a previously exported CV
  // re-uploaded as the source) produce corrupted parses: the same role
  // parsed twice (once with the location in the title field), company and
  // dates swapped into each other's fields, and hard-wrapped bullet
  // fragments split into separate "responsibilities". Sanitise all of that
  // deterministically before locking the skeleton.
  _sanitiseSkeletonRoles(experience = []) {
    const isDateRange = (value) => {
      const text = String(value || '').trim();
      return text.length <= 60 &&
        /\b(?:19|20)\d{2}\b\s*(?:-|–|—|to)\s*(?:.*\b(?:19|20)\d{2}\b|\s*(?:present|current)\b)/i.test(text);
    };
    const isLocationLike = (value) => {
      const text = String(value || '').trim();
      if (!text || text.length > 45) return false;
      if (/\b(engineer|developer|manager|architect|analyst|designer|consultant|lead|director|specialist|administrator|scientist)\b/i.test(text)) return false;
      return /,/.test(text) || /^(remote|hybrid|onsite)$/i.test(text)
        || /\b(uk|usa|united kingdom|united states|nigeria|remote)\b/i.test(text);
    };

    const cleaned = [];
    for (const exp of experience) {
      let company = String(exp?.company || '').trim();
      let dates = String(exp?.dates || '').trim();
      let title = String(exp?.title || '').trim();
      if (!company && !title) continue;

      // Swapped fields: "Feb 2019 - May 2020" parsed as the company while
      // the real company sits in the dates field.
      if (isDateRange(company) && !isDateRange(dates)) {
        [company, dates] = [dates, company];
      }
      if (isDateRange(title) && !dates) {
        dates = title;
        title = '';
      }
      // Location parsed as the job title ("Birmingham, UK").
      if (isLocationLike(title)) title = '';

      const bulletPairs = this._joinWrappedBulletEvidence(
        (exp?.responsibilities || []).map((text, index) => ({
          text: String(text || '').trim(),
          sourceIds: [exp?.responsibilityEvidence?.[index]?.sourceId].filter(Boolean),
        })).filter(item => item.text)
      );
      cleaned.push({
        company,
        dates,
        title,
        sourceId: exp?.sourceId,
        roleSourceIds: [exp?.sourceId].filter(Boolean),
        originalBulletEvidence: bulletPairs.map(item => ({ text: item.text, sourceIds: item.sourceIds })),
        originalBullets: bulletPairs.map(item => item.text),
      });
    }

    // Merge duplicate parses of the same role: same primary company segment
    // + same dates. Keep the copy with a real title first so its (usually
    // complete) bullets win the near-duplicate dedupe over truncated ones.
    const merged = [];
    const indexByKey = new Map();
    for (const role of cleaned) {
      const primaryCompany = this._normaliseText(String(role.company).split('|')[0]);
      const key = `${primaryCompany}::${this._normaliseText(role.dates)}`;
      if (!primaryCompany || !indexByKey.has(key)) {
        if (primaryCompany) indexByKey.set(key, merged.length);
        merged.push(role);
        continue;
      }
      const existing = merged[indexByKey.get(key)];
      if (existing.title && role.title && this._normaliseText(existing.title) !== this._normaliseText(role.title)) {
        merged.push(role);
        continue;
      }
      const primary = existing.title ? existing : (role.title ? role : existing);
      const secondary = primary === existing ? role : existing;
      const originalBullets = this._dedupeSimilarBullets([
        ...primary.originalBullets,
        ...secondary.originalBullets,
      ]);
      const evidenceByText = [...(primary.originalBulletEvidence || []), ...(secondary.originalBulletEvidence || [])];
      merged[indexByKey.get(key)] = {
        company: primary.company.length >= secondary.company.length ? primary.company : secondary.company,
        dates: primary.dates || secondary.dates,
        title: primary.title || secondary.title,
        sourceId: primary.sourceId,
        roleSourceIds: [...new Set([...(primary.roleSourceIds || []), ...(secondary.roleSourceIds || [])])],
        originalBulletEvidence: originalBullets.map(text => evidenceByText.find(record =>
          this._normaliseBulletForSimilarity(record?.text) === this._normaliseBulletForSimilarity(text)
        ) || { text, sourceIds: [] }),
        originalBullets,
      };
    }

    return merged;
  }

  // Hard-wrapped PDF extraction can leave a bullet's continuation as its own
  // "responsibility" ("...enterprise-scale" / "integrations."). Rejoin a
  // fragment that starts lowercase onto a previous bullet that ends without
  // terminal punctuation.
  _joinWrappedBulletFragments(bullets = []) {
    const output = [];
    for (const bullet of bullets) {
      const previous = output.length ? output[output.length - 1] : '';
      if (
        previous &&
        /[a-z0-9,\-]$/i.test(previous) && !/[.!?:;]$/.test(previous) &&
        /^[a-z]/.test(bullet)
      ) {
        output[output.length - 1] = `${previous} ${bullet}`;
        continue;
      }
      output.push(bullet);
    }
    return output;
  }

  _joinWrappedBulletEvidence(items = []) {
    const output = [];
    for (const item of items) {
      const previous = output.at(-1);
      if (previous && /[a-z0-9,\-]$/i.test(previous.text) && !/[.!?:;]$/.test(previous.text) && /^[a-z]/.test(item.text)) {
        previous.text = `${previous.text} ${item.text}`;
        previous.sourceIds = [...new Set([...(previous.sourceIds || []), ...(item.sourceIds || [])])];
      } else {
        output.push({ ...item });
      }
    }
    return output.map(item => ({ ...item, text: this._trimIncompleteTrailingSentence(item.text) }));
  }

  _trimIncompleteTrailingSentence(value) {
    const text = String(value || '').trim();
    if (!text || /[.!?]$/.test(text)) return text;
    const completeEnd = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
    if (completeEnd < 40) return text;
    const trailing = text.slice(completeEnd + 2).trim();
    // Preserve ordinary punctuation-free bullets. Only remove a trailing
    // extraction fragment when a complete sentence precedes it and the
    // fragment visibly ends mid-clause or on an unfinished participle.
    if (!trailing || !/(?:\b(?:and|or|to|with|including|such as)|[a-z]{5,}ing)$/i.test(trailing)) return text;
    return text.slice(0, completeEnd + 1).trim();
  }

  // Header contact lines verbatim from the original CV (location, phone,
  // email, profile URLs) - the parser's contactInfo has no location field,
  // and verbatim lines preserve the user's own formatting. Falls back to
  // composing from parsed contactInfo when the raw header yields nothing.
  _extractHeaderContactLines(cvData = {}) {
    const raw = String(cvData?.rawText || '');
    const collected = [];
    if (raw) {
      const lines = raw.split('\n');
      let passedHeading = false;
      for (let i = 1; i < Math.min(lines.length, 12); i++) {
        const trimmed = String(lines[i] || '').trim();
        if (!trimmed) continue;
        if (this._isLikelySectionHeader(trimmed)) { passedHeading = true; continue; }
        const contactish =
          /[\w.+-]+@[\w-]+\.\w+/.test(trimmed) ||
          /https?:\/\//i.test(trimmed) ||
          /(?:linkedin|github)\.com/i.test(trimmed) ||
          (/(?:\+?\d[\d\s\-.()]{6,})/.test(trimmed) && !/\b(?:19|20)\d{2}\b/.test(trimmed)) ||
          (!passedHeading && trimmed.length <= 60 && /,/.test(trimmed)
            && /\b(?:UK|USA|United Kingdom|United States|Canada|Nigeria|Ghana|Ireland|Remote)\b/i.test(trimmed)
            && !/\b(engineer|developer|manager|architect|analyst|designer|consultant)\b/i.test(trimmed));
        if (contactish) collected.push(trimmed);
      }
    }
    const contactInfo = cvData?.contactInfo || {};
    const merged = [...collected, ...[
      contactInfo.email,
      contactInfo.phone,
      contactInfo.linkedin,
      contactInfo.github,
      contactInfo.website,
      contactInfo.portfolio,
      contactInfo.twitter,
    ].map(v => String(v || '').trim()).filter(Boolean)];
    const seen = new Set();
    return merged.filter(value => {
      if (value.length > 500 || /[.!?]\s/.test(value)) return false;
      const key = value.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (seen.has(key)) return false; seen.add(key); return true;
    }).slice(0, 8);
  }

  // Education/certifications section verbatim from the original CV text.
  // The model never rewrites this section, so the safest source is the
  // user's own lines - including compound headers ("EDUCATION,
  // CERTIFICATIONS & RECOGNITION") the parser's field extraction misses.
  _extractEducationLines(cvData = {}) {
    const raw = String(cvData?.rawText || '');
    if (raw) {
      const lines = raw.split('\n');
      const OTHER_HEADER = /^(professional\s+summary|summary|profile|about|objective|core\s+competenc(?:y|ies)|(?:professional\s+)?experience|employment(?:\s+history)?|work\s+history|technical\s+skills?|skills|technologies|projects?|achievements?|languages?|interests?|references?)\s*[:\-]?\s*$/i;
      let start = -1;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = String(lines[i] || '').trim();
        if (!trimmed || trimmed.length > 70) continue;
        if (!/\b(education|certifications?|qualifications|academic)\b/i.test(trimmed)) continue;
        if (OTHER_HEADER.test(trimmed)) continue;
        const headerish = trimmed === trimmed.toUpperCase()
          || /^(education|certifications?|academic|qualifications)\b/i.test(trimmed);
        if (headerish) { start = i; break; }
      }
      if (start !== -1) {
        // Raw CV text (especially multi-page PDF extraction, or a previously
        // exported CV re-uploaded as the source) can continue with EXPERIENCE
        // content after the education header without any section header in
        // between. Stop collecting the moment a line matches a known
        // experience company/title from cvData, or looks like an experience
        // entry header (short line carrying a full date RANGE - education
        // lines carry single years like "..., 2018", never ranges).
        const experienceMarkers = (cvData?.experience || [])
          .flatMap(exp => [exp?.company, exp?.title])
          .map(v => this._normaliseText(v))
          .filter(marker => marker && marker.length >= 6);
        const looksLikeExperienceContent = (trimmed) => {
          const norm = this._normaliseText(trimmed);
          if (norm && experienceMarkers.some(marker => norm === marker || norm.includes(marker))) {
            return true;
          }
          return trimmed.length <= 80 &&
            /\b(?:19|20)\d{2}\b\s*(?:-|–|—|to)\s*(?:.*\b(?:19|20)\d{2}\b|\s*(?:present|current)\b)/i.test(trimmed);
        };

        const collected = [];
        for (let i = start + 1; i < lines.length; i++) {
          const trimmed = String(lines[i] || '').trim();
          if (OTHER_HEADER.test(trimmed)) break;
          if (looksLikeExperienceContent(trimmed)) break;
          if (!trimmed) continue;
          if (trimmed.length >= 3 && !/\w/.test(trimmed)) continue;
          collected.push(trimmed.replace(/^[•\-*●▪◦–—]\s*/, ''));
        }
        if (collected.length > 0) return collected.slice(0, 20);
      }
    }

    const out = [];
    for (const edu of (cvData?.education || [])) {
      const line = [edu.degree, edu.institution, edu.dates]
        .map(v => String(v || '').trim()).filter(Boolean).join(', ');
      if (line) out.push(line);
    }
    for (const cert of (cvData?.certifications || [])) {
      const line = String(cert || '').trim();
      if (line) out.push(line);
    }
    return out;
  }

  buildStructuredTailoringPrompt(cvData, jdData, matchMap = [], { domainRisk = null, confirmedSkills = [] } = {}) {
    const skeleton = this.buildCvSkeleton(cvData, jdData);
    const supported = matchMap.filter(m => m.allowedToMention).map(m => m.requirement);
    const unsupported = matchMap.filter(m => !m.allowedToMention).map(m => m.requirement);
    const confirmed = this._uniqueDisplaySkills(confirmedSkills || []);
    const topKeywords = (jdData?.atsKeywords || []).slice(0, 15);
    const tailoringPlan = this.buildTailoringPlan(cvData, jdData, matchMap);
    const roleCredibilityGuidance = this._buildRoleCredibilityGuidance(jdData);
    const domainRiskGuidance = this._buildDomainRiskGuidance(domainRisk);
    const matchStrength = this.calcMatchStrength(matchMap);
    const confidenceInstruction = {
      strong:  'MATCH LEVEL: STRONG — the CV covers most requirements. Write with confidence, achievement-led language for supported claims.',
      moderate:'MATCH LEVEL: MODERATE — write confidently where supported; frame unsupported areas honestly as transferable experience.',
      weak:    'MATCH LEVEL: WEAK — focus on genuine transferable evidence. Do not overstate.',
      unknown: '',
    }[matchStrength.level] || '';

    const systemPrompt = `You are a professional CV tailoring engine. You return ONLY a single JSON object — no prose, no explanations, no markdown fences.

The candidate's CV structure (name, contact details, companies, employment dates, job titles, education, certifications) is LOCKED and rendered separately by the application. You never output any of it. You write only the mutable content.

OUTPUT SCHEMA — return exactly this shape:
{
  "summary": {"text":"3-4 sentence professional summary targeting the role","sourceIds":["..."]},
  "competencies": [ { "label": "Category name", "items": [{"text":"Skill or Tool","sourceIds":["..."]}] } ],
  "roles": [ { "id": "role_0", "focus": {"text":"one-line positioning","sourceIds":["..."]} or null, "bullets": [{"text":"...","sourceIds":["..."]}] } ]
}

STRICT RULES:
1. "roles" must contain exactly one entry per role id listed under ROLES, in the same order.
2. Summary, bullets, and focus must cite supporting SOURCE IDs. Bullets must be grounded in that role's ORIGINAL BULLETS — rephrase with JD vocabulary, reorder for relevance, tighten — but never invent achievements, metrics, employers, tools, or credentials. Uncited strings are rejected.
3. Never claim any UNSUPPORTED requirement.
4. Include every USER-CONFIRMED skill somewhere in competencies.
5. Competency items are short skill or tool names of 1-4 words ("Terraform", "Model registry"). NEVER requirement sentences or phrases like "IaC using Terraform", "deep experience building systems", or "X years of experience". Never list the same tool twice in different phrasings.
6. Use 3-6 competency categories with 3-8 items each. No item may repeat across categories.
7. "focus" is a single line (max 120 characters) positioning that role for the target job, or null for roles with no meaningful connection to it.
8. Keep each role's bullet count close to its original count (minimum 1, maximum 6). Never leave a role empty.
9. No section headers, dates, company names, or contact details anywhere in your output.
10. The output must be valid JSON: double quotes, no trailing commas, no comments.`;

    const rolesBlock = skeleton.roles.map(role => {
      const bullets = role.originalBullets.length
        ? role.originalBullets.map((b, i) => `    - [${(role.originalBulletEvidence[i]?.sourceIds || []).join(', ')}] ${b}`).join('\n')
        : '    (no bullets in original)';
      return `${role.id}: ${role.title || '(untitled)'} @ ${role.company || '(no company)'} (${role.dates || 'no dates'})\n  ORIGINAL BULLETS:\n${bullets}`;
    }).join('\n\n');

    const userPrompt = `TARGET ROLE
  Job title:  ${jdData?.jobTitle || 'Not specified'}
  Company:    ${jdData?.company || 'Not specified'}
  Seniority:  ${jdData?.seniority || 'Not specified'}
${confidenceInstruction ? `\n${confidenceInstruction}\n` : ''}
MATCH REPORT (${matchStrength.supportedCount}/${matchStrength.totalCount} requirements supported)
  Supported requirements (you MAY reference these):
${supported.length ? supported.map(s => `    ✓ ${s}`).join('\n') : '    (none)'}

  User-confirmed skills (include in competencies):
${confirmed.length ? confirmed.map(s => `    + ${s}`).join('\n') : '    (none)'}

  Unsupported requirements (do NOT claim these):
${unsupported.length ? unsupported.map(s => `    ✗ ${s}`).join('\n') : '    (none)'}
${topKeywords.length ? `\nATS KEYWORDS (weave into bullets only where truthful):\n${topKeywords.map(s => `  • ${s}`).join('\n')}\n` : ''}
TAILORING BLUEPRINT
  Target positioning: ${tailoringPlan.targetPositioning}
${roleCredibilityGuidance ? `\nROLE CREDIBILITY CHECK\n${roleCredibilityGuidance}\n` : ''}${domainRiskGuidance ? `\nDOMAIN REVIEW CHECK\n${domainRiskGuidance}\n` : ''}
ORIGINAL PROFESSIONAL SUMMARY (grounding for the new summary)
${String(cvData?.summary || '').trim() || '  (none)'}

ROLES (locked context — shown so you can ground bullets; never output these fields)
${rolesBlock}

Return the JSON object now.`;

    return { systemPrompt, userPrompt, temperature: 0.3, skeleton };
  }

  buildStructuredAuditPrompt(skeleton, content, matchMap = []) {
    const supported = matchMap.filter(m => m.allowedToMention).map(m => m.requirement);
    const unsupported = matchMap.filter(m => !m.allowedToMention).map(m => m.requirement);

    const systemPrompt = `You are a CV truthfulness auditor. You receive the candidate's original role bullets and a tailored-content JSON document. Remove or reword any claim that is not supported by the original bullets or the supported requirements. Do not add new claims, roles, or skills. Keep the exact same JSON shape and the same role ids. Return ONLY the corrected JSON object — no prose, no markdown fences.`;

    const rolesBlock = skeleton.roles.map(role => {
      const bullets = role.originalBullets.length
        ? role.originalBullets.map(b => `    - ${b}`).join('\n')
        : '    (no bullets in original)';
      return `${role.id}: ${role.title}\n  ORIGINAL BULLETS:\n${bullets}`;
    }).join('\n\n');

    const userPrompt = `SUPPORTED REQUIREMENTS (claims referencing these are allowed):
${supported.length ? supported.map(s => `  ✓ ${s}`).join('\n') : '  (none)'}

UNSUPPORTED REQUIREMENTS (claims referencing these must be removed):
${unsupported.length ? unsupported.map(s => `  ✗ ${s}`).join('\n') : '  (none)'}

ORIGINAL ROLE BULLETS (ground truth):
${rolesBlock}

TAILORED CONTENT TO AUDIT:
${JSON.stringify(content)}

Return the corrected JSON object now.`;

    return { systemPrompt, userPrompt, temperature: 0.1 };
  }

  // Defensive JSON extraction: models wrap JSON in fences or prose despite
  // instructions. Never trusted - the result always goes through
  // validateStructuredContent.
  parseStructuredContent(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return null;
    const unfenced = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/m, '');
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(unfenced.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // Deterministic validation of model-returned mutable content against the
  // locked skeleton. Returns a normalised content object, or null when the
  // output is unsalvageable (caller falls back to the legacy text path).
  validateStructuredContent(content, skeleton, { matchMap = [], confirmedSkills = [], cvData = {} } = {}) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
    if (!skeleton || !Array.isArray(skeleton.roles) || skeleton.roles.length === 0) return null;

    const groundingContext = buildGroundingContext(cvData, { confirmedFacts: confirmedSkills });
    const summaryClaim = typeof content.summary === 'object' && !Array.isArray(content.summary) ? content.summary : null;
    const summarySourceIds = Array.isArray(summaryClaim?.sourceIds) ? summaryClaim.sourceIds.filter(id => typeof id === 'string') : [];
    const acceptedSummary = String(summaryClaim?.text || '').split(/(?<=[.!?])\s+/)
      .map(sentence => this._clampInline(sentence, 600))
      .filter(sentence => sentence && isTextSupported(sentence, groundingContext, {
        sourceIds: summarySourceIds,
        requireSourceIds: true,
      }).supported)
      .join(' ');
    const originalSummarySentences = String(cvData?.summary || '').split(/(?<=[.!?])\s+/).map(sentence => this._clampInline(sentence, 600)).filter(Boolean).slice(0, 4);
    const acceptedSummarySentences = acceptedSummary.split(/(?<=[.!?])\s+/).filter(Boolean);
    const summaryFellBelowSourceShape = originalSummarySentences.length > 1 && acceptedSummarySentences.length < 2;
    const summary = summaryFellBelowSourceShape
      ? this._clampInline(originalSummarySentences.join(' '), 1200)
      : acceptedSummary;
    const summaryEvidence = summary
      ? summaryFellBelowSourceShape
        ? ['summary:0'].filter(id => groundingContext.sourceIndex[id])
        : summarySourceIds.filter(id => groundingContext.sourceIndex[id])
      : [];
    const competencies = this._normaliseStructuredCompetencies(content.competencies, { matchMap, confirmedSkills, cvData, groundingContext });

    const suppliedById = new Map();
    for (const role of (Array.isArray(content.roles) ? content.roles : [])) {
      if (role && typeof role === 'object' && typeof role.id === 'string') {
        suppliedById.set(role.id, role);
      }
    }

    const roles = skeleton.roles.map(skel => {
      const supplied = suppliedById.get(skel.id);
      const acceptedBullets = (Array.isArray(supplied?.bullets) ? supplied.bullets : [])
        .map(b => ({
          text: this._cleanStructuredBullet(typeof b === 'string' ? b : b?.text),
          sourceIds: Array.isArray(b?.sourceIds) ? b.sourceIds.filter(id => typeof id === 'string') : [],
        }))
        .map(item => ({
          ...item,
          support: isTextSupported(item.text, groundingContext, {
            allowedSourceIds: skel.allowedSourceIds,
            sourceIds: item.sourceIds,
            requireSourceIds: true,
          }),
        }))
        .filter(item => item.text && item.support.supported
          && item.support.validProposedSourceIds.length === item.sourceIds.length)
        .map(({ support, ...item }) => ({ ...item, sourceIds: support.validProposedSourceIds }))
        .filter(Boolean);
      let bullets = acceptedBullets.map(item => item.text);
      let bulletEvidence = acceptedBullets.map(item => ({ text: item.text, sourceIds: item.sourceIds }));
      bullets = this._dedupeSimilarBullets(bullets);
      // A role can never disappear: backfill from the original bullets when
      // the model dropped or shortchanged it.
      if (bullets.length === 0) {
        bullets = skel.originalBullets.slice(0, 6);
        bulletEvidence = bullets.map((text, index) => ({
          text,
          sourceIds: skel.originalBulletEvidence?.[index]?.sourceIds || [],
        }));
      } else if (skel.originalBullets.length >= 2 && bullets.length < 2) {
        for (const original of skel.originalBullets) {
          if (bullets.length >= 2) break;
          // Skip originals the model already covers - including rephrased
          // variants where one normalised form is a prefix of the other.
          const key = this._normaliseBulletForSimilarity(original);
          const covered = bullets.some(b => {
            const existing = this._normaliseBulletForSimilarity(b);
            return existing === key ||
              ((existing.startsWith(key) || key.startsWith(existing)) &&
               Math.min(existing.length, key.length) >= 25);
          });
          if (!covered) bullets.push(original);
        }
        bulletEvidence = bullets.map(text => bulletEvidence.find(item => item.text === text) || {
          text,
          sourceIds: skel.originalBulletEvidence?.[skel.originalBullets.indexOf(text)]?.sourceIds || [],
        });
      }
      bullets = bullets.slice(0, 6);
      bulletEvidence = bulletEvidence.slice(0, 6);

      const focusClaim = typeof supplied?.focus === 'string' ? { text: supplied.focus, sourceIds: [] } : supplied?.focus;
      let focus = this._clampInline(focusClaim?.text, 140);
      focus = focus ? focus.replace(/^focus\s*:\s*/i, '').trim() : '';
      const focusSourceIds = Array.isArray(focusClaim?.sourceIds) ? focusClaim.sourceIds.filter(id => typeof id === 'string') : [];
      const focusSupport = isTextSupported(focus, groundingContext, {
        allowedSourceIds: skel.allowedSourceIds,
        sourceIds: focusSourceIds,
        requireSourceIds: true,
      });
      if (focus && (!focusSupport.supported
        || focusSupport.validProposedSourceIds.length !== focusSourceIds.length)) focus = '';

      const focusEvidence = focus ? focusSupport.validProposedSourceIds : [];
      return { id: skel.id, focus: focus || null, focusEvidence, bullets, bulletEvidence };
    });

    if (!summary && roles.every(r => r.bullets.length === 0)) return null;
    const competencyEvidence = competencies.map(category => ({
      label: category.label,
      items: category.items.map(item => ({
        text: item,
        sourceIds: (groundingContext.records || [])
          .filter(record => !/\b(?:no|not|never|without|lack(?:s|ed|ing)?|\w+n['’]?t)\b/i.test(record.text)
            && this._normaliseText(record.text).includes(this._normaliseText(item)))
          .map(record => record.sourceId)
          .slice(0, 5),
      })),
    }));
    return { summary, summaryEvidence, competencies, competencyEvidence, roles };
  }

  _clampInline(value, maxLen) {
    if (value === null || value === undefined) return '';
    const text = String(value)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length <= maxLen) return text;
    const cut = text.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/, '');
  }

  _cleanStructuredBullet(bullet) {
    const text = this._clampInline(String(bullet || '').replace(/^[•\-*●▪◦–—]\s*/, ''), 320);
    if (!text || text.length < 8) return '';
    return text.replace(/[,\s]+$/, '');
  }

  _dedupeSimilarBullets(bullets = []) {
    const seen = new Set();
    const result = [];
    for (const bullet of bullets) {
      const key = this._normaliseBulletForSimilarity(bullet);
      if (!key || seen.has(key)) continue;
      const truncatedDuplicate = [...seen].some(existing =>
        (existing.startsWith(key) || key.startsWith(existing)) &&
        Math.min(existing.length, key.length) >= 30
      );
      if (truncatedDuplicate) continue;
      seen.add(key);
      result.push(bullet);
    }
    return result;
  }

  _normaliseStructuredCompetencies(raw, { confirmedSkills = [], groundingContext } = {}) {
    const PROSE_RE = /\b(using|with|within|experience|experienced|deep|strong|proficien\w*|expertise|knowledge|ability|abilities|years?|including|such as|hands.on)\b/i;
    const safeLabels = new Map([
      'Relevant Skills', 'Technical Skills', 'Professional Skills', 'Core Skills', 'Confirmed Skills',
      'Cloud', 'Cloud Platforms', 'Cloud & Infrastructure', 'Infrastructure as Code', 'DevOps & Delivery',
      'Programming', 'Programming & Automation', 'Software Engineering', 'Backend & APIs', 'Integration & APIs',
      'Data & Analytics', 'Databases & Data', 'Data Quality & Validation', 'AI & Machine Learning', 'Research & Methods',
      'Observability & Monitoring', 'Security', 'Customer Support', 'Customer Success', 'Stakeholder Engagement',
      'Pre-Sales Execution', 'Solution Architecture', 'Project Delivery', 'Leadership', 'Communication',
    ].map(label => [this._normaliseText(label), label]));
    const confirmed = this._uniqueDisplaySkills(confirmedSkills || []);
    const confirmedKeys = new Set(confirmed.map(s => this._normaliseText(s)));

    const categories = [];
    const globalKeys = new Set();
    for (const cat of (Array.isArray(raw) ? raw : [])) {
      const proposedLabel = this._clampInline(cat?.label, 48);
      if (!proposedLabel) continue;
      // Category labels are model-authored display text. Keep them within an
      // application-owned vocabulary so a model cannot smuggle an employer,
      // credential, instruction, or other unsupported claim into a heading.
      const label = safeLabels.get(this._normaliseText(proposedLabel)) || 'Relevant Skills';
      const items = [];
      for (const rawItem of (Array.isArray(cat?.items) ? cat.items : [])) {
        const claim = rawItem && typeof rawItem === 'object' ? rawItem : null;
        const item = this._clampInline(claim?.text, 48);
        if (!item) continue;
        if (PROSE_RE.test(item)) continue;
        if (item.split(/\s+/).length > 4) continue;
        const key = this._normaliseText(item);
        if (!key || globalKeys.has(key)) continue;
        const sourceIds = Array.isArray(claim?.sourceIds) ? claim.sourceIds.filter(id => typeof id === 'string') : [];
        if (!confirmedKeys.has(key) && !isTextSupported(item, groundingContext, {
          sourceIds,
          requireSourceIds: true,
        }).supported) continue;
        globalKeys.add(key);
        items.push(item);
      }
      const deduped = this._dedupeContainedSkillItems(items);
      if (deduped.length >= 1) {
        const existing = categories.find(category => category.label === label);
        if (existing) existing.items = this._dedupeContainedSkillItems([...existing.items, ...deduped]).slice(0, 8);
        else categories.push({ label, items: deduped.slice(0, 8) });
      }
      if (categories.length >= 6) break;
    }

    // Every user-confirmed skill must be present somewhere.
    const missingConfirmed = confirmed.filter(s => !globalKeys.has(this._normaliseText(s)));
    if (missingConfirmed.length > 0) {
      const target = categories.find(c => /additional|other|confirmed/i.test(c.label));
      if (target) target.items.push(...missingConfirmed);
      else categories.push({ label: 'Additional Skills', items: missingConfirmed });
    }

    return categories;
  }

  // Drop redundant longer variants of an already-listed skill: "IaC using
  // Terraform" collapses into "Terraform"; "reproducible training workflows"
  // collapses into "reproducible training". Two-word product names that
  // merely contain another token ("Azure DevOps" vs "Azure") are kept -
  // containment only removes items that are 3+ tokens or contain glue words,
  // i.e. phrase-shaped rather than name-shaped.
  _dedupeContainedSkillItems(items = []) {
    const GLUE = new Set(['using', 'with', 'in', 'for', 'of', 'and', 'on', 'to', 'via', 'across', 'the', 'a']);
    const entries = items.map(item => {
      const tokens = this._normaliseText(item).split(/\s+/).filter(Boolean);
      return { item, tokens };
    }).filter(e => e.tokens.length > 0);

    const sorted = [...entries].sort((a, b) => a.tokens.length - b.tokens.length);
    const kept = [];
    for (const entry of sorted) {
      const phraseShaped = entry.tokens.length >= 3 || entry.tokens.some(t => GLUE.has(t));
      const containsKept = kept.some(k =>
        k.tokens.length < entry.tokens.length &&
        k.tokens.every(tok => entry.tokens.includes(tok))
      );
      if (phraseShaped && containsKept) continue;
      kept.push(entry);
    }
    const keptItems = new Set(kept.map(k => k.item));
    return entries.map(e => e.item).filter(item => keptItems.has(item));
  }

  // Deterministic template: the ONLY producer of tailored CV text in
  // structured mode. Canonical Harvard shape, blank lines owned here, in
  // exactly the format the export renderer and validators expect.
  renderTailoredCV(skeleton, content) {
    const lines = [];
    if (skeleton.name) lines.push(skeleton.name);
    if (skeleton.headline) lines.push(skeleton.headline);
    for (const contact of (skeleton.contacts || [])) lines.push(contact);
    lines.push('');

    if (content.summary) {
      lines.push('PROFESSIONAL SUMMARY');
      lines.push(content.summary);
      lines.push('');
    }

    if (Array.isArray(content.competencies) && content.competencies.length > 0) {
      lines.push('CORE COMPETENCIES');
      for (const cat of content.competencies) {
        lines.push(`${cat.label}: ${cat.items.join(', ')}`);
      }
      lines.push('');
    }

    if (Array.isArray(skeleton.roles) && skeleton.roles.length > 0) {
      lines.push('PROFESSIONAL EXPERIENCE');
      const contentById = new Map((content.roles || []).map(r => [r.id, r]));
      for (const skel of skeleton.roles) {
        const role = contentById.get(skel.id);
        if (skel.company) lines.push(skel.company);
        if (skel.dates) lines.push(skel.dates);
        if (skel.title) lines.push(skel.title);
        if (role?.focus) lines.push(`Focus: ${role.focus}`);
        for (const bullet of (role?.bullets || [])) lines.push(`• ${bullet}`);
        lines.push('');
      }
    }

    if (Array.isArray(skeleton.projects) && skeleton.projects.length > 0) {
      lines.push('PROJECTS');
      for (const project of skeleton.projects) {
        lines.push(project.name);
        lines.push(project.url);
        for (const bullet of (project.originalBullets || project.bullets || [])) lines.push(`• ${bullet}`);
        if ((project.skills || []).length) lines.push(`Technologies: ${project.skills.join(', ')}`);
        lines.push('');
      }
    }

    if (Array.isArray(skeleton.educationLines) && skeleton.educationLines.length > 0) {
      lines.push('EDUCATION, CERTIFICATIONS & RECOGNITION');
      for (const edu of skeleton.educationLines) lines.push(`• ${edu}`);
    }

    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  }

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
    const scan = (titleKey) => {
      if (!titleKey) return -1;
      for (let i = Math.max(0, start); i < lines.length; i++) {
        const raw = String(lines[i] || '');
        const line = this._normaliseText(raw);
        if (!line) continue;
        if (line === titleKey) return i;
        if (line === this._normaliseText(`Position: ${titleKey}`)) return i;
        if (/^position\s+/.test(line) && line.includes(titleKey)) return i;
        if (line.startsWith(titleKey) && line.length <= titleKey.length + 80) return i;
        if (line.includes(titleKey) && line.length <= titleKey.length + 20) return i;
        // Composite pipe titles ("Cloud Support Engineer | Cloud Service SME"):
        // match when any pipe-separated segment equals the title exactly.
        if (raw.includes('|') && raw.split('|').some(seg => this._normaliseText(seg) === titleKey)) {
          return i;
        }
      }
      return -1;
    };

    const fullKey = this._normaliseText(title);
    const direct = scan(fullKey);
    if (direct !== -1) return direct;

    // Parsed title itself may be composite while the LLM rendered only the
    // primary segment — retry with the first pipe segment when substantial.
    if (String(title || '').includes('|')) {
      const primary = this._normaliseText(String(title).split('|')[0]);
      if (primary && primary.length >= 8 && primary !== fullKey) {
        return scan(primary);
      }
    }
    return -1;
  }

  // Whether `rawLine` represents `normalisedTarget` as an entry-boundary
  // marker - an exact match, a pipe-segment match (for composite "A | B"
  // lines like "Cloud Support Engineer | Cloud Service SME"), or a prefix
  // match at a genuine word boundary (for a preserved title the LLM appended
  // a suffix to, like "Senior Customer Success Engineer IC4" or "DevOps
  // Engineer - Transitioned from Senior Technical Support Engineer").
  // _findTitleLineIndex already tolerates all three shapes when locating a
  // role's OWN title; this centralises the same tolerance for detecting when
  // scanning has crossed INTO a different role, so every entry-boundary
  // detector agrees on what counts as a match - three independent exact-match
  // checks (_findTitleLineIndex, _findRoleEntryEnd, _findExperienceEntryEnd)
  // is exactly how a composite-pipe-title fix landed in only one of them,
  // silently breaking entry-boundary detection for composite-titled roles
  // in the other two (a later role's Focus/bullets get scooped into an
  // earlier role's window because the boundary between them was missed).
  _lineMatchesBoundaryValue(rawLine, normalisedTarget) {
    if (!normalisedTarget) return false;
    const line = this._normaliseText(rawLine);
    if (line === normalisedTarget) return true;
    if (String(rawLine || '').includes('|')) {
      return String(rawLine).split('|').some(seg => this._normaliseText(seg) === normalisedTarget);
    }
    if (line.startsWith(normalisedTarget)) {
      const rest = line.slice(normalisedTarget.length);
      if (!rest || /^[\s\-–—(:,]/.test(rest)) return true;
    }
    return false;
  }

  _findRoleEntryEnd(lines, titleIdx, titleKeys = new Set(), companyKeys = new Set(), currentCompanyKey = '') {
    for (let i = titleIdx + 1; i < lines.length; i++) {
      const trimmed = String(lines[i] || '').trim();
      if (!trimmed) continue;
      if (this._isLikelySectionHeader(trimmed)) return i;

      if (i > titleIdx + 1 && [...titleKeys].some(key => this._lineMatchesBoundaryValue(trimmed, key))) {
        return i;
      }
      // Titles alone miss the boundary when an intervening role's title also
      // carries an unrecognised suffix - a company line is a second, more
      // reliable signal that scanning has crossed into a different role.
      // Exclude this role's own company so a coincidental repeat within its
      // own block can never falsely truncate it.
      const isOtherCompany = [...companyKeys].some(key => key !== currentCompanyKey && this._lineMatchesBoundaryValue(trimmed, key));
      if (i > titleIdx + 1 && isOtherCompany) {
        return i;
      }
    }
    return lines.length;
  }

  _findExperienceEntryEnd(lines, exp = {}, titleIdx = 0, companyKeys = new Set()) {
    const currentCompanyKey = this._normaliseText(exp.company);

    for (let i = titleIdx + 1; i < lines.length; i++) {
      const trimmed = String(lines[i] || '').trim();
      if (!trimmed) continue;
      if (this._isLikelySectionHeader(trimmed)) return i;

      const isOtherCompany = [...companyKeys].some(key => key !== currentCompanyKey && this._lineMatchesBoundaryValue(trimmed, key));
      if (i > titleIdx + 1 && isOtherCompany) {
        return i;
      }
    }

    return lines.length;
  }

  _findLineIndexContaining(lines, value, start = 0, end = lines.length) {
    const key = this._normaliseText(value);
    if (!key) return -1;
    for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) {
      const line = this._normaliseText(lines[i]);
      if (!line) continue;
      if (line === key || line.includes(key)) return i;
    }
    return -1;
  }

  _rankExperienceBulletsForRole(bullets = [], jdData = {}, matchMap = []) {
    const targetText = this._normaliseText([
      jdData?.jobTitle,
      jdData?.targetPositioning,
      ...(jdData?.requiredSkills || []),
      ...(jdData?.tools || []),
      ...(jdData?.responsibilities || []),
      ...(jdData?.atsKeywords || []),
      ...(matchMap || []).filter(m => m.allowedToMention).map(m => m.requirement),
    ].join(' '));
    const targetTokens = new Set(
      targetText
        .split(/\s+/)
        .filter(tok => tok.length >= 4 && !this._noiseWords().has(tok))
    );

    return [...bullets].sort((a, b) => {
      const aScore = this._experienceBulletRelevanceScore(a, targetTokens);
      const bScore = this._experienceBulletRelevanceScore(b, targetTokens);
      return bScore - aScore || a.length - b.length;
    });
  }

  _experienceBulletRelevanceScore(bullet = '', targetTokens = new Set()) {
    const text = this._normaliseText(bullet);
    if (!text) return 0;

    let score = 0;
    for (const token of targetTokens) {
      if (text.includes(token)) score += 2;
    }
    if (/\b(production|incident|reliability|automation|python|cloud|aws|azure|gcp|kubernetes|docker|terraform|ci.?cd|pipeline|api|integration|engineering|sre|runbook|root cause|rca|monitoring|observability|deployment|customer|enterprise|stakeholder)\b/i.test(bullet)) {
      score += 5;
    }
    if (/\b(reduced|improved|increased|built|developed|led|designed|implemented|delivered|partnered|mentored|scaled|accelerated|strengthened|mitigated)\b/i.test(bullet)) {
      score += 3;
    }
    if (/\b(?:\d+%|\$[\d,]+|\d+x|\d+\+|\d{2,}\b)/i.test(bullet)) {
      score += 4;
    }
    return score;
  }

  _deriveExperienceDepthBullets(bullets = []) {
    const derived = [];
    const actionRe = /^(?:built|developed|designed|implemented|delivered|managed|led|supported|provided|reduced|improved|increased|automated|maintained|created|configured|deployed|monitored|troubleshot|partnered|collaborated|documented|became|contributed|strengthened|resolved|acted)\b/i;

    for (const bullet of bullets) {
      const source = String(bullet || '')
        .replace(/^[-•*●▪◦–—]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!source) continue;

      const includingMatch = source.match(/^(.+?),\s*including\s+(.+)$/i);
      if (includingMatch) {
        const base = includingMatch[1].replace(/[.;]\s*$/, '').trim();
        if (actionRe.test(base)) derived.push(base);
        derived.push(...this._deriveGroupedSupportBullets(includingMatch[2], 'Supported'));
      }

      const whileMatch = source.match(/^(.+?)\s+while\s+(.+)$/i);
      if (whileMatch) {
        const base = whileMatch[1].replace(/[.;]\s*$/, '').trim();
        if (actionRe.test(base)) derived.push(base);
        derived.push(...this._deriveGroupedSupportBullets(
          this._normaliseDerivedClause(whileMatch[2]),
          ''
        ));
      }

      const parts = source
        .split(/\s*(?:;|\.\s+|\s+\bwhile\b\s+)\s*/i)
        .map(part => part.trim())
        .filter(Boolean);

      if (parts.length < 2) continue;

      for (const part of parts) {
        const normalisedPart = this._normaliseDerivedClause(part);
        const words = normalisedPart.split(/\s+/).filter(Boolean);
        if (words.length < 6 || words.length > 34) continue;
        if (!actionRe.test(normalisedPart)) continue;
        derived.push(normalisedPart.replace(/[.;]\s*$/, ''));
      }
    }

    return this._uniqueDisplaySkills(derived);
  }

  _normaliseDerivedClause(clause = '') {
    const clean = String(clause || '').replace(/[.;]\s*$/, '').trim();
    if (!clean) return '';

    const replacements = [
      [/^contributing\s+to\b/i, 'Contributed to'],
      [/^supporting\b/i, 'Supported'],
      [/^building\b/i, 'Built'],
      [/^managing\b/i, 'Managed'],
      [/^developing\b/i, 'Developed'],
      [/^designing\b/i, 'Designed'],
      [/^implementing\b/i, 'Implemented'],
      [/^delivering\b/i, 'Delivered'],
      [/^documenting\b/i, 'Documented'],
      [/^maintaining\b/i, 'Maintained'],
      [/^configuring\b/i, 'Configured'],
      [/^troubleshooting\b/i, 'Troubleshot'],
    ];

    for (const [pattern, replacement] of replacements) {
      if (pattern.test(clean)) return clean.replace(pattern, replacement);
    }
    return clean;
  }

  _deriveGroupedSupportBullets(text = '', fallbackVerb = 'Supported') {
    const normalised = this._normaliseDerivedClause(text)
      .replace(/^including\s+/i, '')
      .replace(/[.;]\s*$/, '')
      .trim();
    if (!normalised) return [];

    const actionRe = /^(?:built|developed|designed|implemented|delivered|managed|led|supported|provided|reduced|improved|increased|automated|maintained|created|configured|deployed|monitored|troubleshot|partnered|collaborated|documented|became|contributed|strengthened|resolved|acted)\b/i;
    if (actionRe.test(normalised) && !/,/.test(normalised)) return [normalised];

    const verbMatch = normalised.match(/^([A-Z][a-z]+(?:ed|t|ed to)?\s+(?:to\s+)?)?(.*)$/);
    const prefix = actionRe.test(normalised)
      ? normalised.match(/^(?:Contributed to|Supported|Managed|Delivered|Documented|Developed|Built|Implemented|Provided)\s+/i)?.[0] || ''
      : fallbackVerb ? `${fallbackVerb} ` : '';
    const body = prefix && normalised.toLowerCase().startsWith(prefix.toLowerCase())
      ? normalised.slice(prefix.length)
      : (verbMatch?.[2] || normalised);
    const items = body
      .replace(/\s+and\s+/gi, ', ')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    if (items.length === 0) return [];
    if (items.length === 1) return [`${prefix}${items[0]}`.trim()];

    const grouped = [];
    for (let i = 0; i < items.length; i += 2) {
      const group = items.slice(i, i + 2);
      const phrase = group.length === 2 ? `${group[0]} and ${group[1]}` : group[0];
      grouped.push(`${prefix}${phrase}`.trim());
    }
    return grouped;
  }

  _looksLikeExperienceResponsibility(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/^[•●▪◦\-–—]/.test(t)) return true;
    if (t.split(/\s+/).length < 5) return false;
    return /^(?:built|developed|designed|implemented|delivered|managed|led|supported|provided|reduced|improved|increased|automated|maintained|created|configured|deployed|monitored|troubleshot|partnered|collaborated|documented|became|performed|owned|drove|coordinated|resolved|optimized|optimised)\b/i.test(t);
  }

  _looksLikeDateLine(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    const month = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
    return new RegExp(`\\b(?:${month}\\s+)?(?:19|20)\\d{2}\\b`, 'i').test(text) ||
      /\b(?:present|current)\b/i.test(text);
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

  _normaliseBulletForSimilarity(text) {
    return this._normaliseText(text)
      .replace(/[.!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _scoreExperienceBulletForTarget(text, jdData = {}, matchMap = []) {
    const raw = String(text || '').trim();
    const normalised = this._normaliseText(raw);
    if (!normalised) return 0;

    const targetPhrases = [
      jdData?.jobTitle,
      ...(jdData?.requiredSkills || []),
      ...(jdData?.preferredSkills || []),
      ...(jdData?.tools || []),
      ...(jdData?.atsKeywords || []),
      ...(jdData?.responsibilities || []),
      ...(matchMap || []).filter(m => m?.allowedToMention).map(m => m.requirement),
    ].flat().filter(Boolean);

    let score = 0;
    const targetTokens = new Set();
    for (const phrase of targetPhrases) {
      const phraseKey = this._normaliseText(phrase);
      if (phraseKey.length >= 4 && normalised.includes(phraseKey)) {
        score += phraseKey.includes(' ') ? 14 : 8;
      }
      for (const token of phraseKey.split(/\s+/)) {
        if (token.length >= 4) targetTokens.add(token);
      }
    }

    for (const token of targetTokens) {
      if (normalised.includes(token)) score += 2;
    }

    if (/\b\d+(?:[.,]\d+)?\s*(?:%|x|k|m|users?|customers?|teams?|systems?|services?|pipelines?|models?|hours?|days?|weeks?|months?|years?)\b/i.test(raw)) {
      score += 8;
    }
    if (/^(?:delivered|designed|built|implemented|improved|reduced|increased|automated|resolved|led|owned|managed|deployed|optimized|optimised|strengthened|accelerated)\b/i.test(raw)) {
      score += 4;
    }
    if (/\b(?:stakeholder|customer|production|enterprise|architecture|platform|reliability|automation|ci\/cd|kubernetes|docker|aws|azure|gcp|python|observability|security)\b/i.test(raw)) {
      score += 3;
    }
    if (/\b(?:responsible for|worked on|helped with|involved in)\b/i.test(raw)) {
      score -= 2;
    }
    if (raw.length > 220) score -= 3;

    return score;
  }

  _escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _isHeaderContactLine(line) {
    return /[\w.+-]+@[\w-]+\.\w+/.test(line)
      || /https?:\/\//i.test(line)
      // Bare domain + path with no protocol, e.g. "linkedin.com/in/jordantaylor"
      // or "github.com/jordantaylor" - common when contact info is pasted
      // without the https:// prefix. Anchored to the WHOLE line (not just a
      // substring match) so ordinary prose that happens to reference a repo
      // URL mid-sentence ("...hosted at github.com/x for anyone who wanted
      // to review it") isn't mistaken for a standalone contact line - a real
      // contact line is essentially just the URL, nothing else.
      || /^(?:linkedin|github|gitlab|portfolio)\.[a-z]{2,}\/\S+$/i.test(line)
      || /^(linkedin|github|website|portfolio|personal\s+website|personal\s+site)$/i.test(line)
      || /(?:\+\d[\d\s\-.()]{5,}|\b\d{3,5}[\s\-.]\d{3,5}[\s\-.]\d{3,6}\b)/.test(line);
  }

  _isLikelyLocationLine(line) {
    return line.length <= 80
      && /,/.test(line)
      && /\b(uk|united kingdom|usa|united states|belgium|canada|germany|france|ireland|netherlands|remote)\b/i.test(line)
      && !/\b(engineer|developer|manager|architect|support|mlops|devops|sre|data|platform)\b/i.test(line);
  }

  _isParserArtefact(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (this._isLocationDateParserArtefact(t)) return true;
    if (/[.!?]$/.test(t)) return true;
    if (/^(and|or|with|for|to|in|of|at|by|from|that|which|who|when|where)\s+/i.test(t) && /^[a-z]/.test(t)) return true;
    if (/^[a-z]/.test(t) && !/[A-Z]/.test(t.slice(1)) && t.split(/\s+/).length >= 2) return true;
    return false;
  }

  _isLocationDateParserArtefact(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 60) return false;
    const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
    const countryOrLocation = '(?:UK|United Kingdom|England|Scotland|Wales|Ireland|Nigeria|USA|United States|Canada|Germany|France|Remote|London|Birmingham|Manchester|Lagos|Abuja)';
    const gluedCountryMonth = new RegExp(`^${countryOrLocation}\\s*${month}\\b`, 'i');
    const anyGluedCountryMonth = new RegExp(`\\b${countryOrLocation}${month}\\b`, 'i');
    const locationCountryMonth = new RegExp(`\\b${countryOrLocation}\\b\\s*,?\\s*\\b${countryOrLocation}\\s*${month}\\b`, 'i');
    const commaLocationMonth = new RegExp(`,\\s*\\b${countryOrLocation}\\s*${month}\\b`, 'i');
    return gluedCountryMonth.test(t) || anyGluedCountryMonth.test(t) || locationCountryMonth.test(t) || commaLocationMonth.test(t);
  }

  _isLikelySectionHeader(line) {
    // Section-boundary functions (mergeDuplicateSkillCategoryLines,
    // ensureExperienceDepth, etc.) rely on this to detect leaving the skills
    // section - the generation prompt dictates "PROFESSIONAL EXPERIENCE"
    // exactly, but real/uploaded CVs and LLM output vary ("Experience",
    // "Employment History", "Work History"). Missing a variant here silently
    // keeps section-scoped logic active past the section it should stop at.
    const trimmed = String(line || '').trim();
    if (/^(professional\s+summary|core\s+competenc(?:y|ies)|(?:professional\s+)?experience|employment(?:\s+history)?|work\s+history|technical\s+skills?|education|certifications?\s*(?:&|and)\s*awards?|technical\s+leadership|achievements?|projects?)\s*[:\-]?$/i
      .test(trimmed)) {
      return true;
    }
    // The anchored list above only matches bare section names, but real CVs
    // routinely combine several into one heading ("EDUCATION, CERTIFICATIONS
    // & RECOGNITION", "TECHNICAL LEADERSHIP, ACHIEVEMENTS & INNOVATION").
    // Rather than enumerate every combination, fall back to an ALL-CAPS
    // multi-word heuristic (mirroring cv-export.js's renderer-side check) -
    // without it, an unrecognised compound header is invisible to
    // entry-boundary detection, so the last experience entry's window never
    // closes and silently swallows everything after it, including the next
    // section's own content. Require multiple words so a single all-caps
    // company acronym on its own line (IBM, SAP, NASA) is never mistaken for
    // a section boundary - real section headers are always multi-word.
    // "/" is allowed ("EDUCATION / CERTIFICATIONS") - digits, @ and + still
    // disqualify a line, since those indicate dates/contacts, not headings.
    if (
      trimmed.length >= 3 &&
      /\s/.test(trimmed) &&
      trimmed === trimmed.toUpperCase() &&
      /[A-Z]/.test(trimmed) &&
      !/[@+\d]/.test(trimmed)
    ) {
      return true;
    }
    return false;
  }

  _isSkillsSectionHeader(line) {
    return /^(core\s+competenc(?:y|ies)|technical\s+skills?|skills|technologies|tools|expertise)\s*[:\-]?$/i
      .test(String(line || '').trim());
  }

  _normaliseSkillSectionLines(sectionLines, matchMap = [], confirmedSkills = [], jdData = {}) {
    const rawItems = [];
    for (const line of this._joinWrappedSkillSectionLines(sectionLines)) {
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

    const unique = this._dedupeContainedSkillItems(
      this._uniqueDisplaySkills(compactItems)
        .filter(item => !this._isJdRequirementProse(item))
        .filter(item => !this._isRequirementFragment(item))
    );

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
      .replace(/\bbusiness\s+communication\s+skills\b/gi, 'Stakeholder Communication')
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
    const enrichedJd = this.roleProfiles.enrichJDData(jdData || {});
    // When the LLM has provided skill categories for this specific role, use them.
    // Require ≥ 4 LLM categories AND ≥ 4 populated result lines — otherwise the LLM
    // analysis was too narrow (e.g. only 3 generic categories) and domain buckets
    // produce better coverage.
    if (Array.isArray(enrichedJd.skillCategories) && enrichedJd.skillCategories.length >= 4) {
      const llmLines = this._buildGroupedSkillsFromLLMCategories(items, enrichedJd.skillCategories);
      if (llmLines.length >= 4) return llmLines;
    }

    const domain = enrichedJd.domain || this._detectDomain(enrichedJd);
    const isSolutionEngineering = domain === 'solution_engineering';
    const buckets = isSolutionEngineering ? [
      { label: 'Pre-Sales & Solution Engineering', terms: ['POC', 'POV', 'proof of concept', 'proof of value', 'technical demo', 'demo', 'RFP', 'RFI', 'solution selling', 'technical selling', 'pre-sales', 'value engineering', 'business value', 'MEDDPICC', 'MEDDICC', 'MEDDIC', 'solution consulting', 'enterprise SaaS sales'] },
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
      { label: 'MLOps & ML Lifecycle', terms: ['MLOps', 'MLflow', 'DVC', 'model registry', 'experiment tracking', 'artifact versioning', 'TensorFlow', 'PyTorch', 'Scikit-learn', 'Keras', 'XGBoost', 'LightGBM', 'NumPy', 'Pandas', 'Hugging Face', 'WandB', 'Optuna', 'Ray', 'ONNX'] },
      { label: 'Data Processing & Streaming', terms: ['Apache Kafka', 'Kafka', 'Apache Spark', 'Spark', 'Apache Hadoop', 'Hadoop', 'Apache Flink', 'Flink', 'Apache Hive', 'Hive', 'Apache Beam', 'Beam', 'dbt', 'Airflow', 'Dagster', 'Delta Lake', 'Apache Iceberg', 'Presto', 'Trino', 'HBase'] },
      { label: 'Model Serving & Infrastructure', terms: ['KServe', 'SageMaker', 'BentoML', 'Docker', 'Kubernetes', 'K8s', 'Kubeflow Pipelines', 'container orchestration', 'NGINX', 'API Gateway', 'NoSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'PostgreSQL'] },
      { label: 'CI/CD & Delivery', terms: ['GitHub Actions', 'GitLab CI', 'Jenkins', 'CircleCI', 'Azure DevOps', 'ArgoCD', 'Argo Workflows', 'Prefect', 'DevOps', 'Release Governance', 'Change Management'] },
      { label: 'Observability & Reliability', terms: ['Prometheus', 'Grafana', 'logging', 'log analysis', 'distributed tracing', 'incident response', 'RCA', 'runbooks', 'on-call', 'monitoring', 'performance tuning', 'diagnostics', 'alerting'] },
      { label: 'Leadership & Stakeholder Management', terms: ['people management', 'technical mentorship', 'technical hiring', 'stakeholder management', 'sales partnership', 'engineering leadership', 'technical lead', 'team leadership', 'customer-facing technical leadership'] },
    ];

    const itemKeys = new Map(this._uniqueDisplaySkills(items).map(item => [this._normaliseText(item), item]));
    const jdText = this._normaliseText([
      enrichedJd.jobTitle,
      ...(enrichedJd.requiredSkills || []),
      ...(enrichedJd.preferredSkills || []),
      ...(enrichedJd.tools || []),
      ...(enrichedJd.responsibilities || []),
      ...(enrichedJd.atsKeywords || []),
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

    // Any skills not placed in a named bucket (e.g. niche confirmed tools) must not be dropped.
    const remaining = [];
    for (const [key, item] of itemKeys) {
      if (!used.has(key)) remaining.push(item);
    }
    const cleanedRemaining = this._uniqueDisplaySkills(remaining).slice(0, 10);
    if (cleanedRemaining.length > 0) {
      lines.push(`Additional Technical Skills: ${cleanedRemaining.join(', ')}`);
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
      'Cloud & Platform Engineering': /\b(gcp|google cloud|vertex|aws|azure|cloud|platform|infrastructure|reliability|enablement|performance.tun|diagnostic|terraform|pulumi|iac|nosql|mongodb|redis|cassandra|elasticsearch|nginx|api.?gateway|load.?balanc|postgre|mysql)\b/,
      'Programming & Automation': /\b(python|golang|go|bash|powershell|automation|scripting|fastapi|flask|git|version.?control)\b/,
      'MLOps & ML Lifecycle': /\b(mlops|mlflow|dvc|model registry|experiment|artifact|training workflow|tensorflow|pytorch|scikit|keras|xgboost|lightgbm|numpy|pandas|hugging.?face|onnx|wandb|optuna|ray)\b/,
      'Data Processing & Streaming': /\b(kafka|spark|hadoop|flink|hive|hudi|beam|airflow|dagster|dbt|delta.?lake|iceberg|presto|trino|hbase|storm|samza)\b/,
      'Model Serving & Infrastructure': /\b(kserve|sagemaker|bentoml|docker|kubernetes|k8s|kubeflow|serving|container)\b/,
      'CI/CD & Delivery': /\b(ci.?cd|github actions|gitlab|jenkins|circleci|azure devops|argocd|argo|prefect|delivery|devops|release|change management|governance|compliance)\b/,
      'CI/CD & DevOps': /\b(ci.?cd|github actions|gitlab|jenkins|circleci|azure devops|buildkite|pipeline|deployment|devops|release)\b/,
      'Observability & Reliability': /\b(prometheus|grafana|log|tracing|incident|rca|runbook|on.?call|observability|monitoring|performance|diagnostic|alert)\b/,
      'Leadership & Stakeholder Management': /\b(people management|mentorship|hiring|stakeholder|sales|leadership|technical lead|customer.?facing|team|travel|executive|communication|change management)\b/,
      'Pre-Sales & Solution Engineering': /\b(poc|pov|proof of concept|proof of value|demo|rfp|rfi|pre.?sales|value engineering|solution selling|technical selling|business value|champion|meddpicc|meddicc|meddic|solution consult|enterprise.?saas.?sales)\b/,
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
      if (/\b(?:no|not|never|without|lack(?:s|ed|ing)?|do(?:es)?n t)\b/i.test(lower)) continue;

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

  /** Find evidence through controlled synonym/equivalence groups. */
  _findSemanticEvidence(requirement, cvSources) {
    const aliases = this._semanticAliasesForRequirement(requirement);
    if (aliases.length === 0) return [];

    const evidence = [];
    for (const source of cvSources) {
      if (!source) continue;
      const lower = this._normaliseText(source);
      if (aliases.some(alias => lower.includes(this._normaliseText(alias)))) {
        evidence.push(source.trim().slice(0, 150));
      }
    }
    return [...new Set(evidence)].slice(0, 5);
  }

  _semanticTokenSupported(token, source) {
    const aliases = this._semanticAliasesForRequirement(token);
    if (aliases.length === 0) return false;
    const lower = this._normaliseText(source);
    return aliases.some(alias => lower.includes(this._normaliseText(alias)));
  }

  _semanticAliasesForRequirement(requirement) {
    const req = this._normaliseText(requirement);
    if (!req) return [];

    const matches = [];
    for (const group of _semanticConceptGroups) {
      const normalised = group.map(item => this._normaliseText(item));
      if (normalised.some(item => req === item || req.includes(item) || item.includes(req))) {
        matches.push(...group);
      }
    }
    return [...new Set(matches)].filter(alias => this._normaliseText(alias) !== req);
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
