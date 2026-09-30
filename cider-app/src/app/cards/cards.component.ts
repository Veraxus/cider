import { Component, OnInit, viewChild } from '@angular/core';
import { CardsService } from '../data-services/services/cards.service';
import { Card } from '../data-services/types/card.type';
import { DecksService } from '../data-services/services/decks.service';
import { CardAttributesService } from '../data-services/services/card-attributes.service';
import { CardAttribute } from '../data-services/types/card-attribute.type';
import { EntitySpreadsheetComponent } from '../entity-spreadsheet/entity-spreadsheet.component';

@Component({
    selector: 'app-cards',
    templateUrl: './cards.component.html',
    styleUrls: ['./cards.component.scss'],
    standalone: false
})
export class CardsComponent implements OnInit {
  /** the attribute behind the column whose settings were opened in the spreadsheet */
  editedAttribute: CardAttribute = {} as CardAttribute;
  attributeDialogVisible: boolean = false;
  private spreadsheet = viewChild(EntitySpreadsheetComponent);

  constructor(public cardsService: CardsService,
    public attributesService: CardAttributesService) { }

  ngOnInit(): void {
  }

  public editAttribute(attribute: CardAttribute) {
    this.editedAttribute = attribute;
    this.attributeDialogVisible = true;
  }

  public onAttributeDialogVisibleChange(visible: boolean) {
    this.attributeDialogVisible = visible;
    if (!visible) {
      // the column keeps showing its old name, type and options until they are read back
      this.spreadsheet()?.refreshColumns();
    }
  }
}
