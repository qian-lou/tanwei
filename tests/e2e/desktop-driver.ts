import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect as runnerExpect, test } from "@playwright/test";
import { desktopPaths, launchTauri } from "../../scripts/tauri-driver.mjs";

export { test, desktopPaths };
type Text = string | RegExp;
type Options = { exact?: boolean; name?: Text; level?: number; hasText?: Text; has?: Locator };
type Step = { kind: string; value?: unknown; options?: Record<string, unknown> };
type Session = Awaited<ReturnType<typeof launchTauri>>;
type ElementReference = { "element-6066-11e4-a52e-4f735466cecf": string };
type ScreenshotOptions = { path: string; fullPage?: boolean; animations?: string; clip?: { x: number; y: number; width: number; height: number } };

const resolveDependency = createRequire(path.join(process.cwd(), "package.json"));
const library = readFile(resolveDependency.resolve("@testing-library/dom/dist/@testing-library/dom.umd.min.js"), "utf8");
const serializeText = (value: Text | undefined): unknown => value instanceof RegExp ? { source: value.source, flags: value.flags } : value;

// Testing Library supplies the same accessible role/name rules used by the
// renderer tests. Queries are resolved afresh after every React render.
function installQueries() {
  const globals = window as unknown as Record<string, any>;
  const dom = globals.TestingLibraryDom;
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const text = (value: any) => value && typeof value === "object" && "source" in value ? new RegExp(value.source, value.flags) : value;
  const matches = (actual: string, expected: any) => {
    const matcher = text(expected);
    if (matcher instanceof RegExp) { matcher.lastIndex = 0; return matcher.test(actual); }
    return actual.toLowerCase().includes(String(matcher).toLowerCase());
  };
  const query = (steps: Step[], scope: ParentNode = document): Element[] => {
    let elements: ParentNode[] = [scope];
    for (const step of steps) {
      if (step.kind === "nth") {
        const index = Number(step.value);
        elements = elements.length ? [elements[index < 0 ? elements.length + index : index]].filter(Boolean) : [];
      } else if (step.kind === "filter") {
        elements = elements.filter(element => (!step.options?.hasText || matches(element.textContent || "", step.options.hasText)) && (!step.options?.has || query(step.options.has as Step[], element).length > 0));
      } else {
        elements = elements.flatMap(scope => {
          const options = { exact: false, ...step.options, ...(step.options?.name === undefined ? {} : { name: text(step.options.name) }) };
          if (step.kind === "role" && typeof options.name === "string" && options.exact !== true) {
            options.name = new RegExp(options.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
          }
          switch (step.kind) {
            case "css": {
              const selector = String(step.value);
              if (/^\.\.(?:\/\.\.)*$/u.test(selector)) {
                let ancestor: ParentNode | null = scope;
                for (const _segment of selector.split("/")) ancestor = ancestor instanceof Element ? ancestor.parentElement : null;
                return ancestor ? [ancestor] : [];
              }
              const matched = Array.from(scope.querySelectorAll(selector.replace(/:visible\b/gu, "")));
              return selector.includes(":visible") ? matched.filter(visible) : matched;
            }
            case "role": return dom.queryAllByRole(scope, step.value, options);
            case "label": return dom.queryAllByLabelText(scope, text(step.value), options);
            case "placeholder": return dom.queryAllByPlaceholderText(scope, text(step.value), options);
            case "text": return dom.queryAllByText(scope, text(step.value), options);
            case "testId": return dom.queryAllByTestId(scope, text(step.value), options);
            default: throw new Error(`Unknown locator step ${step.kind}`);
          }
        });
      }
      elements = [...new Set(elements)];
    }
    return elements.filter((element): element is Element => element instanceof Element);
  };
  globals.__tanweiE2eQuery = query;
  globals.__tanweiE2eVisible = visible;
}

// Preserve CSS animation events: Radix Presence relies on animationend to
// unmount closing portals. Forcing finish/cancel can strand their aria-hidden
// siblings in WebKit. Wait for short animations, then pause only for capture.
async function withScreenshotAnimations<T>(browser: Session["browser"], disabled: boolean, capture: () => Promise<T>): Promise<T> {
  if (!disabled) return capture();
  const token = await browser.execute(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const finite = document.getAnimations().filter(animation =>
      (animation.playState === "running" || animation.pending) &&
      Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(finite.map(animation => animation.finished)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); }),
    ]);
    clearTimeout(timer);
    const paused = document.getAnimations().filter(animation => animation.playState === "running" || animation.pending);
    paused.forEach(animation => animation.pause());
    const token = `__tanweiScreenshot_${Math.random().toString(36).slice(2)}`;
    (window as any)[token] = paused;
    return token;
  });
  try { return await capture(); }
  finally {
    await browser.execute(token => {
      const paused = (window as any)[token] as Animation[] | undefined;
      delete (window as any)[token];
      paused?.forEach(animation => { if (animation.playState === "paused") animation.play(); });
    }, token);
  }
}

export class DesktopApplication {
  readonly windowHandles = new Set<string>();
  constructor(readonly session: Session) {}
  static async launch(options: Parameters<typeof launchTauri>[0]) { return new DesktopApplication(await launchTauri(options)); }
  async firstWindow(): Promise<Page> {
    const handles = await this.session.browser.getWindowHandles();
    if (!handles.length) throw new Error("Tauri has no WebView windows");
    handles.forEach((handle: string) => this.windowHandles.add(handle));
    return new Page(this, handles.includes("main") ? "main" : handles[0]);
  }
  async waitForEvent(event: "window"): Promise<Page> {
    if (event !== "window") throw new Error(`Unsupported desktop event ${event}`);
    const current = new Set(this.windowHandles);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const handles = await this.session.browser.getWindowHandles();
      const handle = handles.find((item: string) => !current.has(item));
      if (handle) { this.windowHandles.add(handle); return new Page(this, handle); }
      await delay(100);
    }
    throw new Error("Timed out waiting for a new Tauri report window");
  }
  close() { return this.session.close(); }
}

export class Page {
  readonly keyboard = { press: (key: string) => this.press(key) };
  constructor(readonly application: DesktopApplication, readonly handle: string) {}
  async run<T>(operation: (browser: Session["browser"]) => Promise<T>): Promise<T> {
    return this.application.session.serial(async () => {
      await this.application.session.browser.switchToWindow(this.handle);
      return operation(this.application.session.browser);
    });
  }
  async prepare(browser: Session["browser"]) {
    if (!await browser.execute(() => Boolean((window as any).__tanweiE2eQuery))) {
      await browser.executeScript(await library);
      await browser.execute(installQueries);
    }
  }
  locator(selector: string, options: Options = {}) { return new Locator(this, []).locator(selector, options); }
  getByRole(role: string, options: Options = {}) { return new Locator(this, []).getByRole(role, options); }
  getByLabel(label: Text, options: Options = {}) { return new Locator(this, []).getByLabel(label, options); }
  getByPlaceholder(placeholder: Text, options: Options = {}) { return new Locator(this, []).getByPlaceholder(placeholder, options); }
  getByText(text: Text, options: Options = {}) { return new Locator(this, []).getByText(text, options); }
  getByTestId(id: Text) { return new Locator(this, []).getByTestId(id); }
  evaluate<T, A = undefined>(fn: (argument: A) => T | Promise<T>, argument?: A): Promise<T> { return this.run(browser => browser.execute(fn, argument ?? null)); }
  async waitForLoadState(_state: "domcontentloaded") {
    await runnerExpect.poll(() => this.evaluate(() => document.readyState), { timeout: 30_000 }).not.toBe("loading");
  }
  url(): Promise<string> { return this.run(browser => browser.getUrl()); }
  title(): Promise<string> { return this.run(browser => browser.getTitle()); }
  async reload() { await this.run(browser => browser.refresh()); await this.waitForLoadState("domcontentloaded"); }
  waitForTimeout(millis: number) { return delay(millis); }
  async close() { await this.run(browser => browser.closeWindow()); this.application.windowHandles.delete(this.handle); }
  async setViewportSize(size: { width: number; height: number }) {
    await this.run(async browser => {
      const current = await browser.command("GET", "/window/rect");
      const viewport = await browser.execute(() => ({ width: innerWidth, height: innerHeight }));
      await browser.setWindowRect({ width: Math.round(size.width + current.width - viewport.width), height: Math.round(size.height + current.height - viewport.height) });
    });
    await runnerExpect.poll(() => this.evaluate(() => ({ width: innerWidth, height: innerHeight })), { timeout: 5_000 }).toEqual(size);
    await this.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  async press(key: string) {
    if (key === "Tab" || key === "Shift+Tab") {
      const result = await this.evaluate(backwards => (window as any).__TAURI_INTERNALS__.invoke("host_call", { method: "e2e_press_tab", args: [backwards] }), key === "Shift+Tab");
      if (!result.ok) throw new Error(result.errorMessage);
      return;
    }
    const keys: Record<string, string> = { Meta: "\uE03D", Control: "\uE009", Alt: "\uE00A", Shift: "\uE008", Escape: "\uE00C", Tab: "\uE004", Enter: "\uE007" };
    const sequence = key.split("+").map(part => keys[part] ?? (part.length === 1 ? part.toLowerCase() : part));
    await this.run(browser => browser.command("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions: [...sequence.map(value => ({ type: "keyDown", value })), ...sequence.toReversed().map(value => ({ type: "keyUp", value }))] }] }));
  }
  async screenshot(options: ScreenshotOptions) {
    await mkdir(path.dirname(options.path), { recursive: true });
    const bytes = await this.run(browser => withScreenshotAnimations(browser, options.animations === "disabled", async () => {
      let screenshot = await browser.takeScreenshot();
      if (options.fullPage) {
        const layout = await browser.execute(() => ({
          width: innerWidth, height: innerHeight, x: scrollX, y: scrollY,
          fullHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
          fullWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        }));
        if (layout.fullHeight > layout.height || layout.fullWidth > layout.width) {
          const tiles: { x: number; y: number; image: string }[] = [];
          try {
            for (let y = 0; y < layout.fullHeight; y += layout.height) {
              for (let x = 0; x < layout.fullWidth; x += layout.width) {
                const actual = await browser.execute(async ({ x, y }: { x: number; y: number }) => {
                  scrollTo({ left: x, top: y, behavior: "instant" });
                  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                  return { x: scrollX, y: scrollY };
                }, { x, y });
                tiles.push({ ...actual, image: await browser.takeScreenshot() });
              }
            }
            screenshot = await browser.execute(async ({ tiles, layout }: { tiles: { x: number; y: number; image: string }[]; layout: { width: number; fullWidth: number; fullHeight: number } }) => {
              const images = await Promise.all(tiles.map(async tile => {
                const image = new Image(); image.src = `data:image/png;base64,${tile.image}`; await image.decode(); return image;
              }));
              const scale = images[0].width / layout.width;
              const canvas = document.createElement("canvas"); canvas.width = Math.ceil(layout.fullWidth * scale); canvas.height = Math.ceil(layout.fullHeight * scale);
              const context = canvas.getContext("2d"); if (!context) throw new Error("Unable to compose full page screenshot");
              images.forEach((image, index) => context.drawImage(image, Math.round(tiles[index].x * scale), Math.round(tiles[index].y * scale)));
              return canvas.toDataURL("image/png").split(",")[1];
            }, { tiles, layout });
          } finally {
            await browser.execute(({ x, y }: { x: number; y: number }) => scrollTo({ left: x, top: y, behavior: "instant" }), layout);
          }
        }
      }
      if (options.clip) {
        screenshot = await browser.execute(async ({ base64, clip }: { base64: string; clip: NonNullable<ScreenshotOptions["clip"]> }) => {
          const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
          const scale = image.width / innerWidth;
          const canvas = document.createElement("canvas"); canvas.width = Math.round(clip.width * scale); canvas.height = Math.round(clip.height * scale);
          const context = canvas.getContext("2d"); if (!context) throw new Error("Unable to crop screenshot");
          context.drawImage(image, clip.x * scale, clip.y * scale, clip.width * scale, clip.height * scale, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png").split(",")[1];
        }, { base64: screenshot, clip: options.clip });
      }
      return Buffer.from(screenshot, "base64");
    }));
    await writeFile(options.path, bytes);
    return bytes;
  }
  async nativeState(): Promise<{ visible: boolean; configuredBackgroundColor: string; theme: string }> {
    const result = await this.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("host_call", { method: "e2e_window_state", args: [] }));
    if (!result.ok) throw new Error(result.errorMessage);
    return result.value;
  }
  async emitDiagnosticEvidence(artifactId: string) {
    const result = await this.evaluate(id => (window as any).__TAURI_INTERNALS__.invoke("host_call", { method: "e2e_emit_diagnostic_evidence", args: [id] }), artifactId);
    if (!result.ok) throw new Error(result.errorMessage);
    return result.value;
  }
  async requestClose() {
    const result = await this.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("host_call", { method: "e2e_request_close", args: [] }));
    if (!result.ok) throw new Error(result.errorMessage);
  }
}

export class Locator {
  constructor(readonly owner: Page, readonly steps: Step[]) {}
  page() { return this.owner; }
  private step(kind: string, value: unknown, options: Options = {}) {
    const next = new Locator(this.owner, [...this.steps, { kind, value: serializeText(value as Text), options: { ...options, name: serializeText(options.name), hasText: undefined, has: undefined } }]);
    return options.has || options.hasText ? next.filter(options) : next;
  }
  locator(selector: string, options: Options = {}) { return this.step("css", selector, options); }
  getByRole(role: string, options: Options = {}) { return this.step("role", role, options); }
  getByLabel(label: Text, options: Options = {}) { return this.step("label", label, options); }
  getByPlaceholder(placeholder: Text, options: Options = {}) { return this.step("placeholder", placeholder, options); }
  getByText(text: Text, options: Options = {}) { return this.step("text", text, options); }
  getByTestId(id: Text) { return this.step("testId", id); }
  filter(options: Options) { return new Locator(this.owner, [...this.steps, { kind: "filter", options: { hasText: serializeText(options.hasText), has: options.has?.steps } }]); }
  nth(index: number) { return new Locator(this.owner, [...this.steps, { kind: "nth", value: index }]); }
  first() { return this.nth(0); }
  last() { return this.nth(-1); }
  async inspect<T>(fn: (elements: Element[]) => T): Promise<T> {
    return this.owner.run(async browser => {
      await this.owner.prepare(browser);
      return browser.executeScript(`return (${fn.toString()})(window.__tanweiE2eQuery(arguments[0]));`, [this.steps]);
    });
  }
  async evaluate<T, A = undefined>(fn: (element: HTMLElement, argument: A) => T, argument?: A): Promise<T> {
    await runnerExpect.poll(() => this.count(), { timeout: 10_000, message: `Locator must resolve to one element: ${JSON.stringify(this.steps)}` }).toBe(1);
    try {
      return await this.owner.run(async browser => {
        await this.owner.prepare(browser);
        return browser.executeScript(`const matches = window.__tanweiE2eQuery(arguments[0]); if (matches.length !== 1) throw new Error('Expected one element, found ' + matches.length); return (${fn.toString()})(matches[0], arguments[1]);`, [this.steps, argument ?? null]);
      });
    } catch (error) {
      throw new Error(`Locator evaluation failed: ${JSON.stringify(this.steps)}`, { cause: error });
    }
  }
  evaluateAll<T>(fn: (elements: HTMLElement[]) => T): Promise<T> { return this.inspect(fn as (elements: Element[]) => T); }
  count() { return this.inspect(elements => elements.length); }
  textContent() { return this.evaluate(element => element.textContent); }
  innerText() { return this.evaluate(element => element.innerText); }
  inputValue() { return this.evaluate(element => (element as HTMLInputElement).value); }
  isVisible() { return this.inspect(elements => elements.length === 1 && (window as any).__tanweiE2eVisible(elements[0])); }
  boundingBox() { return this.inspect(elements => { if (elements.length !== 1 || !(window as any).__tanweiE2eVisible(elements[0])) return null; const { x, y, width, height } = elements[0].getBoundingClientRect(); return { x, y, width, height }; }); }
  async scrollIntoViewIfNeeded() { await this.evaluate(element => element.scrollIntoView({ block: "nearest", inline: "nearest" })); }
  private async native<T>(operation: (browser: Session["browser"], id: string) => Promise<T>, timeout = 10_000): Promise<T> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.owner.run(async browser => {
          await this.owner.prepare(browser);
          const key = await browser.executeScript("const nodes=window.__tanweiE2eQuery(arguments[0]);if(nodes.length!==1)throw new Error('Expected one element, found '+nodes.length);const element=nodes[0];if(!window.__tanweiE2eVisible(element)||element.disabled||element.getAttribute('aria-disabled')==='true')throw new Error('Element is not actionable');element.scrollIntoView({block:'nearest',inline:'nearest'});const key='e2e-'+Math.random().toString(36).slice(2);element.setAttribute('data-tanwei-driver',key);return key;", [this.steps]);
          const reference: ElementReference = await browser.command("POST", "/element", { using: "css selector", value: `[data-tanwei-driver="${key}"]` });
          return operation(browser, reference["element-6066-11e4-a52e-4f735466cecf"]);
        });
      } catch (error) { lastError = error; await delay(100); }
    }
    throw new Error(`Locator did not become actionable: ${JSON.stringify(this.steps)}\n${lastError}`);
  }
  click(options: { timeout?: number } = {}) { return this.native((browser, id) => browser.command("POST", `/element/${id}/click`, {}), options.timeout); }
  focus() { return this.evaluate(element => element.focus()); }
  async fill(value: string) {
    // A fill is one replacement. Separate clear/sendKeys requests allow React
    // to unmount editors whose empty value controls their presence.
    await this.native(async browser => browser.executeScript(`
      const nodes = window.__tanweiE2eQuery(arguments[0]);
      if (nodes.length !== 1) throw new Error('Expected one editable element');
      const element = nodes[0];
      element.focus();
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.readOnly) throw new Error('Element is readonly');
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, arguments[1]);
      } else if (element.isContentEditable) {
        element.textContent = arguments[1];
      } else throw new Error('Element is not editable');
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: arguments[1] }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    `, [this.steps, value]));
  }
  async check() {
    const checked = await this.inspect(elements => elements.length === 1 && ((elements[0] as HTMLInputElement).checked || elements[0].getAttribute("aria-checked") === "true"));
    if (!checked) await this.click();
    await runnerExpect.poll(() => this.inspect(elements => elements.length === 1 && ((elements[0] as HTMLInputElement).checked || elements[0].getAttribute("aria-checked") === "true"))).toBe(true);
  }
  async screenshot(options: ScreenshotOptions) {
    await this.scrollIntoViewIfNeeded();
    const screenshot = await this.native<string>((browser, id) => withScreenshotAnimations(browser, options.animations === "disabled", () => browser.command("GET", `/element/${id}/screenshot`)));
    const bytes = Buffer.from(screenshot, "base64"); await mkdir(path.dirname(options.path), { recursive: true }); await writeFile(options.path, bytes); return bytes;
  }
}

function locatorMatchers(subject: Locator | Page, negate = false): any {
  return new Proxy({}, { get(_target, key) {
    if (key === "not") return locatorMatchers(subject, !negate);
    return async (...args: any[]) => {
      const options = args.at(-1);
      const timeout = options && typeof options === "object" && !(options instanceof RegExp) && "timeout" in options ? options.timeout : 10_000;
      let getter: () => Promise<unknown>;
      let method = "toBe";
      let expected = args[0];
      const read = (fn: (elements: Element[]) => unknown) => () => (subject as Locator).inspect(fn);
      const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
      switch (key) {
        case "toBeVisible": getter = read(elements => elements.length === 1 && (window as any).__tanweiE2eVisible(elements[0])); expected = true; break;
        case "toBeHidden": getter = read(elements => elements.length === 0 || !(window as any).__tanweiE2eVisible(elements[0])); expected = true; break;
        case "toBeChecked": getter = read(elements => elements.length === 1 && Boolean((elements[0] as HTMLInputElement).checked || elements[0].getAttribute("aria-checked") === "true")); expected = true; break;
        case "toBeDisabled": case "toBeEnabled": getter = read(elements => elements.length === 1 ? Boolean((elements[0] as HTMLInputElement).disabled || elements[0].getAttribute("aria-disabled") === "true") : null); expected = key === "toBeDisabled"; break;
        case "toBeFocused": getter = read(elements => elements.length === 1 && elements[0] === document.activeElement); expected = true; break;
        case "toBeEmpty": getter = read(elements => elements.length === 1 && ((elements[0] as HTMLInputElement).value ?? elements[0].textContent ?? "").trim() === ""); expected = true; break;
        case "toHaveCount": getter = () => (subject as Locator).count(); break;
        case "toHaveText": case "toContainText": {
          getter = async () => {
            const values = await (subject as Locator).inspect(elements => elements.map(element => element.textContent || ""));
            return Array.isArray(expected) ? values.map(normalize) : normalize(values.join(" "));
          };
          method = Array.isArray(expected) ? "toEqual" : expected instanceof RegExp ? "toMatch" : key === "toContainText" ? "toContain" : "toBe";
          if (typeof expected === "string") expected = normalize(expected); break;
        }
        case "toHaveAttribute": getter = () => (subject as Locator).evaluate((element, name) => element.getAttribute(name), args[0]); expected = args[1]; method = expected instanceof RegExp ? "toMatch" : "toBe"; break;
        case "toHaveCSS": getter = () => (subject as Locator).evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), args[0]); expected = args[1]; method = expected instanceof RegExp ? "toMatch" : "toBe"; break;
        case "toHaveClass": getter = () => (subject as Locator).evaluate(element => element.className); method = expected instanceof RegExp ? "toMatch" : "toBe"; break;
        case "toHaveValue": getter = () => (subject as Locator).inputValue(); method = expected instanceof RegExp ? "toMatch" : "toBe"; break;
        case "toHaveTitle": getter = () => (subject as Page).title(); method = expected instanceof RegExp ? "toMatch" : "toBe"; break;
        case "toHaveURL": getter = () => (subject as Page).url(); method = expected instanceof RegExp ? "toMatch" : "toBe"; break;
        default: throw new Error(`Unsupported desktop assertion ${String(key)}`);
      }
      let assertion: any = runnerExpect.poll(getter, { timeout, message: `Desktop ${String(key)} ${JSON.stringify(expected)}` });
      if (negate) assertion = assertion.not;
      await assertion[method](expected);
    };
  } });
}

interface DesktopAssertions {
  not: DesktopAssertions;
  toBeVisible(options?: { timeout?: number }): Promise<void>;
  toBeHidden(options?: { timeout?: number }): Promise<void>;
  toBeChecked(options?: { timeout?: number }): Promise<void>;
  toBeDisabled(options?: { timeout?: number }): Promise<void>;
  toBeEnabled(options?: { timeout?: number }): Promise<void>;
  toBeFocused(options?: { timeout?: number }): Promise<void>;
  toBeEmpty(options?: { timeout?: number }): Promise<void>;
  toHaveCount(count: number, options?: { timeout?: number }): Promise<void>;
  toHaveText(text: Text | Text[], options?: { timeout?: number }): Promise<void>;
  toContainText(text: Text | Text[], options?: { timeout?: number }): Promise<void>;
  toHaveAttribute(name: string, value: Text, options?: { timeout?: number }): Promise<void>;
  toHaveCSS(name: string, value: Text, options?: { timeout?: number }): Promise<void>;
  toHaveClass(value: Text, options?: { timeout?: number }): Promise<void>;
  toHaveValue(value: Text, options?: { timeout?: number }): Promise<void>;
  toHaveTitle(value: Text, options?: { timeout?: number }): Promise<void>;
  toHaveURL(value: Text, options?: { timeout?: number }): Promise<void>;
}
type DesktopExpect = { (subject: Locator | Page, message?: string): DesktopAssertions } & typeof runnerExpect;

export const expect = new Proxy(runnerExpect, {
  apply(target, thisArg, args) {
    return args[0] instanceof Locator || args[0] instanceof Page ? locatorMatchers(args[0]) : Reflect.apply(target, thisArg, args);
  },
}) as DesktopExpect;
