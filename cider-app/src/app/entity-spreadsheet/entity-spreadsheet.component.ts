import { Component, ElementRef, OnDestroy, OnInit, inject, signal, viewChild, WritableSignal } from '@angular/core';
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
import { FieldType } from '../data-services/types/field-type.type';
import { ProgressBarModule } from 'primeng/progressbar';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import { MenuItem } from 'primeng/api';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { CommonModule } from '@angular/common';

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

    private lookups: Map<string, Map<string, number>> = new Map(); // Name -> ID
    private reverseLookups: Map<string, Map<number, string>> = new Map(); // ID -> Name


    private cards: Card[] = [];
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
        // capture phase, so this runs before the spreadsheet's own right-click handlers
        this.hostElement.addEventListener('contextmenu', this.onRowContextMenu, true);
    }

    ngOnInit(): void {
        this.loadData();
        this.setupTheme();
    }

    ngOnDestroy(): void {
        this.hostElement.removeEventListener('contextmenu', this.onRowContextMenu, true);
        this.subscriptions.unsubscribe();
        this.unregisterPendingSaves();
        // write edits from the last second instead of dropping them
        this.pendingSaves.track(this.flushPendingChanges());
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
        const spreadsheetAction = (action: string) => () => spreadsheet.handleContextMenuAction(action);

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
        const recordId = (this.data()[modelRow] as any)?.recordId;
        return recordId !== undefined ? this.cards.find(card => card.id === recordId) : this.cards[modelRow];
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
        this.dataChangeSubject.next(newData);
    }

    private async processDataChange(newData: Cell[][]): Promise<void> {
        this.isLoading.set(true);
        try {
            const currentConfig = this.columnConfig();

            for (let rowIndex = 0; rowIndex < newData.length; rowIndex++) {
                const row = newData[rowIndex];
                // Try to find by stashed ID first, fall back to index if missing
                const recordId = (row as any).recordId;
                let originalCard: Card | undefined;

                if (recordId !== undefined) {
                    originalCard = this.cards.find(c => c.id === recordId);
                } else {
                    if (rowIndex < this.cards.length) {
                        originalCard = this.cards[rowIndex];
                    }
                }

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

                            // Add to local cache at the correct position if possible, 
                            // or just ensure lookup finds it next time.
                            if (rowIndex >= this.cards.length) {
                                this.cards.push(createdCard);
                            } else {
                                this.cards[rowIndex] = createdCard;
                            }
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
                let attr = this.attributes.find(a => StringUtils.toKebabCase(a.name) === config.field);
                // Fallback for newly created columns where field ID might not match toKebabCase(name) yet
                if (!attr) {
                    attr = this.attributes.find(a => a.name === config.name);
                }

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
                    if (!attr.isSystem && attr.type !== newType) {
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
