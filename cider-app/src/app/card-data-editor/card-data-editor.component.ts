import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CardsService } from '../data-services/services/cards.service';
import { Card } from '../data-services/types/card.type';
import { EntityField } from '../data-services/types/entity-field.type';
import { FieldType } from '../data-services/types/field-type.type';

/**
 * Editable form for the attributes of a single card
 */
@Component({
  selector: 'app-card-data-editor',
  templateUrl: './card-data-editor.component.html',
  styleUrls: ['./card-data-editor.component.scss'],
  standalone: false
})
export class CardDataEditorComponent implements OnInit {
  @Input() card: Card | undefined;
  @Output() cardEdited: EventEmitter<Card> = new EventEmitter<Card>();
  fields: EntityField<Card>[] = [];
  FieldType = FieldType;
  static readonly MULTI_SELECT_SEPARATOR = ', ';

  constructor(private cardsService: CardsService) { }

  ngOnInit(): void {
    this.cardsService.getFields().then(fields => this.fields = fields.filter(field => !field.hidden));
  }

  public getValue(field: EntityField<Card>): any {
    return this.card ? (<any>this.card)[field.field] : undefined;
  }

  public getCheckboxValue(field: EntityField<Card>): boolean {
    const value = this.getValue(field);
    return value === true || value === 'true';
  }

  /**
   * Multi-select values are stored as a comma separated list, the same way a dropdown stores its
   * single value, so they export to the csv and render in a template without any extra handling.
   */
  public getSelectedValues(field: EntityField<Card>): string[] {
    const value = this.getValue(field);
    return value === undefined || value === null || value === ''
      ? []
      : String(value).split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
  }

  public isSelected(field: EntityField<Card>, option: string): boolean {
    return this.getSelectedValues(field).includes(option);
  }

  public toggleSelection(field: EntityField<Card>, option: string, selected: boolean) {
    const values = new Set(this.getSelectedValues(field));
    if (selected) {
      values.add(option);
    } else {
      values.delete(option);
    }
    // written out in the order the attribute defines its options, so the value is stable
    const optionValues = (field.options || []).map(fieldOption => fieldOption.value);
    const ordered = optionValues.filter(value => values.has(value))
      .concat([...values].filter(value => !optionValues.includes(value)));
    this.setValue(field, ordered.join(CardDataEditorComponent.MULTI_SELECT_SEPARATOR));
  }

  public multiSelectInputId(field: EntityField<Card>, option: string): string {
    return `card-data-${String(field.field)}-${option}`;
  }

  public setValue(field: EntityField<Card>, value: any) {
    if (!this.card) {
      return;
    }
    (<any>this.card)[field.field] = value;
    this.cardEdited.emit(this.card);
  }
}
