import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rendererRoot = path.join(
  projectRoot,
  "apps",
  "desktop",
  "src",
  "renderer",
);
const primitiveRoot = path.join(rendererRoot, "components", "ui");
const globalStylesPath = path.join(rendererRoot, "styles", "global.css");
const badgePath = path.join(primitiveRoot, "badge.tsx");
const forbiddenTags = [
  "button",
  "input",
  "select",
  "option",
  "textarea",
  "label",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "details",
  "summary",
  "dialog",
  "progress",
  "meter",
  "kbd",
];
const forbiddenTagPattern = new RegExp(
  `<(?:${forbiddenTags.join("|")})\\b`,
  "gu",
);
const forbiddenRawNativeSelectTagPattern = /<(?:select|option|optgroup)\b/gu;
const forbiddenAmbiguousStatusGlyphPattern = /[□■▪▫▢▣◇◆○●◉◼◻◾◽]/gu;
const forbiddenHandDrawnIndicatorPattern =
  /<(?:div|span)\b[^>]*\bclassName=["'][^"']*(?:__mark|__dot)[^"']*["'][^>]*(?:\/>|>\s*<\/(?:div|span)>)/gu;
const forbiddenCompositeRoles = [
  "alertdialog",
  "dialog",
  "listbox",
  "option",
  "tab",
  "tablist",
  "tree",
  "treeitem",
];
const forbiddenCompositeRolePattern = new RegExp(
  `role=["'](?:${forbiddenCompositeRoles.join("|")})["']`,
  "gu",
);
const forbiddenAlertContainerPattern =
  /<(?:article|aside|div|p|section|small|span)\b[^>]*\brole=["']alert["'][^>]*>/gu;
const forbiddenNativeEmptyPattern =
  /<(?:article|aside|div|section)\b[^>]*\bclassName=["'][^"']*\bempty-panel\b[^"']*["'][^>]*>/gu;
const forbiddenNativePaginationPattern =
  /<(?:div|footer|section)\b[^>]*\bclassName=["'][^"']*\bpagination\b[^"']*["'][^>]*>/gu;
const forbiddenButtonRadiusPattern =
  /<(?:Button|BaseButton)\b[^>]*\bclassName=["'][^"']*\brounded-[^"']*["'][^>]*>/gu;
const forbiddenCompatibilityComponentPattern =
  /\b(?:BaseButton|FormInput|NativeSelect|NativeSelectOption|NativeSelectOptGroup|SelectField|SelectFieldItem)\b/gu;
const forbiddenLegacyLoaderPattern = /\b(?:Loader2|LoaderCircle)\b/gu;
const forbiddenManualSpinnerPattern = /\banimate-spin\b/gu;
const legacyColorTokenPattern = /--tw-color-[\w-]+/gu;
const hardcodedColorPattern = /#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(/giu;
const nativeFormSelectorPattern =
  /(^|[\s,>+~])(input|select|textarea)([\s.:#\[>,+~]|$)/u;
const nativeFormVisualDeclarationPattern =
  /(?:^|;)\s*(?:border(?:-[\w-]+)?|border-radius|box-shadow|outline(?:-[\w-]+)?|padding(?:-[\w-]+)?|color|background(?:-color)?|font)\s*:/mu;
const sharedControlSlotSelectorPattern =
  /\[data-slot=["'](?:alert|badge|button|checkbox|input|select-trigger|tabs-trigger|textarea|toggle|toggle-group-item)["']\](?::[\w()-]+)*$/u;
const sharedControlVisualDeclarationPattern =
  /(?:^|;)\s*(?:border(?:-[\w-]+)?|box-shadow|color|background(?:-color)?|font(?:-[\w-]+)?)\s*:/mu;

const defaultThemeTokens = {
  ":root": {
    "--radius": "0.625rem",
    "--background": "oklch(1 0 0)",
    "--foreground": "oklch(0.145 0 0)",
    "--card": "oklch(1 0 0)",
    "--card-foreground": "oklch(0.145 0 0)",
    "--popover": "oklch(1 0 0)",
    "--popover-foreground": "oklch(0.145 0 0)",
    "--primary": "oklch(0.205 0 0)",
    "--primary-foreground": "oklch(0.985 0 0)",
    "--secondary": "oklch(0.97 0 0)",
    "--secondary-foreground": "oklch(0.205 0 0)",
    "--muted": "oklch(0.97 0 0)",
    "--muted-foreground": "oklch(0.556 0 0)",
    "--accent": "oklch(0.97 0 0)",
    "--accent-foreground": "oklch(0.205 0 0)",
    "--destructive": "oklch(0.577 0.245 27.325)",
    "--border": "oklch(0.922 0 0)",
    "--input": "oklch(0.922 0 0)",
    "--ring": "oklch(0.708 0 0)",
    "--chart-1": "oklch(0.646 0.222 41.116)",
    "--chart-2": "oklch(0.6 0.118 184.704)",
    "--chart-3": "oklch(0.398 0.07 227.392)",
    "--chart-4": "oklch(0.828 0.189 84.429)",
    "--chart-5": "oklch(0.769 0.188 70.08)",
    "--sidebar": "oklch(0.985 0 0)",
    "--sidebar-foreground": "oklch(0.145 0 0)",
    "--sidebar-primary": "oklch(0.205 0 0)",
    "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    "--sidebar-accent": "oklch(0.97 0 0)",
    "--sidebar-accent-foreground": "oklch(0.205 0 0)",
    "--sidebar-border": "oklch(0.922 0 0)",
    "--sidebar-ring": "oklch(0.708 0 0)",
  },
  ".dark": {
    "--background": "oklch(0.145 0 0)",
    "--foreground": "oklch(0.985 0 0)",
    "--card": "oklch(0.205 0 0)",
    "--card-foreground": "oklch(0.985 0 0)",
    "--popover": "oklch(0.205 0 0)",
    "--popover-foreground": "oklch(0.985 0 0)",
    "--primary": "oklch(0.922 0 0)",
    "--primary-foreground": "oklch(0.205 0 0)",
    "--secondary": "oklch(0.269 0 0)",
    "--secondary-foreground": "oklch(0.985 0 0)",
    "--muted": "oklch(0.269 0 0)",
    "--muted-foreground": "oklch(0.708 0 0)",
    "--accent": "oklch(0.269 0 0)",
    "--accent-foreground": "oklch(0.985 0 0)",
    "--destructive": "oklch(0.704 0.191 22.216)",
    "--border": "oklch(1 0 0 / 10%)",
    "--input": "oklch(1 0 0 / 15%)",
    "--ring": "oklch(0.556 0 0)",
    "--chart-1": "oklch(0.488 0.243 264.376)",
    "--chart-2": "oklch(0.696 0.17 162.48)",
    "--chart-3": "oklch(0.769 0.188 70.08)",
    "--chart-4": "oklch(0.627 0.265 303.9)",
    "--chart-5": "oklch(0.645 0.246 16.439)",
    "--sidebar": "oklch(0.205 0 0)",
    "--sidebar-foreground": "oklch(0.985 0 0)",
    "--sidebar-primary": "oklch(0.488 0.243 264.376)",
    "--sidebar-primary-foreground": "oklch(0.985 0 0)",
    "--sidebar-accent": "oklch(0.269 0 0)",
    "--sidebar-accent-foreground": "oklch(0.985 0 0)",
    "--sidebar-border": "oklch(1 0 0 / 10%)",
    "--sidebar-ring": "oklch(0.556 0 0)",
  },
};

function collectTsxFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsxFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      files.push(absolutePath);
    }
  }
  return files;
}

function collectCssFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectCssFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      files.push(absolutePath);
    }
  }
  return files;
}

function collectJsxOpeningTags(source, tagName) {
  const tags = [];
  const startPattern = new RegExp(`<${tagName}\\b`, "gu");
  for (const match of source.matchAll(startPattern)) {
    const start = match.index ?? 0;
    let braceDepth = 0;
    let quote = null;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === "\\") {
          index += 1;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (character === ">" && braceDepth === 0) {
        tags.push({ index: start, source: source.slice(start, index + 1) });
        break;
      }
    }
  }
  return tags;
}

function extractCssBlock(source, selector) {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) {
    return null;
  }
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace + 1, index);
      }
    }
  }
  return null;
}

const violations = [];
for (const file of collectTsxFiles(rendererRoot)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(forbiddenRawNativeSelectTagPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} uses ${match[0]}; use the shadcn Select primitive so the menu follows the application theme.`,
    );
  }
  for (const match of source.matchAll(forbiddenAmbiguousStatusGlyphPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} uses the ambiguous ${match[0]} status glyph; use an explicit Lucide or shadcn icon.`,
    );
  }
  for (const match of source.matchAll(forbiddenHandDrawnIndicatorPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} hand-draws an empty status marker; use an explicit Lucide or shadcn icon.`,
    );
  }
  if (file.startsWith(`${primitiveRoot}${path.sep}`)) {
    continue;
  }
  for (const match of source.matchAll(forbiddenCompatibilityComponentPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} uses the removed ${match[0]} compatibility layer; import the matching shadcn primitive directly.`,
    );
  }
  for (const match of source.matchAll(forbiddenLegacyLoaderPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} hand-codes ${match[0]} loading UI; use the shadcn Spinner component.`,
    );
  }
  for (const match of source.matchAll(forbiddenManualSpinnerPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} hand-codes spinning UI; use the shadcn Spinner component.`,
    );
  }
  for (const match of source.matchAll(/\bbg-(?:primary(?!\/)|white)\b/gu)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} uses a light solid background in business UI; use shadcn accent, secondary or muted semantics instead.`,
    );
  }
  for (const match of source.matchAll(forbiddenTagPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} uses ${match[0]}; compose the matching component from components/ui instead.`,
    );
  }
  for (const match of source.matchAll(forbiddenCompositeRolePattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} hand-codes ${match[0]}; compose the matching shadcn component instead.`,
    );
  }
  for (const match of source.matchAll(forbiddenAlertContainerPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} hand-codes an alert container; use the shadcn Alert component instead.`,
    );
  }
  for (const match of source.matchAll(forbiddenNativeEmptyPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} hand-codes a full empty state; use the shadcn Empty component instead.`,
    );
  }
  for (const match of source.matchAll(forbiddenNativePaginationPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} hand-codes pagination layout; use the shared shadcn Pagination composition instead.`,
    );
  }
  for (const match of source.matchAll(forbiddenButtonRadiusPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} overrides a shadcn button radius; keep the shared rounded-md button shape.`,
    );
  }
  for (const tag of collectJsxOpeningTags(source, "Button")) {
    const line = source.slice(0, tag.index).split("\n").length;
    if (/\btitle\s*=/u.test(tag.source)) {
      violations.push(
        `${path.relative(projectRoot, file)}:${line} uses a native Button title; compose the shadcn Tooltip component instead.`,
      );
    }
    if (!/\btype\s*=/u.test(tag.source)) {
      violations.push(
        `${path.relative(projectRoot, file)}:${line} omits the Button type; set type="button" or type="submit" explicitly.`,
      );
    }
    if (!/\bvariant\s*=/u.test(tag.source)) {
      violations.push(
        `${path.relative(projectRoot, file)}:${line} relies on the white shadcn default button; choose secondary, outline, ghost or destructive explicitly.`,
      );
    } else if (
      /\bvariant\s*=\s*(?:["']default["']|\{[^}]*["']default["'][^}]*\})/u.test(
        tag.source,
      )
    ) {
      violations.push(
        `${path.relative(projectRoot, file)}:${line} selects the white shadcn default button; use a non-white semantic variant.`,
      );
    }
  }
  for (const tag of collectJsxOpeningTags(source, "Badge")) {
    const line = source.slice(0, tag.index).split("\n").length;
    if (!/\bvariant\s*=/u.test(tag.source)) {
      violations.push(
        `${path.relative(projectRoot, file)}:${line} relies on the white shadcn default badge; choose secondary, outline or destructive explicitly.`,
      );
    } else if (
      /\bvariant\s*=\s*(?:["']default["']|\{[^}]*["']default["'][^}]*\})/u.test(
        tag.source,
      )
    ) {
      violations.push(
        `${path.relative(projectRoot, file)}:${line} selects the white shadcn default badge; use a non-white semantic variant.`,
      );
    }
  }
  if (/\bcreatePortal\b/u.test(source)) {
    violations.push(
      `${path.relative(projectRoot, file)} hand-codes a portal; use a shadcn overlay primitive instead.`,
    );
  }
}

for (const file of collectTsxFiles(primitiveRoot)) {
  if (file === path.join(primitiveRoot, "button.tsx")) {
    continue;
  }
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bbuttonVariants\(\s*\)/gu)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} relies on the white default buttonVariants style; select a non-white variant explicitly.`,
    );
  }
}

for (const file of collectCssFiles(rendererRoot)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(legacyColorTokenPattern)) {
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} uses legacy color token ${match[0]}; consume a shadcn semantic color token directly.`,
    );
  }
  if (file !== globalStylesPath) {
    for (const match of source.matchAll(hardcodedColorPattern)) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      violations.push(
        `${path.relative(projectRoot, file)}:${line} hard-codes ${match[0]}; use a shadcn semantic color token.`,
      );
    }
  }
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = match[1];
    const declarations = match[2];
    if (
      selector
        .split(",")
        .some((item) => sharedControlSlotSelectorPattern.test(item.trim())) &&
      sharedControlVisualDeclarationPattern.test(declarations)
    ) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      violations.push(
        `${path.relative(projectRoot, file)}:${line} repaints a shadcn control from page CSS; use the component variant and keep page CSS structural.`,
      );
    }
    if (
      nativeFormSelectorPattern.test(selector) &&
      nativeFormVisualDeclarationPattern.test(declarations)
    ) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      violations.push(
        `${path.relative(projectRoot, file)}:${line} restyles a native form element in page CSS; keep Input, Select and Textarea visuals owned by components/ui.`,
      );
    }
    if (
      file !== globalStylesPath &&
      /\bbackground(?:-color)?\s*:\s*var\(--(?:tw-color-)?primary\)\s*;/u.test(
        declarations,
      )
    ) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      violations.push(
        `${path.relative(projectRoot, file)}:${line} uses the light primary token as a business surface; use shadcn accent, secondary or muted semantics instead.`,
      );
    }
    if (file !== globalStylesPath && selector.includes(":focus-visible")) {
      const index = match.index ?? 0;
      const line = source.slice(0, index).split("\n").length;
      violations.push(
        `${path.relative(projectRoot, file)}:${line} overrides focus-visible in page CSS; keep the shadcn component focus ring.`,
      );
    }
    const targetsButton =
      /button(?:[\s.:#\[\]>+~]|$)/u.test(selector) ||
      /\[data-slot=["']button["']\]/u.test(selector);
    const targetsStatusPill = /\.status-pill(?:[\s,:.\[\]>+~]|$)/u.test(
      selector,
    );
    if (
      (!targetsButton && !targetsStatusPill) ||
      !/\bborder-radius\s*:/u.test(declarations)
    ) {
      continue;
    }
    const index = match.index ?? 0;
    const line = source.slice(0, index).split("\n").length;
    violations.push(
      `${path.relative(projectRoot, file)}:${line} overrides a shared control radius in CSS; keep the shadcn rounded-md shape.`,
    );
  }
}

const badgeSource = readFileSync(badgePath, "utf8");
if (
  !badgeSource.includes("rounded-md") ||
  badgeSource.includes("rounded-full")
) {
  violations.push(
    `${path.relative(projectRoot, badgePath)} must keep the shadcn rounded-md badge shape.`,
  );
}

const globalStyles = readFileSync(globalStylesPath, "utf8");
for (const [selector, tokens] of Object.entries(defaultThemeTokens)) {
  const block = extractCssBlock(globalStyles, selector);
  if (!block) {
    violations.push(
      `${path.relative(projectRoot, globalStylesPath)} is missing the shadcn default ${selector} theme block.`,
    );
    continue;
  }
  for (const [token, value] of Object.entries(tokens)) {
    if (!block.includes(`${token}: ${value};`)) {
      violations.push(
        `${path.relative(projectRoot, globalStylesPath)} ${selector} must keep shadcn default ${token}: ${value}.`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(
    "Renderer violates the shadcn component or default-theme boundary:",
  );
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    "Renderer shadcn boundary is clean: native controls, composite semantics and default theme are owned by components/ui.",
  );
}
