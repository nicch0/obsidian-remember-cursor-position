import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TAbstractFile } from 'obsidian';

interface PluginSettings {
	dbFileName: string;
	delayAfterFileOpening: number;
	saveTimer: number;
}

const SAFE_DB_FLUSH_INTERVAL = 5000;

const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '.obsidian/plugins/remember-cursor-position/cursor-positions.json',
	delayAfterFileOpening: 100,
	saveTimer: SAFE_DB_FLUSH_INTERVAL,
};

interface EphemeralState {
	cursor?: {
		from: {
			ch: number
			line: number
		},
		to: {
			ch: number
			line: number
		}
	},
	scroll?: number
}

type LeafId = string;
type FileName = string;

export default class RememberCursorPosition extends Plugin {
	settings: PluginSettings;
	db: { [file_path: string]: EphemeralState };
	lastSavedDb: { [file_path: string]: EphemeralState };
	loadedLeavesCache: Set<[LeafId, FileName]> = new Set();

	async onload() {
		await this.loadSettings();

		try {
			this.db = await this.readDb();
			this.lastSavedDb = await this.readDb();
		} catch (e) {
			console.error(
				"Remember Cursor Position plugin can\'t read database: " + e
			);
			this.db = {};
			this.lastSavedDb = {};
		}

		this.addSettingTab(new SettingTab(this.app, this));

		// Restores the cursor/scroll position when a new markdown file is open
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					console.log(
						`[Remember Cursor Position] File opened: ${file.name}. Restoring position...`,
					);
					this.restoreFilePositionForActiveLeaf();
				}
			}),
		);

		// Saves the database when Obsidian is closing
		this.registerEvent(
			this.app.workspace.on("quit", () => this.writeDb(this.db)),
		);

		// Renames the file in the database when a file is renamed
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.renameFile(file, oldPath),
			),
		);

		// Removes database entry for a file when a file is deleted
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.deleteFile(file)),
		);

		this.registerInterval(
			window.setInterval(() => this.writeDb(this.db), this.settings.saveTimer)
		);

		// Reference handler to plugin for cursor tracker to access
		const plugin = this;

		// Class to listen for any updates to the viewport (i.e. cursor or editor-change events)
		const cursorTracker = ViewPlugin.fromClass(
			class {
				constructor(private view: EditorView) {}

				update(update: ViewUpdate) {
					if (!update.selectionSet) return;
					// On every update, if the update happened and the file or the cursor
					// is changed, update the cursor.
					const currentFile =
						plugin.app.workspace.getActiveFile()?.path;
					if (!currentFile) return;

					const selection = update.state.selection.main;
					const fromPos = update.state.doc.lineAt(selection.from);
					const toPos = update.state.doc.lineAt(selection.to);

					// CodeMirror is 1-based, convert to 0-based
					//
					const currentState = {
						cursor: {
							from: {
								line: fromPos.number - 1,
								ch: selection.from - fromPos.from,
							},
							to: {
								line: toPos.number - 1,
								ch: selection.to - toPos.from,
							},
						},
						scroll: this.view.scrollDOM.scrollTop,
					} satisfies EphemeralState;

					plugin.saveFilePositionIfChanged(currentFile, currentState);
				}
			},
		);
		this.registerEditorExtension(cursorTracker);

		this.restoreFilePositionForActiveLeaf();
	}

	renameFile(file: TAbstractFile, oldPath: string) {
		let newName = file.path;
		let oldName = oldPath;
		this.db[newName] = this.db[oldName];
		delete this.db[oldName];
	}

	deleteFile(file: TAbstractFile) {
		let fileName = file.path;
		delete this.db[fileName];
	}

	private saveFilePositionIfChanged(
		fileName: string,
		currentState: EphemeralState,
	): void {
		// Waiting for load new file
		if (!fileName) return;

		const previousState = this.db[fileName];

		if (
			!previousState ||
			(!isNaN(currentState.scroll) &&
				!this.isEphemeralStatesEquals(currentState, previousState))
		) {
			this.saveEphemeralState(currentState);
		}
	}

	isEphemeralStatesEquals(state1: EphemeralState, state2: EphemeralState): boolean {
		if (state1.cursor && !state2.cursor)
			return false;

		if (!state1.cursor && state2.cursor)
			return false;

		if (state1.cursor) {
			if (state1.cursor.from.ch != state2.cursor.from.ch)
				return false;
			if (state1.cursor.from.line != state2.cursor.from.line)
				return false;
			if (state1.cursor.to.ch != state2.cursor.to.ch)
				return false;
			if (state1.cursor.to.line != state2.cursor.to.line)
				return false;
		}

		if (state1.scroll && !state2.scroll)
			return false;

		if (!state1.scroll && state2.scroll)
			return false;

		if (state1.scroll && state1.scroll != state2.scroll)
			return false;

		return true;
	}

	async restoreFilePositionForActiveLeaf() {
		const fileName = this.app.workspace.getActiveFile()?.path;
		if (!fileName) return;

		// If this leaf+file combination was already loaded, exit early
		// This prevents duplicate restores for the same file
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		const loadedLeafId = [
			activeLeaf.id,
			activeLeaf.getViewState().state.file,
		] as [LeafId, FileName];

		if (activeLeaf && this.loadedLeavesCache.has(loadedLeafId)) return;

		let state: EphemeralState;

		// Get saved state from database
		state = this.db[fileName];
		if (!state) return;

		// Wait for note to load
		await this.delay(this.settings.delayAfterFileOpening);

		// Don't scroll when a link scrolls and highlights text
		// i.e. if file is open by links like [link](note.md#header) and wikilinks
		// See #10, #32, #46, #51
		let containsFlashingSpan =
			this.app.workspace.containerEl.querySelector("span.is-flashing");

		if (!containsFlashingSpan) {
			await this.delay(10);
			this.setEphemeralState(state);
		}
	}

	async readDb(): Promise<{ [file_path: string]: EphemeralState; }> {
		let db: { [file_path: string]: EphemeralState; } = {}

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			db = JSON.parse(data);
		}

		return db;
	}

	async writeDb(db: { [file_path: string]: EphemeralState; }) {
		//create folder for db file if not exist
		let newParentFolder = this.settings.dbFileName.substring(0, this.settings.dbFileName.lastIndexOf("/"));
		if (!(await this.app.vault.adapter.exists(newParentFolder)))
			this.app.vault.adapter.mkdir(newParentFolder);

		if (JSON.stringify(this.db) !== JSON.stringify(this.lastSavedDb)) {
			this.app.vault.adapter.write(
				this.settings.dbFileName,
				JSON.stringify(db)
			);
			this.lastSavedDb = JSON.parse(JSON.stringify(db));
		}
	}

	private async saveEphemeralState(st: EphemeralState) {
		let fileName = this.app.workspace.getActiveFile()?.path;
		if (fileName) {
			//do not save if file changed or was not loaded
			this.db[fileName] = st;
		}
	}

	private setEphemeralState(state: EphemeralState): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		// Restore cursor
		if (state.cursor) {
			view.editor.setSelection(state.cursor.from, state.cursor.to);
		}

		// Restore scroll
		if (state.scroll) {
			view.setEphemeralState(state);
			// view.previewMode.applyScroll(state.scroll);
			// view.sourceMode.applyScroll(state.scroll);
		}
	}

	async loadSettings() {
		let settings: PluginSettings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		if (settings?.saveTimer < SAFE_DB_FLUSH_INTERVAL) {
			settings.saveTimer = SAFE_DB_FLUSH_INTERVAL;
		}
		this.settings = settings;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async delay(ms: number) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

class SettingTab extends PluginSettingTab {
	plugin: RememberCursorPosition;

	constructor(app: App, plugin: RememberCursorPosition) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		let { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Remember cursor position - Settings' });

		new Setting(containerEl)
			.setName('Data file name')
			.setDesc('Save positions to this file')
			.addText((text) =>
				text
					.setPlaceholder("Example: cursor-positions.json")
					.setValue(this.plugin.settings.dbFileName)
					.onChange(async (value) => {
						this.plugin.settings.dbFileName = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Delay after opening a new note')
			.setDesc(
				"This plugin shouldn't scroll if you used a link to the note header like [link](note.md#header). If it did, then increase the delay until everything works. If you are not using links to page sections, set the delay to zero (slider to the left). Slider values: 0-300 ms (default value: 100 ms)."
			)
			.addSlider((text) =>
				text
					.setLimits(0, 300, 10)
					.setValue(this.plugin.settings.delayAfterFileOpening)
					.onChange(async (value) => {
						this.plugin.settings.delayAfterFileOpening = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Delay between saving the cursor position to file')
			.setDesc(
				"Useful for multi-device users. If you don't want to wait until closing Obsidian to the cursor position been saved."			)
			.addSlider((text) =>
				text
					.setLimits(SAFE_DB_FLUSH_INTERVAL, SAFE_DB_FLUSH_INTERVAL * 10, 10)
					.setValue(this.plugin.settings.saveTimer)
					.onChange(async (value) => {
						this.plugin.settings.saveTimer = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
