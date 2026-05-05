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
    // Explicit label patterns take priority
    const labeled = text.match(
      /^(?:job\s*title|role|position|opening|vacancy|title)[:\s]+(.+)/im
    );
    if (labeled) return labeled[1].trim();

    // Check the first 5 non-empty lines for something that looks like a job title
    // (contains role-level words, or short and plausible)
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 5)) {
      if (
        line.length >= 5 &&
        line.length <= 80 &&
        /\b(engineer|developer|manager|designer|analyst|scientist|architect|lead|director|specialist|consultant|coordinator|officer|head|principal|staff)\b/i.test(line)
      ) return line;
    }

    // Fall back to first short line
    const first = text.match(/^([^\n]{5,80})\n/);
    return first ? first[1].trim() : '';
  }

  _extractCompany(text) {
    // Explicit label patterns
    const labeled = text.match(
      /(?:^|\n)\s*(?:company|employer|organization|organisation|hiring\s+company)[:\s]+([A-Z][^\n,]{2,60})/im
    );
    if (labeled) return labeled[1].trim();

    // "at CompanyName" or "@ CompanyName"
    const atPattern = text.match(/\bat\s+([A-Z][a-zA-Z0-9\s&.,'-]{2,50})(?=[\s,.\n]|$)/m);
    if (atPattern && atPattern[1].trim().length >= 2) return atPattern[1].trim();

    // "About CompanyName" (but not "About us" or "About the role")
    const about = text.match(
      /\bAbout\s+(?!us\b|the\s+role\b|this\s+role\b|the\s+position\b|the\s+company\b)([A-Z][^\n.]{2,60})/i
    );
    if (about) return about[1].trim();

    return '';
  }

  extractSeniority(text) {
    const t = text.toLowerCase();

    // Title-level signals take priority over YOE
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

    // Detect requirement section by a broad set of header synonyms
    const reqSection = text.match(
      /(?:requirements?|required\s+(?:skills?|qualifications?|experience)|must[- ]have|minimum\s+qualifications?|what\s+(?:we(?:'re|\s+are)\s+looking\s+for|you(?:'ll|\s+will)\s+bring|you\s+have|you\s+must\s+have)|who\s+you\s+are|your\s+background|qualifications?)[:\s]*\n([\s\S]*?)(?=\n\s*(?:preferred|nice[- ]to|good\s+to\s+have|bonus|responsibilities?|what\s+you|about|benefits?|compensation|perks|$))/i
    );
    if (reqSection) {
      this._extractBulletsAndSentences(reqSection[1]).forEach(b => skills.add(b));
    }

    // Also scan the full text for common tech keywords
    const techRe = /\b(React(?:\.js)?|Vue(?:\.js)?|Angular|Next\.js|Nuxt(?:\.js)?|Svelte(?:Kit)?|Remix|Astro|Node(?:\.js)?|Express(?:\.js)?|NestJS|Fastify|Django|Flask|FastAPI|Spring(?:\s*Boot)?|Laravel|Rails|Ruby\s+on\s+Rails|Python|TypeScript|JavaScript|Go(?:lang)?|Rust|Java|C#|\.NET|PHP|Swift|Kotlin|Scala|Elixir|GraphQL|REST(?:ful)?|gRPC|tRPC|SQL|PostgreSQL|MySQL|MongoDB|Redis|Elasticsearch|Kafka|RabbitMQ|AWS\s*CDK|AWS|GCP|Azure\s*ML|Azure|Docker|Kubernetes|Terraform|CI\/CD|GitHub\s*Actions|GitLab\s*CI|Git(?:Hub|Lab)?|Jira|Linux|Bash|Shell|Kubeflow|KFP|KubeRay|Ray(?:\.io|\.Serve|\.Train)?|SkyPilot|DCGM|MLflow|DVC|Seldon|BentoML|Triton(?:\s+Inference\s+Server)?|Feast|WandB|Weights\s*&\s*Biases|ZenML|Metaflow|ClearML|Argo\s*(?:Workflows?|CD|Rollouts?)?|ArgoCD|Vertex\s*AI|SageMaker|ONNX|Dask|Polars|Evidently(?:\s*AI)?|Neptune|vLLM|Prefect|Dagster|Delta\s*Lake|Apache\s*(?:Spark|Kafka|Flink|Airflow|Iceberg)|Great\s*Expectations|Pulumi|Crossplane|OpenTelemetry|Prometheus|Grafana|Datadog|Istio|Helm|Vault|Consul|Flux(?:CD)?|Karpenter|KEDA|Kuberay|LangChain|LangGraph|LlamaIndex|Pinecone|Weaviate|Qdrant|ChromaDB|OpenAI|Anthropic|Bedrock|Vertex)\b/gi;
    let m;
    while ((m = techRe.exec(text)) !== null) {
      skills.add(m[0]);
    }

    return [...skills].slice(0, 30);
  }

  extractPreferredSkills(text) {
    const HEADER_RE = /^(preferred|nice\s+to\s+have|nice-to-have|good\s+to\s+have|bonus(?:\s+points?)?|plus|advantageous|desired(?:\s+qualifications?)?|would\s+be\s+(?:great|ideal|a\s+plus)|ideal\s+but\s+not\s+required|not\s+required\s+but|if\s+you\s+(?:also\s+)?have)\s*[:\-]?\s*$/i;
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
    const toolRe = /\b(React(?:\.js)?|Vue(?:\.js)?|Angular|Next\.js|Nuxt(?:\.js)?|Svelte(?:Kit)?|Remix|Astro|Node(?:\.js)?|Express(?:\.js)?|NestJS|Fastify|Django|Flask|FastAPI|Spring(?:\s*Boot)?|Laravel|Rails|Python|TypeScript|JavaScript|Go(?:lang)?|Rust|Java|C#|\.NET|PHP|Swift|Kotlin|Scala|Elixir|GraphQL|gRPC|tRPC|PostgreSQL|MySQL|MariaDB|MongoDB|Redis|DynamoDB|Cassandra|Elasticsearch|Kafka|RabbitMQ|SQS|SNS|AWS\s*CDK|AWS|GCP|Azure\s*ML|Azure|Docker|Kubernetes|Helm|Terraform|Ansible|Jenkins|GitHub\s*Actions|GitLab\s*CI|CircleCI|Travis\s*CI|Datadog|Prometheus|Grafana|Splunk|Sentry|Figma|Jira|Confluence|Slack|Linear|Notion|dbt|Airflow|Spark|Hadoop|Snowflake|BigQuery|Redshift|Tableau|Power\s*BI|Looker|pandas|NumPy|scikit[- ]learn|TensorFlow|PyTorch|Keras|OpenAI|LangChain|LangGraph|LlamaIndex|Pinecone|Weaviate|Qdrant|ChromaDB|Celery|Prisma|Drizzle|Stripe|Twilio|SendGrid|Firebase|Supabase|PlanetScale|Neon|Vercel|Netlify|Fly\.io|Cloudflare|Heroku|Turborepo|Nx|Vite|Webpack|Rollup|Pydantic|Linux|Bash|Shell|Git|Kubeflow|KFP|KubeRay|Ray(?:\.io|\.Serve|\.Train)?|SkyPilot|DCGM|MLflow|DVC|Seldon|BentoML|Triton(?:\s+Inference\s+Server)?|Feast|WandB|Weights\s*&\s*Biases|ZenML|Metaflow|ClearML|Argo\s*(?:Workflows?|CD|Rollouts?)?|ArgoCD|Vertex\s*AI|SageMaker|ONNX|Dask|Polars|Evidently(?:\s*AI)?|Neptune|vLLM|Prefect|Dagster|Delta\s*Lake|Apache\s*(?:Flink|Iceberg)|Great\s*Expectations|Pulumi|Crossplane|OpenTelemetry|Istio|Vault|Consul|Flux(?:CD)?|Karpenter|KEDA|Anthropic|Bedrock)\b/gi;
    const found = new Set();
    let m;
    while ((m = toolRe.exec(text)) !== null) {
      found.add(m[0]);
    }
    return [...found];
  }

  extractResponsibilities(text) {
    const HEADER_RE = /^(responsibilities?|what\s+you(?:'ll|\s+will)\s+do|role\s+overview|key\s+duties|your\s+role|day[- ]to[- ]day|the\s+role|in\s+this\s+role(?:\s+you\s+will)?|you(?:'ll|\s+will)\s+be\s+(?:responsible)?|your\s+day[- ]to[- ]day|the\s+position\s+involves?)\s*[:\-]?\s*$/i;
    const NEXT_RE = /^(requirements?|must.have|qualifications?|essential|preferred|nice\s+to\s+have|good\s+to\s+have|about\s+us?|benefits?|compensation|perks|our\s+team|the\s+company)\s*[:\-]?\s*$/i;
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
      'conflict resolution', 'decision making', 'strategic thinking', 'detail-oriented',
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

    if (/no\s+(?:visa\s+)?sponsor(?:ship)?|sponsorship\s+not\s+(?:available|provided|offered)|unable\s+to\s+sponsor|cannot\s+(?:provide|offer|support)(?:\s+visa)?\s+sponsor|must\s+be\s+(?:eligible\s+to\s+work|authorized|authorised)|not\s+eligible\s+to\s+sponsor|does\s+not\s+(?:provide|offer)\s+(?:visa\s+)?sponsor/i.test(text)) {
      breakers.push('No visa sponsorship');
    }

    const degreeRe = /(?:must\s+have|requires?|require(?:d|ment)?)\s+(?:a\s+)?(?:bachelor|master|phd|doctorate|degree)|(?:bachelor'?s?|master'?s?|phd|doctorate|degree)\s+(?:in\s+\w+\s+)?(?:is\s+)?required/i;
    if (degreeRe.test(text)) {
      const dm = text.match(/(?:bachelor'?s?|master'?s?|phd|doctorate|degree)[^\n,]{0,80}(?:required|mandatory)/i);
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

  // ── private helpers ───────────────────────────────────────────────────────

  /**
   * Extract items from a section block — handles both bulleted and numbered
   * lists, and falls back to splitting on sentence boundaries.
   */
  _extractBulletsAndSentences(block) {
    const items = [];

    for (const rawLine of block.split('\n')) {
      const t = rawLine.trim();
      if (!t) continue;

      // Bulleted / numbered lines
      if (/^[\-•*●\d.]/.test(t)) {
        const cleaned = t.replace(/^[\-•*●\d.]+\s*/, '').trim();
        // Some bullets use "/" as sub-item separator: split and add each
        if (cleaned.length > 2 && cleaned.length < 200) {
          for (const part of cleaned.split(/\s*\/\s*/)) {
            const p = part.trim();
            if (p.length > 2 && p.length < 200) items.push(p);
          }
        }
        continue;
      }

      // Plain-text lines that look like requirements (not section headers)
      // Accept lines that start with a capital letter or common requirement verb
      if (
        t.length > 10 && t.length < 250 &&
        /^[A-Z]/.test(t) &&
        !/^(requirements?|preferred|qualifications?|responsibilities?|benefits?|about\s|what\s+you|who\s+you|we\s+(are|offer))/i.test(t)
      ) {
        // Also split on "/" in plain-text lines (e.g. "Experience of X / Y / Z")
        for (const part of t.split(/\s*\/\s*/)) {
          const p = part.trim();
          if (p.length > 10 && p.length < 200) items.push(p);
        }
      }
    }

    // Plain-sentence fallback when nothing was collected at all
    if (items.length === 0) {
      block.split(/[.;]\s+/).forEach(sent => {
        const s = sent.trim();
        if (s.length > 10 && s.length < 200) items.push(s);
      });
    }

    return items;
  }
}

export default JDParser;
