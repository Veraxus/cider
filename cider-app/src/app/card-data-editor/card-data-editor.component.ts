import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CardsService } from '../data-services/services/cards.service';
import { Card } from '../data-services/types/card.type';
import { EntityField } from '../data-services/types/entity-field.type';
import { FieldType } from '../data-services/types/field-type.type';
import MultiSelectUtils from '../shared/utils/multi-select-utils';

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

  public isSelected(field: EntityField<Card>, option: string): boolean {
    return MultiSelectUtils.split(this.getValue(field)).includes(option);
  }

  public toggleSelection(field: EntityField<Card>, option: string, selected: boolean) {
    const optionValues = (field.options || []).map(fieldOption => fieldOption.value);
    this.setValue(field, MultiSelectUtils.toggle(this.getValue(field), option, selected, optionValues));
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
