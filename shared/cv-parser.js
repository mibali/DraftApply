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
    const websiteMatch = text.match(/(?:https?:\/\/)?(?:www\.)?(?!linkedin\.com|github\.com)[\w-]+\.[\w.-]+(?:\/[\w./-]*)?/i);
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
      
      // Pattern for job entries: Company, Title, Date range, then bullets
      const jobPattern = /([A-Z][^\n]+)\n([^\n]+)\n([^\n]*\d{4}[^\n]*)\n([\s\S]*?)(?=\n[A-Z][^\n]+\n[^\n]+\n[^\n]*\d{4}|$)/gi;
      
      let match;
      while ((match = jobPattern.exec(expText)) !== null) {
        experiences.push({
          company: match[1].trim(),
          title: match[2].trim(),
          dates: match[3].trim(),
          responsibilities: this.extractBulletPoints(match[4])
        });
      }
      
      // Fallback: simpler extraction
      if (experiences.length === 0) {
        const lines = expText.split('\n').filter(l => l.trim());
        let currentExp = null;
        
        for (const line of lines) {
          if (line.match(/\d{4}\s*[-–]\s*(\d{4}|present|current)/i)) {
            if (currentExp) experiences.push(currentExp);
            currentExp = {
              company: '',
              title: '',
              dates: line.trim(),
              responsibilities: []
            };
          } else if (currentExp) {
            if (!currentExp.company) {
              currentExp.company = line.trim();
            } else if (!currentExp.title) {
              currentExp.title = line.trim();
            } else if (line.match(/^[\s]*[•\-\*]/)) {
              currentExp.responsibilities.push(line.replace(/^[\s]*[•\-\*]\s*/, '').trim());
            }
          }
        }
        if (currentExp) experiences.push(currentExp);
      }
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
