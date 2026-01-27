/**
 * Answer Generator Module
 * 
 * Orchestrates CV parsing, prompt construction, and LLM API calls.
 * This is the main interface that both web app and extension will use.
 * 
 * DESIGN DECISIONS:
 * 1. Provider-agnostic API interface - can swap OpenAI for other providers
 * 2. Streaming support for better UX
 * 3. Built-in caching of parsed CV to avoid re-parsing
 * 4. Post-processing to catch and fix common LLM output issues
 */

import { CVParser } from './cv-parser.js';
import { PromptBuilder } from './prompt-builder.js';

export class AnswerGenerator {
  constructor(config = {}) {
    this.cvParser = new CVParser();
    this.promptBuilder = new PromptBuilder();
    
    this.config = {
      apiEndpoint: config.apiEndpoint || '/api/generate',
      model: config.model || 'gpt-4o',
      temperature: config.temperature || 0.7,
      ...config
    };
    
    this.parsedCV = null;
    this.rawCV = null;
  }

  /**
   * Load and parse a CV
   * @param {string} cvText - Raw CV text
   * @returns {Object} Parsed CV data
   */
  loadCV(cvText) {
    this.rawCV = cvText;
    this.parsedCV = this.cvParser.parse(cvText);
    return this.parsedCV;
  }

  /**
   * Check if CV is loaded
   * @returns {boolean}
   */
  hasCV() {
    return this.parsedCV !== null;
  }

  /**
   * Get the parsed CV data
   * @returns {Object|null}
   */
  getCV() {
    return this.parsedCV;
  }

  /**
   * Clear the loaded CV
   */
  clearCV() {
    this.parsedCV = null;
    this.rawCV = null;
  }

  /**
   * Generate an answer to a job application question
   * @param {string} question - The application question
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Generated answer and metadata
   */
  async generateAnswer(question, options = {}) {
    if (!this.parsedCV) {
      throw new Error('No CV loaded. Please load a CV first.');
    }

    const length = options.length || 'medium';
    const prompt = this.promptBuilder.buildPrompt(
      this.parsedCV,
      question,
      length,
      {
        jobTitle: options.jobTitle,
        company: options.company
      }
    );

    try {
      const response = await this.callAPI(prompt);
      const processedAnswer = this.postProcess(response.answer);

      return {
        answer: processedAnswer,
        questionType: prompt.metadata.questionType,
        length: prompt.metadata.length,
        tokensUsed: response.tokensUsed
      };
    } catch (error) {
      console.error('Answer generation failed:', error);
      throw error;
    }
  }

  /**
   * Generate answer with streaming (for real-time UI updates)
   * @param {string} question - The application question
   * @param {Object} options - Generation options
   * @param {Function} onChunk - Callback for each text chunk
   * @returns {Promise<Object>} Final result
   */
  async generateAnswerStream(question, options = {}, onChunk) {
    if (!this.parsedCV) {
      throw new Error('No CV loaded. Please load a CV first.');
    }

    const length = options.length || 'medium';
    const prompt = this.promptBuilder.buildPrompt(
      this.parsedCV,
      question,
      length,
      {
        jobTitle: options.jobTitle,
        company: options.company
      }
    );

    try {
      const response = await this.callAPIStream(prompt, onChunk);
      const processedAnswer = this.postProcess(response.answer);

      return {
        answer: processedAnswer,
        questionType: prompt.metadata.questionType,
        length: prompt.metadata.length
      };
    } catch (error) {
      console.error('Answer generation failed:', error);
      throw error;
    }
  }

  /**
   * Call the LLM API (non-streaming)
   * @param {Object} prompt - The constructed prompt
   * @returns {Promise<Object>} API response
   */
  async callAPI(prompt) {
    const response = await fetch(this.config.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        stream: false
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    return {
      answer: data.answer,
      tokensUsed: data.tokensUsed
    };
  }

  /**
   * Call the LLM API with streaming
   * @param {Object} prompt - The constructed prompt
   * @param {Function} onChunk - Callback for each chunk
   * @returns {Promise<Object>} Final response
   */
  async callAPIStream(prompt, onChunk) {
    const response = await fetch(this.config.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        stream: true
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullAnswer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              fullAnswer += parsed.text;
              if (onChunk) onChunk(parsed.text);
            }
          } catch (e) {
            // Skip malformed chunks
          }
        }
      }
    }

    return { answer: fullAnswer };
  }

  /**
   * Post-process the generated answer
   * @param {string} answer - Raw LLM output
   * @returns {string} Cleaned answer
   */
  postProcess(answer) {
    let processed = answer;

    // Remove common LLM artifacts
    processed = processed.replace(/^(Here's|Here is|I would say|My answer:)\s*/i, '');
    processed = processed.replace(/^\s*["']|["']\s*$/g, '');
    
    // Remove any meta-commentary
    processed = processed.replace(/^(As the candidate,?|Speaking as the candidate,?)\s*/i, '');
    
    // Fix double spaces
    processed = processed.replace(/\s+/g, ' ');
    
    // Trim
    processed = processed.trim();

    return processed;
  }

  /**
   * Validate that the answer doesn't contain hallucinated facts
   * This is a basic check - can be expanded
   * @param {string} answer - The generated answer
   * @returns {Object} Validation result
   */
  validateAnswer(answer) {
    const warnings = [];
    
    // Check for company names not in CV
    const cvCompanies = this.parsedCV?.experience?.map(e => e.company.toLowerCase()) || [];
    const companyPattern = /(?:at|with|for)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g;
    let match;
    
    while ((match = companyPattern.exec(answer)) !== null) {
      const mentioned = match[1].toLowerCase();
      if (!cvCompanies.some(c => c.includes(mentioned) || mentioned.includes(c))) {
        warnings.push(`Potentially unknown company mentioned: "${match[1]}"`);
      }
    }

    // Check for specific metrics that might be invented
    const metricPattern = /\$[\d,]+|\d+%|\d+\s*(?:years|months)/g;
    const cvMetrics = this.rawCV?.match(metricPattern) || [];
    const answerMetrics = answer.match(metricPattern) || [];
    
    for (const metric of answerMetrics) {
      if (!cvMetrics.includes(metric)) {
        warnings.push(`Metric "${metric}" not found in CV - verify accuracy`);
      }
    }

    return {
      valid: warnings.length === 0,
      warnings
    };
  }
}

export default AnswerGenerator;
