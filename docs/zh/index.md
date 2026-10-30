---
layout: default
page_id: home
title: "一键切换 AI 编程工具的整套工作方式"
description: "在 Codex、Claude Code、Kiki、Pi、DeepSeek Harness、OMP、Grok、OpenCode、Kimi Code、Hermes 与 OpenClaw 之间一键安装、切换、定制和回滚行为配方（主提示词、子代理指令与每轮提醒），支持 Diff 预览与逐字节还原。"
---
{% assign shots = site.data.screenshots %}
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <p class="hero-kicker">recipe-switch · Node.js ≥ 22 · 零依赖</p>
      <h1>一键切换 AI 编程工具的整套工作方式</h1>
      <p class="hero-sub">主提示词、子代理分工与每轮纠偏提醒，先看 diff 再落盘，随时逐字节还原。</p>
      <p class="hero-cmd"><code>node scripts/demo.mjs --reset</code><span class="cmd-alt"># 沙盒试玩 · 不碰真实配置</span></p>
      <div class="hero-actions">
        <a class="btn btn-signal" href="{{ site.data.nav.zh['getting-started'] | relative_url }}">快速开始</a>
        <a class="btn" href="https://github.com/NB-Corp/recipe-switch">GitHub 仓库</a>
      </div>
    </div>
    <figure class="shot-frame">
      <img src="{{ shots.hero.zh | relative_url }}" alt="{{ shots.hero.alt_zh }}" loading="eager">
      <figcaption>只监听 127.0.0.1 的竖屏面板——每款工具一张卡片。</figcaption>
    </figure>
  </div>
</section>

<section class="wall">
  <div class="wrap">
    <p class="wall-label">一份配方 · 十一款编程工具</p>
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
      <span class="badge dim"><i></i>Gemini CLI · 待接入</span>
      <span class="badge dim"><i></i>Cursor · 待接入</span>
      <span class="badge dim"><i></i>Qoder · 待接入</span>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">安全模型</p>
      <h2 class="section-title">每次写入都能检查，手改内容绝不丢失</h2>
      <p class="section-sub">recipe-switch 通过改写配置文件来切换十一款工具的行为，四条保证让这件事变得很无聊。</p>
    </div>
    <div class="features">
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><path d="M3 4.5h14M3 9.5h14M3 14.5h8"/><path class="sig" d="M13 16.5l2 2 3.5-4"/></svg></div>
        <h3>先看 diff 再落盘</h3>
        <p>所有命令默认预览模式，打印精确的 unified diff，敏感凭据自动脱敏。只有加 <code>--yes</code> 或点击<b>确认写入</b>才动磁盘——过期预览会直接中止写入。</p>
      </div>
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><path d="M10 3l6 2.5v4c0 4-2.7 6.5-6 7.5-3.3-1-6-3.5-6-7.5v-4z"/><path class="sig" d="M7 10l2 2 4-4.5"/></svg></div>
        <h3>手改不覆盖</h3>
        <p>受管文件与配置行带标记和指纹。你手动改过，下一次切换就会停下拦截，而不是悄悄冲掉你的劳动。坚持覆盖也会先把你手改的版本完整备份。</p>
      </div>
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 1 1.8 4.3M4 16.5v-3.7h3.7"/></svg></div>
        <h3>逐字节还原</h3>
        <p>撤回上一步、撤销全部操作栈、或恢复到装之前的基线。原始字节精确回归——空白、注释与 JSON 跨度原样奉还。</p>
      </div>
      <div class="feature">
        <div class="feat-icon"><svg viewBox="0 0 20 20"><rect x="4" y="8" width="12" height="8" rx="2"/><path class="sig" d="M7 8V6a3 3 0 0 1 6 0v2"/></svg></div>
        <h3>原始备份按安装周期计</h3>
        <p>从未安装状态装上时拍一次快照，周期内不覆盖；按钮旁直接显示快照日期，备份目录只有你能读。卸载即退役，没人引用的内容立即释放。</p>
      </div>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">带选项的配方</p>
      <h2 class="section-title">一份配方，复选框变体</h2>
      <p class="section-sub">一份配方打包最多六个协同文本——主代理、子代理、独立代理提示词，加上用户、子代理与结果每轮提醒。复选框选项可以按需包含或修补章节，diff 随你拨动开关实时重算。</p>
    </div>
    <div class="opts-demo">
      <div class="opts">
        <div class="opt">
          <span class="opt-name">安全审查</span>
          <span class="opt-desc">在 Tone 章节前插入一份安全检查清单。</span>
          <span class="switch on" aria-hidden="true"><span></span></span>
        </div>
        <div class="opt">
          <span class="opt-name">引用行号</span>
          <span class="opt-desc">每轮提醒代理为结论标注 file:line。</span>
          <span class="switch on" aria-hidden="true"><span></span></span>
        </div>
        <div class="opt">
          <span class="opt-name">简洁回复</span>
          <span class="opt-desc">从最终答复中删掉进度叙述。</span>
          <span class="switch" aria-hidden="true"><span></span></span>
        </div>
      </div>
      <figure class="shot-frame">
        <img src="{{ shots.options.src | relative_url }}" alt="{{ shots.options.alt_zh }}" loading="lazy">
        <figcaption>拨动选项——unified diff 实时更新。</figcaption>
      </figure>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">定位</p>
      <h2 class="section-title">cc-switch 之上的一层</h2>
    </div>
    <div class="compare">
      <div>
        <h3>cc-switch</h3>
        <p>为你的编程代理切换 API 供应商与模型——决定哪颗大脑来回答。</p>
      </div>
      <div class="cmp-vs">对比</div>
      <div class="cmp-here">
        <h3>recipe-switch</h3>
        <p>切换模型之上的行为层——决定这些代理怎么思考、拆解任务与保持方向。</p>
      </div>
    </div>
  </div>
</section>
<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">FAQ</p>
      <h2 class="section-title">快速答疑</h2>
    </div>
    <div class="faq-list">
      <details class="faq-item">
        <summary>会动我的 API Key、模型或 MCP 配置吗？</summary>
        <div class="faq-body"><p>不会。recipe-switch 只写提示词文件和挂载它们所需的最小配置键。模型选择、凭据、provider、MCP 与角色定义一概不碰——diff 里任何像密钥的内容都会自动脱敏。</p></div>
      </details>
      <details class="faq-item">
        <summary>我手动改了受管文件会怎样？</summary>
        <div class="faq-body"><p>工具卡片会标为<b>有手改</b>，下一次切换、撤回或还原都会停下拦截，而不是覆盖你的劳动。显式确认覆盖时，会先把你手改的版本完整备份并给出路径。</p></div>
      </details>
      <details class="faq-item">
        <summary>怎么回到安装之前的样子？</summary>
        <div class="faq-body"><p>三种粒度：<code>rollback</code> 撤回一步，<code>uninstall</code> 撤销全部，<code>restore-original</code> 恢复到当前安装周期开始时拍下的原始快照。</p></div>
      </details>
      <details class="faq-item">
        <summary>支持哪些工具？</summary>
        <div class="faq-body"><p>十一款：Codex、Claude Code、Kiki、Pi、DeepSeek Harness、Oh My Pi、Grok Build、OpenCode、Kimi Code、Hermes 与 OpenClaw。Gemini CLI、Cursor、Qoder 会被检测但保持不动，直到确认安全的写入入口。</p></div>
      </details>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section-head">
      <p class="section-kicker">文档</p>
      <h2 class="section-title">深入阅读</h2>
    </div>
    <div class="doc-cards">
      <a class="doc-card" href="{{ site.data.nav.zh['getting-started'] | relative_url }}"><b>安装与快速开始</b><span>两分钟跑通沙盒演示、CLI 预览与本地 Web 面板。</span><span class="go">阅读 →</span></a>
      <a class="doc-card" href="{{ site.data.nav.zh.harnesses | relative_url }}"><b>各工具写入点</b><span>11 款工具的具体写入文件、配置键与 hook 路径。</span><span class="go">阅读 →</span></a>
      <a class="doc-card" href="{{ site.data.nav.zh.safety | relative_url }}"><b>安全与回滚</b><span>Diff 预览、手改拦截、安装周期快照与崩溃恢复。</span><span class="go">阅读 →</span></a>
      <a class="doc-card" href="{{ site.data.nav.zh.recipes | relative_url }}"><b>配方与选项格式</b><span>编写 recipe.toml，定义复选框选项与章节修补。</span><span class="go">阅读 →</span></a>
      <a class="doc-card" href="{{ site.data.nav.zh.faq | relative_url }}"><b>常见问题</b><span>Claude Code、Codex、Kimi Code、Hermes、OpenClaw 常见疑问。</span><span class="go">阅读 →</span></a>
      <a class="doc-card" href="https://github.com/NB-Corp/recipe-switch"><b>GitHub 仓库</b><span>源码、议题与 MIT 许可证。</span><span class="go">打开 →</span></a>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="cta">
      <h2>先用一次性沙盒试玩</h2>
      <p>演示脚本会在 .tmp/demo/ 下造一套假工具目录并打开面板。随便装、随便换、故意搞坏——你的真实配置完全不参与。</p>
      <code>git clone https://github.com/NB-Corp/recipe-switch.git && cd recipe-switch && node scripts/demo.mjs --reset</code>
      <div class="hero-actions">
        <a class="btn btn-signal" href="{{ site.data.nav.zh['getting-started'] | relative_url }}">完整快速开始</a>
        <a class="btn" href="https://github.com/NB-Corp/recipe-switch">去 GitHub 标星</a>
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
  "description": "一键切换 AI 编程工具的整套工作方式。在 11 款 AI 编程工具之间安装、切换、定制和回滚主提示词、子代理指令与每轮提醒，支持 Diff 预览与逐字节还原。",
  "url": "https://nb-corp.github.io/recipe-switch/zh/",
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
    { "@type": "Question", "name": "recipe-switch 会动我的 API Key、模型或 MCP 配置吗？",
      "acceptedAnswer": { "@type": "Answer", "text": "不会。recipe-switch 只写提示词文件和挂载它们所需的最小配置键。模型选择、凭据、provider、MCP 与角色定义一概不碰，diff 中任何像密钥的内容都会自动脱敏。" } },
    { "@type": "Question", "name": "手动改了受管文件会怎样？",
      "acceptedAnswer": { "@type": "Answer", "text": "工具会被标为有手改，下一次切换、撤回或还原都会停下拦截，而不是覆盖你的劳动。显式确认覆盖时会先备份你手改的版本并给出路径。" } },
    { "@type": "Question", "name": "怎么恢复到安装 recipe-switch 之前的状态？",
      "acceptedAnswer": { "@type": "Answer", "text": "rollback 撤回一步，uninstall 撤销全部操作栈，restore-original 恢复到当前安装周期开始时拍下的原始快照。" } },
    { "@type": "Question", "name": "recipe-switch 支持哪些 AI 编程工具？",
      "acceptedAnswer": { "@type": "Answer", "text": "十一款：OpenAI Codex、Claude Code、Kiki、Pi、DeepSeek Harness、Oh My Pi、Grok Build、OpenCode、Kimi Code、Hermes Agent 与 OpenClaw。Gemini CLI、Cursor、Qoder 会被检测但保持不动。" } }
  ]
}
</script>
