import OpenAI from "openai";
import Anthropic from '@anthropic-ai/sdk';

// Provider priority order for failover (most preferred first)
const PROVIDER_PRIORITY = ['anthropic', 'openai', 'deepseek', 'grok'] as const;
type Provider = typeof PROVIDER_PRIORITY[number] | 'perplexity';

// Default models
const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_GROK_MODEL = "grok-3-latest";

// Check if a provider is configured (has API key)
export function isProviderConfigured(provider: string): boolean {
  switch (provider) {
    case 'openai': return !!process.env.OPENAI_API_KEY;
    case 'anthropic': return !!process.env.ANTHROPIC_API_KEY;
    case 'deepseek': return !!process.env.DEEPSEEK_API_KEY;
    case 'grok': return !!process.env.GROK_API_KEY;
    case 'perplexity': return !!process.env.PERPLEXITY_API_KEY;
    default: return false;
  }
}

// Get configured providers in priority order
export function getConfiguredProviders(): string[] {
  return PROVIDER_PRIORITY.filter(p => isProviderConfigured(p));
}

export interface AICallOptions {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  preferredProvider?: string;
}

// Make a single AI call to a specific provider
async function callProvider(provider: string, options: AICallOptions): Promise<string> {
  const { prompt, systemPrompt, temperature = 0.7, maxTokens = 4000 } = options;
  
  switch (provider) {
    case 'openai': {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const messages: any[] = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: prompt });
      
      const response = await openai.chat.completions.create({
        model: DEFAULT_OPENAI_MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
      });
      return response.choices[0].message.content || "";
    }
    
    case 'anthropic': {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: DEFAULT_ANTHROPIC_MODEL,
        messages: [{ role: "user", content: prompt }],
        system: systemPrompt,
        max_tokens: maxTokens,
        temperature,
      });
      const textBlock = response.content[0];
      return textBlock.type === 'text' ? textBlock.text : '';
    }
    
    case 'deepseek': {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: DEFAULT_DEEPSEEK_MODEL,
          messages: systemPrompt 
            ? [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
            : [{ role: "user", content: prompt }],
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      });
      if (!response.ok) throw new Error(`DeepSeek API error: ${response.statusText}`);
      const data = await response.json();
      return data.choices[0].message.content || "";
    }
    
    case 'grok': {
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: DEFAULT_GROK_MODEL,
          messages: systemPrompt 
            ? [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }]
            : [{ role: "user", content: prompt }],
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      });
      if (!response.ok) throw new Error(`Grok API error: ${response.statusText}`);
      const data = await response.json();
      return data.choices[0].message.content || "";
    }
    
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Make an AI call with automatic failover
 * Tries providers in sequence until one succeeds
 * @param options - AI call options including prompt, system prompt, temperature, etc.
 * @returns The AI response text
 */
export async function callAIWithFailover(options: AICallOptions): Promise<string> {
  const configuredProviders = getConfiguredProviders();
  
  if (configuredProviders.length === 0) {
    throw new Error('No AI providers are configured. Please add API keys.');
  }
  
  // Build provider order: preferred first (if configured), then others
  let providerOrder: string[];
  if (options.preferredProvider && isProviderConfigured(options.preferredProvider)) {
    providerOrder = [options.preferredProvider, ...configuredProviders.filter(p => p !== options.preferredProvider)];
  } else {
    providerOrder = configuredProviders;
  }
  
  let lastError: Error | null = null;
  
  for (const provider of providerOrder) {
    try {
      console.log(`🔄 AI Failover: Trying provider ${provider}`);
      const result = await callProvider(provider, options);
      console.log(`✅ AI Failover: Success with ${provider}`);
      return result;
    } catch (error: any) {
      console.warn(`⚠️ AI Failover: Provider ${provider} failed: ${error.message}`);
      lastError = error;
      // Continue to next provider
    }
  }
  
  // All providers failed
  throw new Error(`All AI providers failed. Last error: ${lastError?.message}`);
}

// Clean markdown from output
export function cleanMarkdown(text: string): string {
  return text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/```[\s\S]*?```/g, (match) => {
      return match.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    })
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/>\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
