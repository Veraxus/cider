import { Component, OnInit, OnDestroy, ViewChild, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Document } from '../data-services/types/document.type';
import { DocumentsService } from '../data-services/services/documents.service';
import { PendingSavesService } from '../data-services/services/pending-saves.service';
import { debounceTime, Subject, Subscription, tap } from 'rxjs';
import { ThemeService } from '../data-services/theme/theme.service';

@Component({
  selector: 'app-document',
  templateUrl: './document.component.html',
  styleUrl: './document.component.scss',
  standalone: false
})
export class DocumentComponent implements OnInit, OnDestroy {
  editorOptions: any = {
    theme: 'vs-dark-extended', language: 'markdown',
    automaticLayout: true, minimap: { enabled: false }
  };
  mermaidOptions: any = {
    theme: 'dark'
  };
  textDocument: Document = {
    name: "",
    mime: "text/markdown",
    content: ""
  } as Document;
  disablePanels: boolean = false;
  documentChanges: Subject<boolean>;
  private editor: any;
  private monaco: any;
  private themeSubscription: Subscription | null = null;
  private readonly pendingSaves = inject(PendingSavesService);
  private documentSavePending: boolean = false;
  private unregisterPendingSaves = this.pendingSaves.register(() => this.saveIfPending());

  constructor(private route: ActivatedRoute,
    private themeService: ThemeService,
    private documentsService: DocumentsService,
  ) {
    this.route.paramMap.subscribe(params => {
      const documentIdString = params.get('documentId') || '';
      const documentId = parseInt(documentIdString, 10);
      if (!isNaN(documentId)) {
        this.documentsService.get(documentId).then((textDocument) => {
          this.textDocument = textDocument;
          this.updateEditorType();
        }).catch(error => {
          console.error(`Error fetching document with ID ${documentId}:`, error);
        });
      } else {
        this.textDocument = {
          name: "New Document",
          mime: "text/markdown",
          content: ""
        } as Document;
      }
    });
    this.documentChanges = new Subject();

    // Set initial theme based on current theme
    const isDark = this.themeService.isDarkMode();
    this.editorOptions.theme = isDark ? 'vs-dark-extended' : 'vs';
    this.mermaidOptions = {
      theme: isDark ? 'dark' : 'default',
    };
  }

  protected editorInitialized(editor: any) {
    this.editor = editor;
    this.monaco = (window as any).monaco;
    this.updateEditorType();
  }

  private updateEditorType() {
    if (this.textDocument.mime === 'text/html') {
      this.editorOptions.language = 'html';
    } else if (this.textDocument.mime === 'text/css') {
      this.editorOptions.language = 'css-handlebars';
    } else if (this.textDocument.mime === 'application/javascript') {
      this.editorOptions.language = 'javascript';
    } else {
      this.editorOptions.language = 'markdown';
    }

    if (this.editor && this.monaco) {
      this.monaco.editor.setModelLanguage(this.editor.getModel(), this.editorOptions.language);
    }
  }

  ngOnInit(): void {
    this.documentChanges.asObservable().pipe(
      tap(() => this.documentSavePending = true),
      debounceTime(1000)
    ).subscribe(() => this.saveIfPending());

    // Subscribe to theme changes for Monaco editor
    this.themeSubscription = this.themeService.currentTheme$.subscribe(theme => {
      const isDark = theme.colorScheme === 'dark';
      const monacoTheme = isDark ? 'vs-dark-extended' : 'vs';
      this.editorOptions = { ...this.editorOptions, theme: monacoTheme };
      this.mermaidOptions = {
        theme: isDark ? 'dark' : 'default',
      };
      if (this.monaco && this.editor) {
        this.monaco.editor.setTheme(monacoTheme);
      }
    });
  }

  ngOnDestroy(): void {
    if (this.themeSubscription) {
      this.themeSubscription.unsubscribe();
    }
    this.unregisterPendingSaves();
    // write document edits from the last second instead of dropping them
    this.pendingSaves.track(this.saveIfPending());
  }

  /**
   * Save document edits that are still waiting on the debounce
   */
  private saveIfPending(): Promise<unknown> {
    const id = (<any>this.textDocument)[this.documentsService.getIdField()];
    if (!this.documentSavePending || !id) {
      return Promise.resolve();
    }
    this.documentSavePending = false;
    return this.documentsService.update(id, this.textDocument).catch(error => {
      console.error(`Error saving document with ID ${id}:`, error);
    });
  }

  public save(entity: Document) {
    const id = (<any>this.textDocument)[this.documentsService?.getIdField()];
    if (id) {
      this.updateExisting(id, this.textDocument);
    }
  }

  public updateExisting(id: number, entity: Document) {
    this.documentsService?.update(id, entity).then(result => { }).catch(error => { });
  }

  public debounceSave() {
    this.documentChanges.next(true);
  }


  public onResizeStart(event: any) {
    this.disablePanels = true;
  }

  public onResizeEnd(event: any) {
    this.disablePanels = false;
  }

}
