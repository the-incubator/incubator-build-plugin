#!/usr/bin/env node
// Classify a PR diff and verify the evidence actually visible in its PR body.
import fs from 'node:fs';

const args = process.argv.slice(2);
const mode = args.shift();
const option = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const visualPath = (path) => {
  const p = path.toLowerCase();
  const productPath = /(^|\/)(app|pages|components|ui|views|screens|public|assets|styles)\//.test(p);
  if (/(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return false;
  if (/(^|\/)(app|pages)\/api\//.test(p)) return false;
  if (/(^|\/)(docs?|notes)\//.test(p) && !productPath) return false;
  return productPath
    || /\.(css|scss|sass|less|html|vue|svelte|astro|tsx|jsx|swift|storyboard|xib|png|jpe?g|svg|webp)$/.test(p);
};
const nonVisualPath = (path) => {
  const p = path.toLowerCase();
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
    || /(^|\/)(tests?|__tests__|docs?|notes|scripts|server|api|cli|bin|migrations|\.github)\//.test(p)
    || /(^|\/)(readme|changelog|license|agents|claude|contributing)(\.[^/]*)?$/i.test(p)
    || /(^|\/)(package(?:-lock)?|plugin|tsconfig|jsconfig|biome|eslint|prettier)\.json$/.test(p)
    || /\.(md|txt|ya?ml|toml|lock|sh)$/.test(p);
};
const renderedMarkdown = body => {
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  let fence = null;
  return withoutComments.split('\n').filter(line => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter && !fence) { fence = delimiter[1]; return false; }
    if (fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) { fence = null; return false; }
    return !fence;
  }).join('\n');
};
const attachmentUrls = (body, heading) => {
  // Implementation plans may contain their own example headings and images.
  const topLevel = renderedMarkdown(body).split(/^<details>/m)[0];
  const sections = [...topLevel.matchAll(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^#{2,3} |^<sub>|$(?![\\s\\S]))`, 'gm'))].map(m => m[1]);
  const image = /!\[(?:\\.|[^\\\]])*\]\(([^)]+)\)/g;
  const urls = sections.flatMap(section => [...section.matchAll(image)].map(m => m[1]));
  if (urls.some(url => url.startsWith('./'))) throw new Error(`${heading} still contains local image references`);
  return urls.filter(url => /^https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+$/.test(url));
};

try {
  if (mode === 'classify') {
    const files = fs.readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    if (!files.length) throw new Error('empty diff: cannot classify evidence');
    // Visual wins over test/config changes. Unknown files remain visual until reviewed.
    const visual = files.filter(p => visualPath(p) || !nonVisualPath(p));
    console.log(visual.length ? `visual: ${visual.join(', ')}` : 'non-visual: allowlisted paths only');
  } else if (mode === 'verify') {
    const classification = option('--classification');
    const evidence = option('--evidence');
    if (!['visual', 'non-visual'].includes(classification)) throw new Error('classification must be visual or non-visual');
    if (evidence === 'skip:non-visual') {
      if (classification !== 'non-visual') throw new Error('visual changes cannot skip as non-visual');
    } else if (evidence.startsWith('skip:blocked:')) {
      const blocker = evidence.slice('skip:blocked:'.length).trim();
      const fixture = args.includes('--fixture-attempted');
      const attachment = args.includes('--attachment-blocked');
      if (!blocker || fixture === attachment)
        throw new Error('blocked skip needs a named blocker and either fixture fallback or attachment-tool blocker');
      const body = fs.readFileSync(option('--body-file'), 'utf8');
      if (!body.includes('### Evidence blocked') || !body.includes(blocker)
        || !(fixture ? /fixture/i.test(body) : /attach/i.test(body)))
        throw new Error('PR body must disclose the named blocker and attempted fallback');
    } else if (evidence === 'screenshots' || evidence === 'demo') {
      const count = Number(option('--expected-count'));
      if (!Number.isInteger(count) || count < 1) throw new Error('expected-count must name captured files');
      const heading = evidence === 'screenshots' ? 'Screenshots' : 'Demo';
      const body = fs.readFileSync(option('--body-file'), 'utf8');
      const beforeFile = option('--before-body-file');
      if (!beforeFile) throw new Error('before-body-file is required to prove attachment freshness');
      const before = fs.readFileSync(beforeFile, 'utf8');
      const oldUrls = new Set(before.match(/https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+/g) ?? []);
      const fresh = attachmentUrls(body, heading).filter(url => !oldUrls.has(url));
      if (new Set(fresh).size < count) throw new Error(`expected ${count} new GitHub attachments in ## ${heading}, found ${new Set(fresh).size}`);
    } else {
      throw new Error('evidence must be screenshots, demo, skip:non-visual, or skip:blocked:<named blocker>');
    }
    console.log(`evidence=${evidence}`);
  } else {
    throw new Error('usage: visual-evidence.mjs classify (paths on stdin) | verify --classification visual|non-visual --evidence TOKEN [--body-file FILE --expected-count N --before-body-file FILE] [--fixture-attempted|--attachment-blocked]');
  }
} catch (error) {
  console.error(`EVIDENCE_BLOCKED: ${error.message}`);
  process.exitCode = 1;
}
