/**
 * LLM Provider Abstraction
 * 
 * Supports multiple free LLM providers:
 * 
 * LOCAL (no API key, fully private):
 * - Ollama: Easy local setup
 * - LM Studio: GUI app with API
 * - LocalAI: OpenAI-compatible local server
 * 
 * CLOUD (free tiers, API key required):
 * - Groq: Very fast, generous free tier
 * - Google Gemini: 15 RPM free
 * - Mistral: Free tier available
 * - Together AI: $5 free credit
 * - OpenAI: Paid, but included for completeness
 */

export const PROVIDERS = {
  // === LOCAL PROVIDERS (No API key needed) ===
  
  ollama: {
    name: 'Ollama',
    type: 'local',
    defaultModel: 'llama3.2',
    baseUrl: 'http://localhost:11434',
    setupHint: 'Install: brew install ollama && ollama pull llama3.2 && ollama serve'
  },
  
  lmstudio: {
    name: 'LM Studio',
    type: 'local',
    defaultModel: 'local-model',
    baseUrl: 'http://localhost:1234/v1',
    setupHint: 'Download LM Studio, load a model, start the local server'
  },
  
  localai: {
    name: 'LocalAI',
    type: 'local',
    defaultModel: 'gpt-3.5-turbo',
    baseUrl: 'http://localhost:8080/v1',
    setupHint: 'Run: docker run -p 8080:8080 localai/localai'
  },

  // === CLOUD PROVIDERS (Free tiers) ===
  
  groq: {
    name: 'Groq',
    type: 'cloud',
    defaultModel: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1',
    setupHint: 'Get free API key at https://console.groq.com'
  },
  
  gemini: {
    name: 'Google Gemini',
    type: 'cloud',
    defaultModel: 'gemini-1.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    setupHint: 'Get free API key at https://aistudio.google.com/apikey'
  },
  
  mistral: {
    name: 'Mistral',
    type: 'cloud',
    defaultModel: 'mistral-small-latest',
    baseUrl: 'https://api.mistral.ai/v1',
    setupHint: 'Get API key at https://console.mistral.ai'
  },
  
  together: {
    name: 'Together AI',
    type: 'cloud',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    baseUrl: 'https://api.together.xyz/v1',
    setupHint: 'Get $5 free credit at https://together.ai'
  },
  
  openai: {
    name: 'OpenAI',
    type: 'cloud',
    defaultModel: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    setupHint: 'Get API key at https://platform.openai.com (paid)'
  }
};

/**
 * Get provider configuration
 */
export function getProviderConfig(providerName, env = {}) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  
  const envPrefix = providerName.toUpperCase();
  
  return {
    ...provider,
    apiKey: env[`${envPrefix}_API_KEY`] || env.LLM_API_KEY,
    model: env[`${envPrefix}_MODEL`] || env.LLM_MODEL || provider.defaultModel,
    baseUrl: env[`${envPrefix}_URL`] || provider.baseUrl
  };
}

/**
 * Generate completion using Ollama
 */
export async function generateOllama(config, messages, options = {}) {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      options: { temperature: options.temperature || 0.7 }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama error: ${error}`);
  }

  const data = await response.json();
  return { answer: data.message.content };
}

/**
 * Stream completion using Ollama
 */
export async function streamOllama(config, messages, options = {}, res) {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      options: { temperature: options.temperature || 0.7 }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.message?.content) {
          res.write(`data: ${JSON.stringify({ text: data.message.content })}\n\n`);
        }
      } catch (e) {}
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Generate completion using OpenAI-compatible API
 * Works for: OpenAI, Groq, Mistral, Together, LM Studio, LocalAI
 */
export async function generateOpenAICompatible(config, messages, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: options.temperature || 0.7
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `${config.name} error: ${response.status}`);
  }

  const data = await response.json();
  return {
    answer: data.choices[0].message.content,
    tokensUsed: data.usage
  };
}

/**
 * Stream completion using OpenAI-compatible API
 */
export async function streamOpenAICompatible(config, messages, options = {}, res) {
  const headers = { 'Content-Type': 'application/json' };
  
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: options.temperature || 0.7,
      stream: true
    })
  });

  if (!response.ok) {
    throw new Error(`${config.name} error: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const text = parsed.choices[0]?.delta?.content;
        if (text) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      } catch (e) {}
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Generate completion using Google Gemini
 */
export async function generateGemini(config, messages, options = {}) {
  if (!config.apiKey) {
    throw new Error('Gemini API key required');
  }

  // Convert messages to Gemini format
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  // Prepend system message to first user message
  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg && contents.length > 0) {
    contents[0].parts[0].text = `${systemMsg.content}\n\n${contents[0].parts[0].text}`;
  }

  const response = await fetch(
    `${config.baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: options.temperature || 0.7
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Gemini error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!text) {
    throw new Error('No response from Gemini');
  }

  return { answer: text };
}

/**
 * Stream completion using Google Gemini
 */
export async function streamGemini(config, messages, options = {}, res) {
  if (!config.apiKey) {
    throw new Error('Gemini API key required');
  }

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg && contents.length > 0) {
    contents[0].parts[0].text = `${systemMsg.content}\n\n${contents[0].parts[0].text}`;
  }

  const response = await fetch(
    `${config.baseUrl}/models/${config.model}:streamGenerateContent?key=${config.apiKey}&alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: options.temperature || 0.7
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini error: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

    for (const line of lines) {
      try {
        const data = JSON.parse(line.slice(6));
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      } catch (e) {}
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Main generate function - routes to correct provider
 */
export async function generate(providerName, config, messages, options = {}) {
  switch (providerName) {
    case 'ollama':
      return generateOllama(config, messages, options);
    case 'gemini':
      return generateGemini(config, messages, options);
    case 'lmstudio':
    case 'localai':
    case 'groq':
    case 'mistral':
    case 'together':
    case 'openai':
      return generateOpenAICompatible(config, messages, options);
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

/**
 * Main stream function - routes to correct provider
 */
export async function stream(providerName, config, messages, options = {}, res) {
  switch (providerName) {
    case 'ollama':
      return streamOllama(config, messages, options, res);
    case 'gemini':
      return streamGemini(config, messages, options, res);
    case 'lmstudio':
    case 'localai':
    case 'groq':
    case 'mistral':
    case 'together':
    case 'openai':
      return streamOpenAICompatible(config, messages, options, res);
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

/**
 * Check provider availability
 */
export async function checkProvider(providerName, config) {
  try {
    switch (providerName) {
      case 'ollama': {
        const response = await fetch(`${config.baseUrl}/api/tags`);
        if (!response.ok) throw new Error('Not responding');
        
        const data = await response.json();
        const models = data.models?.map(m => m.name) || [];
        const hasModel = models.some(m => m.startsWith(config.model));
        
        return {
          available: true,
          modelInstalled: hasModel,
          models,
          hint: hasModel ? null : `Run: ollama pull ${config.model}`
        };
      }
      
      case 'lmstudio':
      case 'localai': {
        const response = await fetch(`${config.baseUrl}/models`);
        if (!response.ok) throw new Error('Not responding');
        
        const data = await response.json();
        return {
          available: true,
          models: data.data?.map(m => m.id) || []
        };
      }
      
      case 'gemini': {
        if (!config.apiKey) {
          return { available: false, hint: 'API key required' };
        }
        
        const response = await fetch(
          `${config.baseUrl}/models?key=${config.apiKey}`
        );
        return { available: response.ok };
      }
      
      case 'groq':
      case 'mistral':
      case 'together':
      case 'openai': {
        if (!config.apiKey) {
          return { available: false, hint: 'API key required' };
        }
        
        const response = await fetch(`${config.baseUrl}/models`, {
          headers: { 'Authorization': `Bearer ${config.apiKey}` }
        });
        return { available: response.ok };
      }
      
      default:
        return { available: false, hint: 'Unknown provider' };
    }
  } catch (error) {
    return {
      available: false,
      error: error.message,
      hint: PROVIDERS[providerName]?.setupHint
    };
  }
}

/**
 * Generate with fallback chain
 * Tries each provider in order until one succeeds
 */
export async function generateWithFallback(fallbackChain, messages, options = {}) {
  const errors = [];
  
  for (const { name, config } of fallbackChain) {
    try {
      console.log(`[Fallback] Trying ${name}...`);
      const result = await generate(name, config, messages, options);
      console.log(`[Fallback] Success with ${name}`);
      return { ...result, provider: name };
    } catch (error) {
      console.warn(`[Fallback] ${name} failed:`, error.message);
      errors.push({ provider: name, error: error.message });
    }
  }
  
  // All providers failed
  throw new Error(`All providers failed: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`);
}

/**
 * Build fallback chain from environment config
 */
export function buildFallbackChain(env = {}) {
  const chain = [];
  
  // Primary provider (if set)
  const primary = env.LLM_PROVIDER || 'ollama';
  const primaryConfig = getProviderConfig(primary, env);
  chain.push({ name: primary, config: primaryConfig });
  
  // Add Ollama if not primary and available locally
  if (primary !== 'ollama') {
    chain.push({ 
      name: 'ollama', 
      config: getProviderConfig('ollama', env) 
    });
  }
  
  // Add cloud fallbacks if API keys are available
  if (env.GROQ_API_KEY && primary !== 'groq') {
    chain.push({ 
      name: 'groq', 
      config: getProviderConfig('groq', env) 
    });
  }
  
  if (env.GEMINI_API_KEY && primary !== 'gemini') {
    chain.push({ 
      name: 'gemini', 
      config: getProviderConfig('gemini', env) 
    });
  }
  
  if (env.MISTRAL_API_KEY && primary !== 'mistral') {
    chain.push({ 
      name: 'mistral', 
      config: getProviderConfig('mistral', env) 
    });
  }
  
  if (env.TOGETHER_API_KEY && primary !== 'together') {
    chain.push({ 
      name: 'together', 
      config: getProviderConfig('together', env) 
    });
  }
  
  if (env.OPENAI_API_KEY && primary !== 'openai') {
    chain.push({ 
      name: 'openai', 
      config: getProviderConfig('openai', env) 
    });
  }
  
  return chain;
}
