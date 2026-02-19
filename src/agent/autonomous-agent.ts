/**
 * Autonomous WP Cache Analysis Agent
 *
 * A TRUE autonomous agent where an LLM:
 * 1. Observes the current state (what we've found so far)
 * 2. Reasons about what to do next
 * 3. Picks from available tools/actions
 * 4. Executes and loops until it decides to stop
 *
 * The LLM is the brain - it decides navigation, experiments, when to stop.
 */

import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { httpClient, type HttpClientResult } from '../mcp-server/tools/http-client.js';
import { cacheTester, type CacheTestResult } from '../mcp-server/tools/cache-tester.js';
import { dnsLookup } from '../mcp-server/tools/dns-lookup.js';
import { wpSiteHealth } from '../mcp-server/tools/wp-site-health.js';
import { analyze, type AnalysisResult } from './analyzer.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface AgentConfig {
  baseUrl: string;
  timeout: number;
  apiKey?: string;
  maxIterations: number;
  verbose: boolean;
}

export interface AgentMemory {
  analyzedPages: Map<string, PageResult>;
  discoveredUrls: Set<string>;
  experiments: ExperimentResult[];
  observations: string[];
  hypotheses: string[];
}

export interface PageResult {
  url: string;
  httpResult: HttpClientResult;
  cacheTest?: CacheTestResult;
  analysis: AnalysisResult;
  timestamp: Date;
}

export interface ExperimentResult {
  name: string;
  hypothesis: string;
  method: string;
  result: string;
  conclusion: string;
}

export interface AgentSummary {
  pagesAnalyzed: number;
  cacheWorking: boolean;
  detectedPlugins: string[];
  detectedCDNs: string[];
  conflicts: string[];
  experiments: ExperimentResult[];
  finalAnalysis: string;
  recommendations: string[];
}

// ============================================================================
// Tool Definitions for the LLM
// ============================================================================

const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'fetch_page',
    description: 'Fetch a page and analyze its cache configuration. Use this to explore different pages on the site.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch and analyze',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'test_cache_behavior',
    description: 'Test how the cache responds to specific conditions. Use this to experiment with cache behavior.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to test',
        },
        test_type: {
          type: 'string',
          enum: ['bypass_header', 'vary_encoding', 'with_cookie', 'query_string', 'mobile_ua', 'post_request'],
          description: 'Type of cache test to run',
        },
        hypothesis: {
          type: 'string',
          description: 'What you expect to happen and why',
        },
      },
      required: ['url', 'test_type', 'hypothesis'],
    },
  },
  {
    name: 'dns_lookup',
    description: 'Perform DNS lookup to detect CDN and hosting provider.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The URL to lookup',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'check_wordpress_api',
    description: 'Query WordPress REST API for site information, plugins, and configuration.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'The base URL of the WordPress site',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'record_observation',
    description: 'Record an observation or insight about the cache configuration.',
    input_schema: {
      type: 'object' as const,
      properties: {
        observation: {
          type: 'string',
          description: 'The observation to record',
        },
      },
      required: ['observation'],
    },
  },
  {
    name: 'form_hypothesis',
    description: 'Form a hypothesis about the cache behavior that you want to test.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hypothesis: {
          type: 'string',
          description: 'The hypothesis to test',
        },
      },
      required: ['hypothesis'],
    },
  },
  {
    name: 'complete_analysis',
    description: 'Call this when you have gathered enough information and are ready to provide final recommendations.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Summary of what you found',
        },
        recommendations: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of specific, actionable recommendations',
        },
        confidence: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'How confident you are in your analysis',
        },
        areas_needing_more_investigation: {
          type: 'array',
          items: { type: 'string' },
          description: 'Areas that would benefit from more investigation',
        },
      },
      required: ['summary', 'recommendations', 'confidence'],
    },
  },
];

const SYSTEM_PROMPT = `You are an autonomous WordPress cache analysis agent. Your job is to thoroughly investigate a website's caching configuration by:

1. EXPLORING: Fetch and analyze different types of pages (homepage, blog posts, product pages, cart, etc.) to understand how caching varies across the site.

2. EXPERIMENTING: Run cache behavior tests to understand how the cache responds to different conditions. Form hypotheses and test them.

3. REASONING: Connect your findings to build a complete picture. If you notice something unexpected, investigate it.

4. DECIDING: You control what to investigate next. Don't follow a fixed script - adapt based on what you find.

## Guidelines

- Start by fetching the homepage and checking WordPress API to understand the setup
- Look for links to different page types and analyze them
- If you detect a caching plugin, test its specific behaviors
- If cache seems broken, investigate why
- Form hypotheses and test them with experiments
- Record observations as you go
- When you have enough information, complete the analysis

## Important

- You have a limited number of iterations, so be strategic
- Don't repeat the same tests - each action should give new information
- If something surprises you, investigate it
- Think out loud about what you're seeing and why

Remember: You are NOT following a script. You are autonomously investigating based on what you discover.`;

// ============================================================================
// Autonomous Agent Implementation
// ============================================================================

export class AutonomousAgent extends EventEmitter {
  private config: AgentConfig;
  private memory: AgentMemory;
  private client: Anthropic;
  private conversationHistory: Anthropic.MessageParam[] = [];
  private iteration = 0;
  private completed = false;
  private finalAnalysis?: {
    summary: string;
    recommendations: string[];
    confidence: string;
    areasNeedingMoreInvestigation?: string[];
  };

  constructor(config: Partial<AgentConfig> & { baseUrl: string }) {
    super();

    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY required for autonomous agent');
    }

    this.config = {
      baseUrl: config.baseUrl,
      timeout: config.timeout ?? 30000,
      apiKey,
      maxIterations: config.maxIterations ?? 20,
      verbose: config.verbose ?? false,
    };

    this.memory = {
      analyzedPages: new Map(),
      discoveredUrls: new Set([this.config.baseUrl]),
      experiments: [],
      observations: [],
      hypotheses: [],
    };

    this.client = new Anthropic({ apiKey });
  }

  async run(): Promise<AgentSummary> {
    this.emit('start', { config: this.config });
    this.log('Autonomous agent starting...');
    this.log(`Target: ${this.config.baseUrl}`);
    this.log(`Max iterations: ${this.config.maxIterations}`);

    // Initial prompt to kick off the agent
    const initialPrompt = `You are analyzing the WordPress site at: ${this.config.baseUrl}

Begin your autonomous investigation. Start by understanding the basic setup, then explore and experiment based on what you find.

What would you like to do first?`;

    this.conversationHistory.push({
      role: 'user',
      content: initialPrompt,
    });

    // Main agent loop - LLM decides what to do
    while (!this.completed && this.iteration < this.config.maxIterations) {
      this.iteration++;
      this.log(`\n--- Iteration ${this.iteration}/${this.config.maxIterations} ---`);

      try {
        const response = await this.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: AGENT_TOOLS,
          messages: this.conversationHistory,
        });

        // Process the response
        await this.processResponse(response);

      } catch (error) {
        this.log(`Error in iteration: ${error}`);
        this.emit('error', { iteration: this.iteration, error });
        break;
      }
    }

    if (!this.completed) {
      this.log('Reached max iterations without completing analysis');
      // Force a completion
      this.finalAnalysis = {
        summary: 'Analysis incomplete - reached iteration limit',
        recommendations: ['Run agent with more iterations for complete analysis'],
        confidence: 'low',
      };
    }

    return this.buildSummary();
  }

  private async processResponse(response: Anthropic.Message): Promise<void> {
    const assistantContent: Anthropic.ContentBlockParam[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        this.log(`Agent thinking: ${block.text}`);
        assistantContent.push({ type: 'text', text: block.text });
        this.emit('thinking', { text: block.text });
      } else if (block.type === 'tool_use') {
        this.log(`Agent action: ${block.name}`);
        assistantContent.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });

        // Execute the tool
        const result = await this.executeTool(block.name, block.input as Record<string, unknown>);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    // Add assistant message to history
    this.conversationHistory.push({
      role: 'assistant',
      content: assistantContent,
    });

    // Add tool results if any
    if (toolResults.length > 0) {
      this.conversationHistory.push({
        role: 'user',
        content: toolResults,
      });
    }

    // Check if we need to continue (if there were tool uses, we need another round)
    if (response.stop_reason === 'tool_use' && !this.completed) {
      // Continue the conversation
      return;
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    this.emit('tool_use', { name, input });

    try {
      switch (name) {
        case 'fetch_page':
          return await this.toolFetchPage(input.url as string);

        case 'test_cache_behavior':
          return await this.toolTestCacheBehavior(
            input.url as string,
            input.test_type as string,
            input.hypothesis as string
          );

        case 'dns_lookup':
          return await this.toolDnsLookup(input.url as string);

        case 'check_wordpress_api':
          return await this.toolCheckWordPressApi(input.url as string);

        case 'record_observation':
          return this.toolRecordObservation(input.observation as string);

        case 'form_hypothesis':
          return this.toolFormHypothesis(input.hypothesis as string);

        case 'complete_analysis':
          return this.toolCompleteAnalysis(
            input.summary as string,
            input.recommendations as string[],
            input.confidence as string,
            input.areas_needing_more_investigation as string[] | undefined
          );

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.log(`Tool error: ${errorMsg}`);
      return `Error executing ${name}: ${errorMsg}`;
    }
  }

  // --------------------------------------------------------------------------
  // Tool Implementations
  // --------------------------------------------------------------------------

  private async toolFetchPage(url: string): Promise<string> {
    this.log(`Fetching: ${url}`);

    // Validate URL is on the same domain
    try {
      const baseHost = new URL(this.config.baseUrl).hostname;
      const targetHost = new URL(url).hostname;
      if (targetHost !== baseHost) {
        return `Cannot fetch ${url} - different domain than ${this.config.baseUrl}`;
      }
    } catch {
      return `Invalid URL: ${url}`;
    }

    const httpResult = await httpClient(url, { timeout: this.config.timeout });
    if (httpResult.error) {
      return `Failed to fetch ${url}: ${httpResult.error}`;
    }

    const cacheTest = await cacheTester(url, { timeout: this.config.timeout });

    // Use the rule-based analyzer
    const analysis = analyze(httpResult, cacheTest);

    // Store results
    this.memory.analyzedPages.set(url, {
      url,
      httpResult,
      cacheTest,
      analysis,
      timestamp: new Date(),
    });

    // Extract links for discovery
    const links = this.extractLinks(httpResult.html, url);
    links.forEach(link => this.memory.discoveredUrls.add(link));

    this.emit('page_analyzed', { url, analysis });

    // Build a useful response for the LLM
    return JSON.stringify({
      url,
      statusCode: httpResult.statusCode,
      isWordPress: analysis.isWordPress,
      cacheStatus: {
        working: analysis.cacheStatus.working,
        header: analysis.cacheStatus.header,
        value: analysis.cacheStatus.value,
        explanation: analysis.cacheStatus.explanation,
      },
      timing: {
        ttfbFirst: cacheTest.doubleHit.firstRequest.ttfb,
        ttfbSecond: cacheTest.doubleHit.secondRequest.ttfb,
        improvement: analysis.timing.improvement,
      },
      detectedPlugins: analysis.plugins.map(p => p.name),
      detectedCDNs: analysis.cdns.map(c => c.name),
      conflicts: analysis.conflicts.map(c => ({
        plugins: c.plugins,
        severity: c.severity,
        reason: c.reason,
      })),
      discoveredLinks: links.slice(0, 10), // First 10 links for LLM to consider
      serverInfo: {
        server: analysis.serverSpecs.server,
        hosting: analysis.hosting,
        phpVersion: analysis.serverSpecs.phpVersion,
      },
    }, null, 2);
  }

  private async toolTestCacheBehavior(
    url: string,
    testType: string,
    hypothesis: string
  ): Promise<string> {
    this.log(`Running cache experiment: ${testType} on ${url}`);
    this.log(`Hypothesis: ${hypothesis}`);

    let headers: Record<string, string> = {};
    let testUrl = url;
    let description = '';

    switch (testType) {
      case 'bypass_header':
        headers = { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' };
        description = 'Testing if cache respects no-cache directive';
        break;

      case 'vary_encoding':
        headers = { 'Accept-Encoding': 'identity' };
        description = 'Testing cache behavior with different Accept-Encoding';
        break;

      case 'with_cookie':
        headers = { 'Cookie': `wordpress_test_cookie=${Date.now()}` };
        description = 'Testing if cookies bypass cache';
        break;

      case 'query_string':
        testUrl = `${url}${url.includes('?') ? '&' : '?'}cache_bust=${Date.now()}`;
        description = 'Testing cache behavior with query strings';
        break;

      case 'mobile_ua':
        headers = {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        };
        description = 'Testing if mobile requests are cached separately';
        break;

      default:
        return `Unknown test type: ${testType}`;
    }

    // Make two requests to test cache behavior
    const firstResult = await httpClient(testUrl, {
      timeout: this.config.timeout,
      headers,
    });

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 500));

    const secondResult = await httpClient(testUrl, {
      timeout: this.config.timeout,
      headers,
    });

    const cacheHitFirst = this.detectCacheHit(firstResult.headers);
    const cacheHitSecond = this.detectCacheHit(secondResult.headers);

    const experiment: ExperimentResult = {
      name: testType,
      hypothesis,
      method: description,
      result: `First request: ${cacheHitFirst ? 'HIT' : 'MISS'} (${firstResult.timing.ttfb}ms), Second: ${cacheHitSecond ? 'HIT' : 'MISS'} (${secondResult.timing.ttfb}ms)`,
      conclusion: '', // LLM will interpret
    };

    this.memory.experiments.push(experiment);
    this.emit('experiment_complete', { experiment });

    return JSON.stringify({
      testType,
      hypothesis,
      description,
      results: {
        firstRequest: {
          statusCode: firstResult.statusCode,
          ttfb: firstResult.timing.ttfb,
          cacheHit: cacheHitFirst,
          cacheHeaders: this.extractCacheHeaders(firstResult.headers),
        },
        secondRequest: {
          statusCode: secondResult.statusCode,
          ttfb: secondResult.timing.ttfb,
          cacheHit: cacheHitSecond,
          cacheHeaders: this.extractCacheHeaders(secondResult.headers),
        },
      },
      interpretation: {
        cacheRespectedBypass: testType === 'bypass_header' && !cacheHitFirst,
        cookiesBypassCache: testType === 'with_cookie' && !cacheHitSecond,
        queryStringsCached: testType === 'query_string' && cacheHitSecond,
        mobileServedSeparately: testType === 'mobile_ua',
      },
    }, null, 2);
  }

  private async toolDnsLookup(url: string): Promise<string> {
    this.log(`DNS lookup: ${url}`);

    const result = await dnsLookup(url);

    return JSON.stringify({
      hostname: result.hostname,
      addresses: result.addresses,
      cnames: result.cnames,
      nameservers: result.nameservers,
      detected: result.detected,
    }, null, 2);
  }

  private async toolCheckWordPressApi(url: string): Promise<string> {
    this.log(`Checking WordPress API: ${url}`);

    const result = await wpSiteHealth(url, { timeout: this.config.timeout });

    return JSON.stringify({
      isWordPress: result.isWordPress,
      wpVersion: result.wpVersion,
      siteName: result.siteName,
      siteDescription: result.siteDescription,
      namespaces: result.namespaces,
      restPlugins: result.restPlugins?.map(p => ({
        name: p.name,
        namespace: p.namespace,
        category: p.category,
      })),
      siteHealth: result.siteHealth ? {
        phpVersion: result.siteHealth.phpVersion,
        mysqlVersion: result.siteHealth.mysqlVersion,
        serverSoftware: result.siteHealth.serverSoftware,
        objectCache: result.siteHealth.objectCache,
        activePluginsCount: result.siteHealth.activePluginsCount,
      } : null,
      error: result.error,
    }, null, 2);
  }

  private toolRecordObservation(observation: string): string {
    this.memory.observations.push(observation);
    this.log(`Observation recorded: ${observation}`);
    this.emit('observation', { observation });
    return `Observation recorded: "${observation}"`;
  }

  private toolFormHypothesis(hypothesis: string): string {
    this.memory.hypotheses.push(hypothesis);
    this.log(`Hypothesis formed: ${hypothesis}`);
    this.emit('hypothesis', { hypothesis });
    return `Hypothesis recorded: "${hypothesis}". You can now test this with test_cache_behavior or fetch_page.`;
  }

  private toolCompleteAnalysis(
    summary: string,
    recommendations: string[],
    confidence: string,
    areasNeedingMoreInvestigation?: string[]
  ): string {
    this.completed = true;
    this.finalAnalysis = {
      summary,
      recommendations,
      confidence,
      areasNeedingMoreInvestigation,
    };

    this.log('Analysis completed');
    this.emit('complete', { summary, recommendations, confidence });

    return 'Analysis complete. The agent will now generate the final report.';
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private extractLinks(html: string, baseUrl: string): string[] {
    const links: string[] = [];
    const base = new URL(baseUrl);
    const linkRegex = /<a[^>]+href=["']([^"']+)["']/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      try {
        const href = match[1];
        if (href.startsWith('#') || href.startsWith('javascript:') ||
            href.startsWith('mailto:') || href.startsWith('tel:')) {
          continue;
        }

        const resolved = new URL(href, baseUrl);
        if (resolved.hostname === base.hostname) {
          const normalized = resolved.origin + resolved.pathname.replace(/\/$/, '');
          if (!links.includes(normalized) && !this.memory.analyzedPages.has(normalized)) {
            links.push(normalized);
          }
        }
      } catch {
        // Invalid URL
      }
    }

    return links;
  }

  private detectCacheHit(headers: Record<string, string>): boolean {
    const cacheHeaders = [
      'x-cache', 'cf-cache-status', 'x-varnish', 'x-proxy-cache',
      'x-kinsta-cache', 'x-wpe-cached', 'x-litespeed-cache'
    ];

    for (const header of cacheHeaders) {
      const value = headers[header]?.toLowerCase();
      if (value && (value.includes('hit') || value === 'cached')) {
        return true;
      }
    }
    return false;
  }

  private extractCacheHeaders(headers: Record<string, string>): Record<string, string> {
    const cacheRelated = [
      'cache-control', 'x-cache', 'cf-cache-status', 'x-varnish',
      'x-proxy-cache', 'x-kinsta-cache', 'x-wpe-cached', 'x-litespeed-cache',
      'age', 'expires', 'vary', 'etag'
    ];

    const result: Record<string, string> = {};
    for (const header of cacheRelated) {
      if (headers[header]) {
        result[header] = headers[header];
      }
    }
    return result;
  }

  private buildSummary(): AgentSummary {
    const pages = Array.from(this.memory.analyzedPages.values());
    const allPlugins = new Set<string>();
    const allCDNs = new Set<string>();
    const allConflicts: string[] = [];

    let cacheWorkingCount = 0;

    for (const page of pages) {
      page.analysis.plugins.forEach(p => allPlugins.add(p.name));
      page.analysis.cdns.forEach(c => allCDNs.add(c.name));

      for (const conflict of page.analysis.conflicts) {
        const key = `${conflict.plugins.join(' + ')}: ${conflict.reason}`;
        if (!allConflicts.includes(key)) {
          allConflicts.push(key);
        }
      }

      if (page.analysis.cacheStatus.working) {
        cacheWorkingCount++;
      }
    }

    return {
      pagesAnalyzed: pages.length,
      cacheWorking: pages.length > 0 && cacheWorkingCount > pages.length / 2,
      detectedPlugins: Array.from(allPlugins),
      detectedCDNs: Array.from(allCDNs),
      conflicts: allConflicts,
      experiments: this.memory.experiments,
      finalAnalysis: this.finalAnalysis?.summary || 'Analysis incomplete',
      recommendations: this.finalAnalysis?.recommendations || [],
    };
  }

  private log(message: string): void {
    if (this.config.verbose) {
      console.error(`[Agent] ${message}`);
    }
    this.emit('log', { message });
  }

  // Public accessors
  getMemory(): AgentMemory {
    return this.memory;
  }

  getIteration(): number {
    return this.iteration;
  }
}
