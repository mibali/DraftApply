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
    this.rawText = text;
    
    this.structured = {
      contactInfo: this.extractContactInfo(text),
      summary: this.extractSummary(text),
      experience: this.extractExperience(text),
      education: this.extractEducation(text),
      skills: this.extractSkills(text),
      achievements: this.extractAchievements(text),
      certifications: this.extractCertifications(text),
      rawText: text
    };
    
    return this.structured;
  }

  extractContactInfo(text) {
    const lines = text.split('\n').slice(0, 10);
    const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
    const phoneMatch = text.match(/[\+]?[(]?[0-9]{1,3}[)]?[-\s.]?[0-9]{1,4}[-\s.]?[0-9]{1,4}[-\s.]?[0-9]{1,9}/);
    const linkedinMatch = text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w-]+\/?/i);
    const githubMatch = text.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w-]+\/?/i);
    const websiteMatch = text.match(/\b(?:https?:\/\/|www\.)(?!(?:www\.)?(?:linkedin|github|twitter|x)\.com\b)[\w.-]+\.[a-z]{2,}(?:\/[\w./-]*)?/i);
    const twitterMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[\w-]+\/?/i);
    const portfolioMatch = text.match(/(?:portfolio|behance\.net|dribbble\.com|kaggle\.com)[:\s]*(?:https?:\/\/)?[\w./-]+/i);

    return {
      name: lines[0]?.trim() || '',
      email: emailMatch?.[0] || '',
      phone: phoneMatch?.[0] || '',
      linkedin: linkedinMatch?.[0] || '',
      github: githubMatch?.[0] || '',
      website: websiteMatch?.[0] || '',
      twitter: twitterMatch?.[0] || '',
      portfolio: portfolioMatch?.[0] || ''
    };
  }

  extractSummary(text) {
    const summaryPatterns = [
      /(?:summary|profile|about|objective)[:\s]*\n?([\s\S]*?)(?=\n\s*(?:experience|education|skills|work|employment|projects))/i,
      /^([\s\S]{50,500}?)(?=\n\s*(?:experience|education|skills|work|employment))/i
    ];
    
    for (const pattern of summaryPatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }
    return '';
  }

  extractExperience(text) {
    const experiences = [];
    
    // Match experience section
    const expSection = text.match(/(?:experience|employment|work\s*history)[:\s]*\n([\s\S]*?)(?=\n\s*(?:education|skills|certifications|projects|$))/i);
    
    if (expSection) {
      const expText = expSection[1];

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

        if (currentExp && !currentExp.title && this._isLikelyJobTitle(line)) {
          currentExp.title = line;
          continue;
        }

        if (currentExp && this._looksLikeResponsibility(line)) {
          currentExp.responsibilities.push(line);
          continue;
        }

        if (!this._isLikelyNoiseExperienceLine(line)) {
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
    const skillsSection = text.match(/(?:skills|technologies|competencies|expertise)[:\s]*\n([\s\S]*?)(?=\n\s*(?:experience|education|certifications|projects|$))/i);
    
    if (skillsSection) {
      const skillsText = skillsSection[1];
      // Split by common delimiters
      return skillsText
        .split(/[,\n•\-\*|]/)
        .map(s => s.trim())
        .filter(s => s.length > 0 && s.length < 50);
    }
    
    return [];
  }

  extractAchievements(text) {
    const achievements = [];
    
    // Look for quantified achievements anywhere in the CV
    const metricPatterns = [
      /(?:increased|improved|reduced|grew|saved|generated|managed|led|delivered)[^.]*\d+[%$kmb]?[^.]*/gi,
      /\d+[%$kmb]?[^.]*(?:increase|improvement|reduction|growth|savings|revenue|budget)/gi
    ];
    
    for (const pattern of metricPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        achievements.push(...matches.map(m => m.trim()));
      }
    }
    
    return [...new Set(achievements)];
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
    const match = String(line || '').match(/^\s*(?:[•●▪*]|\-\s+|\d+[.)])\s*(.+)$/);
    return match ? match[1].trim() : '';
  }

  _cleanExperienceHeader(value) {
    return String(value || '')
      .replace(/^[•●▪*\-\s]+/, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*$/, '')
      .trim();
  }

  _isLikelyJobTitle(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 120 || this._cleanBullet(text)) return false;
    return /\b(engineer|developer|architect|manager|lead|director|consultant|analyst|designer|scientist|specialist|officer|coordinator|administrator|advisor|associate|executive|representative|support|success|product|sales|marketing|finance|operations|devops|platform|cloud|data|software|security|solution|solutions|technical|principal|staff|head)\b/i.test(text);
  }

  _looksLikeResponsibility(line) {
    const text = String(line || '').trim();
    if (text.length < 35 || text.length > 260) return false;
    if (this._extractDateRange(text) || this._isLikelyJobTitle(text)) return false;
    return /^(built|created|designed|implemented|led|managed|owned|delivered|developed|improved|reduced|increased|supported|resolved|partnered|collaborated|provided|conducted|deployed|automated|maintained|launched|defined|drove|coordinated)\b/i.test(text);
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
