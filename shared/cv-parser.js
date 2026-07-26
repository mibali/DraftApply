const CANONICAL_SECTION_HEADINGS = new Set([
  'PROFESSIONAL EXPERIENCE', 'WORK EXPERIENCE', 'EXPERIENCE', 'EMPLOYMENT', 'EMPLOYMENT HISTORY', 'CAREER HISTORY', 'WORK HISTORY',
  'PROFESSIONAL SUMMARY', 'SUMMARY', 'PROFILE', 'ABOUT', 'OBJECTIVE',
  'CORE COMPETENCY', 'CORE COMPETENCIES', 'CORE SKILLS', 'TECHNICAL SKILLS', 'SKILLS', 'TECHNOLOGIES', 'EXPERTISE',
  'PROJECT', 'PROJECTS', 'EDUCATION', 'ACADEMIC', 'QUALIFICATIONS', 'CERTIFICATION', 'CERTIFICATIONS',
  'EDUCATION / CERTIFICATIONS', 'EDUCATION, CERTIFICATIONS & RECOGNITION', 'CERTIFICATIONS & AWARDS',
  'ACHIEVEMENTS', 'AWARDS', 'PUBLICATIONS', 'LANGUAGES', 'INTERESTS', 'REFERENCES', 'TECHNICAL LEADERSHIP',
]);

/**
 * CV Parser Module
 * 
 * Extracts structured data from CV text. This module is designed to be
 * reusable across web app and browser extension contexts.
 * 
 * DESIGN DECISION: We parse CV into structured sections to enable:
 * 1. Targeted retrieval for specific question types
 * 2. Better context window management when constructing prompts
 * 3. Validation that we're not hallucinating facts
 */

export class CVParser {
  constructor() {
    this.rawText = '';
    this.structured = null;
  }

  /**
   * Parse CV text into structured sections
   * @param {string} text - Raw CV text content
   * @returns {Object} Structured CV data
   */
  parse(text) {
    const normalizedText = this._stripAutoLinksTrailer(this._normaliseExtractionSpacing(
      this._insertMissingSpaceBeforeMonths(this._normaliseSpacedHeadings(text))
    ));
    this.rawText = normalizedText;
    const experience = this.extractExperience(normalizedText);
    const summary = this.extractSummary(normalizedText);
    const education = this.extractEducation(normalizedText);
    const skills = this.extractSkills(normalizedText);
    const skillCategories = this.extractSkillCategories(normalizedText);
    const achievements = this.extractAchievements(normalizedText, experience);
    const certifications = this.extractCertifications(normalizedText);
    const projects = this.extractProjects(normalizedText);
    const { sourceIndex, evidenceIndex } = this._indexSources({
      experience, summary, education, skills, achievements, certifications, projects,
    });

    this.structured = {
      contactInfo: this.extractContactInfo(normalizedText),
      summary,
      experience,
      education,
      skills,
      skillCategories,
      achievements,
      certifications,
      projects,
      sourceIndex,
      evidenceIndex,
      rawText: normalizedText
    };

    return this.structured;
  }

  // CV upload appends a trailing "Links:\n<url>\n<url>..." block collecting
  // every hyperlink annotation found anywhere in the source PDF/DOCX -
  // including reference links inside body bullets (a blog post, a book, a
  // conference page), not just the candidate's own profile links. Left in
  // the text, it gets swallowed whole into whatever section happens to
  // precede it (usually Education, since PDF extraction appends it after
  // the last page's content) and poisons contact-field regex matching.
  // The same links remain available separately via the upload API's
  // linkAnnotations field, so this block is pure noise once removed - only
  // stripped when every line after "Links:" is a bare URL, so a real
  // human-authored "Links" section (with descriptive text) is left alone.
  _stripAutoLinksTrailer(text) {
    const raw = String(text || '');
    const match = raw.match(/\n{1,3}Links:[ \t]*\n([\s\S]*)$/i);
    if (!match) return raw;
    const trailerLines = match[1].split('\n').map(line => line.trim()).filter(Boolean);
    if (trailerLines.length === 0 || !trailerLines.every(line => /^https?:\/\/\S+$/i.test(line))) return raw;
    return raw.slice(0, match.index).replace(/\s+$/, '');
  }

  _normaliseExtractionSpacing(text) {
    // PDF extraction can insert whitespace after a visible hyphen when a
    // hyphenated word wraps across text boxes ("customer- facing"). Restore
    // the single lexical token without changing spaced dashes or date ranges.
    return String(text || '').replace(/\b([A-Za-z]{2,})-\s+([a-z]{2,})\b/g, '$1-$2');
  }

  /**
   * Add stable provenance alongside the legacy experience string fields.
   * Positional IDs are deterministic for the same parsed CV and deliberately
   * avoid using mutable/display text as identity.
   */
  _indexSources({ experience = [], summary = '', education = [], skills = [], achievements = [], certifications = [], projects = [] } = {}) {
    const sourceIndex = {};
    const evidenceIndex = [];

    experience.forEach((role, roleIndex) => {
      const roleSourceId = `experience:${roleIndex}`;
      role.sourceId = roleSourceId;
      role.responsibilityEvidence = (role.responsibilities || []).map((text, responsibilityIndex) => {
        const sourceId = `${roleSourceId}:responsibility:${responsibilityIndex}`;
        const record = {
          sourceId,
          roleSourceId,
          type: 'experience_responsibility',
          roleIndex,
          responsibilityIndex,
          text,
          company: role.company || '',
          title: role.title || '',
          dates: role.dates || '',
        };
        sourceIndex[sourceId] = record;
        evidenceIndex.push(record);
        return record;
      });
      sourceIndex[roleSourceId] = {
        sourceId: roleSourceId,
        type: 'experience_role',
        roleIndex,
        title: role.title,
        company: role.company,
        dates: role.dates,
      };
    });

    const add = (type, text, index = 0) => {
      if (text && typeof text === 'object') {
        text = Object.values(text).filter(value => typeof value === 'string' && value.trim()).join(' | ');
      }
      if (!String(text || '').trim()) return;
      const sourceId = `${type}:${index}`;
      const record = { sourceId, type, text: String(text).trim() };
      sourceIndex[sourceId] = record;
      evidenceIndex.push(record);
    };
    add('summary', summary);
    for (const [type, values] of Object.entries({ education, skill: skills, achievement: achievements, certification: certifications })) {
      (values || []).forEach((value, index) => add(type, value, index));
    }
    projects.forEach((project, projectIndex) => {
      const projectSourceId = `project:${projectIndex}`;
      project.sourceId = projectSourceId;
      const identity = { sourceId: projectSourceId, type: 'project', projectIndex, text: `${project.name} ${project.url}`.trim(), name: project.name, url: project.url };
      sourceIndex[projectSourceId] = identity;
      project.bulletEvidence = project.bullets.map((text, index) => {
        const record = { sourceId: `${projectSourceId}:bullet:${index}`, projectSourceId, type: 'project_bullet', projectIndex, bulletIndex: index, text, name: project.name, url: project.url };
        sourceIndex[record.sourceId] = record; evidenceIndex.push(record); return record;
      });
      project.skillEvidence = project.skills.map((text, index) => {
        const record = { sourceId: `${projectSourceId}:skill:${index}`, projectSourceId, type: 'project_skill', projectIndex, skillIndex: index, text, name: project.name, url: project.url };
        sourceIndex[record.sourceId] = record; evidenceIndex.push(record); return record;
      });
    });

    return { sourceIndex, evidenceIndex };
  }

  // PDF/DOCX text extraction sometimes squishes a location directly against
  // a following date with no space (e.g. "Birmingham, UKSep 2021 - Present"),
  // because the two were visually separated (different columns/alignment) in
  // the original document but have no whitespace between them once
  // flattened to plain text. Without a space, date-detection regexes'
  // word-boundary requirement fails to recognize the month (no \b between
  // two letters), so the whole garbled string gets misclassified as a
  // company/job-title/institution field instead of being split into its
  // real location and date parts. Idempotent: already-spaced text is
  // untouched since the pattern requires no space between the letter and
  // the month name.
  _insertMissingSpaceBeforeMonths(text) {
    const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
    return String(text || '').replace(
      new RegExp(`([a-zA-Z])(${month}\\.?\\s+(?:19|20)\\d{2})`, 'g'),
      '$1 $2'
    );
  }

  _normaliseSpacedHeadings(text) {
    return String(text || '').split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed.split(/\s+/).every(token => /^[A-Za-z]$/.test(token))) return line;
      const compact = trimmed.replace(/\s+/g, '').toUpperCase();
      const heading = [...CANONICAL_SECTION_HEADINGS].find(value => /^[A-Z ]+$/.test(value) && value.replace(/\s/g, '') === compact);
      return heading ? line.replace(trimmed, heading) : line;
    }).join('\n');
  }

  extractContactInfo(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    // Profile links (LinkedIn/GitHub/website/portfolio) live in the header.
    // Matching them against the whole document lets an unrelated reference
    // link deep in the body - a company's GitHub org mentioned in a bullet,
    // a book URL in an achievements section - get misattributed as the
    // candidate's own profile. Email/phone stay whole-document: those
    // patterns don't have that false-positive risk.
    const firstSectionIdx = lines.findIndex((line, i) => i > 0 && this._isExactSectionHeading(line));
    const headerText = lines.slice(0, firstSectionIdx === -1 ? 20 : Math.min(firstSectionIdx, 20)).join('\n');
    const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
    const phoneMatch = text.match(/(?:^|[^\d])((?:\+\d[\d\s().-]{7,18}\d)|(?:\+?\d{10,15})|(?:\(?\d{2,4}\)?[\s.-])\d{3,4}[\s.-]\d{3,4})(?!\d)/m);
    const linkedinMatch = headerText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[\w%-]+(?:\/[\w%-]+){0,3}\/?/i);
    const githubMatch = headerText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i);
    const websiteMatch = headerText.match(/\b(?:https?:\/\/|www\.)(?!(?:www\.)?(?:linkedin|github|twitter|x)\.com\b)[\w.-]+\.[a-z]{2,}(?:\/[\w./-]*)?/i);
    const twitterMatch = headerText.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[\w-]+\/?/i);
    const portfolioMatch = headerText.match(/(?:portfolio|behance\.net|dribbble\.com|kaggle\.com)[:\s]*(?:https?:\/\/)?[\w./-]+/i);

    return {
      name: this._findContactName(lines),
      email: emailMatch?.[0] || '',
      phone: phoneMatch?.[1]?.trim() || '',
      linkedin: linkedinMatch?.[0] || '',
      github: githubMatch?.[0] || '',
      website: websiteMatch?.[0] || '',
      twitter: twitterMatch?.[0] || '',
      portfolio: portfolioMatch?.[0] || ''
    };
  }

  _findContactName(lines) {
    const contactIndexes = lines.map((line, i) => /@|(?:linkedin|github)\.com|(?:\+?\d[\d ().-]{7,}\d)/i.test(line) ? i : -1).filter(i => i >= 0);
    const center = contactIndexes[0] ?? 0;
    const candidates = lines.map((line, i) => ({ line, i })).filter(({ line, i }) => Math.abs(i - center) <= 5 && i <= 14 &&
      line.length >= 3 && line.length <= 60 && /^[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){1,3}$/.test(line) &&
      !this._isExactSectionHeading(line) && !/https?:|www\.|@|\d|\b(engineer|architect|manager|developer|consultant|analyst|specialist|director|lead)\b/i.test(line));
    return candidates.sort((a, b) => Math.abs(a.i - center) - Math.abs(b.i - center))[0]?.line || '';
  }

  extractSummary(text) {
    const explicit = this._extractExactSection(text, ['PROFESSIONAL SUMMARY', 'SUMMARY', 'PROFILE']);
    if (explicit) return explicit.trim();

    const prose = [];
    for (const line of String(text || '').split('\n').map(value => value.trim()).filter(Boolean)) {
      if (this._isExactSectionHeading(line) || this._isLetterSpacedDisplayLine(line)
        || this._isContactLine(line) || /(?:\+?\d[\d ().-]{7,}\d)/i.test(line)
        || /^[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,3}$/.test(line)) break;
      if (line.split(/\s+/).length < 5) break;
      prose.push(line);
    }
    const joined = prose.join(' ').replace(/\s+/g, ' ').trim();
    return joined.length >= 50 && /[.!?]/.test(joined) ? joined : '';
  }

  extractExperience(text) {
    const experiences = [];
    
    // Match experience section
    const expSection = this._extractExactSection(text, ['PROFESSIONAL EXPERIENCE', 'WORK EXPERIENCE', 'EXPERIENCE', 'EMPLOYMENT', 'EMPLOYMENT HISTORY', 'WORK HISTORY']);
    
    if (expSection) {
      const expText = expSection;

      const trailing = this._parseTrailingDateExperience(expText);
      if (trailing !== null) return trailing;

      const lines = expText
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .filter(l => !this._isDecorativeLine(l));

      let currentExp = null;
      let headerBuffer = [];

      const pushCurrent = () => {
        if (!currentExp) return;
        currentExp.company = this._cleanExperienceHeader(currentExp.company);
        currentExp.title = this._cleanExperienceHeader(currentExp.title);
        currentExp.dates = this._extractDateRange(currentExp.dates) || currentExp.dates;
        if (currentExp.company || currentExp.title || currentExp.responsibilities.length > 0) {
          experiences.push(currentExp);
        }
        currentExp = null;
      };

      const startEntry = (entry) => {
        pushCurrent();
        currentExp = {
          company: entry.company || '',
          title: entry.title || '',
          dates: entry.dates || '',
          responsibilities: [],
        };
        headerBuffer = [];
      };

      for (const rawLine of lines) {
        const line = rawLine.trim();
        const bullet = this._cleanBullet(line);

        if (bullet) {
          if (currentExp) currentExp.responsibilities.push(bullet);
          headerBuffer = [];
          continue;
        }

        // Hard-wrapped PDF extraction leaves a bullet's continuation on its
        // own unbulleted line ("...and production" / "monitoring."). Rejoin
        // it here; dropping it truncates the bullet mid-phrase. A capitalised
        // continuation ("Product teams.") only joins when the previous line
        // visibly dangles on a conjunction/preposition.
        const previousBullet = currentExp?.responsibilities.at(-1) || '';
        if (
          previousBullet &&
          /[a-z0-9,\-]$/i.test(previousBullet) && !/[.!?:;]$/.test(previousBullet) &&
          (/^[a-z]/.test(line) ||
            (/\b(?:and|or|with|of|to|for|across|including|by|from|the|a|an)$/i.test(previousBullet) && /^[A-Z][a-z]/.test(line)))
        ) {
          currentExp.responsibilities[currentExp.responsibilities.length - 1] = `${previousBullet} ${line}`;
          headerBuffer = [];
          continue;
        }

        const inlineEntry = this._parseExperienceHeader(line);
        if (inlineEntry) {
          startEntry(inlineEntry);
          continue;
        }

        const dates = this._extractDateRange(line);
        if (dates) {
          const entry = this._entryFromBufferedHeader(headerBuffer, dates);
          startEntry(entry);
          continue;
        }

        // A location parsed into the title slot ("UK (Remote)") must not
        // block the real job title on the following line.
        if (currentExp && (!currentExp.title || this._isLikelyLocationText(currentExp.title))
            && this._isLikelyJobTitle(line) && !this._isLikelySentenceFragment(line)) {
          if (currentExp.title) currentExp.company = [currentExp.company, currentExp.title].filter(Boolean).join(' — ');
          currentExp.title = line;
          continue;
        }

        if (currentExp && this._looksLikeResponsibility(line)) {
          currentExp.responsibilities.push(line);
          continue;
        }

        if (!this._isLikelyNoiseExperienceLine(line) && !this._isLikelySentenceFragment(line)) {
          headerBuffer.push(line);
          headerBuffer = headerBuffer.slice(-3);
        }
      }

      pushCurrent();
    }
    
    return experiences;
  }

  extractEducation(text) {
    const education = [];
    
    const eduSection = text.match(/(?:education|academic|qualifications)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|skills|certifications|projects|$))/i);
    
    if (eduSection) {
      const eduText = eduSection[1];
      const lines = eduText.split('\n').filter(l => l.trim());
      
      let currentEdu = null;
      
      for (const line of lines) {
        if (line.match(/university|college|school|institute|bachelor|master|phd|degree/i)) {
          if (currentEdu) education.push(currentEdu);
          currentEdu = {
            institution: line.trim(),
            degree: '',
            dates: ''
          };
        } else if (currentEdu) {
          if (line.match(/\d{4}/)) {
            currentEdu.dates = line.trim();
          } else if (!currentEdu.degree) {
            currentEdu.degree = line.trim();
          }
        }
      }
      if (currentEdu) education.push(currentEdu);
    }
    
    return education;
  }

  extractSkills(text) {
    // Lookahead: stop at next section header OR end-of-string.
    // The $ is placed outside the \n\s* group so that end-of-string is matched
    // without requiring a trailing newline (common in uploaded CV files).
    const exactSkillHeadings = ['CORE COMPETENCY', 'CORE COMPETENCIES', 'TECHNICAL SKILLS', 'SKILLS', 'TECHNOLOGIES', 'EXPERTISE'];
    const wantedSkillHeadings = new Set(exactSkillHeadings);
    const hasExactSkillsSection = String(text || '').split('\n')
      .some(line => wantedSkillHeadings.has(line.trim().replace(/:$/, '').trim().toUpperCase()));
    const exactSkillsSection = hasExactSkillsSection ? this._extractExactSection(text, exactSkillHeadings) : '';
    const skillsSection = hasExactSkillsSection
      ? [null, exactSkillsSection]
      : text.match(/(?:skills|technologies|competencies|expertise)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|education|certifications|projects)|$)/i);
    
    if (skillsSection) {
      const skillsText = skillsSection[1];
      const sectionSkills = hasExactSkillsSection
        ? this._extractSectionSkills(skillsText)
        : skillsText.split(/[,\n•\-\*|]/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 50);
      return this._dedupeSkills([...sectionSkills, ...this._extractInlineSkills(text)]);
    }
    return this._dedupeSkills(this._extractInlineSkills(text));
  }

  // The user's own skills section often carries labelled categories
  // ("MLOps & ML Lifecycle: MLflow, DVC, model registry, ..."). Preserve
  // them as structured {label, items} groups so the tailored CV can keep
  // the user's categorisation instead of inventing or losing it.
  extractSkillCategories(text) {
    const section = this._extractExactSection(text,
      ['CORE COMPETENCY', 'CORE COMPETENCIES', 'CORE SKILLS', 'TECHNICAL SKILLS', 'SKILLS', 'TECHNOLOGIES', 'EXPERTISE']);
    if (!section) return [];
    const LABEL_RE = /^[•\-*]?\s*([A-Za-z][A-Za-z &/+,.'-]{1,44}):\s*(.+)$/;

    // Hard-wrapped PDF extraction splits category lines; rejoin every
    // non-label line onto the previous line (inside this section, a line is
    // either a category or the continuation of one).
    const joined = [];
    for (const raw of section.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (!LABEL_RE.test(line) && joined.length > 0 && !/[.!?]$/.test(joined.at(-1))) {
        joined[joined.length - 1] += ` ${line}`;
        continue;
      }
      joined.push(line);
    }

    const categories = [];
    const seen = new Set();
    for (const line of joined) {
      const match = line.match(LABEL_RE);
      if (!match) continue;
      const label = match[1].trim();
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      const items = match[2].split(/[,;]/)
        .map(value => value.trim().replace(/[.]+$/, ''))
        // A colon inside an item means column-flattened extraction glued a
        // neighbouring category into this one ("gRPC Databases & Data: ...").
        .filter(value => value && value.length <= 48 && value.split(/\s+/).length <= 5 && !value.includes(':'));
      if (items.length < 2) continue;
      seen.add(key);
      categories.push({ label, items });
      if (categories.length >= 8) break;
    }
    return categories;
  }

  _extractInlineSkills(text) {
    const result = [];
    const lines = String(text || '').split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const match = line.trim().match(/^([A-Za-z][A-Za-z &/+.-]{0,30}):\s*(.+)$/);
      const categoryOnly = line.trim().match(/^([A-Za-z][A-Za-z &/+.-]{0,30}):\s*$/);
      const label = match?.[1]?.trim() || categoryOnly?.[1]?.trim();
      const valueText = match?.[2] || (categoryOnly ? String(lines[index + 1] || '').trim() : '');
      if (!label || !valueText.includes(',')) continue;
      const values = valueText.split(',').map(v => v.trim()).filter(Boolean);
      if (!/^skills?$/i.test(label) && (label.split(/\s+/).length > 3 || values.length < 2)) continue;
      if (values.some(v => v.length > 45 || v.split(/\s+/).length > 5 || /[.!?]$/.test(v))) continue;
      result.push(...values);
    }
    return result;
  }

  _extractSectionSkills(text) {
    const result = [];
    for (const rawLine of String(text || '').split('\n')) {
      let line = rawLine.trim();
      if (!line || /^[A-Za-z][A-Za-z &/+.-]{0,35}:\s*$/.test(line)) continue;
      line = line.replace(/^[A-Za-z][A-Za-z &/+.-]{0,35}:\s*/, '');
      const values = line.split(/[,•*|]/).map(value => value.replace(/^[-–—]\s*/, '').trim()).filter(Boolean);
      if (values.some(value => value.length > 48 || value.split(/\s+/).length > 5 || /[.!?]$/.test(value))) continue;
      result.push(...values);
    }
    return result;
  }

  _dedupeSkills(values) {
    const seen = new Set();
    return values.map(value => String(value || '').replace(/^[•·▪◦*-]\s*/, '').replace(/[.;]+$/, '').trim()).filter(value => {
      const key = value.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  extractProjects(text) {
    const section = this._extractExactSection(text, ['PROJECTS']);
    if (!section) return [];
    const lines = section.split('\n').map(line => line.trim()).filter(Boolean);
    const entries = [];
    let current = null;
    let detailsOpen = false;
    const flush = () => {
      if (current) {
        current.bullets = this._joinExtractedSentences(current.bullets);
        entries.push(current);
      }
      current = null;
      detailsOpen = false;
    };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const header = line.match(/^(?:\d{1,2}\s*(?:\.\)|[.)])\s+)?(.+?)\s*\(((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)]*)?)\)\s*$/i);
      const canonicalUrl = String(lines[lineIndex + 1] || '').match(/^https?:\/\/\S+$/i)?.[0];
      if (header) {
        flush();
        current = { name: header[1].trim(), url: /^https?:\/\//i.test(header[2]) ? header[2] : `https://${header[2]}`, bullets: [], skills: [] };
        detailsOpen = true;
        continue;
      }
      if (canonicalUrl && line.length <= 120 && !/^[•*\-]/.test(line) && !/[.!?]$/.test(line)) {
        flush();
        current = { name: line, url: canonicalUrl, bullets: [], skills: [] };
        detailsOpen = true;
        continue;
      }
      if (current && line === current.url) continue;
      if (!current) continue;
      const skills = line.match(/^(?:Skills|Technologies):\s*(.+)$/i);
      if (skills && skills[1].includes(',')) {
        current.skills.push(...skills[1].split(',').map(v => v.trim()).filter(v => v && v.length <= 48));
        detailsOpen = false;
        continue;
      }
      if (!detailsOpen || /^[A-Za-z][A-Za-z &/+.-]{0,35}:\s*$/.test(line)) continue;
      const detail = line.replace(/^(?:[•*\-]\s+)/, '').trim();
      if (detail.length >= 8 && detail.length <= 320 && !this._isExactSectionHeading(detail)) current.bullets.push(detail);
    }
    flush();
    return entries.map(project => ({ ...project, skills: this._dedupeSkills(project.skills) }));
  }

  _isExactSectionHeading(line) {
    return CANONICAL_SECTION_HEADINGS.has(String(line || '').trim().replace(/:$/, '').trim().toUpperCase());
  }

  _isLetterSpacedDisplayLine(line) {
    const tokens = String(line || '').trim().split(/\s+/);
    return tokens.filter(token => /^[A-Z]$/.test(token)).length >= 6;
  }

  // Some PDFs carry a duplicated text layer: the extracted text repeats the
  // whole document (or a section) with its heading. Treating the repeated
  // heading as "next section starts here" silently discards everything after
  // it - observed live as a 7-role CV reduced to 2 roles. Collect EVERY
  // occurrence of the wanted heading and concatenate the bodies; duplicate
  // roles/skills are deduplicated downstream.
  _extractExactSection(text, headings) {
    const wanted = new Set(headings.map(v => v.toUpperCase()));
    const isWanted = line => wanted.has(String(line || '').trim().replace(/:$/, '').toUpperCase());
    const lines = String(text || '').split('\n');
    const bodies = [];
    let current = null;
    for (const line of lines) {
      if (isWanted(line)) {
        if (current) bodies.push(current.join('\n'));
        current = [];
        continue;
      }
      if (current && (this._isExactSectionHeading(line) || this._isLikelyAuxiliarySectionHeading(line))) {
        bodies.push(current.join('\n'));
        current = null;
        continue;
      }
      if (current) current.push(line);
    }
    if (current) bodies.push(current.join('\n'));
    // Identical repeated bodies (full text-layer duplication) collapse to one;
    // near-duplicates with different line wrapping are deduplicated by the
    // section-specific consumers (role merge, skill dedupe).
    const seen = new Set();
    const unique = bodies.filter(body => {
      const key = body.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.join('\n');
  }

  _extractSectionWhere(text, startPredicate) {
    const lines = String(text || '').split('\n');
    const start = lines.findIndex(line => startPredicate(line));
    if (start < 0) return '';
    const body = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (this._isExactSectionHeading(lines[i]) || this._isLikelyAuxiliarySectionHeading(lines[i])) break;
      body.push(lines[i]);
    }
    return body.join('\n');
  }

  // Custom ALL-CAPS section headings ("AI STRATEGY, ENABLEMENT & OPERATING
  // MODEL", "SELECTED AI ENABLEMENT, OPERATIONS & INNOVATION ACHIEVEMENTS")
  // must terminate a section like canonical headings do - otherwise their
  // bullets get absorbed into whatever section precedes them (observed as a
  // trailing section's achievements misattributed to the last experience
  // role). Keyword-gated so ALL-CAPS company header lines are not mistaken
  // for section boundaries.
  _isLikelyAuxiliarySectionHeading(line) {
    const text = String(line || '').trim().replace(/:$/, '').trim();
    if (text.length < 6 || text.length > 70) return false;
    if (text !== text.toUpperCase() || /\d/.test(text)) return false;
    if (!/^[A-Z][A-Z &,/'()\-]*$/.test(text)) return false;
    return /\b(?:STRATEGY|ENABLEMENT|ACHIEVEMENTS?|ACCOMPLISHMENTS?|AWARDS?|RECOGNITION|PUBLICATIONS?|VOLUNTEER(?:ING)?|LANGUAGES?|INTERESTS?|REFERENCES?|LEADERSHIP|CERTIFICATIONS?|EDUCATION|SKILLS|SUMMARY|PROJECTS?|TRAINING|MEMBERSHIPS?|AFFILIATIONS?)\b/.test(text);
  }

  _parseTrailingDateExperience(text) {
    // Role-local Skills lines can appear on either side of the trailing date
    // after column flattening. They are evidence for the global skill list,
    // never responsibilities or block delimiters.
    const lines = String(text || '').split('\n').map(v => v.trim()).filter(Boolean).filter(line =>
      !/^Skills:\s*.+,/i.test(line)
      && !this._isContactLine(line)
      && !this._looksLikeSkillListContinuation(line)
    );
    const dateIndexes = lines.map((line, i) => this._isDateOnlyRangeLine(line) ? i : -1).filter(i => i >= 0);
    if (dateIndexes.length < 2) return null;
    const firstBlock = lines.slice(0, dateIndexes[0]);
    if (firstBlock.length < 3 || !this._isLikelyJobTitle(firstBlock[1])
      || this._extractActionSentences(firstBlock.slice(2)).length === 0) return null;
    const roles = [];
    let start = 0;
    for (const dateIndex of dateIndexes) {
      const block = lines.slice(start, dateIndex);
      start = dateIndex + 1;
      if (block.length < 3) return [];
      const core = block;
      const company = core[0];
      const title = core[1];
      if (!company || !this._isLikelyJobTitle(title) || this._looksLikeResponsibility(title)) return [];
      const joined = this._extractActionSentences(core.slice(2));
      if (joined.length === 0 || joined.some(action => !/^[A-Z]/.test(action))) return [];
      roles.push({ company, title, dates: this._extractFullDateRange(lines[dateIndex]), responsibilities: joined });
    }
    if (start < lines.length && lines.slice(start).some(line => !/^[A-Za-z][A-Za-z &/+.-]{0,35}:\s*$/.test(line))) return [];
    return roles.length >= 2 ? roles.sort((a, b) => this._dateSortValue(b.dates) - this._dateSortValue(a.dates)) : null;
  }

  _isContactLine(line) {
    return /[\w.+-]+@[\w.-]+\.\w+|https?:\/\/|www\.|(?:linkedin|github)\.com/i.test(String(line || ''));
  }

  _looksLikeSkillListContinuation(line) {
    const text = String(line || '').trim();
    return !this._looksLikeResponsibility(text) && !/[.!?]$/.test(text)
      && (text.match(/,/g) || []).length >= 2 && text.split(/\s+/).length <= 18;
  }

  _joinExtractedSentences(lines = []) {
    const output = [];
    for (const value of lines) {
      const line = String(value || '').trim();
      if (!line) continue;
      if (output.length && !/[.!?]$/.test(output.at(-1)) && !this._looksLikeResponsibility(line)) output[output.length - 1] += ` ${line}`;
      else output.push(line);
    }
    return output.map(value => value.replace(/\s+/g, ' ').trim());
  }

  _extractActionSentences(lines = []) {
    const output = [];
    for (const value of lines) {
      const line = String(value || '').trim();
      if (this._looksLikeResponsibility(line)) {
        output.push(line);
      } else if (output.length && !/[.!?]$/.test(output.at(-1))
        && !this._isContactLine(line) && !this._looksLikeSkillListContinuation(line)) {
        output[output.length - 1] += ` ${line}`;
      }
    }
    return output.map(value => value.replace(/\s+/g, ' ').trim());
  }

  _dateSortValue(range) {
    if (/\b(?:present|current|now)\b/i.test(range)) return 999999;
    const years = String(range || '').match(/(?:19|20)\d{2}/g) || [];
    return Number(years.at(-1) || 0);
  }

  _extractFullDateRange(line) {
    const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
    const endpoint = `(?:${month}\\s+)?(?:19|20)\\d{2}`;
    return String(line || '').match(new RegExp(`\\b${endpoint}\\s*(?:-|–|—|to)\\s*(?:${endpoint}|Present|Current|Now)\\b`, 'i'))?.[0] || '';
  }

  _isDateOnlyRangeLine(line) {
    const text = String(line || '').trim();
    const range = this._extractFullDateRange(text);
    return Boolean(range) && text.replace(range, '').replace(/[|,;:()\s]+/g, '') === '';
  }

  /**
   * Extract quantified achievements from two sources:
   *   1. A dedicated Achievements / Accomplishments section (high confidence)
   *   2. Experience bullets that contain measurable evidence (metrics, scale, outcomes)
   *
   * Passing the already-parsed `experience` array avoids re-parsing and lets
   * the metric scan operate on clean bullet strings rather than raw CV text.
   *
   * @param {string} text - Raw CV text
   * @param {Array}  experience - Already-parsed experience array from extractExperience()
   */
  extractAchievements(text, experience = []) {
    const achievements = new Set();

    // Pattern that matches a bullet containing a quantified signal
    const METRIC_RE = /(?:[\$£€][\d,.]+[kmb]?\b|\b\d[\d,.]*\s*(?:%|percent\b|x\b|×|k\b|m\b|bn\b|users?|customers?|clients?|engineers?|countries|markets?|months?|weeks?|days?|hours?|minutes?|ms\b|requests?\s+per|rpm\b|rps\b)|\btimes?\s+faster\b|\b\d+\s*(?:people|reports?|team members?|headcount|accounts?)\b|\b(?:doubled|tripled|halved|quadrupled)\b)/i;

    // 1. Dedicated achievements / accomplishments section
    const achieveSection = text.match(
      /(?:key\s+achievements?|accomplishments?|highlights?|notable\s+results?)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|education|skills|certifications|projects|$))/i
    );
    if (achieveSection) {
      for (const line of achieveSection[1].split('\n')) {
        const cleaned = line.replace(/^[\s•\-\*\d.]+/, '').trim();
        if (cleaned.length > 10 && cleaned.length < 300) achievements.add(cleaned);
      }
    }

    // 1b. Custom ALL-CAPS achievements headings ("SELECTED AI ENABLEMENT,
    // OPERATIONS & INNOVATION ACHIEVEMENTS") the strict pattern above misses.
    const customAchieveSection = achieveSection ? '' : this._extractSectionWhere(text, line =>
      /\b(?:ACHIEVEMENTS?|ACCOMPLISHMENTS?|LEADERSHIP)\b/.test(String(line || '')) && this._isLikelyAuxiliarySectionHeading(line));
    if (customAchieveSection) {
      const cleanedLines = customAchieveSection.split('\n')
        .map(line => line.replace(/^[\s•\-\*\d.]+/, '').trim())
        .filter(Boolean);
      for (const joined of this._joinExtractedSentences(cleanedLines)) {
        if (joined.length > 10 && joined.length < 300) achievements.add(joined);
      }
    }

    // 2. Experience bullets that contain a measurable signal
    for (const exp of experience) {
      for (const bullet of (exp.responsibilities || [])) {
        if (METRIC_RE.test(bullet)) {
          achievements.add(bullet.trim());
        }
      }
    }

    // 3. Fallback: scan raw text when no structured experience was parsed
    if (experience.length === 0) {
      const legacyPatterns = [
        /(?:increased|improved|reduced|grew|saved|generated|delivered)[^.]*\d+[%$kmb]?[^.]*/gi,
        /\d+[%$kmb]?[^.]*(?:increase|improvement|reduction|growth|savings|revenue|budget)/gi,
      ];
      for (const re of legacyPatterns) {
        const matches = text.match(re);
        if (matches) matches.forEach(m => achievements.add(m.trim()));
      }
    }

    return [...achievements].filter(a => a.length > 10 && a.length < 300);
  }

  extractCertifications(text) {
    const certSection = text.match(/(?:certifications?|licenses?|credentials)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|education|skills|projects|$))/i);
    
    if (certSection) {
      return certSection[1]
        .split('\n')
        .map(l => l.replace(/^[\s•\-\*]*/, '').trim())
        .filter(l => l.length > 0);
    }
    
    return [];
  }

  extractBulletPoints(text) {
    return text
      .split('\n')
      .map(l => l.replace(/^[\s]*[•\-\*]\s*/, '').trim())
      .filter(l => l.length > 0);
  }

  _parseExperienceHeader(line) {
    if (!line || this._isLikelyNoiseExperienceLine(line)) return null;
    const dates = this._extractDateRange(line);
    if (!dates) return null;

    const withoutDates = line
      .replace(dates, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*[|,;:/-]\s*$/g, '')
      .trim();
    if (!withoutDates || this._isLikelyNoiseExperienceLine(withoutDates)) return null;

    const atMatch = withoutDates.match(/^(.{3,80}?)\s+(?:at|@)\s+(.{2,80})$/i);
    if (atMatch) {
      return {
        title: this._cleanExperienceHeader(atMatch[1]),
        company: this._cleanExperienceHeader(atMatch[2]),
        dates,
      };
    }

    const parts = withoutDates
      .split(/\s+(?:\||–|—|-)\s+/)
      .map(p => this._cleanExperienceHeader(p))
      .filter(Boolean)
      .filter(p => !this._isLikelyNoiseExperienceLine(p));

    if (parts.length >= 2) {
      const [first, second] = parts;
      // "Sourcegraph — UK (Remote) Feb 2026 – Present": the second segment is
      // a location, not a title. Keep it with the company so the real title
      // line below the header can claim the title slot.
      if (this._isLikelyLocationText(second) && !this._isLikelyJobTitle(second)) {
        return { company: `${first} — ${second}`, title: '', dates };
      }
      if (this._isLikelyJobTitle(first) && !this._isLikelyJobTitle(second)) {
        return { title: first, company: second, dates };
      }
      return { company: first, title: second, dates };
    }

    if (parts.length === 1) {
      const only = parts[0];
      return this._isLikelyJobTitle(only)
        ? { title: only, company: '', dates }
        : { company: only, title: '', dates };
    }

    return null;
  }

  _entryFromBufferedHeader(buffer, dates) {
    const clean = (buffer || [])
      .map(line => this._cleanExperienceHeader(line))
      .filter(Boolean)
      .filter(line => !this._isLikelyNoiseExperienceLine(line))
      .filter(line => !this._isLikelySentenceFragment(line))
      .slice(-3);

    if (clean.length >= 2) {
      const first = clean[clean.length - 2];
      const second = clean[clean.length - 1];
      if (this._isLikelyJobTitle(first) && !this._isLikelyJobTitle(second)) {
        return { title: first, company: second, dates };
      }
      return { company: first, title: second, dates };
    }

    if (clean.length === 1) {
      const only = clean[0];
      return this._isLikelyJobTitle(only)
        ? { title: only, company: '', dates }
        : { company: only, title: '', dates };
    }

    return { company: '', title: '', dates };
  }

  _extractDateRange(line) {
    const text = String(line || '');
    const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
    const year = '(?:19|20)\\d{2}';
    const endpoint = `(?:${month}\\s+)?(?:${year}|Present|Current|Now)`;
    const patterns = [
      new RegExp(`\\b${endpoint}\\s*(?:-|–|—|to)\\s*${endpoint}\\b`, 'i'),
      /\b(?:Present|Current|Now)\b/i,
      /\b(?:19|20)\d{2}\b/,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[0].trim();
    }
    return '';
  }

  _cleanBullet(line) {
    const match = String(line || '').match(/^\s*(?:[•●▪*]|>>\s+|\-\s+|\d+[.)])\s*(.+)$/);
    return match ? match[1].trim() : '';
  }

  _cleanExperienceHeader(value) {
    return String(value || '')
      .replace(/^[•●▪*\-\s]+/, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*$/, '')
      .trim();
  }

  _isLikelyCorporateName(text) {
    const t = String(text || '').trim();
    if (/\b(Ltd\.?|Limited|Inc\.?|Incorporated|Corp\.?|Corporation|LLC|LLP|GmbH|PLC|Pty|Pvt)\b/i.test(t)) return true;
    // "Bincom ICT Solutions | Nigeria": the corporate marker sits before a
    // separator or location suffix, not only at the very end of the line.
    if (/\b(Solutions|Technologies|Holdings|Ventures)\s*(?:$|\||,)/i.test(t)) return true;
    if (/[,|]\s*(USA|UK|US|UAE|India|Canada|Australia|Nigeria|Ghana|Kenya|South Africa|Singapore)(?:\s*\/\s*Remote)?\s*$/i.test(t)) return true;
    return false;
  }

  _isLikelyLocationText(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 45) return false;
    if (/\b(engineer|developer|manager|architect|analyst|designer|consultant|lead|director|specialist|administrator|scientist)\b/i.test(text)) return false;
    return /,/.test(text) || /^(remote|hybrid|onsite)$/i.test(text)
      || /\b(uk|usa|united kingdom|united states|nigeria|ghana|kenya|canada|australia|india|remote)\b/i.test(text);
  }

  _isLikelySentenceFragment(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/[.!?]$/.test(t)) return true;
    if (/^(and|or|with|for|to|in|of|at|by|from|that|which|who|when|where)\s+/i.test(t) && /^[a-z]/.test(t)) return true;
    if (/^[a-z]/.test(t) && !/[A-Z]/.test(t.slice(1)) && t.split(/\s+/).length >= 2) return true;
    return false;
  }

  _isLikelyJobTitle(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 120 || this._cleanBullet(text)) return false;
    if (this._isLikelyCorporateName(text)) return false;
    if (/^(position|title|role|job|occupation)\s*:/i.test(text)) return false;
    if (/^(and|or|with|for|to|in|of|at|by|from)\s+/i.test(text) && /^[a-z]/.test(text)) return false;
    return /\b(engineer|developer|architect|manager|lead|director|consultant|analyst|designer|scientist|specialist|officer|coordinator|administrator|advisor|associate|executive|representative|support|success|product|sales|marketing|finance|operations|devops|platform|cloud|data|software|security|solution|solutions|technical|principal|staff|head)\b/i.test(text);
  }

  _looksLikeResponsibility(line) {
    const text = String(line || '').trim();
    if (text.length < 35 || text.length > 260) return false;
    if (this._isDateOnlyRangeLine(text)) return false;
    if (/^(act(?:ed)?|analy[sz](?:e|ed)|automated|built|collaborat(?:e|ed)|conducted|contribut(?:e|ed)|coordinated|created|defined|delivered|deployed|designed|developed|drove|employed|implemented|improved|increased|integrated|launched|led|maintain(?:ed)?|managed|optimized|own(?:ed)?|partnered|perform(?:ed)?|provid(?:e|ed)|reduced|resolved|serv(?:e|ed)|set\s+up|support(?:ed)?|troublesh(?:oot|ot)|used|utili[sz](?:e|ed)|worked)\b/i.test(text)) return true;
    return false;
  }

  _isLikelyNoiseExperienceLine(line) {
    const text = String(line || '').trim();
    if (!text) return true;
    if (this._cleanBullet(text)) return true;
    if (text.length > 160) return true;
    if (/^(professional\s+experience|work\s+experience|employment|career\s+history|experience)$/i.test(text)) return true;
    if (/^(responsibilities?|achievements?|key\s+achievements?|selected\s+projects?)[:\s]*$/i.test(text)) return true;
    if (/^(remote|hybrid|onsite|full[- ]time|part[- ]time|contract|freelance)$/i.test(text)) return true;
    return false;
  }

  _isDecorativeLine(line) {
    return /^[=_\-—–]{3,}$/.test(String(line || '').trim());
  }

  /**
   * Get relevant CV sections for a specific question type
   * @param {string} questionType - Type of question (behavioral, technical, etc.)
   * @returns {Object} Relevant sections
   */
  getRelevantSections(questionType) {
    if (!this.structured) return null;
    
    const relevanceMap = {
      behavioral: ['experience', 'achievements', 'summary'],
      technical: ['skills', 'experience', 'certifications'],
      leadership: ['experience', 'achievements', 'summary'],
      motivation: ['summary', 'experience', 'education'],
      culture: ['summary', 'experience', 'achievements'],
      general: ['summary', 'experience', 'skills', 'education']
    };
    
    const sections = relevanceMap[questionType] || relevanceMap.general;
    const result = {};
    
    for (const section of sections) {
      result[section] = this.structured[section];
    }
    
    return result;
  }
}

export default CVParser;
