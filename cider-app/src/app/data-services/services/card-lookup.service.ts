import { Injectable } from '@angular/core';
import { debounceTime, filter } from 'rxjs/operators';
import { AppDB } from '../indexed-db/db';
import { Card } from '../types/card.type';
import { Deck } from '../types/deck.type';
import { FieldType } from '../types/field-type.type';
import MultiSelectUtils from 'src/app/shared/utils/multi-select-utils';
import { CardsService } from './cards.service';

/**
 * How a lookup chooses between rows when the criteria match more than one
 */
export type LookupPick = 'first' | 'last' | 'random' | 'all' | 'count' | number;

/**
 * How a lookup compares the criteria value to the column's value
 */
export type LookupMatch = 'exact' | 'contains' | 'starts';

export interface LookupRequest {
  /** the deck to read, by name */
  deck: any;
  /** the column to match on, by its name in that deck */
  column: any;
  /** the value to match */
  value: any;
  /** the column whose value is returned, by its name in that deck */
  returnColumn: any;
  match?: any;
  pick?: any;
  /** joins the values of pick 'all' */
  separator?: any;
  /** makes pick 'random' repeatable: the same seed always chooses the same row */
  seed?: any;
}

interface DeckSnapshot {
  name: string;
  cards: Card[];
  /** loosely matched column name -> the card field holding it */
  fieldsByColumn: Map<string, string>;
  typesByField: Map<string, FieldType>;
}

/**
 * A synchronous, read-only view of every deck's cards, so a card template can reference a card
 * in another deck while it renders. Handlebars helpers cannot await anything, so the whole index
 * is rebuilt up front and then kept in step with the database.
 */
@Injectable({
  providedIn: 'root'
})
export class CardLookupService {
  private decksByName = new Map<string, DeckSnapshot>();
  /** only the newest rebuild is allowed to publish its result */
  private rebuildToken = 0;

  constructor(private db: AppDB, private cardsService: CardsService) {
    this.rebuild();
    this.db.onLoad().subscribe(() => this.rebuild());
    this.db.onChange().pipe(
      filter(event => !event || !event.tableName || [AppDB.CARDS_TABLE,
        AppDB.CARD_ATTRIBUTES_TABLE, AppDB.DECKS_TABLE, 'all'].includes(event.tableName)),
      debounceTime(250)
    ).subscribe(() => this.rebuild());
  }

  /**
   * Compares names the way the rest of the project does: 'Drink First', 'drink first' and
   * 'drink-first' are the same deck, column or value. Keeps digits so '0' and '10' still differ.
   */
  private static loose(value: any): string {
    if (value === undefined || value === null) {
      return '';
    }
    return ('' + value).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Stable 32 bit hash, so pick 'random' returns the same row for the same seed. A card has to
   * render the same way in the preview, the export and the print sheet.
   */
  private static hash(seed: string): number {
    let hash = 2166136261;
    for (let index = 0; index < seed.length; index++) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private async rebuild() {
    const token = ++this.rebuildToken;
    const decksByName = new Map<string, DeckSnapshot>();
    try {
      const decks: Deck[] = await this.db.table(AppDB.DECKS_TABLE).toArray();
      for (const deck of decks) {
        // the fields carry both the column name as authored and the field it was mapped onto,
        // so a template can say 'ID' without knowing the attribute became card.attr-id
        const fields = await this.cardsService.getFieldsUnfiltered({ deckId: deck.id });
        const cards = await this.cardsService.getAllUnfiltered({ deckId: deck.id });
        const fieldsByColumn = new Map<string, string>();
        const typesByField = new Map<string, FieldType>();
        fields.forEach(field => {
          // hidden fields are the database's own: the primary key is reassigned on every load,
          // so letting a template match on it would be a reference that silently moves
          if (field.hidden) {
            return;
          }
          const column = CardLookupService.loose(field.header);
          if (column && !fieldsByColumn.has(column)) {
            fieldsByColumn.set(column, <string>field.field);
          }
          const asField = CardLookupService.loose(field.field);
          if (asField && !fieldsByColumn.has(asField)) {
            fieldsByColumn.set(asField, <string>field.field);
          }
          if (field.type) {
            typesByField.set(<string>field.field, field.type);
          }
        });
        // the csv index is computed on load rather than stored, so add it here too
        cards.forEach((card, index) => (<any>card)[CardsService.CSV_INDEX_FIELD] = index + 1);
        fieldsByColumn.set(CardsService.CSV_INDEX_FIELD, CardsService.CSV_INDEX_FIELD);
        decksByName.set(CardLookupService.loose(deck.name), {
          name: deck.name, cards: cards, fieldsByColumn: fieldsByColumn, typesByField: typesByField
        });
      }
    } catch (error) {
      console.error('Error indexing decks for template lookups', error);
      return;
    }
    if (token === this.rebuildToken) {
      this.decksByName = decksByName;
    }
  }

  /**
   * Every card in the given deck whose column matches the given value, in csv order
   */
  public findMatches(deckName: any, column: any, value: any, match: LookupMatch = 'exact'): Card[] {
    const deck = this.decksByName.get(CardLookupService.loose(deckName));
    if (!deck) {
      return [];
    }
    const field = deck.fieldsByColumn.get(CardLookupService.loose(column));
    const needle = CardLookupService.loose(value);
    if (!field || !needle) {
      return [];
    }
    const isList = deck.typesByField.get(field) === FieldType.multiSelect;
    return deck.cards.filter(card => {
      const cell = (<any>card)[field];
      // a multi-select column matches when any one of its values matches
      const candidates = isList ? MultiSelectUtils.split(cell) : [cell];
      return candidates.some(candidate => {
        const haystack = CardLookupService.loose(candidate);
        if (!haystack) {
          return false;
        }
        if (match === 'contains') {
          return haystack.includes(needle);
        }
        if (match === 'starts') {
          return haystack.startsWith(needle);
        }
        return haystack === needle;
      });
    });
  }

  /**
   * The value of one column of one matching card. Returns '' when nothing matches, so a template
   * renders without the missing value rather than failing outright.
   */
  public lookup(request: LookupRequest): any {
    const match: LookupMatch = ['contains', 'starts'].includes('' + request.match)
      ? <LookupMatch>('' + request.match) : 'exact';
    const matches = this.findMatches(request.deck, request.column, request.value, match);
    const pick = request.pick === undefined || request.pick === null || request.pick === ''
      ? 'first' : request.pick;
    if (pick === 'count') {
      return matches.length;
    }
    if (!matches.length) {
      return '';
    }
    const deck = this.decksByName.get(CardLookupService.loose(request.deck));
    const field = deck?.fieldsByColumn.get(CardLookupService.loose(request.returnColumn));
    if (!field) {
      return '';
    }
    const valueOf = (card: Card) => {
      const cell = (<any>card)[field];
      return cell === undefined || cell === null ? '' : cell;
    };

    if (pick === 'all') {
      const separator = typeof request.separator === 'string' ? request.separator : ', ';
      return matches.map(valueOf).filter(cell => cell !== '').join(separator);
    }
    if (pick === 'last') {
      return valueOf(matches[matches.length - 1]);
    }
    if (pick === 'random') {
      // seeded on the card doing the lookup, so every column of the row picked for one card
      // agrees and the card does not change between renders
      const seed = [request.seed, CardLookupService.loose(request.deck),
        CardLookupService.loose(request.column), CardLookupService.loose(request.value)].join('|');
      return valueOf(matches[CardLookupService.hash(seed) % matches.length]);
    }
    if (pick !== 'first') {
      // an explicit 1 based position within the matches
      const position = Number(pick);
      if (isNaN(position) || position < 1 || position > matches.length) {
        return '';
      }
      return valueOf(matches[Math.floor(position) - 1]);
    }
    return valueOf(matches[0]);
  }
}
