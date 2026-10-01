import { Injectable } from '@angular/core';
import { Card } from '../types/card.type';
import { AppDB } from '../indexed-db/db';
import { FieldType } from '../types/field-type.type';
import { CardAttributesService } from './card-attributes.service';
import { CardTemplatesService } from './card-templates.service';
import { EntityField } from '../types/entity-field.type';
import { DecksChildService as DecksChildService } from '../indexed-db/decks-child.service';
import { DecksService } from './decks.service';
import { CardAttribute } from '../types/card-attribute.type';
import StringUtils from 'src/app/shared/utils/string-utils';
import { DropdownOption } from '../types/dropdown-option.type';
import { ElectronService } from '../electron/electron.service';
import { ProjectStateService } from './project-state.service';
import XlsxUtils from 'src/app/shared/utils/xlsx-utils';
import { PersistentPath } from '../types/persistent-path.type';
import { firstValueFrom, groupBy, mergeMap, debounceTime, filter } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class CardsService extends DecksChildService<Card, number> {
  static readonly CSV_INDEX_FIELD = 'csv-index';

  /**
   * Card properties the database owns, as an attribute name would kebab-case to them. A user
   * attribute that landed on one of these would overwrite it on import: an attribute named 'ID'
   * wrote its authored value into the primary key, so every repeated value raised a
   * ConstraintError and opening the project failed. Those attributes get an 'attr-' prefixed
   * field instead, e.g. {{card.attr-id}} for an attribute named 'ID'.
   */
  private static readonly RESERVED_FIELDS = new Set<string>([
    'id', 'name', 'count', CardsService.CSV_INDEX_FIELD]);

  constructor(private attributesService: CardAttributesService,
    private cardTemplatesService: CardTemplatesService,
    decksService: DecksService, db: AppDB,
    private electronService: ElectronService,
    private projectStateService: ProjectStateService) {
    super(decksService, db, AppDB.CARDS_TABLE, [
      { field: 'id', header: 'ID', type: FieldType.numeric, hidden: true },
      { field: 'deckId', header: 'Deck ID', type: FieldType.numeric, hidden: true }
    ]);

    this.electronService.getFileChanged().pipe(
      filter(path => path.endsWith('cards.csv')),
      groupBy(path => path),
      mergeMap(group => group.pipe(debounceTime(300)))
    ).subscribe(path => this.handleFileChanged(path));
  }

  private async handleFileChanged(path: string) {
    const parts = path.split('/');
    if (parts.length < 2) return;
    const folderName = parts[parts.length - 2];

    const decks = await this.decksService.getAll();
    const deck = decks.find(d => StringUtils.toKebabCase(d.name) === folderName);

    if (deck) {
      console.log(`Syncing cards for deck: ${deck.name} from external CSV change.`);
      await this.syncFromCsv(path, deck.id);
    }
  }

  private async syncFromCsv(path: string, deckId: number) {
    const homeUrl = await firstValueFrom(this.electronService.getProjectHomeUrl());
    if (!homeUrl) return;

    const persistentPath: PersistentPath = {
      path: path,
      bookmark: homeUrl.bookmark
    };

    const buffer = await this.electronService.readFile(persistentPath);
    if (!buffer) return;

    const blob: Blob = new Blob([new Uint8Array(buffer)], { type: 'text/csv' });
    const file: File = new File([blob], 'cards.csv', { type: 'text/csv' });

    const fields = await this.getFieldsUnfiltered({ deckId });
    const lookups = await this.getLookups({ deckId });

    const entities = await XlsxUtils.entityImport(fields, lookups, file);

    this.projectStateService.setTrackingEnabled(false);
    try {
      await this.db.table(this.tableName).where({ deckId }).delete();
      await Promise.all(entities.map(entity => {
        (<any>entity)['deckId'] = deckId;
        return this.create(entity, true);
      }));
      console.log(`Synced ${entities.length} cards for deck ${deckId}`);
    } catch (e) {
      console.error("Error syncing cards from CSV", e);
    } finally {
      this.projectStateService.setTrackingEnabled(true);
    }
  }

  override async getFields(equalityCriterias?: { [key: string]: any; }) {
    const attributes = await this.attributesService.getAll(equalityCriterias);
    return this.fields.concat(attributes.map(attribute => this.cardAttributeToEntityField(attribute)));
  }

  async getFieldsUnfiltered(equalityCriterias?: { [key: string]: any; }) {
    const attributes = await this.attributesService.getAllUnfiltered(equalityCriterias);
    return this.fields.concat(attributes.map(attribute => this.cardAttributeToEntityField(attribute)));
  }

  private cardAttributeToEntityField(attribute: CardAttribute) {
    let options: DropdownOption[] = [];

    if (Array.isArray(attribute.options)) {
      if (attribute.options.length > 0 && typeof attribute.options[0] === 'string') {
        options = (attribute.options as unknown as string[]).map(o => ({ value: o, color: '#FFFFFF' }));
      } else {
        options = attribute.options as DropdownOption[];
      }
    } else if (attribute.options) {
      const optsStr = attribute.options as string;
      if (optsStr.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(optsStr);
          if (Array.isArray(parsed)) {
            if (parsed.length > 0 && typeof parsed[0] === 'string') {
              options = parsed.map((o: string) => ({ value: o, color: '#FFFFFF' }));
            } else {
              options = parsed;
            }
          }
        } catch (e) {
          options = optsStr.split(',').map(o => ({ value: o.trim(), color: '#FFFFFF' }));
        }
      } else {
        options = optsStr.split(',').map(o => ({ value: o.trim(), color: '#FFFFFF' }));
      }
    }

    if (attribute.isSystem) {
      if (attribute.name === 'Name') {
        return {
          field: 'name',
          header: attribute.name,
          type: attribute.type,
          description: attribute.description,
          width: attribute.width
        } as EntityField<Card>;
      }
      if (attribute.name === 'Count') {
        return {
          field: 'count',
          header: attribute.name,
          type: attribute.type,
          description: attribute.description,
          width: attribute.width
        } as EntityField<Card>;
      }
      if (attribute.name === 'Front Template') {
        return {
          field: 'frontCardTemplateId',
          header: attribute.name,
          type: attribute.type,
          service: <any>this.cardTemplatesService,
          description: attribute.description,
          width: attribute.width
        } as EntityField<Card>;
      }
      if (attribute.name === 'Back Template') {
        return {
          field: 'backCardTemplateId',
          header: attribute.name,
          type: attribute.type,
          service: <any>this.cardTemplatesService,
          description: attribute.description,
          width: attribute.width
        } as EntityField<Card>;
      }
    }

    const kebabName = StringUtils.toKebabCase(attribute.name);
    return {
      field: CardsService.RESERVED_FIELDS.has(kebabName) ? 'attr-' + kebabName : kebabName,
      header: attribute.name,
      type: attribute.type,
      description: attribute.description,
      options: options,
      width: attribute.width
    } as EntityField<Card>;
  }

  override getEntityName(entity: Card) {
    return entity.name;
  }

  /**
   * Adds the handlebars property card.csv-index: the 1-based row of the card in its
   * deck's cards.csv. The csv is written in the same order that getAll returns.
   */
  override getAll(equalityCriterias?: { [key: string]: any; }) {
    return super.getAll(equalityCriterias).then(cards => {
      cards.forEach((card, index) => (<any>card)[CardsService.CSV_INDEX_FIELD] = index + 1);
      return cards;
    });
  }

  override create(entity: Card, overrideParent?: boolean) {
    return super.create(CardsService.withoutCsvIndex(entity), overrideParent);
  }

  override update(id: number, entity: Card, overrideParent?: boolean) {
    return super.update(id, CardsService.withoutCsvIndex(entity), overrideParent);
  }

  override bulkCreate(entities: Card[]) {
    return super.bulkCreate(entities.map(entity => CardsService.withoutCsvIndex(entity)));
  }

  /**
   * csv-index is computed on load, so it is never stored
   */
  private static withoutCsvIndex(entity: Card): Card {
    if (!entity || !(CardsService.CSV_INDEX_FIELD in entity)) {
      return entity;
    }
    const { [CardsService.CSV_INDEX_FIELD]: csvIndex, ...stored } = <any>entity;
    return stored;
  }
}
