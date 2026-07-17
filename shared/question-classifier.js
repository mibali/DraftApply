const DATA_EXTRACTION = [
  /^(full\s*)?name\b/i, /^(first|last|middle|legal|preferred)\s*name\b/i,
  /^(e-?mail|phone|mobile|cell|address|city|state|country|postal|zip|location)\b/i,
  /\b(linkedin|github|gitlab|portfolio|website|behance|dribbble|kaggle|stack\s*overflow|twitter|x\.com)\b/i,
];

const PERSONAL_FACT = /\b(notice\s*period|available\s*to\s*start|start\s*date|availability|visa|sponsorship|right\s*to\s*work|work\s*authori[sz]ation|security\s*clearance|willing\s*to\s*(?:relocate|travel)|relocation|travel\s*percentage|criminal\s*(?:record|history)|conflict\s*of\s*interest|salary|compensation|pay\s*rate|references?)\b/i;
const SENSITIVE = /\b(disab(?:ility|led)|ethnic(?:ity)?|race|gender|sex|sexual\s*orientation|religion|marital\s*status|veteran|date\s*of\s*birth|age|nationality)\b/i;

export function isMultiPartQuestion(question = '') {
  const q = String(question || '').trim();
  const explicit = (q.match(/(?:^|\s)(?:1[.)]|2[.)]|3[.)]|\([a-c]\))/gi) || []).length >= 2;
  const interrogatives = (q.match(/\b(?:what|why|how|when|where|which|describe|explain|tell|give)\b/gi) || []).length;
  return explicit || (/[?].*[?]/s.test(q)) || (/\band\b/i.test(q) && interrogatives >= 2);
}

export function classifyApplicationQuestion(question = '') {
  const raw = String(question || '').trim();
  const q = raw.toLowerCase();
  const multiPart = isMultiPartQuestion(raw);
  let type = 'general';

  if (DATA_EXTRACTION.some(pattern => pattern.test(raw))) type = 'data_extraction';
  else if (SENSITIVE.test(q)) type = 'sensitive_voluntary';
  else if (/^(are|do|have|can|will|would|is|did)\s+you\b/i.test(raw) && /\b(?:willing|able|comfortable|open|prepared)\b/i.test(q)) type = 'yes_no';
  else if (PERSONAL_FACT.test(q)) type = /salary|compensation|pay\s*rate/.test(q) ? 'salary' : 'personal_factual';
  else if (/cover\s*(?:ing)?\s*letter|motivation\s*letter|letter\s*of\s*interest|application\s*letter/i.test(q)) type = 'cover_letter';
  else if (/where\s+(?:are|do)\s+you\s+(?:currently\s+)?(?:located|based|resid|liv)|\b(?:current|your)\s+location\b|\b(?:city|country)\s+of\s+residence\b|\btime\s*zone\b/i.test(q)) type = 'short_factual';
  else if (/why\s+(?:do\s+you\s+want|would\s+you\s+like|are\s+you\s+(?:applying|interested)|this\s+(?:company|role)|us\b)|what\s+(?:interests?|attracts?|draws?|excites?)\s+you\s+about/i.test(q)) type = 'why_company';
  else if (/\b(troubleshoot\w*|debug\w*|diagnos\w*|root\s*cause|incident|rca)\b/i.test(q) && /\b(how|approach|process|method|steps?)\b/i.test(q)) type = 'troubleshooting';
  else if (/tell\s+(?:me\s+)?about\s+a\s+time|describe\s+a\s+(?:time|situation|challenge)|give\s+(?:me\s+)?(?:an?\s+)?example|how\s+did\s+you\s+(?:handle|deal|manage|overcome|resolve)|share\s+(?:a|an)\s+(?:example|experience|time)/i.test(q)) type = 'behavioral';
  else if (/\b(?:technical|architecture|system\s*design|implementation|programming|coding|api|database|cloud|framework|technology|tooling)\b/i.test(q) && /\b(?:experience|describe|explain|build|design|implement|use|used|worked|approach)\b/i.test(q)) type = 'technical';
  else if (/\b(?:strength|weakness|development\s*area|areas?\s+(?:for|to)\s+improve|greatest\s+achievement)\b/i.test(q)) type = 'strength_weakness';
  else if (/\b(?:what\s+motivates|career\s+(?:goal|aspiration)|where\s+do\s+you\s+see\s+yourself|what\s+about\s+this\s+(?:role|position))\b/i.test(q)) type = 'motivation';
  else if (/^(are|do|have|can|will|would|is|did)\s+you\b/i.test(raw)) type = 'yes_no';
  else if (/\b(?:briefly|few\s+words|one\s+(?:sentence|paragraph)|short\s+(?:description|summary)|summari[sz]e)\b/i.test(q)) type = 'brief';

  return {
    type,
    multiPart,
    requiresUserFact: ['personal_factual', 'sensitive_voluntary'].includes(type),
    voluntary: type === 'sensitive_voluntary',
    requiresJobContext: !['data_extraction', 'personal_factual', 'sensitive_voluntary', 'salary'].includes(type),
  };
}

export function questionType(question = '') {
  return classifyApplicationQuestion(question).type;
}

export default classifyApplicationQuestion;
