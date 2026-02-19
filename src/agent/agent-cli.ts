#!/usr/bin/env node
/**
 * Autonomous WP Cache Analysis Agent CLI
 *
 * This is a TRUE autonomous agent where the LLM decides:
 * - What pages to explore
 * - What experiments to run
 * - When it has enough information to stop
 */

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { AutonomousAgent, type AgentSummary } from './autonomous-agent.js';

const program = new Command();

program
  .name('wp-agent')
  .description('Autonomous WordPress Cache Analysis Agent - LLM-driven investigation')
  .version('1.0.0');

function printSummary(summary: AgentSummary): void {
  console.log('');
  console.log(chalk.bold('═══════════════════════════════════════════════════════════════'));
  console.log(chalk.bold.cyan('              AUTONOMOUS AGENT ANALYSIS REPORT'));
  console.log(chalk.bold('═══════════════════════════════════════════════════════════════'));
  console.log('');

  // Overview
  console.log(chalk.bold('📊 Investigation Summary'));
  console.log(`   Pages analyzed: ${chalk.yellow(summary.pagesAnalyzed)}`);
  console.log(`   Cache working: ${summary.cacheWorking ? chalk.green('YES') : chalk.red('NO')}`);
  console.log(`   Experiments run: ${chalk.yellow(summary.experiments.length)}`);
  console.log('');

  // Detected Stack
  if (summary.detectedPlugins.length > 0 || summary.detectedCDNs.length > 0) {
    console.log(chalk.bold('🔧 Detected Stack'));
    if (summary.detectedPlugins.length > 0) {
      console.log(`   Plugins: ${summary.detectedPlugins.join(', ')}`);
    }
    if (summary.detectedCDNs.length > 0) {
      console.log(`   CDNs: ${summary.detectedCDNs.join(', ')}`);
    }
    console.log('');
  }

  // Conflicts
  if (summary.conflicts.length > 0) {
    console.log(chalk.bold.red('⚠️  Conflicts Detected'));
    for (const conflict of summary.conflicts) {
      console.log(`   ${chalk.red('•')} ${conflict}`);
    }
    console.log('');
  }

  // Experiments
  if (summary.experiments.length > 0) {
    console.log(chalk.bold('🧪 Experiments Conducted'));
    for (const exp of summary.experiments) {
      console.log(`   ${chalk.blue('•')} ${exp.name}: ${exp.result}`);
    }
    console.log('');
  }

  // Agent's Analysis
  console.log(chalk.bold('🤖 Agent Analysis'));
  console.log(`   ${summary.finalAnalysis}`);
  console.log('');

  // Recommendations
  if (summary.recommendations.length > 0) {
    console.log(chalk.bold('💡 Recommendations'));
    for (let i = 0; i < summary.recommendations.length; i++) {
      console.log(`   ${i + 1}. ${summary.recommendations[i]}`);
    }
    console.log('');
  }

  console.log(chalk.bold('═══════════════════════════════════════════════════════════════'));
}

program
  .argument('<url>', 'Base URL to analyze')
  .option('--max-iterations <n>', 'Maximum agent iterations', '20')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
  .option('--anthropic-key <key>', 'Anthropic API key')
  .option('-v, --verbose', 'Show agent thinking process')
  .option('--json', 'Output as JSON')
  .action(async (url: string, options) => {
    try {
      // Validate URL
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.error(chalk.red('Error: Only HTTP/HTTPS URLs are supported'));
        process.exit(1);
      }

      // Check for API key
      const apiKey = options.anthropicKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.error(chalk.red('Error: Anthropic API key required.'));
        console.error(chalk.yellow('Set ANTHROPIC_API_KEY or use --anthropic-key'));
        process.exit(1);
      }

      if (!options.json) {
        console.log(chalk.cyan('\n🤖 Starting Autonomous Agent\n'));
        console.log(chalk.gray(`Target: ${url}`));
        console.log(chalk.gray(`Max iterations: ${options.maxIterations}`));
        console.log(chalk.gray('The agent will autonomously decide what to investigate.\n'));
      }

      // Create agent
      const agent = new AutonomousAgent({
        baseUrl: url,
        timeout: parseInt(options.timeout, 10),
        apiKey,
        maxIterations: parseInt(options.maxIterations, 10),
        verbose: options.verbose === true,
      });

      // Set up event handlers
      if (options.verbose && !options.json) {
        agent.on('thinking', ({ text }) => {
          console.log(chalk.gray(`\n💭 ${text}\n`));
        });

        agent.on('tool_use', ({ name, input }) => {
          console.log(chalk.yellow(`⚡ Action: ${name}`));
          if (name === 'fetch_page' || name === 'test_cache_behavior') {
            console.log(chalk.gray(`   URL: ${(input as Record<string, unknown>).url}`));
          }
        });

        agent.on('observation', ({ observation }) => {
          console.log(chalk.blue(`📝 Observation: ${observation}`));
        });

        agent.on('hypothesis', ({ hypothesis }) => {
          console.log(chalk.magenta(`🔬 Hypothesis: ${hypothesis}`));
        });

        agent.on('page_analyzed', ({ url: pageUrl, analysis }) => {
          const status = analysis.cacheStatus.working
            ? chalk.green('✓ cached')
            : chalk.yellow('✗ not cached');
          console.log(chalk.gray(`   Result: ${status}`));
        });

        agent.on('experiment_complete', ({ experiment }) => {
          console.log(chalk.gray(`   Result: ${experiment.result}`));
        });
      } else if (!options.json) {
        // Non-verbose: just show progress
        agent.on('tool_use', ({ name }) => {
          const icons: Record<string, string> = {
            fetch_page: '🔍',
            test_cache_behavior: '🧪',
            dns_lookup: '🌐',
            check_wordpress_api: '📡',
            record_observation: '📝',
            form_hypothesis: '🔬',
            complete_analysis: '✅',
          };
          process.stdout.write(icons[name] || '•');
        });
      }

      // Handle SIGINT
      process.on('SIGINT', () => {
        console.error(chalk.yellow('\n\nInterrupted by user'));
        process.exit(1);
      });

      // Run the agent
      const summary = await agent.run();

      if (!options.json) {
        console.log('\n'); // New line after progress dots
      }

      // Output results
      if (options.json) {
        console.log(JSON.stringify({
          summary,
          memory: {
            observations: agent.getMemory().observations,
            hypotheses: agent.getMemory().hypotheses,
            pagesAnalyzed: Array.from(agent.getMemory().analyzedPages.keys()),
          },
          iterations: agent.getIteration(),
        }, null, 2));
      } else {
        printSummary(summary);

        // Show observations if any
        const memory = agent.getMemory();
        if (memory.observations.length > 0) {
          console.log(chalk.bold('📝 Agent Observations'));
          for (const obs of memory.observations) {
            console.log(`   ${chalk.gray('•')} ${obs}`);
          }
          console.log('');
        }

        console.log(chalk.gray(`Completed in ${agent.getIteration()} iterations`));
      }

    } catch (error) {
      if (error instanceof Error && error.message.includes('Invalid URL')) {
        console.error(chalk.red('Error: Invalid URL format'));
      } else {
        console.error(chalk.red(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      }
      process.exit(1);
    }
  });

program.parse();
