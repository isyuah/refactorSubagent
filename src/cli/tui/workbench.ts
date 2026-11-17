import {
  BoxRenderable, CodeRenderable, DiffRenderable, InputRenderable, LineNumberRenderable,
  RGBA, ScrollBoxRenderable, SelectRenderable, SyntaxStyle, TabSelectRenderable,
  TextareaRenderable, TextRenderable, createCliRenderer,
  type CliRenderer, type KeyEvent, type Renderable,
} from "@opentui/core";
import { cleanText } from "../terminal.js";

export type Tone = "normal" | "heading" | "accent" | "agent" | "success" | "warning" | "error" | "muted";
export interface Paragraph { text: string; tone?: Tone }
export type Detail = { title: string; paragraphs: readonly Paragraph[]; code?: string; diff?: string; follow?: boolean };
export interface Item { id: string; label: string; description?: string; detail: () => Detail | Promise<Detail>; activate?: () => void | Promise<void> }
export interface Section { id: string; title: string; items: () => readonly Item[] }
export interface Action { id: string; label: string; run: () => void | Promise<void>; disabled?: string; tone?: Tone }
export interface InputRequest { title: string; value?: string; help?: string; multiline?: boolean; validate?: (value: string) => string | null }
export interface Choice { label: string; value: string; description?: string }

/** Layout, input editing, selection, scrolling and painting belong to OpenTUI. */
export class Workbench {
  readonly root: BoxRenderable;
  private readonly header: TextRenderable;
  private readonly navigation: TabSelectRenderable;
  private readonly body: BoxRenderable;
  private readonly listBox: BoxRenderable;
  readonly list: SelectRenderable;
  private readonly detailBox: BoxRenderable;
  readonly detail: ScrollBoxRenderable;
  private readonly actionsBox: BoxRenderable;
  private readonly footer: TextRenderable;
  private sections: readonly Section[] = [];
  private actions: readonly Action[] = [];
  private selection = new Map<string, string>();
  private positions = new Map<string, number>();
  private sectionIndex = 0;
  private selectedId = "";
  private detailKey = "";
  private detailContent = "";
  private readonly syntax: SyntaxStyle;
  private detailsVersion = 0;
  private focusables: Renderable[] = [];
  private buttons: BoxRenderable[] = [];
  private modal: BoxRenderable | null = null;
  private modalCancel: (() => void) | null = null;
  private modalFocus: Renderable[] = [];
  private narrowDetail = false;
  private updating = false;
  private disposed = false;
  private title = "Refactor Subagent";
  private status = "";
  private notice = "Tab 切换区域 · 方向键选择 · Enter 打开 · Q 退出";
  private closedPromise: Promise<void> | null = null;
  onCancel: () => void = () => {};
  onExit: () => void = () => {};
  onFollow: () => void = () => {};
  constructor(readonly renderer: CliRenderer, readonly color: boolean) {
    this.syntax = SyntaxStyle.create(renderer.nativeScene);
    const foreground = this.ink("normal");
    const background = RGBA.defaultBackground();
    this.root = new BoxRenderable(renderer, { id: "workbench", width: "100%", height: "100%", flexDirection: "column", backgroundColor: background });
    renderer.root.add(this.root);
    this.header = new TextRenderable(renderer, { height: 2, width: "100%", wrapMode: "none", truncate: true, fg: this.ink("heading"), paddingLeft: 1, content: this.title });
    this.navigation = new TabSelectRenderable(renderer, { id: "navigation", width: "100%", height: 2, tabWidth: 14,
      showDescription: false, showUnderline: true, wrapSelection: true,
      textColor: foreground, selectedTextColor: this.ink("accent"), backgroundColor: background,
      selectedBackgroundColor: background, focusedBackgroundColor: background });
    this.body = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, width: "100%", flexDirection: "row" });
    this.listBox = new BoxRenderable(renderer, { width: 27, height: "100%", border: true, title: "选择项目", borderColor: this.ink("muted") });
    this.list = new SelectRenderable(renderer, { id: "items", width: "100%", height: "100%", showDescription: true,
      showSelectionIndicator: false, wrapSelection: false, backgroundColor: background,
      focusedBackgroundColor: background, selectedBackgroundColor: background, textColor: foreground,
      focusedTextColor: foreground, selectedTextColor: this.ink("accent"), descriptionColor: this.ink("muted"),
      selectedDescriptionColor: this.ink("accent") });
    this.listBox.add(this.list);
    this.detailBox = new BoxRenderable(renderer, { flexGrow: 1, minWidth: 0, height: "100%", border: true, title: "详情", borderColor: this.ink("muted") });
    this.detail = new ScrollBoxRenderable(renderer, { id: "details", width: "100%", height: "100%", scrollY: true, scrollX: false, stickyStart: "bottom", paddingX: 1, scrollbarOptions: { trackOptions: { foregroundColor: this.ink("muted"), backgroundColor: background } } });
    this.detail.focusable = true;
    this.detailBox.add(this.detail);
    this.body.add(this.listBox); this.body.add(this.detailBox);
    this.actionsBox = new BoxRenderable(renderer, { width: "100%", height: 3, flexDirection: "row", flexWrap: "wrap", gap: 1 });
    this.footer = new TextRenderable(renderer, { width: "100%", height: 2, fg: this.ink("muted"), content: this.notice, paddingLeft: 1 });
    this.root.add(this.header); this.root.add(this.navigation); this.root.add(this.body); this.root.add(this.actionsBox); this.root.add(this.footer);
    this.navigation.on("selectionChanged", (index: number) => { if (!this.updating) this.selectSection(index); });
    this.list.on("selectionChanged", (index: number) => { if (!this.updating) this.selectItem(index); });
    this.list.on("itemSelected", () => { void this.openSelected(); });
    this.detail.onMouseScroll = () => { this.detail.stickyScroll = false; };
    renderer.keyInput.on("keypress", this.keypress);
    renderer.on("resize", this.resize);
    renderer.stdin.on("end", this.eof);
    for (const node of [this.navigation, this.list, this.detail]) node.on("focused", this.focusChanged);
    this.resize();
  }
  static async create(color: boolean): Promise<Workbench> {
    const enabled = color && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
    const renderer = await createCliRenderer({ stdin: process.stdin, stdout: process.stderr, exitOnCtrlC: false,
      exitSignals: [], screenMode: "alternate-screen", consoleMode: "disabled", targetFps: 20,
      useMouse: true, enableMouseMovement: false, openConsoleOnError: false });
    return new Workbench(renderer, enabled);
  }
  ink(tone: Tone): RGBA {
    if (!this.color || tone === "normal") return RGBA.defaultForeground();
    return RGBA.fromIndex(({ heading: 12, accent: 14, agent: 13, success: 10, warning: 11, error: 9, muted: 8 } as const)[tone]);
  }
  setTitle(title: string): void { this.title = cleanText(title); this.paintHeader(); }
  setStatus(status: string): void { this.status = cleanText(status); this.paintHeader(); }
  setNotice(text: string): void { this.notice = cleanText(text); this.focusChanged(); }
  private paintHeader(): void { if (!this.disposed) this.header.content = `${this.title}\n${this.status}`; }
  setSections(sections: readonly Section[]): void {
    this.positions.clear(); this.selection.clear(); this.sectionIndex = 0; this.selectedId = ""; this.detailKey = "";
    this.sections = sections; this.updating = true;
    this.navigation.options = sections.map(section => ({ name: section.title, description: "", value: section.id }));
    this.navigation.setSelectedIndex(0); this.updating = false;
    this.refresh(); this.list.focus();
  }
  setActions(actions: readonly Action[]): void {
    const focused = this.buttons.findIndex(button => button.focused);
    for (const button of this.buttons) button.destroyRecursively();
    this.buttons = []; this.actions = actions;
    for (const action of actions) {
      const label = action.label;
      const button = this.button(this.actionsBox, label, () => { if (!action.disabled) void this.perform(action.run); }, action.disabled ? "muted" : action.tone ?? "accent", `action:${action.id}`);
      button.focusable = !action.disabled;
      this.buttons.push(button);
    }
    this.resize();
    if (focused >= 0) this.buttons.find((button, i) => i >= focused && button.focusable)?.focus();
  }
  private button(parent: BoxRenderable, label: string, action: () => void, tone: Tone = "accent", id?: string): BoxRenderable {
    const button = new BoxRenderable(this.renderer, { id, height: 3, width: Math.min(40, Bun.stringWidth(label) + 4), border: true,
      borderColor: this.ink("muted"), focusedBorderColor: this.ink("accent"), focusable: true, paddingX: 1,
      onKeyDown: key => { if (key.name === "return" || key.name === "space") { key.preventDefault(); action(); } },
      onMouseDown: () => { button.focus(); action(); } });
    button.add(new TextRenderable(this.renderer, { content: label, fg: this.ink(tone), height: 1 }));
    button.on("focused", this.focusChanged); parent.add(button); return button;
  }
  private currentSection(): Section | undefined { return this.sections[this.sectionIndex]; }
  currentItem(): Item | undefined { return this.currentSection()?.items().find(item => item.id === this.selectedId); }
  refresh(): void {
    if (this.disposed) return;
    const section = this.currentSection(); const items = section?.items() ?? [];
    let index = items.findIndex(item => item.id === (this.selection.get(section?.id ?? "") ?? this.selectedId));
    if (index < 0) index = 0;
    this.selectedId = items[index]?.id ?? "";
    if (section) this.selection.set(section.id, this.selectedId);
    this.updating = true;
    this.list.options = items.map((item, i) => ({ name: `${i === index ? "[当前] " : ""}${cleanText(item.label)}`, description: cleanText(item.description ?? ""), value: item.id }));
    this.list.setSelectedIndex(index); this.updating = false;
    this.listBox.title = `${section?.title ?? "选择项目"} · ${items.length}`;
    void this.showDetail(); this.focusChanged();
  }
  selectSection(index: number): void {
    if (!this.sections[index]) return;
    this.savePosition(); this.sectionIndex = index; this.selectedId = this.selection.get(this.sections[index]!.id) ?? "";
    this.updating = true; this.navigation.setSelectedIndex(index); this.updating = false;
    this.detailKey = ""; this.narrowDetail = false; this.refresh(); this.resize();
  }
  selectItem(index: number): void {
    const item = this.currentSection()?.items()[index]; if (!item || item.id === this.selectedId) return;
    this.savePosition(); this.selectedId = item.id; this.selection.set(this.currentSection()!.id, item.id); this.detailKey = ""; this.refresh();
  }
  private savePosition(): void { if (this.detailKey) this.positions.set(this.detailKey, this.detail.scrollTop); }
  private async showDetail(): Promise<void> {
    const item = this.currentItem(); const version = ++this.detailsVersion;
    let detail: Detail;
    try { detail = item ? await item.detail() : { title: "暂无内容", paragraphs: [{ text: "此阶段尚未产生结果。" }] }; }
    catch (error) { detail = { title: "无法读取详情", paragraphs: [{ text: error instanceof Error ? error.message : String(error), tone: "error" }] }; }
    if (this.disposed || version !== this.detailsVersion) return;
    const key = `${this.currentSection()?.id}/${item?.id}`; const changed = key !== this.detailKey;
    const fingerprint = JSON.stringify(detail);
    if (!changed && fingerprint === this.detailContent) return;
    this.detailContent = fingerprint;
    const position = changed ? this.positions.get(key) ?? 0 : this.detail.scrollTop;
    this.detailKey = key; this.detailBox.title = cleanText(detail.title);
    for (const child of this.detail.getChildren()) child.destroyRecursively();
    for (const paragraph of detail.paragraphs) this.detail.add(new TextRenderable(this.renderer, {
      content: cleanText(paragraph.text), fg: this.ink(paragraph.tone ?? "normal"), width: "100%", wrapMode: "word", marginBottom: 1,
    }));
    if (detail.diff !== undefined) this.detail.add(new DiffRenderable(this.renderer, { diff: cleanText(detail.diff), view: "unified", width: "100%",
      fg: this.ink("normal"), syntaxStyle: this.syntax, lineNumberFg: this.ink("muted"), lineNumberBg: RGBA.defaultBackground(), showLineNumbers: true, wrapMode: "word", contextBg: RGBA.defaultBackground(), contextContentBg: RGBA.defaultBackground(), addedLineNumberBg: RGBA.defaultBackground(), removedLineNumberBg: RGBA.defaultBackground(), addedBg: RGBA.defaultBackground(), removedBg: RGBA.defaultBackground(),
      addedContentBg: RGBA.defaultBackground(), removedContentBg: RGBA.defaultBackground(),
      addedSignColor: this.ink("success"), removedSignColor: this.ink("error") }));
    else if (detail.code !== undefined) {
      const code = new CodeRenderable(this.renderer, { content: cleanText(detail.code), syntaxStyle: this.syntax, fg: this.ink("normal"), width: "100%", wrapMode: "word" });
      const numbered = new LineNumberRenderable(this.renderer, { target: code, width: "100%", fg: this.ink("muted"), showLineNumbers: true, minWidth: 3 });
      this.detail.add(numbered);
    }
    if (changed) this.detail.stickyScroll = detail.follow === true;
    this.detail.scrollTop = position;
  }
  private async openSelected(): Promise<void> {
    const item = this.currentItem();
    if (item?.activate) await this.perform(item.activate);
    else { this.narrowDetail = true; this.resize(); this.detail.focus(); }
  }
  async perform(action: () => void | Promise<void>): Promise<void> {
    if (this.modal) return;
    try { await action(); } catch (error) { if (!this.disposed) await this.message("操作失败", error instanceof Error ? error.message : String(error)); }
  }
  private focusChanged = (): void => {
    if (this.disposed) return;
    this.listBox.borderColor = this.ink(this.list.focused ? "accent" : "muted");
    this.detailBox.borderColor = this.ink(this.detail.focused ? "accent" : "muted");
    const focused = this.buttons.findIndex(button => button.focused);
    const name = this.modal ? "输入窗口" : this.navigation.focused ? "分区导航" : this.list.focused ? "列表" : this.detail.focused ? "详情" : this.actions[focused]?.label ?? "列表";
    this.footer.content = `焦点：${name} · ${this.notice}\n${this.actions.filter(action => action.disabled).map(action => `${action.label}：${action.disabled}`).join("；")}`;
  };
  private resize = (): void => {
    if (this.disposed) return;
    const narrow = this.renderer.width < 80;
    this.listBox.visible = !narrow || !this.narrowDetail; this.detailBox.visible = !narrow || this.narrowDetail;
    this.listBox.width = narrow ? "100%" : 27;
    let rows = 1; let used = 0;
    for (const action of this.actions) {
      const width = Math.min(40, Bun.stringWidth(action.label) + 4);
      if (used && used + 1 + width > this.renderer.width) { rows++; used = width; }
      else used += (used ? 1 : 0) + width;
    }
    this.actionsBox.height = rows * 3 + rows - 1;
    const small = this.renderer.width < 60 || this.renderer.height < 18;
    this.body.visible = !small; this.navigation.visible = !small; this.actionsBox.visible = !small;
    this.focusables = [this.navigation, this.list, this.detail, ...this.buttons].filter(node => node.visible && node.focusable && (node !== this.list || this.listBox.visible) && (node !== this.detail || this.detailBox.visible));
    if (small) this.footer.content = "窗口过小，请调整到至少 60 列、18 行；Ctrl+C 取消。\n" + this.status;
    else this.focusChanged();
  };
  private eof = (): void => { this.dismissDialog(); this.onCancel(); };
  dismissDialog(): void { this.modalCancel?.(); }
  private keypress = (key: KeyEvent): void => {
    if (key.ctrl && key.name === "c") { key.preventDefault(); this.dismissDialog(); this.onCancel(); return; }
    if (key.name === "tab") {
      key.preventDefault();
      const nodes = this.modal ? this.modalFocus : this.focusables;
      const index = nodes.findIndex(node => node.focused);
      nodes[(index + (key.shift ? -1 : 1) + nodes.length) % nodes.length]?.focus(); this.focusChanged(); return;
    }
    if (this.modal) { if (key.name === "escape") { key.preventDefault(); this.modalCancel?.(); } return; }
    if (key.name === "escape") { this.narrowDetail = false; this.resize(); this.list.focus(); return; }
    if (key.name === "q") { key.preventDefault(); this.onExit(); return; }
    if (key.name === "end" && this.detail.focused) { this.detail.stickyScroll = true; this.onFollow(); }
    if (["up", "pageup", "home"].includes(key.name) && this.detail.focused) this.detail.stickyScroll = false;
    if (/^[1-9]$/.test(key.name) && this.sections[Number(key.name) - 1]) { key.preventDefault(); this.selectSection(Number(key.name) - 1); }
  };
  private createModal(title: string): BoxRenderable {
    if (this.modal) throw new Error("another dialog is already open");
    const modal = new BoxRenderable(this.renderer, { id: "dialog", position: "absolute", top: "10%", left: "5%", width: "90%", height: "80%",
      border: true, borderColor: this.ink("accent"), backgroundColor: RGBA.defaultBackground(), title: cleanText(title), padding: 1, flexDirection: "column", zIndex: 10 });
    this.root.add(modal); this.modal = modal; return modal;
  }
  private closeModal(): void {
    this.modal?.destroyRecursively(); this.modal = null; this.modalCancel = null; this.modalFocus = []; this.list.focus(); this.focusChanged();
  }
  input(request: InputRequest): Promise<string | null> {
    return new Promise(resolve => {
      const modal = this.createModal(request.title);
      modal.add(new TextRenderable(this.renderer, { content: cleanText(request.help ?? "Tab 切换到提交；Esc 取消。"), fg: this.ink("muted"), width: "100%", marginBottom: 1 }));
      const editor = request.multiline
        ? new TextareaRenderable(this.renderer, { id: "editor", initialValue: cleanText(request.value ?? ""), flexGrow: 1, width: "100%", wrapMode: "word", backgroundColor: RGBA.defaultBackground(), textColor: this.ink("normal"), focusedBackgroundColor: RGBA.defaultBackground() })
        : new InputRenderable(this.renderer, { id: "editor", value: cleanText(request.value ?? ""), width: "100%", backgroundColor: RGBA.defaultBackground(), textColor: this.ink("normal"), focusedBackgroundColor: RGBA.defaultBackground() });
      modal.add(editor);
      const error = new TextRenderable(this.renderer, { content: "", fg: this.ink("error"), width: "100%", height: 2 }); modal.add(error);
      const controls = new BoxRenderable(this.renderer, { flexDirection: "row", height: 3, gap: 1 }); modal.add(controls);
      const done = (value: string | null): void => { this.closeModal(); resolve(value); };
      const submit = (): void => {
        const value = cleanText(editor.plainText).trim(); const failure = request.validate?.(value);
        if (failure) { error.content = failure; editor.focus(); } else done(value);
      };
      const submitButton = this.button(controls, "提交", submit, "accent", "dialog:submit");
      const cancel = this.button(controls, "取消", () => done(null), "muted", "dialog:cancel");
      if (editor instanceof InputRenderable) editor.on("enter", submit);
      this.modalFocus = [editor, submitButton, cancel]; this.modalCancel = () => done(null); editor.focus(); this.focusChanged();
    });
  }
  choose(title: string, choices: readonly Choice[]): Promise<string | null> {
    return new Promise(resolve => {
      const modal = this.createModal(title);
      const select = new SelectRenderable(this.renderer, { id: "choices", width: "100%", flexGrow: 1, showSelectionIndicator: false,
        options: choices.map(choice => ({ name: cleanText(choice.label), description: cleanText(choice.description ?? ""), value: choice.value })),
        backgroundColor: RGBA.defaultBackground(), focusedBackgroundColor: RGBA.defaultBackground(), selectedBackgroundColor: RGBA.defaultBackground(),
        textColor: this.ink("normal"), selectedTextColor: this.ink("accent"), showDescription: true });
      modal.add(select);
      const done = (value: string | null): void => { this.closeModal(); resolve(value); };
      select.on("itemSelected", (index: number) => done(choices[index]!.value));
      const controls = new BoxRenderable(this.renderer, { height: 3, flexDirection: "row", gap: 1 }); modal.add(controls);
      const confirm = this.button(controls, "选择", () => done(choices[select.getSelectedIndex()]!.value));
      const cancel = this.button(controls, "取消", () => done(null), "muted", "dialog:cancel");
      this.modalCancel = () => done(null); this.modalFocus = [select, confirm, cancel]; select.focus(); this.focusChanged();
    });
  }
  message(title: string, text: string): Promise<void> {
    return new Promise(resolve => {
      const modal = this.createModal(title);
      const scroll = new ScrollBoxRenderable(this.renderer, { width: "100%", flexGrow: 1, scrollY: true }); scroll.focusable = true;
      scroll.add(new TextRenderable(this.renderer, { content: cleanText(text), width: "100%", fg: this.ink("normal"), wrapMode: "word" })); modal.add(scroll);
      const controls = new BoxRenderable(this.renderer, { height: 3 }); modal.add(controls);
      const done = (): void => { this.closeModal(); resolve(); };
      const button = this.button(controls, "返回", done, "accent", "dialog:close"); this.modalCancel = done; this.modalFocus = [scroll, button]; button.focus();
    });
  }
  async confirm(title: string, text: string): Promise<boolean> {
    return (await this.choose(title, [{ label: "返回", value: "no", description: text }, { label: "确认", value: "yes" }])) === "yes";
  }
  follow(): void { this.detail.stickyScroll = true; this.detail.scrollTo({ x: 0, y: this.detail.scrollHeight }); }
  async close(): Promise<void> {
    if (this.closedPromise) return this.closedPromise;
    this.disposed = true; this.modalCancel?.(); this.renderer.keyInput.off("keypress", this.keypress); this.renderer.off("resize", this.resize); this.renderer.stdin.off("end", this.eof);
    this.renderer.destroy(); this.closedPromise = this.renderer.closed; await this.closedPromise;
  }
}

