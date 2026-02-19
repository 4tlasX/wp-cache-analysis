/**
 * Reporter
 * Formats analysis results as JSON or Markdown
 */

import type { AnalysisResult } from './analyzer.js';
import type { LLMAnalysis } from '../llm/analyzer.js';

/**
 * Generate a visual score bar
 */
function getScoreBar(score: number): string {
  const filled = Math.round(score / 10);
  const empty = 10 - filled;
  const color = score >= 80 ? '🟢' : score >= 60 ? '🟡' : '🔴';
  return color + ' [' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

/**
 * Wrap text to a specified width, with special handling for numbered steps
 */
function wrapText(text: string, width: number): string[] {
  // First, split on numbered steps like "1)", "2)", etc. to put each on its own line
  const stepPattern = /(\d+\))/g;
  const hasSteps = stepPattern.test(text);

  if (hasSteps) {
    // Split text into segments by step numbers
    const segments = text.split(/(?=\d+\))/g).filter(s => s.trim());
    const lines: string[] = [];

    for (const segment of segments) {
      const trimmed = segment.trim();
      // Wrap each step individually
      const wrapped = wrapSimple(trimmed, width);
      lines.push(...wrapped);
    }

    return lines.length > 0 ? lines : [''];
  }

  return wrapSimple(text, width);
}

/**
 * Simple word wrap without step handling
 */
function wrapSimple(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.length > 0 ? lines : [''];
}

export interface ReportOptions {
  format: 'json' | 'markdown' | 'text';
  verbose?: boolean;
  llmAnalysis?: LLMAnalysis;
}

export function generateReport(result: AnalysisResult, options: ReportOptions): string {
  switch (options.format) {
    case 'json':
      if (options.llmAnalysis) {
        return JSON.stringify({ ...result, aiAnalysis: options.llmAnalysis }, null, 2);
      }
      return JSON.stringify(result, null, 2);
    case 'markdown':
      return generateMarkdown(result, options.verbose, options.llmAnalysis);
    case 'text':
      return generateText(result, options.verbose, options.llmAnalysis);
    default:
      return JSON.stringify(result, null, 2);
  }
}

function generateMarkdown(result: AnalysisResult, verbose = false, llmAnalysis?: LLMAnalysis): string {
  const lines: string[] = [];

  lines.push('# WordPress Cache Analysis Report');
  lines.push('');
  lines.push(`**URL:** ${result.url}`);
  lines.push(`**WordPress:** ${result.isWordPress ? 'Yes' : 'No'}`);
  lines.push('');

  // Performance
  lines.push('## Performance');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| TTFB (first request) | ${result.timing.ttfb}ms |`);
  if (result.timing.ttfbCached !== undefined) {
    lines.push(`| TTFB (second request) | ${result.timing.ttfbCached}ms |`);
    if (result.timing.improvement && result.timing.improvement > 0) {
      lines.push(`| Cache Improvement | ${result.timing.improvement}% faster |`);
    }
  }
  lines.push('');

  // Server
  lines.push('## Server');
  lines.push('');
  lines.push('| Spec | Value |');
  lines.push('|------|-------|');
  if (result.serverSpecs.hosting) {
    lines.push(`| Hosting | ${result.serverSpecs.hosting} |`);
  }
  if (result.serverSpecs.server) {
    const isCdnServer = result.serverSpecs.server.toLowerCase() === 'cloudflare';
    if (isCdnServer && result.serverSpecs.originServer) {
      lines.push(`| Origin Server | ${result.serverSpecs.originServer} (behind Cloudflare) |`);
    } else if (isCdnServer && !result.serverSpecs.originServer && !result.serverSpecs.hosting) {
      lines.push(`| Proxy | Cloudflare (origin unknown) |`);
    } else if (!isCdnServer) {
      lines.push(`| Server | ${result.serverSpecs.server} |`);
    }
  }
  if (result.serverSpecs.poweredBy) {
    lines.push(`| Platform | ${result.serverSpecs.poweredBy} |`);
  }
  if (result.serverSpecs.phpVersion) {
    lines.push(`| PHP Version | ${result.serverSpecs.phpVersion} |`);
  }
  // Add site health PHP version if we have it and didn't get from headers
  if (result.siteHealth?.phpVersion && !result.serverSpecs.phpVersion) {
    lines.push(`| PHP Version | ${result.siteHealth.phpVersion} |`);
  }
  if (result.siteHealth?.mysqlVersion) {
    lines.push(`| MySQL | ${result.siteHealth.mysqlVersion} |`);
  }
  lines.push('');

  // WordPress Info (from /wp-json/)
  if (result.wpInfo) {
    lines.push('## WordPress Info');
    lines.push('');
    if (result.wpInfo.siteName) {
      lines.push(`**Site Name:** ${result.wpInfo.siteName}`);
    }
    if (result.wpInfo.siteDescription) {
      lines.push(`**Description:** ${result.wpInfo.siteDescription}`);
    }
    // WordPress version: prefer REST API, fallback to head tag generator
    const wpVersion = result.wpInfo.wpVersion || result.headTagInfo?.wpVersion;
    if (wpVersion) {
      lines.push(`**WordPress:** ${wpVersion}`);
    }
    // Theme: prefer Site Health, fallback to body class, then head tag
    const theme = result.siteHealth?.activeTheme || result.bodyClassInfo?.theme || result.headTagInfo?.theme;
    const themeVersion = result.headTagInfo?.themeVersion;
    if (theme) {
      let themeLine = `**Theme:** ${theme}`;
      if (themeVersion) themeLine += ` v${themeVersion}`;
      if (result.bodyClassInfo?.isBlockTheme) themeLine += ' (Block Theme)';
      lines.push(themeLine);
    }
    // SEO plugin from head tags
    if (result.headTagInfo?.seoPlugin) {
      lines.push(`**SEO Plugin:** ${result.headTagInfo.seoPlugin}`);
    }
    if (result.siteHealth?.activePluginsCount !== undefined) {
      lines.push(`**Active Plugins:** ${result.siteHealth.activePluginsCount}`);
    }
    if (result.siteHealth?.isMultisite) {
      lines.push(`**Multisite:** Yes`);
    }
    lines.push('');

    // Plugins detected via REST namespaces
    if (result.wpInfo.restPlugins && result.wpInfo.restPlugins.length > 0) {
      lines.push('### Detected via REST API');
      lines.push('');
      for (const plugin of result.wpInfo.restPlugins) {
        lines.push(`- **${plugin.name}** (${plugin.category || 'plugin'})`);
      }
      lines.push('');
    }

    // Plugins detected via body classes
    if (result.bodyClassInfo) {
      const bodyPlugins: string[] = [];
      if (result.bodyClassInfo.hasWooCommerce) bodyPlugins.push('WooCommerce');
      bodyPlugins.push(...result.bodyClassInfo.otherPlugins);
      if (bodyPlugins.length > 0) {
        lines.push('### Detected via Body Classes');
        lines.push('');
        for (const plugin of bodyPlugins) {
          lines.push(`- **${plugin}**`);
        }
        lines.push('');
      }
    }

    // Plugins detected via head tags (script/style URLs)
    if (result.headTagInfo?.plugins && result.headTagInfo.plugins.length > 0) {
      lines.push('### Detected via Head Tags');
      lines.push('');
      for (const plugin of result.headTagInfo.plugins) {
        const versionStr = plugin.version ? ` v${plugin.version}` : '';
        lines.push(`- **${plugin.name}**${versionStr}`);
      }
      lines.push('');
    }

    // Show namespaces in verbose mode
    if (verbose && result.wpInfo.namespaces.length > 0) {
      lines.push('### REST Namespaces');
      lines.push('');
      lines.push(`\`${result.wpInfo.namespaces.join('`, `')}\``);
      lines.push('');
    }
  }

  // Body class / head tag info (when wpInfo section wasn't shown)
  if (!result.wpInfo && (result.bodyClassInfo || result.headTagInfo)) {
    lines.push('## WordPress Info');
    lines.push('');
    // WordPress version from head tag generator
    if (result.headTagInfo?.wpVersion) {
      lines.push(`**WordPress:** ${result.headTagInfo.wpVersion}`);
    }
    // Theme: prefer body class, then head tag
    const theme = result.bodyClassInfo?.theme || result.headTagInfo?.theme;
    const themeVersion = result.headTagInfo?.themeVersion;
    if (theme) {
      let themeLine = `**Theme:** ${theme}`;
      if (themeVersion) themeLine += ` v${themeVersion}`;
      if (result.bodyClassInfo?.isBlockTheme) themeLine += ' (Block Theme)';
      lines.push(themeLine);
    }
    // SEO plugin
    if (result.headTagInfo?.seoPlugin) {
      lines.push(`**SEO Plugin:** ${result.headTagInfo.seoPlugin}`);
    }
    // Body class plugins
    if (result.bodyClassInfo) {
      const bodyPlugins: string[] = [];
      if (result.bodyClassInfo.hasWooCommerce) bodyPlugins.push('WooCommerce');
      bodyPlugins.push(...result.bodyClassInfo.otherPlugins);
      if (bodyPlugins.length > 0) {
        lines.push('');
        lines.push('### Detected via Body Classes');
        lines.push('');
        for (const plugin of bodyPlugins) {
          lines.push(`- **${plugin}**`);
        }
      }
    }
    // Head tag plugins
    if (result.headTagInfo?.plugins && result.headTagInfo.plugins.length > 0) {
      lines.push('');
      lines.push('### Detected via Head Tags');
      lines.push('');
      for (const plugin of result.headTagInfo.plugins) {
        const versionStr = plugin.version ? ` v${plugin.version}` : '';
        lines.push(`- **${plugin.name}**${versionStr}`);
      }
    }
    lines.push('');
  }

  // Server Environment (from Site Health /info)
  if (result.siteHealth) {
    const envInfo: [string, string][] = [];
    if (result.siteHealth.phpVersion) envInfo.push(['PHP', result.siteHealth.phpVersion]);
    if (result.siteHealth.mysqlVersion) envInfo.push(['MySQL', result.siteHealth.mysqlVersion]);
    if (result.siteHealth.serverSoftware) envInfo.push(['Server', result.siteHealth.serverSoftware]);
    if (result.siteHealth.wpMemoryLimit) envInfo.push(['Memory Limit', result.siteHealth.wpMemoryLimit]);
    if (result.siteHealth.curlVersion) envInfo.push(['cURL', result.siteHealth.curlVersion]);
    if (result.siteHealth.wpDebugMode !== undefined) envInfo.push(['Debug Mode', result.siteHealth.wpDebugMode ? 'Enabled' : 'Disabled']);
    if (result.siteHealth.objectCache) {
      const cacheStatus = result.siteHealth.objectCache.enabled ? '✅ Enabled' : '❌ Disabled';
      const cacheType = result.siteHealth.objectCache.type || 'Unknown';
      envInfo.push(['Object Cache', `${cacheStatus} (${cacheType})`]);
    }

    if (envInfo.length > 0) {
      lines.push('## Server Environment');
      lines.push('');
      lines.push('| Setting | Value |');
      lines.push('|---------|-------|');
      for (const [key, value] of envInfo) {
        lines.push(`| ${key} | ${value} |`);
      }
      lines.push('');
    }
  }

  // SSL
  if (result.ssl) {
    lines.push('## SSL/TLS');
    lines.push('');
    const secureIcon = result.ssl.isSecure ? '✅' : '❌';
    lines.push(`${secureIcon} **HTTPS:** ${result.ssl.isSecure ? 'Yes' : 'No'}`);
    if (result.ssl.tlsVersion) {
      lines.push(`**Protocol:** ${result.ssl.tlsVersion}`);
    }
    if (result.ssl.certificate) {
      lines.push('');
      lines.push('| Certificate | Value |');
      lines.push('|-------------|-------|');
      lines.push(`| Issuer | ${result.ssl.certificate.issuer} |`);
      lines.push(`| Valid From | ${result.ssl.certificate.validFrom} |`);
      lines.push(`| Valid To | ${result.ssl.certificate.validTo} |`);
      const daysIcon = result.ssl.certificate.daysRemaining < 30 ? '⚠️' : '✅';
      lines.push(`| Days Remaining | ${daysIcon} ${result.ssl.certificate.daysRemaining} |`);
      if (result.ssl.certificate.cipher) {
        lines.push(`| Cipher | ${result.ssl.certificate.cipher} |`);
      }
      if (verbose && result.ssl.certificate.altNames && result.ssl.certificate.altNames.length > 0) {
        lines.push('');
        lines.push(`**Alt Names:** ${result.ssl.certificate.altNames.slice(0, 5).join(', ')}${result.ssl.certificate.altNames.length > 5 ? ` (+${result.ssl.certificate.altNames.length - 5} more)` : ''}`);
      }
    }
    if (result.ssl.error) {
      lines.push(`**Error:** ${result.ssl.error}`);
    }
    lines.push('');
  }

  // DNS
  if (result.dns) {
    lines.push('## DNS');
    lines.push('');
    if (result.dns.addresses.length > 0) {
      lines.push(`**IP Addresses:** ${result.dns.addresses.join(', ')}`);
    }
    if (result.dns.cnames.length > 0) {
      lines.push('');
      lines.push('**CNAME Chain:**');
      lines.push(`\`${result.dns.hostname}\` → \`${result.dns.cnames.join('\` → \`')}\``);
    }
    if (result.dns.nameservers.length > 0) {
      lines.push('');
      lines.push(`**Nameservers:** ${result.dns.nameservers.join(', ')}`);
    }
    lines.push('');
  }

  // Cache Status
  lines.push('## Cache Status');
  lines.push('');
  const statusIcon = result.cacheStatus.working ? '✅' : '❌';
  lines.push(`${statusIcon} **${result.cacheStatus.working ? 'Working' : 'Not Working'}**`);
  lines.push('');
  lines.push(`> ${result.cacheStatus.explanation}`);

  // Show all cache status headers
  if (result.cacheStatus.allHeaders && result.cacheStatus.allHeaders.length > 0) {
    lines.push('');
    lines.push('**Cache Headers:**');
    for (const h of result.cacheStatus.allHeaders) {
      const hitIcon = h.isHit ? '✅' : '⚪';
      lines.push(`- ${hitIcon} \`${h.header}: ${h.value}\``);
    }
  }

  // Show additional cache-related headers
  if (result.headers.cfEdgeCache || result.headers.serverTiming || result.headers.speculationRules) {
    lines.push('');
    lines.push('**Additional Headers:**');
    if (result.headers.cfEdgeCache) {
      lines.push(`- \`cf-edge-cache: ${result.headers.cfEdgeCache}\``);
    }
    if (result.headers.speculationRules) {
      lines.push(`- \`speculation-rules: ${result.headers.speculationRules}\``);
    }
    if (result.headers.serverTiming && verbose) {
      lines.push(`- \`server-timing: ${result.headers.serverTiming}\``);
    }
  }
  lines.push('');

  // Detected Stack
  lines.push('## Detected Stack');
  lines.push('');

  if (result.plugins.length > 0) {
    lines.push('### Cache Plugins');
    for (const plugin of result.plugins) {
      lines.push(`- **${plugin.name}** (${plugin.category})`);
      if (verbose) {
        for (const match of plugin.matchedBy) {
          lines.push(`  - Matched by: ${match}`);
        }
      }
    }
    lines.push('');
  } else {
    lines.push('### Cache Plugins');
    lines.push('- None detected');
    lines.push('');
  }

  if (result.cdns.length > 0) {
    lines.push('### CDN');
    for (const cdn of result.cdns) {
      lines.push(`- **${cdn.name}**`);
      if (verbose) {
        for (const match of cdn.matchedBy) {
          lines.push(`  - Matched by: ${match}`);
        }
      }
    }
    lines.push('');
  }

  if (result.serverCache.length > 0) {
    lines.push('### Server Cache');
    for (const cache of result.serverCache) {
      lines.push(`- **${cache.name}**`);
    }
    lines.push('');
  }

  if (result.hosting) {
    lines.push('### Hosting');
    lines.push(`- ${result.hosting}`);
    lines.push('');
  }

  // Detected Plugins (WPScan)
  if (result.detectedPlugins && result.detectedPlugins.length > 0) {
    lines.push('## Detected Plugins');
    lines.push('');
    lines.push('| Plugin | Version | Vulnerabilities |');
    lines.push('|--------|---------|-----------------|');
    for (const plugin of result.detectedPlugins) {
      const vulnCount = plugin.vulnerabilities.length;
      const vulnStatus = vulnCount > 0 ? `⚠️ ${vulnCount} found` : '✅ None';
      lines.push(`| ${plugin.name} | ${plugin.version || 'Unknown'} | ${vulnStatus} |`);
    }
    lines.push('');

    // Show vulnerability details if any
    const pluginsWithVulns = result.detectedPlugins.filter(p => p.vulnerabilities.length > 0);
    if (pluginsWithVulns.length > 0) {
      lines.push('### Vulnerabilities');
      lines.push('');
      for (const plugin of pluginsWithVulns) {
        for (const vuln of plugin.vulnerabilities) {
          const severityIcon = vuln.severity === 'critical' ? '🔴' :
                               vuln.severity === 'high' ? '🟠' :
                               vuln.severity === 'medium' ? '🟡' : '🟢';
          lines.push(`${severityIcon} **${vuln.title}** (${plugin.name})`);
          lines.push(`> Type: ${vuln.type} | Severity: ${vuln.severity || 'Unknown'}`);
          if (vuln.fixedIn) {
            lines.push(`> Fixed in: ${vuln.fixedIn}`);
          }
          lines.push('');
        }
      }
    }
  }

  // Image Analysis
  if (result.imageAnalysis && result.imageAnalysis.totalImages > 0) {
    lines.push('## Image Performance');
    lines.push('');
    lines.push(`**Total Images:** ${result.imageAnalysis.totalImages}`);
    const issueRate = Math.round((result.imageAnalysis.imagesWithIssues / result.imageAnalysis.totalImages) * 100);
    const issueIcon = issueRate > 50 ? '🔴' : issueRate > 25 ? '🟡' : '🟢';
    lines.push(`**Images with Issues:** ${issueIcon} ${result.imageAnalysis.imagesWithIssues} (${issueRate}%)`);
    lines.push('');

    // Summary table
    const { summary } = result.imageAnalysis;
    if (summary.missingDimensions || summary.missingLazyLoad || summary.legacyFormats || summary.missingSrcset) {
      lines.push('| Issue | Count | Impact |');
      lines.push('|-------|-------|--------|');
      if (summary.missingDimensions > 0) {
        lines.push(`| Missing dimensions | ${summary.missingDimensions} | High (CLS) |`);
      }
      if (summary.missingLazyLoad > 0) {
        lines.push(`| Missing lazy loading | ${summary.missingLazyLoad} | Medium |`);
      }
      if (summary.legacyFormats > 0) {
        lines.push(`| Legacy formats (JPG/PNG) | ${summary.legacyFormats} | Medium |`);
      }
      if (summary.missingSrcset > 0) {
        lines.push(`| Missing srcset | ${summary.missingSrcset} | Medium |`);
      }
      if (summary.missingAlt > 0) {
        lines.push(`| Missing alt text | ${summary.missingAlt} | Low (SEO) |`);
      }
      lines.push('');
    }

    // Recommendations
    if (result.imageAnalysis.recommendations.length > 0) {
      lines.push('**Recommendations:**');
      for (const rec of result.imageAnalysis.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }
  }

  // Conflicts
  if (result.conflicts.length > 0) {
    lines.push('## ⚠️ Conflicts Detected');
    lines.push('');
    for (const conflict of result.conflicts) {
      const severityIcon = conflict.severity === 'high' ? '🔴' : conflict.severity === 'medium' ? '🟡' : '🟢';
      lines.push(`${severityIcon} **${conflict.severity.toUpperCase()}:** ${conflict.plugins.join(' + ')}`);
      lines.push(`> ${conflict.reason}`);
      lines.push('');
    }
  }

  // Headers
  if (verbose) {
    lines.push('## Cache Headers');
    lines.push('');
    lines.push('| Header | Value |');
    lines.push('|--------|-------|');
    if (result.headers.cacheControl) {
      lines.push(`| Cache-Control | \`${result.headers.cacheControl}\` |`);
    }
    if (result.headers.expires) {
      lines.push(`| Expires | \`${result.headers.expires}\` |`);
    }
    if (result.headers.etag) {
      lines.push(`| ETag | \`${result.headers.etag}\` |`);
    }
    if (result.headers.lastModified) {
      lines.push(`| Last-Modified | \`${result.headers.lastModified}\` |`);
    }
    if (result.headers.server) {
      lines.push(`| Server | \`${result.headers.server}\` |`);
    }
    lines.push('');
  }

  // AI Analysis
  if (llmAnalysis) {
    lines.push('## AI Analysis');
    lines.push('');
    lines.push(`**Score:** ${llmAnalysis.score}/100`);
    lines.push('');
    lines.push(`> ${llmAnalysis.summary}`);
    lines.push('');

    if (llmAnalysis.issues.length > 0) {
      lines.push('### Issues');
      for (const issue of llmAnalysis.issues) {
        const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
        lines.push(`${icon} **${issue.title}**`);
        lines.push(`> ${issue.description}`);
        lines.push(`> **Fix:** ${issue.fix}`);
        lines.push('');
      }
    }

    if (llmAnalysis.recommendations.length > 0) {
      lines.push('### Recommendations');
      for (const rec of llmAnalysis.recommendations) {
        lines.push(`${rec.priority}. **${rec.title}** (${rec.impact} impact)`);
        lines.push(`   ${rec.description}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function generateText(result: AnalysisResult, verbose = false, llmAnalysis?: LLMAnalysis): string {
  const lines: string[] = [];
  const divider = '═'.repeat(60);

  lines.push(divider);
  lines.push('  WordPress Cache Analysis Report');
  lines.push(divider);
  lines.push('');
  lines.push(`URL: ${result.url}`);
  lines.push(`WordPress: ${result.isWordPress ? 'Yes' : 'No'}`);
  lines.push('');

  // Performance / TTFB
  lines.push('─'.repeat(40));
  lines.push('PERFORMANCE');
  lines.push('─'.repeat(40));
  lines.push(`TTFB (first):  ${result.timing.ttfb}ms`);
  if (result.timing.ttfbCached !== undefined) {
    lines.push(`TTFB (second): ${result.timing.ttfbCached}ms`);
    if (result.timing.improvement && result.timing.improvement > 0) {
      lines.push(`Improvement:   ${result.timing.improvement}% faster`);
    }
  }
  lines.push('');

  // Server Specs
  lines.push('─'.repeat(40));
  lines.push('SERVER');
  lines.push('─'.repeat(40));
  if (result.serverSpecs.hosting) {
    lines.push(`Hosting:  ${result.serverSpecs.hosting}`);
  }
  if (result.serverSpecs.server) {
    // Check if server is a CDN (cloudflare, etc) vs actual origin
    const isCdnServer = result.serverSpecs.server.toLowerCase() === 'cloudflare';
    if (isCdnServer && result.serverSpecs.originServer) {
      lines.push(`Origin:   ${result.serverSpecs.originServer} (behind Cloudflare)`);
    } else if (isCdnServer && !result.serverSpecs.originServer && !result.serverSpecs.hosting) {
      lines.push(`Proxy:    Cloudflare (origin unknown)`);
    } else if (!isCdnServer) {
      lines.push(`Server:   ${result.serverSpecs.server}`);
    }
  }
  if (result.serverSpecs.poweredBy) {
    lines.push(`Platform: ${result.serverSpecs.poweredBy}`);
  }
  if (result.serverSpecs.phpVersion) {
    lines.push(`PHP:      ${result.serverSpecs.phpVersion}`);
  }
  // Add site health PHP version if we have it and didn't get from headers
  if (result.siteHealth?.phpVersion && !result.serverSpecs.phpVersion) {
    lines.push(`PHP:      ${result.siteHealth.phpVersion}`);
  }
  if (result.siteHealth?.mysqlVersion) {
    lines.push(`MySQL:    ${result.siteHealth.mysqlVersion}`);
  }
  lines.push('');

  // WordPress Info (from /wp-json/)
  if (result.wpInfo) {
    lines.push('─'.repeat(40));
    lines.push('WORDPRESS');
    lines.push('─'.repeat(40));
    if (result.wpInfo.siteName) {
      lines.push(`Site:       ${result.wpInfo.siteName}`);
    }
    if (result.wpInfo.siteDescription) {
      lines.push(`Desc:       ${result.wpInfo.siteDescription}`);
    }
    // WordPress version: prefer REST API, fallback to head tag generator
    const wpVersion = result.wpInfo.wpVersion || result.headTagInfo?.wpVersion;
    if (wpVersion) {
      lines.push(`Version:    ${wpVersion}`);
    }
    // Theme: prefer Site Health, fallback to body class, then head tag
    const theme = result.siteHealth?.activeTheme || result.bodyClassInfo?.theme || result.headTagInfo?.theme;
    const themeVersion = result.headTagInfo?.themeVersion;
    if (theme) {
      let themeLine = `Theme:      ${theme}`;
      if (themeVersion) themeLine += ` v${themeVersion}`;
      if (result.bodyClassInfo?.isBlockTheme) themeLine += ' (Block Theme)';
      lines.push(themeLine);
    }
    // SEO plugin from head tags
    if (result.headTagInfo?.seoPlugin) {
      lines.push(`SEO:        ${result.headTagInfo.seoPlugin}`);
    }
    if (result.siteHealth?.activePluginsCount !== undefined) {
      lines.push(`Plugins:    ${result.siteHealth.activePluginsCount} active`);
    }
    if (result.siteHealth?.isMultisite) {
      lines.push(`Multisite:  Yes`);
    }

    // Plugins detected via REST namespaces
    if (result.wpInfo.restPlugins && result.wpInfo.restPlugins.length > 0) {
      lines.push('');
      lines.push('  REST Plugins:');
      for (const plugin of result.wpInfo.restPlugins) {
        lines.push(`    • ${plugin.name} (${plugin.category || 'plugin'})`);
      }
    }

    // Plugins detected via body classes
    if (result.bodyClassInfo) {
      const bodyPlugins: string[] = [];
      if (result.bodyClassInfo.hasWooCommerce) bodyPlugins.push('WooCommerce');
      bodyPlugins.push(...result.bodyClassInfo.otherPlugins);
      if (bodyPlugins.length > 0) {
        lines.push('');
        lines.push('  Body Class Plugins:');
        for (const plugin of bodyPlugins) {
          lines.push(`    • ${plugin}`);
        }
      }
    }

    // Plugins detected via head tags (script/style URLs)
    if (result.headTagInfo?.plugins && result.headTagInfo.plugins.length > 0) {
      lines.push('');
      lines.push('  Head Tag Plugins:');
      for (const plugin of result.headTagInfo.plugins) {
        const versionStr = plugin.version ? ` v${plugin.version}` : '';
        lines.push(`    • ${plugin.name}${versionStr}`);
      }
    }

    // Show namespaces in verbose mode
    if (verbose && result.wpInfo.namespaces.length > 0) {
      lines.push('');
      lines.push(`  Namespaces: ${result.wpInfo.namespaces.slice(0, 10).join(', ')}${result.wpInfo.namespaces.length > 10 ? ` (+${result.wpInfo.namespaces.length - 10})` : ''}`);
    }
    lines.push('');
  }

  // Body class / head tag info (when wpInfo section wasn't shown)
  if (!result.wpInfo && (result.bodyClassInfo || result.headTagInfo)) {
    lines.push('─'.repeat(40));
    lines.push('WORDPRESS');
    lines.push('─'.repeat(40));
    // WordPress version from head tag generator
    if (result.headTagInfo?.wpVersion) {
      lines.push(`Version:    ${result.headTagInfo.wpVersion}`);
    }
    // Theme: prefer body class, then head tag
    const theme = result.bodyClassInfo?.theme || result.headTagInfo?.theme;
    const themeVersion = result.headTagInfo?.themeVersion;
    if (theme) {
      let themeLine = `Theme:      ${theme}`;
      if (themeVersion) themeLine += ` v${themeVersion}`;
      if (result.bodyClassInfo?.isBlockTheme) themeLine += ' (Block Theme)';
      lines.push(themeLine);
    }
    // SEO plugin
    if (result.headTagInfo?.seoPlugin) {
      lines.push(`SEO:        ${result.headTagInfo.seoPlugin}`);
    }
    // Body class plugins
    if (result.bodyClassInfo) {
      const bodyPlugins: string[] = [];
      if (result.bodyClassInfo.hasWooCommerce) bodyPlugins.push('WooCommerce');
      bodyPlugins.push(...result.bodyClassInfo.otherPlugins);
      if (bodyPlugins.length > 0) {
        lines.push('');
        lines.push('  Body Class Plugins:');
        for (const plugin of bodyPlugins) {
          lines.push(`    • ${plugin}`);
        }
      }
    }
    // Head tag plugins
    if (result.headTagInfo?.plugins && result.headTagInfo.plugins.length > 0) {
      lines.push('');
      lines.push('  Head Tag Plugins:');
      for (const plugin of result.headTagInfo.plugins) {
        const versionStr = plugin.version ? ` v${plugin.version}` : '';
        lines.push(`    • ${plugin.name}${versionStr}`);
      }
    }
    lines.push('');
  }

  // Server Environment (from Site Health /info)
  if (result.siteHealth) {
    if (result.siteHealth.phpVersion || result.siteHealth.mysqlVersion ||
        result.siteHealth.serverSoftware || result.siteHealth.wpMemoryLimit) {
      lines.push('  Environment:');
      if (result.siteHealth.phpVersion) lines.push(`    PHP:      ${result.siteHealth.phpVersion}`);
      if (result.siteHealth.mysqlVersion) lines.push(`    MySQL:    ${result.siteHealth.mysqlVersion}`);
      if (result.siteHealth.serverSoftware) lines.push(`    Server:   ${result.siteHealth.serverSoftware}`);
      if (result.siteHealth.wpMemoryLimit) lines.push(`    Memory:   ${result.siteHealth.wpMemoryLimit}`);
      if (result.siteHealth.curlVersion) lines.push(`    cURL:     ${result.siteHealth.curlVersion}`);
      if (result.siteHealth.wpDebugMode !== undefined) {
        lines.push(`    Debug:    ${result.siteHealth.wpDebugMode ? 'Enabled' : 'Disabled'}`);
      }
      if (result.siteHealth.objectCache) {
        const icon = result.siteHealth.objectCache.enabled ? '✓' : '✗';
        const type = result.siteHealth.objectCache.type || 'Unknown';
        lines.push(`    ObjCache: ${icon} ${result.siteHealth.objectCache.enabled ? 'Enabled' : 'Disabled'} (${type})`);
      }
      lines.push('');
    }
    lines.push('');
  }

  // SSL
  if (result.ssl) {
    lines.push('─'.repeat(40));
    lines.push('SSL/TLS');
    lines.push('─'.repeat(40));
    const secureIcon = result.ssl.isSecure ? '✓' : '✗';
    lines.push(`HTTPS:    ${secureIcon} ${result.ssl.isSecure ? 'Yes' : 'No'}`);
    if (result.ssl.tlsVersion) {
      lines.push(`Protocol: ${result.ssl.tlsVersion}`);
    }
    if (result.ssl.certificate) {
      lines.push(`Issuer:   ${result.ssl.certificate.issuer}`);
      lines.push(`Valid:    ${result.ssl.certificate.validFrom} - ${result.ssl.certificate.validTo}`);
      const daysIcon = result.ssl.certificate.daysRemaining < 30 ? '!' : '✓';
      lines.push(`Expires:  ${daysIcon} ${result.ssl.certificate.daysRemaining} days remaining`);
      if (result.ssl.certificate.cipher) {
        lines.push(`Cipher:   ${result.ssl.certificate.cipher}`);
      }
      if (verbose && result.ssl.certificate.altNames && result.ssl.certificate.altNames.length > 0) {
        lines.push(`SANs:     ${result.ssl.certificate.altNames.slice(0, 3).join(', ')}${result.ssl.certificate.altNames.length > 3 ? ` (+${result.ssl.certificate.altNames.length - 3})` : ''}`);
      }
    }
    if (result.ssl.error) {
      lines.push(`Error:    ${result.ssl.error}`);
    }
    lines.push('');
  }

  // DNS
  if (result.dns) {
    lines.push('─'.repeat(40));
    lines.push('DNS');
    lines.push('─'.repeat(40));
    if (result.dns.addresses.length > 0) {
      lines.push(`IPs:      ${result.dns.addresses.join(', ')}`);
    }
    if (result.dns.cnames.length > 0) {
      lines.push(`CNAMEs:   ${result.dns.hostname} → ${result.dns.cnames.join(' → ')}`);
    }
    if (result.dns.nameservers.length > 0) {
      lines.push(`NS:       ${result.dns.nameservers.join(', ')}`);
    }
    lines.push('');
  }

  // Cache Status
  lines.push('─'.repeat(40));
  lines.push('CACHE STATUS');
  lines.push('─'.repeat(40));
  const statusIcon = result.cacheStatus.working ? '✓' : '✗';
  lines.push(`${statusIcon} ${result.cacheStatus.working ? 'Working' : 'Not Working'}`);
  lines.push(`  ${result.cacheStatus.explanation}`);

  // Show all cache status headers
  if (result.cacheStatus.allHeaders && result.cacheStatus.allHeaders.length > 0) {
    lines.push('');
    lines.push('  Cache Headers:');
    for (const h of result.cacheStatus.allHeaders) {
      const hitIcon = h.isHit ? '✓' : '○';
      lines.push(`    ${hitIcon} ${h.header}: ${h.value}`);
    }
  }

  // Show additional cache-related headers
  if (result.headers.cfEdgeCache || result.headers.serverTiming || result.headers.speculationRules) {
    lines.push('');
    lines.push('  Additional:');
    if (result.headers.cfEdgeCache) {
      lines.push(`    cf-edge-cache: ${result.headers.cfEdgeCache}`);
    }
    if (result.headers.speculationRules) {
      lines.push(`    speculation-rules: ${result.headers.speculationRules}`);
    }
    if (result.headers.serverTiming && verbose) {
      lines.push(`    server-timing: ${result.headers.serverTiming}`);
    }
  }
  lines.push('');

  // Stack
  lines.push('─'.repeat(40));
  lines.push('DETECTED STACK');
  lines.push('─'.repeat(40));

  if (result.plugins.length > 0) {
    lines.push('Cache Plugins:');
    for (const plugin of result.plugins) {
      lines.push(`  • ${plugin.name} (${plugin.category})`);
      if (verbose) {
        for (const match of plugin.matchedBy) {
          lines.push(`    └ ${match}`);
        }
      }
    }
  } else {
    lines.push('Cache Plugins: None detected');
  }

  if (result.cdns.length > 0) {
    lines.push('CDN:');
    for (const cdn of result.cdns) {
      lines.push(`  • ${cdn.name}`);
    }
  }

  if (result.serverCache.length > 0) {
    lines.push('Server Cache:');
    for (const cache of result.serverCache) {
      lines.push(`  • ${cache.name}`);
    }
  }

  if (result.hosting) {
    lines.push(`Hosting: ${result.hosting}`);
  }

  lines.push('');

  // Detected Plugins (WPScan)
  if (result.detectedPlugins && result.detectedPlugins.length > 0) {
    lines.push('─'.repeat(40));
    lines.push('DETECTED PLUGINS');
    lines.push('─'.repeat(40));
    for (const plugin of result.detectedPlugins) {
      const vulnCount = plugin.vulnerabilities.length;
      const vulnStatus = vulnCount > 0 ? `⚠ ${vulnCount} vulnerabilities` : '✓ No known vulnerabilities';
      lines.push(`  • ${plugin.name} ${plugin.version ? `v${plugin.version}` : ''}`);
      lines.push(`    ${vulnStatus}`);
    }
    lines.push('');

    // Show vulnerability details
    const pluginsWithVulns = result.detectedPlugins.filter(p => p.vulnerabilities.length > 0);
    if (pluginsWithVulns.length > 0) {
      lines.push('─'.repeat(40));
      lines.push('⚠ VULNERABILITIES');
      lines.push('─'.repeat(40));
      for (const plugin of pluginsWithVulns) {
        for (const vuln of plugin.vulnerabilities) {
          const severityLabel = vuln.severity?.toUpperCase() || 'UNKNOWN';
          lines.push(`[${severityLabel}] ${vuln.title}`);
          lines.push(`  Plugin: ${plugin.name}`);
          lines.push(`  Type: ${vuln.type}`);
          if (vuln.fixedIn) {
            lines.push(`  Fixed in: ${vuln.fixedIn}`);
          }
          lines.push('');
        }
      }
    }
  }

  // Image Analysis
  if (result.imageAnalysis && result.imageAnalysis.totalImages > 0) {
    lines.push('─'.repeat(40));
    lines.push('IMAGE PERFORMANCE');
    lines.push('─'.repeat(40));
    lines.push(`Total Images:  ${result.imageAnalysis.totalImages}`);
    const issueRate = Math.round((result.imageAnalysis.imagesWithIssues / result.imageAnalysis.totalImages) * 100);
    const issueIcon = issueRate > 50 ? '✗' : issueRate > 25 ? '!' : '✓';
    lines.push(`With Issues:   ${issueIcon} ${result.imageAnalysis.imagesWithIssues} (${issueRate}%)`);
    lines.push('');

    const { summary } = result.imageAnalysis;
    if (summary.missingDimensions > 0) {
      lines.push(`  • Missing dimensions: ${summary.missingDimensions} (causes CLS)`);
    }
    if (summary.missingLazyLoad > 0) {
      lines.push(`  • Missing lazy load:  ${summary.missingLazyLoad}`);
    }
    if (summary.legacyFormats > 0) {
      lines.push(`  • Legacy formats:     ${summary.legacyFormats} (use WebP/AVIF)`);
    }
    if (summary.missingSrcset > 0) {
      lines.push(`  • Missing srcset:     ${summary.missingSrcset}`);
    }
    if (summary.missingAlt > 0) {
      lines.push(`  • Missing alt text:   ${summary.missingAlt}`);
    }

    if (result.imageAnalysis.recommendations.length > 0) {
      lines.push('');
      lines.push('  Recommendations:');
      for (const rec of result.imageAnalysis.recommendations) {
        lines.push(`    → ${rec}`);
      }
    }
    lines.push('');
  }

  // Conflicts
  if (result.conflicts.length > 0) {
    lines.push('─'.repeat(40));
    lines.push('⚠ CONFLICTS');
    lines.push('─'.repeat(40));
    for (const conflict of result.conflicts) {
      lines.push(`[${conflict.severity.toUpperCase()}] ${conflict.plugins.join(' + ')}`);
      lines.push(`  ${conflict.reason}`);
    }
    lines.push('');
  }

  // Headers
  if (verbose && Object.values(result.headers).some(v => v)) {
    lines.push('─'.repeat(40));
    lines.push('CACHE HEADERS');
    lines.push('─'.repeat(40));
    if (result.headers.cacheControl) lines.push(`Cache-Control: ${result.headers.cacheControl}`);
    if (result.headers.expires) lines.push(`Expires: ${result.headers.expires}`);
    if (result.headers.etag) lines.push(`ETag: ${result.headers.etag}`);
    if (result.headers.lastModified) lines.push(`Last-Modified: ${result.headers.lastModified}`);
    if (result.headers.server) lines.push(`Server: ${result.headers.server}`);
    lines.push('');
  }

  // AI Analysis
  if (llmAnalysis) {
    lines.push('');
    lines.push('╔' + '═'.repeat(78) + '╗');
    lines.push('║' + '  AI ANALYSIS'.padEnd(78) + '║');
    lines.push('╚' + '═'.repeat(78) + '╝');
    lines.push('');

    // Score with visual bar
    const scoreBar = getScoreBar(llmAnalysis.score);
    lines.push(`  Score: ${llmAnalysis.score}/100  ${scoreBar}`);
    lines.push('');

    // Summary in a box
    lines.push('  ┌' + '─'.repeat(76) + '┐');
    const summaryLines = wrapText(llmAnalysis.summary, 74);
    for (const line of summaryLines) {
      lines.push('  │ ' + line.padEnd(75) + '│');
    }
    lines.push('  └' + '─'.repeat(76) + '┘');
    lines.push('');

    if (llmAnalysis.issues.length > 0) {
      lines.push('  ▼ ISSUES');
      lines.push('  ' + '─'.repeat(76));
      for (const issue of llmAnalysis.issues) {
        const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
        lines.push('');
        lines.push(`  ${icon} ${issue.title}`);
        lines.push('');
        // Wrap description
        const descLines = wrapText(issue.description, 72);
        for (const line of descLines) {
          lines.push(`     ${line}`);
        }
        lines.push('');
        // Wrap fix with "Fix:" prefix
        lines.push('     💡 Fix:');
        const fixLines = wrapText(issue.fix, 70);
        for (const line of fixLines) {
          lines.push(`        ${line}`);
        }
      }
      lines.push('');
    }

    if (llmAnalysis.recommendations.length > 0) {
      lines.push('  ▼ RECOMMENDATIONS');
      lines.push('  ' + '─'.repeat(76));
      for (const rec of llmAnalysis.recommendations) {
        const impactIcon = rec.impact === 'high' ? '⬆️' : rec.impact === 'medium' ? '➡️' : '⬇️';
        lines.push('');
        lines.push(`  ${rec.priority}. ${rec.title}`);
        lines.push(`     Impact: ${impactIcon} ${rec.impact}`);
        lines.push('');
        // Wrap description
        const descLines = wrapText(rec.description, 72);
        for (const line of descLines) {
          lines.push(`     ${line}`);
        }
      }
      lines.push('');
    }
  }

  lines.push(divider);

  return lines.join('\n');
}
