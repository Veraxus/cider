import { DomSanitizer } from '@angular/platform-browser';
import { CardLookupService } from 'src/app/data-services/services/card-lookup.service';
import { HandlebarsPipe } from './handlebars.pipe';

describe('HandlebarsPipe', () => {
  it('create an instance', () => {
    const pipe = new HandlebarsPipe({} as DomSanitizer, {} as CardLookupService);
    expect(pipe).toBeTruthy();
  });
});
