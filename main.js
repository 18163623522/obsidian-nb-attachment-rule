/*
 * 笔记白板附件规则 (nb-attachment-rule)
 *
 * 功能 1 附件放置规则：
 *   在「笔记」文件夹下的 .md 里粘贴/拖入附件 → 存到 <笔记>/附件/<笔记名>/
 *   在「白板」文件夹下的 .canvas 里粘贴/拖入附件 → 存到 <白板>/附件/<白板名>/
 *   实现方式：动态接管 Obsidian 保存附件时读取的 attachmentFolderPath 配置，
 *   按当前活动文件的类型与所在祖先文件夹计算目标路径（Obsidian 会自动创建缺失的层级）。
 *
 * 功能 2 附件文件夹置底：
 *   文件管理器中，名为「附件」的文件夹固定排在所在文件夹列表的最后。
 */
"use strict";

const {
  Plugin,
  PluginSettingTab,
  Setting,
  TFolder,
  around,
  normalizePath,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  noteFolderName: "笔记",
  canvasFolderName: "白板",
  attachmentFolderName: "附件",
  sortAttachmentLast: true,
};

module.exports = class NbAttachmentRulePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // ---------- 功能 1：接管附件保存路径 ----------
    const plugin = this;
    this.uninstallConfigPatch = around(this.app.vault, "getConfig", function (old) {
      return function (key) {
        if (key === "attachmentFolderPath") {
          const computed = plugin.computeAttachmentFolder();
          if (computed !== null) return computed;
        }
        return old.call(this, key);
      };
    });

    // ---------- 功能 2：附件文件夹置底 ----------
    this.patchedExplorerProtos = new Set();
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.patchExplorerSort())
    );
    this.app.workspace.onLayoutReady(() => this.patchExplorerSort());

    this.addSettingTab(new NbAttachmentRuleSettingTab(this.app, this));
  }

  onunload() {
    if (this.uninstallConfigPatch) this.uninstallConfigPatch();
    if (this.uninstallSortPatch) this.uninstallSortPatch();
  }

  /**
   * 依据当前活动文件计算附件目标文件夹。
   * 返回 vault 内的文件夹路径；不适用时返回 null（回落到 Obsidian 原生设置）。
   */
  computeAttachmentFolder() {
    const s = this.settings;
    const active = this.app.workspace.getActiveFile();
    if (!active) return null;

    let ancestorName;
    if (active.extension === "canvas") ancestorName = s.canvasFolderName;
    else if (active.extension === "md") ancestorName = s.noteFolderName;
    else return null;

    let folder = active.parent;
    while (folder) {
      if (folder.name === ancestorName) {
        return normalizePath(
          folder.path + "/" + s.attachmentFolderName + "/" + active.basename
        );
      }
      folder = folder.parent;
    }
    return null;
  }

  patchExplorerSort() {
    if (!this.settings.sortAttachmentLast) return;
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf || !leaf.view) return;
    const proto = Object.getPrototypeOf(leaf.view);
    if (this.patchedExplorerProtos.has(proto)) return;
    if (typeof proto.getSortedFolderItems !== "function") {
      console.warn(
        "[笔记白板附件规则] 当前 Obsidian 版本没有 getSortedFolderItems，置底功能不可用（放置规则不受影响）"
      );
      return;
    }
    const plugin = this;
    this.uninstallSortPatch = around(proto, "getSortedFolderItems", function (old) {
      return function (folder) {
        const items = old.call(this, folder);
        try {
          const attName = plugin.settings.attachmentFolderName;
          const isAttachment = (it) => {
            const f = it && (it.file !== undefined ? it.file : it);
            return f instanceof TFolder && f.name === attName;
          };
          const attachments = items.filter(isAttachment);
          if (attachments.length > 0) {
            return items.filter((it) => !isAttachment(it)).concat(attachments);
          }
        } catch (e) {
          console.warn("[笔记白板附件规则] 排序补丁异常", e);
        }
        return items;
      };
    });
    this.patchedExplorerProtos.add(proto);
  }
};

class NbAttachmentRuleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "笔记白板附件规则" });

    new Setting(containerEl)
      .setName("笔记文件夹名")
      .setDesc("md 笔记所在的祖先文件夹名，其附件将存入该文件夹下的 附件/<笔记名>/")
      .addText((text) =>
        text.setValue(this.plugin.settings.noteFolderName).onChange(async (v) => {
          this.plugin.settings.noteFolderName = v.trim() || "笔记";
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("白板文件夹名")
      .setDesc("canvas 白板所在的祖先文件夹名，其附件将存入该文件夹下的 附件/<白板名>/")
      .addText((text) =>
        text.setValue(this.plugin.settings.canvasFolderName).onChange(async (v) => {
          this.plugin.settings.canvasFolderName = v.trim() || "白板";
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("附件文件夹名")
      .setDesc("附件统一存放的子文件夹名（默认：附件）")
      .addText((text) =>
        text.setValue(this.plugin.settings.attachmentFolderName).onChange(async (v) => {
          this.plugin.settings.attachmentFolderName = v.trim() || "附件";
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("附件文件夹置底")
      .setDesc("在文件管理器中把「附件」文件夹固定排在每个文件夹列表的最后")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sortAttachmentLast).onChange(async (v) => {
          this.plugin.settings.sortAttachmentLast = v;
          await this.plugin.saveData(this.plugin.settings);
        })
      );
  }
}
