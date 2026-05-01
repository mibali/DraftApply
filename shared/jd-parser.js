export class JDParser {
  parse(text, jobTitle = '', company = '') {
    return {
      jobTitle:            jobTitle  || this._extractJobTitle(text),
      company:             company   || this._extractCompany(text),
      seniority:           this.extractSeniority(text),
      requiredSkills:      this.extractRequiredSkills(text),
      preferredSkills:     this.extractPreferredSkills(text),
      tools:               this.extractTools(text),
      responsibilities:    this.extractResponsibilities(text),
      softSkills:          this.extractSoftSkills(text),
      atsKeywords:         this.extractAtsKeywords(text),
      dealBreakers:        this.extractDealBreakers(text),
    };
  }

  _extractJobTitle(text) {
    // Look for common heading patterns at top of JD
    const m = text.match(/^(?:job\s*title|role|position)[:\s]+(.+)/im)
           || text.match(/^([^\n]{5,80})\n/);
    return m ? m[1].trim() : '';
  }

  _extractCompany(text) {
    const m = text.match(/(?:at|@|company|employer)[:\s]+([A-Z][^\n,]{2,60})/i)
           || text.match(/(?:about us|about\s+)([A-Z][^\n.]{2,60})/i);
    return m ? m[1].trim() : '';
  }

  extractSeniority(text) {
    const t = text.toLowerCase();

    // Check title-level signals first
    if (/\b(vp|vice\s*president|chief|c[tos]o|director|head\s+of|principal)\b/.test(t)) return 'senior/executive';
    if (/\b(senior|sr\.?|lead|staff|architect)\b/.test(t)) return 'senior';

    // Years-of-experience signals
    const yoeMatch = t.match(/(\d+)\+?\s*years?\s*(?:of\s+)?(?:experience|exp)/);
    if (yoeMatch) {
      const yrs = parseInt(yoeMatch[1], 10);
      if (yrs >= 8)  return 'senior/executive';
      if (yrs >= 5)  return 'senior';
      if (yrs >= 3)  return 'mid-senior';
      if (yrs >= 1)  return 'mid-level';
      return 'junior';
    }

    if (/\b(mid[- ]?senior|mid[- ]?level\s+senior)\b/.test(t)) return 'mid-senior';
    if (/\b(mid[- ]?level|intermediate)\b/.test(t))             return 'mid-level';
    if (/\b(junior|jr\.?|entry[- ]?level|graduate|intern)\b/.test(t)) return 'junior';

    return 'mid-level';
  }

  extractRequiredSkills(text) {
    const skills = new Set();

    // Detect "Required" section and pull bullets
    const reqSection = text.match(
      /(?:requirements?|required\s+(?:skills?|qualifications?|experience))[:\s]*\n([\s\S]*?)(?=\n\s*(?:preferred|nice[- ]to|bonus|responsibilities?|what\s+you|about|benefits?|$))/i
    );
    if (reqSection) {
      const bullets = reqSection[1]
        .split('\n')
        .map(l => l.replace(/^[\s•\-\*•●]+/, '').trim())
        .filter(l => l.length > 2 && l.length < 200);
      bullets.forEach(b => skills.add(b));
    }

    // Also pick up common tech keywords scattered anywhere
    const techRe = /\b(React(?:\.js)?|Vue(?:\.js)?|Angular|Next\.js|Nuxt(?:\.js)?|Svelte|Node(?:\.js)?|Express(?:\.js)?|NestJS|Django|Flask|FastAPI|Spring(?:\s*Boot)?|Laravel|Rails|Ruby\s+on\s+Rails|Python|TypeScript|JavaScript|Go(?:lang)?|Rust|Java|C#|\.NET|PHP|Swift|Kotlin|Scala|Elixir|GraphQL|REST(?:ful)?|gRPC|SQL|PostgreSQL|MySQL|MongoDB|Redis|Elasticsearch|Kafka|RabbitMQ|AWS|GCP|Azure|Docker|Kubernetes|Terraform|CI\/CD|Git(?:Hub|Lab)?|Jira|Linux|Bash|Shell)\b/gi;
    let m;
    while ((m = techRe.exec(text)) !== null) {
      skills.add(m[0]);
    }

    return [...skills].slice(0, 30);
  }

  extractPreferredSkills(text) {
    const HEADER_RE = /^(preferred|nice\s+to\s+have|nice-to-have|bonus|plus|advantageous)\s*[:\-]?\s*$/i;
    const NEXT_RE = /^(requirements?|must.have|qualifications?|essential|responsibilities?|what\s+you|about\s+us?|benefits?|compensation|perks|the\s+role|the\s+company|our\s+team)\s*[:\-]?\s*$/i;
    const items = [];
    let inSection = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (HEADER_RE.test(t)) { inSection = true; continue; }
      if (inSection) {
        if (NEXT_RE.test(t)) break;
        if (t && /^[\-•*●\d.]/.test(t)) {
          const cleaned = t.replace(/^[\-•*●\d.]+\s*/, '');
          if (cleaned.length > 2 && cleaned.length < 200) items.push(cleaned);
        }
      }
    }
    return items.slice(0, 20);
  }

  extractTools(text) {
    const toolRe = /\b(React(?:\.js)?|Vue(?:\.js)?|Angular|Next\.js|Nuxt(?:\.js)?|Svelte|Node(?:\.js)?|Express(?:\.js)?|NestJS|Django|Flask|FastAPI|Spring(?:\s*Boot)?|Laravel|Rails|Python|TypeScript|JavaScript|Go(?:lang)?|Rust|Java|C#|\.NET|PHP|Swift|Kotlin|Scala|Elixir|GraphQL|gRPC|PostgreSQL|MySQL|MariaDB|MongoDB|Redis|DynamoDB|Cassandra|Elasticsearch|Kafka|RabbitMQ|SQS|SNS|AWS|GCP|Azure|Docker|Kubernetes|Helm|Terraform|Ansible|Jenkins|GitHub\s*Actions|GitLab\s*CI|CircleCI|Travis\s*CI|Datadog|Prometheus|Grafana|Splunk|Sentry|Figma|Jira|Confluence|Slack|Linear|Notion|dbt|Airflow|Spark|Hadoop|Snowflake|BigQuery|Redshift|Tableau|Power\s*BI|Looker|pandas|NumPy|scikit[- ]learn|TensorFlow|PyTorch|Keras|OpenAI|LangChain|Pinecone|Weaviate|Stripe|Twilio|SendGrid|Firebase|Supabase|Vercel|Netlify|Heroku|Linux|Bash|Shell|Git)\b/gi;
    const found = new Set();
    let m;
    while ((m = toolRe.exec(text)) !== null) {
      found.add(m[0]);
    }
    return [...found];
  }

  extractResponsibilities(text) {
    const HEADER_RE = /^(responsibilities?|what\s+you(?:'ll|\s+will)\s+do|role\s+overview|key\s+duties|your\s+role|day[- ]to[- ]day|the\s+role)\s*[:\-]?\s*$/i;
    const NEXT_RE = /^(requirements?|must.have|qualifications?|essential|preferred|nice\s+to\s+have|about\s+us?|benefits?|compensation|perks|our\s+team|the\s+company)\s*[:\-]?\s*$/i;
    const items = [];
    let inSection = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (HEADER_RE.test(t)) { inSection = true; continue; }
      if (inSection) {
        if (NEXT_RE.test(t)) break;
        if (t && /^[\-•*●\d.]/.test(t)) {
          const cleaned = t.replace(/^[\-•*●\d.]+\s*/, '');
          if (cleaned.length > 5 && cleaned.length < 300) items.push(cleaned);
        }
      }
    }
    return items.slice(0, 20);
  }

  extractSoftSkills(text) {
    const KNOWN = [
      'communication', 'collaboration', 'teamwork', 'leadership', 'mentoring',
      'problem solving', 'problem-solving', 'critical thinking', 'adaptability',
      'creativity', 'time management', 'organizational skills', 'attention to detail',
      'analytical', 'initiative', 'self-motivated', 'self-starter', 'proactive',
      'ownership', 'accountability', 'empathy', 'interpersonal', 'presentation skills',
      'written communication', 'verbal communication', 'cross-functional', 'stakeholder management',
    ];
    const lower = text.toLowerCase();
    return KNOWN.filter(s => lower.includes(s));
  }

  extractAtsKeywords(text) {
    const STOP = new Set([
      'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
      'from','up','about','into','through','as','is','are','was','were','be','been',
      'being','have','has','had','do','does','did','will','would','could','should',
      'may','might','shall','must','can','this','that','these','those','we','our',
      'you','your','they','their','it','its','i','my','me','he','she','his','her',
      'us','them','who','what','when','where','how','all','any','both','each',
      'more','most','other','some','such','no','nor','not','only','own','same','so',
      'than','too','very','just','also','if','then','than','because','while','although',
      'however','therefore','thus','hence','ie','eg','etc','team','work','role','job',
      'position','company','new','strong','good','great','excellent','required','preferred',
      'experience','skills','ability','knowledge','understanding','background','minimum',
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9+#.\-\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOP.has(w));

    const freq = {};
    for (const w of words) {
      freq[w] = (freq[w] || 0) + 1;
    }

    return Object.entries(freq)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([word]) => word);
  }

  extractDealBreakers(text) {
    const breakers = [];
    const t = text.toLowerCase();

    if (/no\s+(?:visa\s+)?sponsor|sponsorship\s+not\s+available|unable\s+to\s+sponsor|must\s+be\s+authoriz/i.test(text)) {
      breakers.push('No visa sponsorship');
    }
    if (/must\s+have\s+(?:a\s+)?(?:bachelor|master|phd|degree)|(?:bachelor|master|phd|degree)\s+required/i.test(text)) {
      const dm = text.match(/(?:bachelor'?s?|master'?s?|phd|doctorate|degree)[^\n,]{0,60}(?:required|mandatory)/i);
      breakers.push(dm ? `Degree required: ${dm[0].slice(0, 80)}` : 'Degree required');
    }

    const yoeReq = text.match(/(\d+)\+\s*years?\s*(?:of\s+)?(?:experience|exp)[^\n]{0,60}/gi);
    if (yoeReq) {
      yoeReq.slice(0, 3).forEach(y => breakers.push(`Min experience: ${y.trim().slice(0, 80)}`));
    }

    if (/\bon[- ]?site\b|full[- ]?time\s+on[- ]?site|required\s+to\s+be\s+in[- ]?office|no\s+remote/i.test(text)) {
      breakers.push('On-site required');
    }

    if (/security\s*clearance\s*required|must\s+hold\s+.*clearance/i.test(text)) {
      breakers.push('Security clearance required');
    }

    return breakers;
  }
}

export default JDParser;
