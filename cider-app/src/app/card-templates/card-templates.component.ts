import { Component, OnInit, HostListener, SecurityContext, ViewChild, ElementRef, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ConfirmationService, MessageService } from 'primeng/api';
import { CardTemplatesService } from '../data-services/services/card-templates.service';
import { CardsService } from '../data-services/services/cards.service';
import { CardTemplate } from '../data-services/types/card-template.type';
import { Card } from '../data-services/types/card.type';
import { Subject, Subscription, debounceTime, groupBy, mergeMap, tap } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { Location } from '@angular/common';
import { LocalStorageService, PreviewSettings } from '../data-services/local-storage/local-storage.service';
import { PendingSavesService } from '../data-services/services/pending-saves.service';

const templateCssFront  = 
`.card {
    width: 825px;
    height: 1125px;
    border-radius: 25px;
    text-align: center;
    display: flex;
    flex-direction: column;
    background-color: hsl(0, 0%, 40%);
    border: 45px solid hsl(0, 0%, 10%);
    color: hsl(0, 0%, 90%);
    font-weight: 600;
    font-size: 50px;
}
.card .header {
    height: 300px;
    font-size: 80px;
    font-weight: 600;
    padding: 10px;
    padding-top: 60px;
}
.card .content {
    flex: 1;
    padding: 50px;
    padding-top: 60px;
}
.card .footer {
    height: 200px;
    text-align: right;
    padding: 100px;
    padding-right: 50px;
}`;

const templateHtmlFront = 
`<div class="card">
    <div class="header">{{card.name}}</div>
    <div class="content">Card description</div>
    <div class="footer">A{{#padZeros card.id 3}}{{/padZeros}}</div>
</div>`;

@Component({
    selector: 'app-card-templates',
    templateUrl: './card-templates.component.html',
    styleUrls: ['./card-templates.component.scss'],
    providers: [MessageService, ConfirmationService],
    standalone: false
})
export class CardTemplatesComponent implements OnInit, AfterViewInit, OnDestroy {
  previewSpace?: ElementRef;
  // the preview space is re-created when panels resize or the card data panel is toggled,
  // so watch whichever element is current
  @ViewChild('previewSpace') set previewSpaceElement(element: ElementRef | undefined) {
    this.previewSpace = element;
    this.resizeObserver?.disconnect();
    if (element) {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.disablePanels) {
          this.centerPreview();
        }
      });
      this.resizeObserver.observe(element.nativeElement);
    }
  }
  static readonly DEFAULT_HTML: string = templateHtmlFront;
  static readonly DEFAULT_CSS: string = templateCssFront;
  // have to be non-static
  readonly ZOOM_UP: number = 1.5;
  readonly ZOOM_DOWN: number = 1/1.5;
  readonly DEFAULT_ZOOM: number = Math.pow(this.ZOOM_DOWN, 2);

  htmlEditorOptions: any = { theme: 'vs-dark-extended', language: 'handlebars', 
    automaticLayout: true, minimap: { enabled: false } };
  cssEditorOptions: any = { heme: 'vs-dark-extended', language: 'css-handlebars', 
    automaticLayout: true, minimap: { enabled: false } };
  templates: CardTemplate[] = [];
  cards: Card[] = [];
  // the card dropdown ignores deep-equal option arrays, so names are copied out to refresh on rename
  cardOptions: { name: string, card: Card }[] = [];
  selectedCard: Card = {} as Card;
  selectedTemplate: CardTemplate = {} as CardTemplate;
  editTemplate: CardTemplate = {} as CardTemplate;
  dialogVisible: boolean = false;
  infoVisible: boolean = false;
  infoText: string = '';
  zoom: number = this.DEFAULT_ZOOM;
  previewPanelWidth = 40;
  disablePanels: boolean = false;
  templateChanges: Subject<boolean>;
  disableSplitter = false;
  windowResizing$: Subject<boolean>;
  templateVersion: number = 0;
  isPanning: boolean = false;
  settingsVisible: boolean = false;
  previewSettings: PreviewSettings = {
    tiltEnabled: false,
    trimLinesEnabled: false,
    trimOffset: 0.125,
    trimUnit: 'in',
    safeLinesEnabled: false,
    safeOffset: 0.25,
    safeUnit: 'in',
    cardDataColumnEnabled: false
  };
  unitOptions = [
    { label: 'Inches', value: 'in' },
    { label: 'Pixels', value: 'px' },
    { label: 'mm', value: 'mm' }
  ];

  private panStartX: number = 0;
  private panStartY: number = 0;
  private scrollLeftStart: number = 0;
  private scrollTopStart: number = 0;
  private resizeObserver: ResizeObserver | null = null;
  private cardChanges: Subject<Card> = new Subject<Card>();
  private pendingCardSaves: Map<number, Card> = new Map<number, Card>();
  private templateSavePending: boolean = false;
  private readonly pendingSaves = inject(PendingSavesService);
  private readonly location = inject(Location);
  private unregisterPendingSaves = this.pendingSaves.register(() => this.flushPendingSaves());
  // debounce per card so switching cards mid-edit does not drop the previous card's save
  private cardSaveSubscription: Subscription = this.cardChanges.pipe(
    groupBy(card => card.id),
    mergeMap(group => group.pipe(debounceTime(1000)))
  ).subscribe(card => this.saveCard(card));


  constructor(private domSanitizer: DomSanitizer, 
    public service: CardTemplatesService,
    private cardsService: CardsService,
    private messageService: MessageService, 
    private confirmationService: ConfirmationService,
    private localStorage: LocalStorageService,
    private route: ActivatedRoute) {
      this.route.paramMap.subscribe(params => {
        const templateIdString = params.get('templateId') || '';
        const templateId = parseInt(templateIdString, 10);
        if (!isNaN(templateId)) {
          this.service.get(templateId).then((template) => {
            this.selectedTemplate = template;
            // this.selectedCard = this.cards.find(card => card.templateId === template.id) || {} as Card;
          }).catch(error => {
            console.error(`Error fetching template with ID ${templateId}:`, error);
          });
        }
      });
      this.templateChanges = new Subject();
      this.windowResizing$ = new Subject();
      this.windowResizing$.pipe(debounceTime(200)).subscribe(() => {
        this.disablePanels = false;
        setTimeout(() => this.centerPreview(), 100);
      });
      if (!this.localStorage.getDarkMode()) {
        this.htmlEditorOptions.theme = 'vs';
        this.cssEditorOptions.theme = 'vs';
      }
    }

  ngOnInit(): void {
    const savedSettings = this.localStorage.getPreviewSettings();
    if (savedSettings) {
      this.previewSettings = savedSettings;
    }

    this.service.getAll().then(templates => {
      this.templates = templates;
      // if (this.templates.length > 0) {
      //   this.selectedTemplate = this.templates[0];
      // }
    });
    this.cardsService.getAll().then(cards => {
      this.cards = cards;
      this.refreshCardOptions();
      // preselect the card requested in the url (e.g. from the thumbnails view), otherwise the first card
      this.route.queryParamMap.subscribe(params => {
        const cardId = parseInt(params.get('cardId') || '', 10);
        const requestedCard = this.cards.find(card => card.id === cardId);
        if (requestedCard) {
          this.selectedCard = requestedCard;
        } else if (!this.selectedCard.id && this.cards.length > 0) {
          this.selectedCard = this.cards[0];
        }
      });
    });
    this.templateChanges.asObservable().pipe(
      tap(() => this.templateSavePending = true),
      debounceTime(1000)
    ).subscribe(() => this.saveTemplateIfPending());
  }

  public saveSettings() {
    this.localStorage.setPreviewSettings(this.previewSettings);
  }

  public getTrimOffsetPx(): number {
    return this.convertToPx(this.previewSettings.trimOffset, this.previewSettings.trimUnit);
  }

  public getSafeOffsetPx(): number {
    return this.convertToPx(this.previewSettings.safeOffset, this.previewSettings.safeUnit);
  }

  private convertToPx(value: number, unit: 'in' | 'px' | 'mm'): number {
    if (unit === 'px') return value;
    if (unit === 'in') return value * 300;
    if (unit === 'mm') return (value / 25.4) * 300;
    return value;
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.centerPreview(), 500);
  }

  ngOnDestroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    // save template and card edits still waiting on the debounce
    this.cardSaveSubscription.unsubscribe();
    this.unregisterPendingSaves();
    this.pendingSaves.track(this.flushPendingSaves());
  }

  public onCardEdited(card: Card) {
    this.templateVersion++;
    this.refreshCardOptions();
    this.pendingCardSaves.set(card.id, card);
    this.cardChanges.next(card);
  }

  /**
   * Ctrl+Left / Ctrl+Right select the previous / next card, wrapping around at either end
   */
  @HostListener('window:keydown', ['$event'])
  public onCardShortcut(event: KeyboardEvent) {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
      || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
      return;
    }
    // in text fields and the code editors Ctrl+Arrow moves the cursor by word
    const target = event.target as HTMLElement | null;
    if (this.cards.length === 0 || target?.closest('input, textarea, [contenteditable="true"], .monaco-editor')) {
      return;
    }
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const index = this.cards.findIndex(card => card.id === this.selectedCard.id);
    const nextIndex = index === -1
      ? (step > 0 ? 0 : this.cards.length - 1)
      : (index + step + this.cards.length) % this.cards.length;
    this.selectCard(this.cards[nextIndex]);
  }

  public selectCard(card: Card) {
    this.selectedCard = card;
    // keep the selected card in the url without navigating, so reloading the project returns to it
    this.location.replaceState(this.location.path().split('?')[0], `cardId=${card.id}`);
  }

  private refreshCardOptions() {
    this.cardOptions = this.cards.map(card => ({ name: card.name, card: card }));
  }

  /**
   * Save template and card edits that are still waiting on the debounce
   */
  private flushPendingSaves(): Promise<unknown> {
    const cardSaves = Array.from(this.pendingCardSaves.values()).map(card => this.saveCard(card));
    return Promise.all([this.saveTemplateIfPending(), ...cardSaves]);
  }

  private saveTemplateIfPending(): Promise<unknown> {
    const id = this.selectedTemplate.id;
    if (!this.templateSavePending || !id) {
      return Promise.resolve();
    }
    this.templateSavePending = false;
    return this.service.update(id, this.selectedTemplate, true).catch(error => {
      console.error(`Error saving template with ID ${id}:`, error);
    });
  }

  private saveCard(card: Card): Promise<unknown> {
    if (!this.pendingCardSaves.delete(card.id)) {
      return Promise.resolve();
    }
    return this.cardsService.update(card.id, card).catch(error => {
      console.error(`Error saving card with ID ${card.id}:`, error);
    });
  }

  @HostListener('window:resize', ['$event'])
  onResize(event: any) {
    this.disablePanels = true;
    this.windowResizing$.next(true);
  }

  public updateTemplatesList() {
    this.service.getAll().then(templates => this.templates = templates);
  }

  public changeZoom(change: number) {
    this.zoom *= change;
    this.clampZoom();
  }

  private clampZoom() {
    if (this.zoom < Math.pow(this.ZOOM_DOWN, 5)) {
      this.zoom = Math.pow(this.ZOOM_DOWN, 5);
    } else if (this.zoom > Math.pow(this.ZOOM_UP, 5)) {
      this.zoom = Math.pow(this.ZOOM_UP, 5);
    }
    this.zoom = parseFloat(this.zoom.toFixed(3));
  }

  public onMouseDown(event: MouseEvent, container: HTMLElement) {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    this.isPanning = true;
    this.panStartX = event.clientX;
    this.panStartY = event.clientY;
    this.scrollLeftStart = container.scrollLeft;
    this.scrollTopStart = container.scrollTop;
  }

  public onMouseMove(event: MouseEvent, container: HTMLElement) {
    if (!this.isPanning) return;
    const dx = event.clientX - this.panStartX;
    const dy = event.clientY - this.panStartY;
    container.scrollLeft = this.scrollLeftStart - dx;
    container.scrollTop = this.scrollTopStart - dy;
  }

  public onMouseUp(event: MouseEvent) {
    this.isPanning = false;
  }

  public onMouseLeave(event: MouseEvent) {
    this.isPanning = false;
  }

  public onWheel(event: WheelEvent) {
    event.preventDefault();
    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
    this.zoom *= zoomFactor;
    this.clampZoom();
  }

  public resetZoomAndPan() {
    this.zoom = this.DEFAULT_ZOOM;
    this.centerPreview();
  }

  public centerPreview() {
    if (this.previewSpace) {
      const container = this.previewSpace.nativeElement;
      const scrollHeight = container.scrollHeight;
      const scrollWidth = container.scrollWidth;
      const clientHeight = container.clientHeight;
      const clientWidth = container.clientWidth;

      container.scrollTop = (scrollHeight - clientHeight) / 2;
      container.scrollLeft = (scrollWidth - clientWidth) / 2;
    }
  }

  public debounceSave() {
    this.templateVersion++;
    this.templateChanges.next(true);
  }

  
  public save(entity : CardTemplate) {
    const id = (<any>this.selectedTemplate)[this.service?.getIdField()];
    if (id) {
      this.updateExisting(id, this.selectedTemplate);
    }
  }

  public updateExisting(id: number, entity: CardTemplate) {
    this.service?.update(id, entity, true).then(result => {}).catch(error => {});
  }

  public openCreateNew() {
    this.editTemplate = {
      name: '',
      description: '',
      css: CardTemplatesComponent.DEFAULT_CSS,
      html: CardTemplatesComponent.DEFAULT_HTML
    } as CardTemplate;
    this.dialogVisible = true;
  }

  public openCssInfo() {
    this.infoVisible = true;
    this.infoText = "CSS Guide";
  }

  public openHtmlInfo() {
    this.infoVisible = true;
    this.infoText = "HTML/Handlebars Guide"
      + "\n\ncard attributes: {{card.name}}"
      + "\ntimes helper: {{#times card.strength}}o{{/times}}";
  }

  public openEditDialog(entity : CardTemplate) {
    this.editTemplate = entity;
    this.dialogVisible = true;
  }

  public openDeleteDialog(entity : CardTemplate) {
    this.confirmationService.confirm({
      message: 'Are you sure you want to delete?',
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      accept: () => {
        this.service?.delete((<any>entity)[this.service?.getIdField()]).then(deleted => {
          this.updateTemplatesList();
          this.messageService.add({severity:'success', summary: 'Successful', detail: 'Entity Deleted', life: 3000});
        });
      }
    });
  }

  public onResizeStart(event: any) {
    this.disablePanels = true;
  }

  public onResizeEnd(event: any) {
    this.disablePanels = false;
    this.previewPanelWidth = event.sizes[0];
    setTimeout(() => this.centerPreview(), 100);
  }

}
