import { Injectable } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { AppDB } from '../indexed-db/db';
import { DecksService } from './decks.service';
import { CardTemplatesService } from './card-templates.service';
import { CardsService } from './cards.service';
import { DocumentsService } from './documents.service';
import StringUtils from 'src/app/shared/utils/string-utils';

type EntityType = 'deck' | 'template' | 'asset' | 'document';

/**
 * A page url with its database ids replaced by entity names
 */
export interface NamedRoute {
  segments: (string | { type: EntityType, name: string, path?: string })[];
  card?: { name: string, occurrence: number };
}

/**
 * Reloading a project from disk gives every entity a new database id. This describes a page
 * by entity names so that the same page can be found again after the reload.
 */
@Injectable({
  providedIn: 'root'
})
export class NamedRouteService {
  // the url segment that comes before an entity id, e.g. decks/:deckId
  private static readonly ID_PARENTS: { [segment: string]: EntityType } = {
    'decks': 'deck',
    'templates': 'template',
    'assets': 'asset',
    'documents': 'document'
  };
  private static readonly TABLES: { [type in EntityType]: string } = {
    'deck': AppDB.DECKS_TABLE,
    'template': AppDB.CARD_TEMPLATES_TABLE,
    'asset': AppDB.ASSETS_TABLE,
    'document': AppDB.DOCUMENTS_TABLE
  };

  constructor(private router: Router,
    private location: Location,
    private db: AppDB,
    private decksService: DecksService,
    private cardTemplatesService: CardTemplatesService,
    private cardsService: CardsService,
    private documentsService: DocumentsService) { }

  /**
   * Describe a url by entity names
   *
   * @param url defaults to the address bar, which also has changes made without navigating,
   *   such as the card selected in the template editor
   * @returns undefined if an entity in the url does not exist
   */
  public async toNamedRoute(url: string = this.location.path()): Promise<NamedRoute | undefined> {
    const tree = this.router.parseUrl(url);
    const paths = tree.root.children['primary']?.segments.map(segment => segment.path) ?? [];
    const route: NamedRoute = { segments: [] };
    let deckId: number | undefined;
    for (let i = 0; i < paths.length; i++) {
      const type = NamedRouteService.ID_PARENTS[paths[i - 1]];
      const id = Number(paths[i]);
      if (!type || !Number.isInteger(id)) {
        route.segments.push(paths[i]);
        continue;
      }
      const entity: any = await this.db.table(NamedRouteService.TABLES[type]).get(id);
      if (!entity) {
        return undefined;
      }
      if (type === 'deck') {
        deckId = id;
      }
      route.segments.push({ type: type, name: entity.name, path: entity.path });
    }

    // the template editor remembers the selected card
    const cardId = Number(tree.queryParams['cardId']);
    if (deckId !== undefined && Number.isInteger(cardId)) {
      const cards = await this.cardsService.getAll({ deckId: deckId });
      const card = cards.find(c => c.id === cardId);
      if (card) {
        // card names can repeat, so also remember which of the same-named cards it was
        route.card = { name: card.name, occurrence: cards.filter(c => c.name === card.name).indexOf(card) };
      }
    }
    return route;
  }

  /**
   * Build the url of a named route from the current database ids
   *
   * @returns undefined if an entity in the route cannot be found
   */
  public async toUrl(route: NamedRoute): Promise<string | undefined> {
    const paths: string[] = [];
    let deckId: number | undefined;
    for (const segment of route.segments) {
      if (typeof segment === 'string') {
        paths.push(segment);
        continue;
      }
      const id = await this.findId(segment.type, segment.name, segment.path, deckId);
      if (id === undefined) {
        return undefined;
      }
      if (segment.type === 'deck') {
        deckId = id;
      }
      paths.push(String(id));
    }

    const queryParams: { [key: string]: number } = {};
    if (route.card && deckId !== undefined) {
      const cardName = route.card.name;
      const cards = (await this.cardsService.getAll({ deckId: deckId })).filter(card => card.name === cardName);
      const card = cards[route.card.occurrence] ?? cards[0];
      if (card) {
        queryParams['cardId'] = card.id;
      }
    }
    return this.router.serializeUrl(this.router.createUrlTree(['/', ...paths], { queryParams: queryParams }));
  }

  private async findId(type: EntityType, name: string, path: string | undefined,
    deckId: number | undefined): Promise<number | undefined> {
    // decks, templates, and assets are saved under kebab-case file names, so compare in that form
    const fileName = StringUtils.toKebabCase(name);
    const sameFileName = (entity: { name: string }) => StringUtils.toKebabCase(entity.name) === fileName;
    switch (type) {
      case 'deck':
        return (await this.decksService.getAll()).find(sameFileName)?.id;
      case 'template':
        return (await this.cardTemplatesService.getAll({ deckId: deckId })).find(sameFileName)?.id;
      case 'document':
        return (await this.documentsService.getAll()).find(document => document.name === name)?.id;
      case 'asset': {
        // query the name index so only assets with a matching name are read
        const assets = await this.db.table(AppDB.ASSETS_TABLE).where('name').anyOf([name, fileName]).toArray();
        return assets.find(asset => (asset.path || '') === (path || ''))?.id;
      }
    }
    return undefined;
  }
}
