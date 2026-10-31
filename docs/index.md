---
layout: default
page_id: home
title: "Switch how your AI coding tools think and work"
description: "Install, switch, customize, and roll back behavior recipes (system prompts, subagent instructions, and per-turn steering) across 11 AI coding harnesses with diff preview and byte-exact recovery."
---
{% assign shots = site.data.screenshots %}
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <p class="hero-kicker">recipe-switch · Node.js ≥ 22 · zero dependencies</p>
      <h1>Switch how your AI coding tools think and work</h1>
      <p class="hero-sub">One click to install, switch, and roll back prompts, subagent instructions, and per-turn reminders — with diff preview and byte-exact recovery.</p>
      <p class="hero-cmd"><code>node scripts/demo.mjs --reset</code><span class="cmd-alt"># sandbox demo · touches nothing real</span></p>
      <div class="hero-actions">
        <a class="btn btn-signal" href="{{ site.data.nav.en['getting-started'] | relative_url }}">Get started</a>
        <a class="btn" href="https://github.com/NB-Corp/recipe-switch">View on GitHub</a>
      </div>
    </div>
    <figure class="shot-frame">
      <img src="{{ shots.hero.en | relative_url }}" alt="{{ shots.hero.alt_en }}" loading="eager">
      <figcaption>The portrait panel on 127.0.0.1 — every tool, one card each.</figcaption>
    </figure>
  </div>
</section>

<section class="wall">
  <div class="wrap">
    <p class="wall-label">One recipe · eleven coding tools</p>
    <div class="badges">
      <span class="badge"><i></i>OpenAI Codex</span>
      <span class="badge steer"><i></i>Claude Code</span>
      <span class="badge steer"><i></i>Kiki</span>
      <span class="badge steer"><i></i>Pi</span>
      <span class="badge steer"><i></i>DeepSeek Harness</span>
      <span class="badge steer"><i></i>Oh My Pi</span>
      <span class="badge"><i></i>Grok Build</span>
      <span class="badge"><i></i>OpenCode</span>
      <span class="badge steer"><i></i>Kimi Code</span>
      <span class="badge steer"><i></i>Hermes Agent</span>
      <span class="badge steer"><i></i>OpenClaw</span>
      <span class="badge dim"><i></i>Gemini CLI · soon</span>
      <span class="badge dim"><i></i>Cursor · soon</span>
      <span class="badge dim"><i></i>Qoder · soon</span>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">Safety model</p>
      <h2 class="section-title">Writes you can inspect, edits you never lose</h2>
      <p class="section-sub">recipe-switch changes how eleven tools behave by editing their config files. Four guarantees keep that boring.</p>
    </div>
    <div class="features">
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><path d="M3 4.5h14M3 9.5h14M3 14.5h8"/><path class="sig" d="M13 16.5l2 2 3.5-4"/></svg></div>
        <h3>See the diff first</h3>
        <p>Every command defaults to a dry run that prints the exact unified diff, with secrets redacted. Nothing touches disk until you pass <code>--yes</code> or click <b>Write changes</b> — and a stale preview aborts the apply.</p>
      </div>
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><path d="M10 3l6 2.5v4c0 4-2.7 6.5-6 7.5-3.3-1-6-3.5-6-7.5v-4z"/><path class="sig" d="M7 10l2 2 4-4.5"/></svg></div>
        <h3>Hand edits are never overwritten</h3>
        <p>Managed files and config lines carry a marker and a fingerprint. Edit one by hand and the next switch blocks instead of clobbering your work. Force it anyway and your version is backed up first.</p>
      </div>
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 16.5v-3.7h3.7"/></svg></div>
        <h3>Byte-exact rollback</h3>
        <p>Undo the last change, unwind the whole stack, or restore the pre-install baseline. Original bytes come back exactly — whitespace, comments, and JSON spans included.</p>
      </div>
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><rect x="4" y="8" width="12" height="8" rx="2"/><path class="sig" d="M7 8V6a3 3 0 0 1 6 0v2"/></svg></div>
        <h3>Original backups, kept per install cycle</h3>
        <p>The first install from a clean state snapshots what it changes — deduplicated by content, dated next to the restore button, readable only by you. Uninstalled? The snapshot retires and its bytes are released.</p>
      </div>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">Recipes with options</p>
      <h2 class="section-title">One recipe, checkbox variations</h2>
      <p class="section-sub">A recipe bundles up to six coordinated texts — Main, Subagent, Independent prompts plus User, Subagent, and Result per-turn reminders. Checkbox options include or patch sections on the fly, and the diff re-renders as you flip them.</p>
    </div>
    <div class="opts-demo">
      <div class="opts">
        <div class="opt">
          <span class="opt-name">Security pass</span>
          <span class="opt-desc">Adds a security checklist section before Tone.</span>
          <span class="switch on" aria-hidden="true"><span></span></span>
        </div>
        <div class="opt">
          <span class="opt-name">Cite lines</span>
          <span class="opt-desc">Reminds the agent to cite file:line each turn.</span>
          <span class="switch on" aria-hidden="true"><span></span></span>
        </div>
        <div class="opt">
          <span class="opt-name">Concise replies</span>
          <span class="opt-desc">Trims status narration from final answers.</span>
          <span class="switch" aria-hidden="true"><span></span></span>
        </div>
      </div>
      <figure class="shot-frame">
        <img src="{{ shots.options.en | relative_url }}" alt="{{ shots.options.alt_en }}" loading="lazy">
        <figcaption>Toggle an option — the unified diff updates live.</figcaption>
      </figure>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">Positioning</p>
      <h2 class="section-title">The layer above cc-switch</h2>
    </div>
    <div class="compare">
      <div>
        <h3>cc-switch</h3>
        <p>Swaps API providers and models across your coding agents — which brain answers.</p>
      </div>
      <div class="cmp-vs">VS</div>
      <div class="cmp-here">
        <h3>recipe-switch</h3>
        <p>Swaps the layer above the model — how those agents reason, delegate, and stay on track.</p>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">FAQ</p>
      <h2 class="section-title">Quick answers</h2>
    </div>
    <div class="faq-list">
      <details class="faq-item">
        <summary>Does it touch my API keys, models, or MCP servers?</summary>
        <div class="faq-body"><p>No. recipe-switch only writes prompt files and the minimal config keys that load them. Model selection, credentials, providers, MCP servers, and role definitions stay untouched — and diffs redact anything that looks like a secret.</p></div>
      </details>
      <details class="faq-item">
        <summary>What happens if I edit a managed file by hand?</summary>
        <div class="faq-body"><p>The tool card flips to <b>Edited</b> and the next switch, rollback, or uninstall blocks instead of overwriting your work. Override explicitly and your hand-edited version is backed up first, with the path printed.</p></div>
      </details>
      <details class="faq-item">
        <summary>How do I get back to how things were before installing?</summary>
        <div class="faq-body"><p>Three ways: <code>rollback</code> steps back one change, <code>uninstall</code> unwinds everything, and <code>restore-original</code> returns to the pre-install snapshot taken when the current install cycle began.</p></div>
      </details>
      <details class="faq-item">
        <summary>Which tools are supported?</summary>
        <div class="faq-body"><p>Eleven: Codex, Claude Code, Kiki, Pi, DeepSeek Harness, Oh My Pi, Grok Build, OpenCode, Kimi Code, Hermes, and OpenClaw. Gemini CLI, Cursor, and Qoder are detected but left untouched until a safe entry point is verified.</p></div>
      </details>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">Documentation</p>
      <h2 class="section-title">Read the details</h2>
    </div>
    <div class="doc-cards">
      <a class="doc-card" href="{{ site.data.nav.en['getting-started'] | relative_url }}"><b>Getting Started</b><span>Sandbox demo, CLI dry runs, and the local web panel in two minutes.</span><span class="go">READ →</span></a>
      <a class="doc-card" href="{{ site.data.nav.en.harnesses | relative_url }}"><b>Harnesses &amp; Write Points</b><span>Exact files, config keys, and hook routes for all 11 tools.</span><span class="go">READ →</span></a>
      <a class="doc-card" href="{{ site.data.nav.en.safety | relative_url }}"><b>Safety &amp; Rollback</b><span>Diff previews, drift blocking, install-cycle snapshots, and recovery.</span><span class="go">READ →</span></a>
      <a class="doc-card" href="{{ site.data.nav.en.recipes | relative_url }}"><b>Recipes &amp; Options</b><span>Write a recipe.toml with checkbox options and section patches.</span><span class="go">READ →</span></a>
      <a class="doc-card" href="{{ site.data.nav.en.faq | relative_url }}"><b>FAQ</b><span>Claude Code, Codex, Kimi Code, Hermes, OpenClaw — common questions.</span><span class="go">READ →</span></a>
      <a class="doc-card" href="https://github.com/NB-Corp/recipe-switch"><b>GitHub Repository</b><span>Source, issues, and the MIT license.</span><span class="go">OPEN →</span></a>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="cta">
      <h2>Try it against a throwaway sandbox first</h2>
      <p>The demo builds fake tool homes under .tmp/demo/ and opens the panel. Install, switch, break things on purpose — your real configs never enter the picture.</p>
      <code>git clone https://github.com/NB-Corp/recipe-switch.git && cd recipe-switch && node scripts/demo.mjs --reset</code>
      <div class="hero-actions">
        <a class="btn btn-signal" href="{{ site.data.nav.en['getting-started'] | relative_url }}">Full quick start</a>
        <a class="btn" href="https://github.com/NB-Corp/recipe-switch">Star on GitHub</a>
      </div>
    </div>
  </div>
</section>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "recipe-switch",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Windows, macOS, Linux",
  "description": "One-click working styles for AI coding tools. Install, switch, customize, and roll back prompts, subagent instructions, and per-turn steering across 11 AI coding harnesses with diff preview and byte-exact recovery.",
  "url": "https://nb-corp.github.io/recipe-switch/",
  "downloadUrl": "https://github.com/NB-Corp/recipe-switch",
  "softwareRequirements": "Node.js >= 22",
  "license": "https://opensource.org/licenses/MIT",
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "author": { "@type": "Organization", "name": "NB-Corp", "url": "https://github.com/NB-Corp" }
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "Does recipe-switch touch API keys, models, or MCP servers?",
      "acceptedAnswer": { "@type": "Answer", "text": "No. recipe-switch only writes prompt files and the minimal config keys that load them. Model selection, credentials, providers, MCP servers, and role definitions stay untouched, and diffs redact anything that looks like a secret." } },
    { "@type": "Question", "name": "What happens if I edit a managed file by hand?",
      "acceptedAnswer": { "@type": "Answer", "text": "The tool is flagged as Edited and the next switch, rollback, or uninstall blocks instead of overwriting your work. Overriding explicitly backs up your hand-edited version first and prints the backup path." } },
    { "@type": "Question", "name": "How do I restore my tools to how they were before installing recipe-switch?",
      "acceptedAnswer": { "@type": "Answer", "text": "rollback steps back one change, uninstall unwinds the whole operation stack, and restore-original returns to the pre-install snapshot taken when the current install cycle began." } },
    { "@type": "Question", "name": "Which AI coding tools does recipe-switch support?",
      "acceptedAnswer": { "@type": "Answer", "text": "Eleven: OpenAI Codex, Claude Code, Kiki, Pi, DeepSeek Harness, Oh My Pi, Grok Build, OpenCode, Kimi Code, Hermes Agent, and OpenClaw. Gemini CLI, Cursor, and Qoder are detected but intentionally left untouched." } }
  ]
}
</script>
