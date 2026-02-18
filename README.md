# WP Cache Analysis Agent

A CLI tool that analyzes WordPress websites to detect caching configurations, CDNs, and potential conflicts — without requiring backend access. It optionally uses AI to provide improvement suggestions and solutions.

## Installation

```bash
npm install
npm run build
```

## Usage

### Basic Analysis

```bash
# Analyze a WordPress site
node dist/agent/index.js https://example.com

# Skip cache testing (faster)
node dist/agent/index.js https://example.com --no-cache-test

# Skip DNS lookup
node dist/agent/index.js https://example.com --no-dns

# Custom timeout (default: 30000ms)
node dist/agent/index.js https://example.com --timeout 60000

# Verbose output
node dist/agent/index.js https://example.com -v
```

### Plugin Detection & Security Scan

```bash
# Detect installed plugins by probing common paths
node dist/agent/index.js https://example.com --wpscan

# With vulnerability checking (requires WPScan API token)
node dist/agent/index.js https://example.com --wpscan --wpscan-token YOUR_API_TOKEN

# Combined with verbose output
node dist/agent/index.js https://example.com --wpscan -v
```

**WPScan API:**
- Free tier: 25 requests/day
- Get your token at [wpscan.com](https://wpscan.com/api)
- Without token: detects plugins only
- With token: checks against 70,000+ known vulnerabilities

### Output Formats

```bash
# Text (default)
node dist/agent/index.js https://example.com

# JSON
node dist/agent/index.js https://example.com -f json

# Markdown
node dist/agent/index.js https://example.com -f markdown
```

### AI-Powered Analysis

AI analysis provides deep insights, scores your cache configuration, and generates prioritized recommendations.

```bash
# Enable AI analysis (uses Claude by default)
node dist/agent/index.js https://example.com --ai

# With API key
# Or use .env file (recommended)
cp .env.example .env
# Edit .env and add your API key
node dist/agent/index.js https://example.com --ai

# Use local Ollama instead of Claude
node dist/agent/index.js https://example.com --ai --local

# AI with verbose output
node dist/agent/index.js https://example.com --ai -v
```

**Providers:**
- **Claude (default)** — Anthropic API, requires `ANTHROPIC_API_KEY` in `.env` or via `--anthropic-key`. Includes web search for additional context.
- **Local Ollama** — Requires [Ollama](https://ollama.ai) running locally, uses `phi3:mini`

**Privacy:** When using Claude, site URLs, names, and descriptions are automatically anonymized before being sent to the API. Only cache-relevant headers and technical data are shared.

## How It Works

1. **HTTP Client** — Fetches the URL, captures headers and HTML
2. **Cache Tester** — Makes two requests to check for cache HITs across all cache headers
3. **DNS Lookup** — Resolves CNAME chain to detect CDN providers
4. **SSL Info** — Connects via TLS to extract certificate details (issuer, expiry, protocol, cipher)
5. **WP REST API** — Fetches WordPress info (3 requests):
   - `/wp-json/` — Site name, namespaces (detects 50+ plugins like WP Rocket, Yoast, WooCommerce)
   - `/wp-json/wp-site-health/v1/info` — PHP, MySQL, memory limits, active theme, plugins
   - `/wp-content/object-cache.php` — Probes for Redis/Memcached/APCu object caching
6. **Image Analyzer** — Parses HTML for image performance issues (missing dimensions, lazy loading, srcset, formats)
7. **Analyzer** — Matches responses against signature database, detects conflicts
8. **Reporter** — Generates human-readable or JSON output

## Project Structure

```
wp-analysis/
├── config/
│   └── signatures.yaml      # Plugin/CDN fingerprints
├── src/
│   ├── agent/
│   │   ├── index.ts         # CLI entry point
│   │   ├── analyzer.ts      # Signature matching
│   │   └── reporter.ts      # Output formatting
│   ├── llm/
│   │   ├── client.ts        # Ollama client + auto-pull
│   │   ├── claude-client.ts # Claude API + anonymization
│   │   └── analyzer.ts      # AI analysis (Claude or local)
│   └── mcp-server/
│       ├── index.ts         # MCP server
│       └── tools/
│           ├── http-client.ts
│           ├── cache-tester.ts
│           ├── dns-lookup.ts
│           ├── wpscan.ts          # Plugin detection & vuln scanning
│           ├── wp-site-health.ts  # WP REST API + object cache probing
│           ├── ssl-info.ts        # SSL certificate analysis
│           └── image-analyzer.ts  # Image performance analysis
├── package.json
└── tsconfig.json
```

## Signatures

Detection is based on `config/signatures.yaml` which contains:

- **HTML comments** — `<!-- Cached by WP Rocket`
- **HTTP headers** — `X-LiteSpeed-Cache`, `CF-Cache-Status`
- **File paths** — `/wp-content/cache/wp-rocket/`
- **Cookies** — `rocket_cache_active`
- **Server headers** — `cloudflare`, `LiteSpeed`
- **Conflicts** — 50+ plugin conflict definitions:
  - Page cache conflicts (WP Rocket + W3TC, LiteSpeed + WP Super Cache, etc.)
  - SEO plugin conflicts (Yoast + Rank Math, AIOSEO + SEO Framework)
  - Security plugin overlaps (Wordfence + iThemes, Sucuri + Defender)
  - Optimization conflicts (Autoptimize + Perfmatters, NitroPack + Flying Scripts)
  - Image optimizer conflicts (Imagify + Smush, EWWW + ShortPixel)

### Adding New Signatures

```yaml
plugins:
  my-plugin:
    name: "My Cache Plugin"
    category: "page-cache"
    signatures:
      html_comments:
        - "<!-- My Cache Plugin"
      headers:
        - "X-My-Cache"
      paths:
        - "/wp-content/plugins/my-plugin/"
```

## MCP Server

The tools are also available as an MCP server:

```bash
node dist/mcp-server/index.js
```

This exposes the tools via Model Context Protocol for use with AI agents.

## Example Output

```
════════════════════════════════════════════════════════════
  WordPress Cache Analysis Report
════════════════════════════════════════════════════════════

URL: https://example.com
WordPress: Yes

────────────────────────────────────────
PERFORMANCE
────────────────────────────────────────
TTFB (first):  245ms
TTFB (second): 42ms
Improvement:   83% faster

────────────────────────────────────────
SERVER
────────────────────────────────────────
Server:   nginx
Platform: PHP/8.2.0
PHP:      8.2.0
Hosting:  Kinsta

  Environment:
    PHP:      8.2.0
    MySQL:    8.0.32
    Memory:   256M
    ObjCache: ✓ Enabled (Redis)

────────────────────────────────────────
CACHE STATUS
────────────────────────────────────────
✓ Working
  CF-Cache-Status: HIT

────────────────────────────────────────
DETECTED STACK
────────────────────────────────────────
Cache Plugins:
  • WP Rocket (page-cache)
CDN:
  • Cloudflare
Server Cache:
  • Nginx FastCGI

────────────────────────────────────────
IMAGE PERFORMANCE
────────────────────────────────────────
Total Images:  24
With Issues:   ! 12 (50%)

  • Missing dimensions: 8 (causes CLS)
  • Missing lazy load:  4
  • Legacy formats:     6 (use WebP/AVIF)

  Recommendations:
    → Add width and height to 8 image(s) to prevent layout shifts
    → Add loading="lazy" to 4 below-fold image(s)
    → Convert 6 image(s) from JPG/PNG to WebP/AVIF

────────────────────────────────────────
⚠ CONFLICTS
────────────────────────────────────────
[MEDIUM] WP Rocket + Autoptimize
  Both can minify CSS/JS

════════════════════════════════════════════════════════════
```

### AI Analysis Report

When using `--ai`, Claude analyzes the cache configuration and provides a scored assessment with prioritized recommendations:

```
────────────────────────────────────────
AI ANALYSIS (Score: 78/100)
────────────────────────────────────────
Summary:
  This site uses a solid cache stack with WP Rocket and Cloudflare CDN.
  Page caching is working correctly with 83% TTFB improvement. Redis
  object cache is properly configured for database query optimization.

Issues:
  [HIGH] Autoptimize CSS/JS overlap with WP Rocket
    Both plugins are configured to minify and combine CSS/JS files,
    which can cause conflicts and double-processing.
    Fix: Disable minification in Autoptimize since WP Rocket handles this.
         Go to Autoptimize > JS, CSS & HTML and uncheck "Optimize CSS/JS".

  [MEDIUM] Images not using next-gen formats
    50% of images are using legacy JPG/PNG formats instead of WebP/AVIF.
    Fix: Enable WebP conversion in WP Rocket > Media > WebP caching,
         or use a dedicated image optimizer like Imagify or ShortPixel.

  [LOW] Missing lazy loading on 4 images
    Some above-fold images lack loading="lazy" attribute.
    Fix: WP Rocket automatically handles this. Check Settings > Media >
         LazyLoad and ensure "Enable for images" is checked.

Recommendations:
  1. [HIGH] Configure Cloudflare page rules for HTML caching
     Currently only static assets are cached at edge. Add a page rule
     for "Cache Everything" with "Edge Cache TTL" to cache HTML pages.

  2. [MEDIUM] Enable WP Rocket's Remove Unused CSS
     Go to WP Rocket > File Optimization > CSS Files and enable
     "Remove Unused CSS" to reduce CSS payload by up to 50%.

  3. [LOW] Consider Redis persistent object cache for sessions
     Your Redis is configured but verify wp-config.php has
     WP_REDIS_HOST and WP_REDIS_DATABASE properly set.

────────────────────────────────────────
```

## License

MIT
