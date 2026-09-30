import { Component, ElementRef, EventEmitter, OnDestroy, OnInit, Output, effect, inject, signal, viewChild, WritableSignal } from '@angular/core';
import { Router } from '@angular/router';
import { CardsService } from '../data-services/services/cards.service';
import { CardAttributesService } from '../data-services/services/card-attributes.service';
import { ThemeService } from '../data-services/theme/theme.service';
import { DecksService } from '../data-services/services/decks.service';
import { PendingSavesService } from '../data-services/services/pending-saves.service';
import { SpreadsheetComponent, Cell, ColumnConfig, DropdownOption, SpreadsheetTheme, longLight, longDark, cosmicDark } from 'oatear-longtable';
import { Card } from '../data-services/types/card.type';
import { CardAttribute } from '../data-services/types/card-attribute.type';
import { Subscription, Subject, debounceTime, firstValueFrom, tap } from 'rxjs';
import StringUtils from '../shared/utils/string-utils';
import MultiSelectUtils from '../shared/utils/multi-select-utils';
import { FieldType } from '../data-services/types/field-type.type';
import { ProgressBarModule } from 'primeng/progressbar';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import { MenuItem } from 'primeng/api';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { CommonModule } from '@angular/common';

/** the open option list of a multi-select cell */
interface MultiSelectEdit {
    row: number;
    col: number;
    top: number;
    left: number;
    width: number;
    options: { value: string, color?: string }[];
    values: string[];
}

@Component({
    selector: 'app-entity-spreadsheet',
    templateUrl: './entity-spreadsheet.component.html',
    styleUrls: ['./entity-spreadsheet.component.scss'],
    standalone: true,
    imports: [SpreadsheetComponent, ProgressBarModule, TranslateModule, CommonModule, ContextMenuModule]
})
export class EntitySpreadsheetComponent implements OnInit, OnDestroy {
    data: WritableSignal<Cell[][]> = signal([]);
    columnConfig: WritableSignal<ColumnConfig[]> = signal([]);
    theme: WritableSignal<SpreadsheetTheme> = signal(longLight);
    isLoading: WritableSignal<boolean> = signal(false);
    rowMenuItems: MenuItem[] = [];
    multiSelectEdit: WritableSignal<MultiSelectEdit | null> = signal(null);
    /** asks the page to edit the attribute behind a column, in place of the spreadsheet's own column settings */
    @Output() attributeEditRequested: EventEmitter<CardAttribute> = new EventEmitter<CardAttribute>();

    private lookups: Map<string, Map<string, number>> = new Map(); // Name -> ID
    private reverseLookups: Map<string, Map<number, string>> = new Map(); // ID -> Name


    private cards: Card[] = [];
    // the spreadsheet replaces every row array when a cell changes, which drops the card id
    // stashed on the row, so the ids are kept here by row position and stamped back onto the rows
    private rowIds: (number | undefined)[] = [];
    // cards whose rows were deleted, written out on the next save
    private pendingDeletions: Set<number> = new Set();
    private attributes: CardAttribute[] = [];
    private subscriptions: Subscription = new Subscription();
    private spreadsheet = viewChild(SpreadsheetComponent);
    private rowMenu = viewChild<ContextMenu>('rowMenu');
    private readonly router = inject(Router);
    private readonly translate = inject(TranslateService);
    private readonly hostElement: HTMLElement = inject(ElementRef).nativeElement;

    private dataChangeSubject = new Subject<Cell[][]>();
    private columnChangeSubject = new Subject<ColumnConfig[]>();
    private dataChangePending = false;
    private pendingColumnConfig: ColumnConfig[] | undefined;
    // changes are written one after another so a flush never runs alongside a debounced save
    private saveQueue: Promise<void> = Promise.resolve();
    private static readonly MULTI_SELECT_MAX_HEIGHT = 240;
    private static readonly MULTI_SELECT_MIN_WIDTH = 160;
    private static readonly MULTI_SELECT_WINDOW_EDGE = 8;
    private unregisterPendingSaves: () => void;

    constructor(
        private cardsService: CardsService,
        private attributesService: CardAttributesService,
        private themeService: ThemeService,
        private decksService: DecksService,
        private pendingSaves: PendingSavesService
    ) {
        this.subscriptions.add(
            this.dataChangeSubject.pipe(
                tap(() => this.dataChangePending = true),
                debounceTime(1000)
            ).subscribe(() => this.saveDataChange())
        );
        this.subscriptions.add(
            this.columnChangeSubject.pipe(
                tap(config => this.pendingColumnConfig = config),
                debounceTime(1000)
            ).subscribe(() => this.saveColumnChange())
        );
        this.unregisterPendingSaves = this.pendingSaves.register(() => this.flushPendingChanges());
        this.interceptColumnSettings();
        this.interceptMultiSelectEditing();
        // capture phase, so this runs before the spreadsheet's own right-click handlers
        this.hostElement.addEventListener('contextmenu', this.onRowContextMenu, true);
    }

    ngOnInit(): void {
        this.loadData();
        this.setupTheme();
    }

    ngOnDestroy(): void {
        this.closeMultiSelectEditor();
        this.hostElement.removeEventListener('contextmenu', this.onRowContextMenu, true);
        this.subscriptions.unsubscribe();
        this.unregisterPendingSaves();
        // write edits from the last second instead of dropping them
        this.pendingSaves.track(this.flushPendingChanges());
    }

    /**
     * The spreadsheet's own column settings only offer the four cell editors it can draw, so a
     * column can't be given an attribute type it doesn't know, such as multi-select. Opening it on
     * a deck attribute shows cider's attribute editor instead, which has every type and the option
     * colors. System columns keep the spreadsheet's dialog, which only lets their width change.
     */
    private interceptColumnSettings(): void {
        effect(() => {
            const spreadsheet = this.spreadsheet();
            if (!spreadsheet?.isColumnSettingsVisible()) {
                return;
            }
            const colIndex = spreadsheet.columnSettingsColIndex();
            const attribute = colIndex === null ? undefined : this.attributeForColumn(this.columnConfig()[colIndex]);
            if (!attribute || attribute.isSystem) {
                return;
            }
            spreadsheet.isColumnSettingsVisible.set(false);
            this.openAttributeEditor(attribute);
        });
    }

    /**
     * The spreadsheet only draws text, numeric, checkbox and dropdown cell editors, so a
     * multi-select cell would be edited as a comma separated string. Editing one opens cider's own
     * option list instead, which ticks and unticks the same options the card data panel shows.
     */
    private interceptMultiSelectEditing(): void {
        effect(() => {
            const spreadsheet = this.spreadsheet();
            const editing = spreadsheet?.editingCell();
            if (!spreadsheet || !editing) {
                return;
            }
            const config = this.columnConfig()[editing.col];
            if (this.attributeForColumn(config)?.type !== FieldType.multiSelect) {
                return;
            }
            spreadsheet.cancelEdit();
            this.openMultiSelectEditor(editing.row, editing.col, config);
        });
    }

    private openMultiSelectEditor(row: number, col: number, config: ColumnConfig): void {
        const cell = this.hostElement.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${col}"]`);
        if (!cell) {
            return;
        }
        const options = (config.options ?? []).map(option => typeof option === 'string'
            ? { value: option }
            : { value: option.value, color: option.color });
        const cellBounds = cell.getBoundingClientRect();
        const height = Math.min(EntitySpreadsheetComponent.MULTI_SELECT_MAX_HEIGHT, options.length * 30 + 8);
        const width = Math.max(cellBounds.width, EntitySpreadsheetComponent.MULTI_SELECT_MIN_WIDTH);
        // open upwards when the list would hang off the bottom of the window, and pull it back
        // when it would hang off the right, which the last columns of a wide table do
        const opensUpward = cellBounds.bottom + height > window.innerHeight && cellBounds.top > height;
        const edge = EntitySpreadsheetComponent.MULTI_SELECT_WINDOW_EDGE;
        this.multiSelectEdit.set({
            row: row,
            col: col,
            top: opensUpward ? cellBounds.top - height : cellBounds.bottom,
            left: Math.max(edge, Math.min(cellBounds.left, window.innerWidth - width - edge)),
            width: width,
            options: options,
            values: MultiSelectUtils.split(this.data()[row]?.[col]?.value)
        });
        document.addEventListener('mousedown', this.onMultiSelectOutsideEvent, true);
        document.addEventListener('keydown', this.onMultiSelectKeyDown, true);
        // the list is placed against the cell, so it has to go once the cell moves
        window.addEventListener('scroll', this.onMultiSelectOutsideEvent, true);
    }

    public isMultiSelectOptionSelected(option: string): boolean {
        return this.multiSelectEdit()?.values.includes(option) ?? false;
    }

    public toggleMultiSelectOption(option: string): void {
        const edit = this.multiSelectEdit();
        if (!edit) {
            return;
        }
        const current = this.data()[edit.row]?.[edit.col]?.value;
        const selected = !MultiSelectUtils.split(current).includes(option);
        const value = MultiSelectUtils.toggle(current, option, selected, edit.options.map(o => o.value));
        this.setCellValue(edit.row, edit.col, value);
        this.multiSelectEdit.set({ ...edit, values: MultiSelectUtils.split(value) });
        this.reselectCell(edit.row, edit.col);
    }

    public closeMultiSelectEditor(): void {
        document.removeEventListener('mousedown', this.onMultiSelectOutsideEvent, true);
        document.removeEventListener('keydown', this.onMultiSelectKeyDown, true);
        window.removeEventListener('scroll', this.onMultiSelectOutsideEvent, true);
        this.multiSelectEdit.set(null);
    }

    private onMultiSelectOutsideEvent = (event: Event) => {
        if (event.type === 'mousedown' && (event.target as HTMLElement)?.closest('.multi-select-editor')) {
            return;
        }
        this.closeMultiSelectEditor();
    };

    private onMultiSelectKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape' || event.key === 'Enter' || event.key === 'Tab') {
            this.closeMultiSelectEditor();
        }
    };

    /**
     * Clicking the option list counts as a click outside the spreadsheet, which drops the cell
     * selection, so the edited cell is selected again
     */
    private reselectCell(row: number, col: number): void {
        const spreadsheet = this.spreadsheet();
        if (!spreadsheet) {
            return;
        }
        spreadsheet.activeCell.set({ row: row, col: col });
        spreadsheet.selectionRanges.set([{ start: { row: row, col: col }, end: { row: row, col: col } }]);
    }

    private setCellValue(row: number, col: number, value: string): void {
        this.data.update(grid => {
            const rows = [...grid];
            const cells = [...rows[row]];
            // the card id is stashed on the row array, and copying the row leaves it behind
            (cells as any).recordId = (rows[row] as any).recordId;
            cells[col] = { ...cells[col], value: value };
            rows[row] = cells;
            return rows;
        });
    }

    private async openAttributeEditor(attribute: CardAttribute): Promise<void> {
        // write queued column edits first, so the editor opens on what is actually saved
        await this.flushPendingChanges();
        const attributes = await this.attributesService.getAll();
        this.attributeEditRequested.emit(attributes.find(saved => saved.id === attribute.id) ?? attribute);
    }

    /**
     * Reloads the columns and rows after an attribute was edited elsewhere
     */
    public async refreshColumns(): Promise<void> {
        this.attributes = await this.attributesService.getAll();
        await this.setupColumns();
        this.setupRows();
    }

    /**
     * The deck attribute a spreadsheet column belongs to
     */
    private attributeForColumn(config: ColumnConfig | undefined): CardAttribute | undefined {
        if (!config) {
            return undefined;
        }
        return this.attributes.find(attribute => StringUtils.toKebabCase(attribute.name) === config.field)
            // newly created columns whose field doesn't match the kebab-case name yet
            ?? this.attributes.find(attribute => attribute.name === config.name);
    }

    /**
     * Replaces the spreadsheet's right-click menu on cells and row numbers with one that can also
     * open the row's card templates. Column header menus are left to the spreadsheet.
     */
    private onRowContextMenu = (event: MouseEvent) => {
        const spreadsheet = this.spreadsheet();
        const target = event.target as HTMLElement;
        const cell = target.closest<HTMLElement>('td[data-row]');
        const rowHeader = target.closest<HTMLElement>('th[data-row-index]');
        if (!spreadsheet || (!cell && !rowHeader)) {
            return;
        }
        event.stopPropagation();

        // let the spreadsheet select the row as it does for its own menu, then close its menu
        let modelRow: number;
        if (cell) {
            modelRow = Number(cell.dataset['row']);
            spreadsheet.onCellContextMenu(event, modelRow, Number(cell.dataset['col']));
        } else {
            const visualRow = Number(rowHeader!.dataset['rowIndex']);
            modelRow = spreadsheet.displayedRows()[visualRow].originalModelIndex;
            spreadsheet.onRowContextMenu(event, visualRow);
        }
        spreadsheet.closeContextMenu();
        this.openRowMenu(event, modelRow);
    };

    private async openRowMenu(event: MouseEvent, modelRow: number) {
        const spreadsheet = this.spreadsheet();
        if (!spreadsheet) {
            return;
        }
        // save pending edits first so the row matches its saved card and template values
        await this.flushPendingChanges();
        const card = this.cardForRow(modelRow);
        const menuData = spreadsheet.contextMenuData();
        // clicking this menu counts as a click outside the spreadsheet, which clears the selection
        // that insert, delete, copy and paste act on, so put the selection back first
        const activeCell = spreadsheet.activeCell();
        const selectionRanges = spreadsheet.selectionRanges();
        const spreadsheetAction = (action: string) => () => {
            spreadsheet.activeCell.set(activeCell);
            spreadsheet.selectionRanges.set(selectionRanges);
            spreadsheet.handleContextMenuAction(action);
        };

        this.rowMenuItems = [
            {
                label: this.translate.instant('spreadsheet.view-front-template'),
                icon: 'pi pi-id-card',
                disabled: !card?.id || typeof card.frontCardTemplateId !== 'number',
                command: () => this.openTemplate(card!, card!.frontCardTemplateId)
            },
            {
                label: this.translate.instant('spreadsheet.view-back-template'),
                icon: 'pi pi-id-card',
                disabled: !card?.id || typeof card.backCardTemplateId !== 'number',
                command: () => this.openTemplate(card!, card!.backCardTemplateId)
            },
            { separator: true },
            { label: menuData.insertRowsAboveText, icon: 'pi pi-arrow-up', command: spreadsheetAction('insertRowAbove') },
            { label: menuData.insertRowsBelowText, icon: 'pi pi-arrow-down', command: spreadsheetAction('insertRowBelow') },
            { separator: true },
            { label: menuData.deleteRowText, icon: 'pi pi-trash', disabled: !menuData.canDeleteRows, command: spreadsheetAction('deleteRows') },
            { separator: true },
            { label: 'Copy', icon: 'pi pi-copy', command: spreadsheetAction('copy') },
            { label: 'Paste', icon: 'pi pi-clipboard', command: spreadsheetAction('paste') }
        ];
        this.rowMenu()?.show(event);
    }

    /**
     * The saved card for a spreadsheet row, matched the same way processDataChange matches rows
     */
    private cardForRow(modelRow: number): Card | undefined {
        const recordId = this.rowIds[modelRow];
        return recordId !== undefined ? this.cards.find(card => card.id === recordId) : undefined;
    }

    private openTemplate(card: Card, templateId: number) {
        this.router.navigate(['/decks', card.deckId, 'templates', templateId], { queryParams: { cardId: card.id } });
    }

    /**
     * Save changes that are still waiting on the debounce, including a cell that is still being edited
     */
    private flushPendingChanges(): Promise<void> {
        const spreadsheet = this.spreadsheet();
        if (spreadsheet?.editingCell()) {
            // saveEdit updates the data signal right away but emits onDataChange later
            spreadsheet.saveEdit();
            this.dataChangePending = true;
        }
        this.saveColumnChange();
        return this.saveDataChange();
    }

    private saveDataChange(): Promise<void> {
        if (this.dataChangePending) {
            this.dataChangePending = false;
            this.saveQueue = this.saveQueue.then(() => this.processDataChange(this.data()))
                .catch(error => console.error('Error saving card changes', error));
        }
        return this.saveQueue;
    }

    private saveColumnChange(): Promise<void> {
        const config = this.pendingColumnConfig;
        if (config) {
            this.pendingColumnConfig = undefined;
            this.saveQueue = this.saveQueue.then(() => this.processColumnChange(config))
                .catch(error => console.error('Error saving column changes', error));
        }
        return this.saveQueue;
    }

    private async loadData(): Promise<void> {
        const [cards, attributes] = await Promise.all([
            this.cardsService.getAll(),
            this.attributesService.getAll()
        ]);

        // if cards are empty, create a default card
        // this is necessary for new decks
        this.cards = cards;
        if (this.cards.length === 0) {
            this.cards.push({ name: 'New Card', count: 1 } as Card);
        }
        this.attributes = attributes;

        if (this.attributes.length === 0) {
            const selectedDeck = await firstValueFrom(this.decksService.getSelectedDeck());
            if (selectedDeck) {
                await this.attributesService.createSystemAttributes(selectedDeck.id);
                this.attributes = await this.attributesService.getAll();
            }
        }

        await this.setupColumns();
        this.setupRows();
    }

    private async setupColumns(): Promise<void> {
        const fields = await this.cardsService.getFields();
        const visibleFields = fields.filter(f => !f.hidden);

        const configs: ColumnConfig[] = await Promise.all(visibleFields.map(async f => {
            const editor = this.mapEditor(f.type);
            let options: (string | DropdownOption)[] = f.options ? f.options : [];

            if (f.service) {
                const entities = await f.service.getAll();
                const nameToId = new Map<string, number>();
                const idToName = new Map<number, string>();

                options = [];
                entities.forEach((e: any) => {
                    const name = e.name;
                    const id = e.id;
                    options.push(name);
                    nameToId.set(name, id);
                    idToName.set(id, name);
                });

                this.lookups.set(f.field as string, nameToId);
                this.reverseLookups.set(f.field as string, idToName);
            }

            const relatedAttribute = this.attributes.find(a => a.name === f.header);

            return {
                name: f.header,
                field: f.field as string,
                width: ((f.width as any) === 'auto' || !f.width) ? 135 : f.width,
                readOnly: f.field === 'id',
                editor: editor,
                options: options,
                description: f.description,
                lockSettings: relatedAttribute?.isSystem,
            };
        }));

        this.columnConfig.set(configs);
    }

    private mapEditor(type: FieldType): 'text' | 'dropdown' | 'checkbox' | 'numeric' {
        switch (type) {
            case FieldType.numeric: return 'numeric';
            case FieldType.dropdown: return 'dropdown';
            case FieldType.checkbox: return 'checkbox';
            // the spreadsheet has no multi-select editor, so those cells hold the selected
            // options as a comma separated list and are edited as text
            default: return 'text';
        }
    }

    private setupRows(): void {
        const rows: Cell[][] = this.cards.map(card => {
            const row: Cell[] = [];
            this.columnConfig().forEach(col => {
                let val = (card as any)[col.field];

                if (this.reverseLookups.has(col.field) && val !== undefined && val !== null) {
                    val = this.reverseLookups.get(col.field)?.get(val) || val;
                }

                row.push({ value: val !== undefined && val !== null ? val : '' });
            });
            // Stash ID for safe retrieval even if rows are reordered
            (row as any).recordId = card.id;
            return row;
        });

        this.rowIds = this.cards.map(card => card.id);
        this.pendingDeletions.clear();
        this.data.set(rows);
    }

    private setupTheme(): void {
        this.updateTheme();
        this.subscriptions.add(
            this.themeService.currentTheme$.subscribe(() => this.updateTheme())
        );
    }

    private updateTheme(): void {
        const current = this.themeService.getCurrentTheme();
        if (current.id === 'cosmic-dark') {
            this.theme.set(cosmicDark);
        } else {
            this.theme.set(current.id.includes('dark') ? longDark : longLight);
        }
    }

    onDataChanged(newData: Cell[][]): void {
        this.syncRowIds(newData);
        this.dataChangeSubject.next(newData);
    }

    /**
     * Keeps track of which card each row belongs to. Inserting or deleting rows keeps the
     * surviving row arrays, and with them the stashed ids, so those changes still line up; editing
     * a cell copies every row array instead, so the ids have to be stamped back on afterwards.
     */
    private syncRowIds(rows: Cell[][]): void {
        const stashedIds = rows.map(row => (row as any).recordId as number | undefined);
        if (stashedIds.some(id => id !== undefined)) {
            this.trackRemovedCards(stashedIds);
            this.rowIds = stashedIds;
        } else if (rows.length !== this.rowIds.length) {
            // no row knows its card, so rows can only be lined up by position, and a row that was
            // removed can't be told apart from one that moved; nothing is deleted from that guess
            this.rowIds = rows.map((row, index) => this.rowIds[index]);
        }
        rows.forEach((row, index) => (row as any).recordId = this.rowIds[index]);
    }

    /**
     * Queues the cards of rows that are no longer in the grid. Only ids the grid itself was
     * showing are queued, so a card this view never loaded is never deleted.
     */
    private trackRemovedCards(newRowIds: (number | undefined)[]): void {
        const keptIds = new Set(newRowIds);
        this.rowIds.forEach(id => {
            if (id !== undefined && !keptIds.has(id)) {
                this.pendingDeletions.add(id);
            }
        });
    }

    private async deleteRemovedCards(): Promise<void> {
        if (this.pendingDeletions.size === 0) {
            return;
        }
        // an undo can bring a row back before its card is written out
        const currentIds = new Set(this.rowIds);
        const removedIds = [...this.pendingDeletions].filter(id => !currentIds.has(id));
        this.pendingDeletions.clear();
        for (const id of removedIds) {
            await this.cardsService.delete(id);
        }
        this.cards = this.cards.filter(card => card.id === undefined || !removedIds.includes(card.id));
    }

    private async processDataChange(newData: Cell[][]): Promise<void> {
        this.isLoading.set(true);
        try {
            const currentConfig = this.columnConfig();
            // a cell that was still being edited is saved into the grid without an emitted change,
            // so line the rows up with their cards again before reading them
            this.syncRowIds(newData);
            await this.deleteRemovedCards();

            for (let rowIndex = 0; rowIndex < newData.length; rowIndex++) {
                const row = newData[rowIndex];
                const recordId = this.rowIds[rowIndex];
                // a row without an id has no card yet; matching those by position used to rewrite
                // every card below an inserted row
                const originalCard = recordId !== undefined
                    ? this.cards.find(c => c.id === recordId)
                    : undefined;

                if (originalCard) {
                    const updatedCard: any = { ...originalCard };

                    row.forEach((cell, cellIndex) => {
                        const colConfig = currentConfig[cellIndex];
                        if (colConfig) {
                            let val = cell.value;
                            if (this.lookups.has(colConfig.field)) {
                                const mapped = this.lookups.get(colConfig.field)?.get(val as string);
                                if (mapped !== undefined) {
                                    val = mapped;
                                }
                            }
                            updatedCard[colConfig.field] = val;
                        }
                    });

                    if (this.hasChanged(originalCard, updatedCard)) {
                        await this.cardsService.update(originalCard.id, updatedCard);
                        // Update local copy
                        const cardIndex = this.cards.findIndex(c => c.id === originalCard?.id);
                        if (cardIndex !== -1) {
                            this.cards[cardIndex] = updatedCard;
                        }
                    }
                } else {
                    // New card creation
                    // Create a basic card object.
                    const newCard: any = { count: 1 }; // Default count
                    let hasData = false;

                    row.forEach((cell, cellIndex) => {
                        const colConfig = currentConfig[cellIndex];
                        if (colConfig) {
                            let val = cell.value;
                            if (this.lookups.has(colConfig.field)) {
                                const mapped = this.lookups.get(colConfig.field)?.get(val as string);
                                if (mapped !== undefined) {
                                    val = mapped;
                                }
                            }
                            newCard[colConfig.field] = val;
                            if (cell.value !== '' && cell.value !== null && cell.value !== undefined) {
                                hasData = true;
                            }
                        }
                    });

                    if (hasData) {
                        try {
                            const createdCard = await this.cardsService.create(newCard);

                            // Attach the new ID to the row so subsequent edits update this card
                            (row as any).recordId = createdCard.id;
                            this.rowIds[rowIndex] = createdCard.id;

                            // the cache is only read by id, so its order doesn't have to match
                            this.cards.push(createdCard);
                        } catch (error) {
                            console.error('Error creating card:', error);
                        }
                    }
                }
            }
        } finally {
            this.isLoading.set(false);
        }
    }

    private hasChanged(oldCard: Card, newCard: any): boolean {
        return JSON.stringify(oldCard) !== JSON.stringify(newCard);
    }

    onColumnChanged(newConfig: ColumnConfig[]): void {
        this.columnChangeSubject.next(newConfig);
        this.columnConfig.set(newConfig);
    }

    private mapToFieldType(editor: string | undefined): FieldType {
        switch (editor) {
            case 'numeric': return FieldType.numeric;
            case 'dropdown': return FieldType.dropdown;
            case 'checkbox': return FieldType.checkbox;
            default: return FieldType.text;
        }
    }

    private async processColumnChange(newConfig: ColumnConfig[]): Promise<void> {
        this.isLoading.set(true);
        try {
            // Updated logic to handle description, types, options and ORDERING

            for (let index = 0; index < newConfig.length; index++) {
                const config = newConfig[index];
                const attr = this.attributeForColumn(config);

                if (attr) {
                    let changed = false;

                    // 1. Update basic properties
                    if (attr.width !== config.width) {
                        attr.width = config.width as number;
                        changed = true;
                    }
                    // System attributes cannot have name changed
                    if (!attr.isSystem && attr.name !== config.name) {
                        attr.name = config.name;
                        changed = true;
                    }

                    // 2. Update Description (if present in config)
                    if (!attr.isSystem && (config as any).description !== undefined && attr.description !== (config as any).description) {
                        attr.description = (config as any).description;
                        changed = true;
                    }

                    // 3. Update Type
                    const newType = this.mapToFieldType(config.editor);
                    // several attribute types share the text editor, so a column is only retyped
                    // when the editor it shows actually changed; otherwise saving a column would
                    // turn a multi-select attribute into plain text
                    const editorChanged = this.mapEditor(attr.type) !== config.editor;
                    if (!attr.isSystem && attr.type !== newType && editorChanged) {
                        attr.type = newType;
                        changed = true;
                    }

                    // 4. Update Options
                    if (config.options && Array.isArray(config.options)) {
                        const newOptionsStr = config.options as any[];
                        let currentOptions: any[] = [];
                        if (Array.isArray(attr.options)) {
                            currentOptions = attr.options;
                        } else if (typeof attr.options === 'string') {
                            const parts = attr.options.split(',');
                            currentOptions = parts.map(v => ({ value: v.trim(), color: '#FFFFFF' }));
                        }

                        const currentValues = currentOptions.map(o => o.value);
                        // Extract option values since newOptionsStr elements can be strings, standard objects, or nested objects.
                        const newValues = newOptionsStr.map((val: any) => {
                            if (typeof val === 'string') return val;
                            if (val && typeof val.value === 'object' && val.value) return val.value.value;
                            return val ? val.value : '';
                        });
                        const valuesChanged = JSON.stringify(currentValues) !== JSON.stringify(newValues);

                        if (!attr.isSystem && valuesChanged) {
                            const mergedOptions = newOptionsStr.map((val: any) => {
                                const valStr = typeof val === 'string' ? val : (val && typeof val.value === 'object' && val.value ? val.value.value : (val ? val.value : ''));
                                const valColor = (val && typeof val !== 'string' && val.color) ? (typeof val.value === 'object' && val.value ? val.value.color || val.color : val.color) : undefined;
                                
                                const existing = currentOptions.find(o => o.value === valStr);
                                if (existing) return existing;
                                return {
                                    value: valStr,
                                    color: valColor || '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
                                };
                            });
                            attr.options = mergedOptions;
                            changed = true;
                        }
                    }

                    // 5. Update Order
                    if (attr.order !== index) {
                        attr.order = index;
                        changed = true;
                    }

                    if (changed) {
                        await this.attributesService.update(attr.id, attr);
                    }
                } else {
                    const newAttr: Partial<CardAttribute> = {
                        deckId: this.attributes[0]?.deckId || this.cards[0]?.deckId || 1,
                        name: config.name,
                        type: this.mapToFieldType(config.editor),
                        description: (config as any).description || '',
                        options: '',
                        width: config.width as number,
                        order: index
                    };
                    if (newAttr.deckId) {
                        const createdAttr = await this.attributesService.create(newAttr as CardAttribute);
                        // Refresh attributes list
                        this.attributes = await this.attributesService.getAll();
                    }
                }
            }

            // Detect removals
            for (const attr of this.attributes) {
                const field = StringUtils.toKebabCase(attr.name);
                const inConfig = newConfig.find(c => c.field === field || c.name === attr.name);

                if (!inConfig && !attr.isSystem) {
                    await this.attributesService.delete(attr.id);
                }
            }
        } finally {
            this.isLoading.set(false);
        }
    }
}
