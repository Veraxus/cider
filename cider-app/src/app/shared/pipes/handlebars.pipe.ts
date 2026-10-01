import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import StringUtils from '../utils/string-utils';
import MultiSelectUtils from '../utils/multi-select-utils';
import { CardLookupService } from 'src/app/data-services/services/card-lookup.service';
import * as Handlebars from 'handlebars';

@Pipe({
  name: 'handlebars',
  standalone: false
})
export class HandlebarsPipe implements PipeTransform {
  private static compiledTemplates = new Map<string, Handlebars.TemplateDelegate>();
  private static readonly MAX_CACHE_SIZE = 500;



  constructor(domSanitizer: DomSanitizer, cardLookupService: CardLookupService) {
    let self = this;

    /***********************************
     * Basic Helpers
     ***********************************/

    /**
     * Resolves the asset URL from the provided path (dot notation support)
     */
    const resolveAsset = (rootAssets: any, path: string): string => {
      if (!rootAssets || !path) return '';
      // Try direct access first (legacy/flat) - normalize to kebab case for key
      const flatKey = StringUtils.toKebabCase(path);
      if (rootAssets[flatKey] && typeof rootAssets[flatKey] === 'string') {
        return rootAssets[flatKey];
      }

      // Try nested access
      const parts = path.split('.');
      let current = rootAssets;
      for (const part of parts) {
        const key = StringUtils.toKebabCase(part);
        if (current && current[key]) {
          current = current[key];
        } else {
          return '';
        }
      }
      return (typeof current === 'string') ? current : '';
    };

    /**
     * {{index assets card.image}}
     */
    Handlebars.registerHelper('index', function (array, value) {
      if (!array || !value) {
        return '';
      }
      // If array is the assets object, use resolveAsset
      // But 'index' helper is generic. 
      // If we want to support nested assets lookups specifically here:
      if (value.includes('.')) {
        // It might be a path.
        // array[value] won't work.
        // We can try to manually traverse if 'array' looks like our assets object?
        // For now, let's keep index generic, but maybe specialized for string keys?
        // If the user uses {{index assets 'icons.fire'}}, array is assets.
        // Does resolving 'icons.fire' work?
        // Let's implement traversal here too or reuse logic if we could.
        // Inline traversal:
        const parts = value.split('.');
        let current = array;
        for (const part of parts) {
          current = current[StringUtils.toKebabCase(part)];
          if (!current) return undefined;
        }
        return current;
      }
      return array[StringUtils.toKebabCase(value)];
    });

    /**
     * Anything the image pass left behind is handlebars written into the card's own text rather
     * than into the template -- a helper call, which the image pattern cannot match because it
     * has arguments. Render it against the context the card is already rendering with, so a
     * value authored mid-sentence works the same as one written in the template. Text that does
     * not compile is left exactly as it was written rather than swallowed.
     */
    let nesting = 0;
    const renderNested = function (text: string, options: any): string {
      if (!text.includes('{{') || nesting >= 3) {
        return text;
      }
      nesting++;
      try {
        let template = HandlebarsPipe.compiledTemplates.get(text);
        if (!template) {
          if (HandlebarsPipe.compiledTemplates.size >= HandlebarsPipe.MAX_CACHE_SIZE) {
            HandlebarsPipe.compiledTemplates.clear();
          }
          template = Handlebars.compile(text);
          HandlebarsPipe.compiledTemplates.set(text, template);
        }
        return template(options.data?.root ?? {});
      } catch (error) {
        return text;
      } finally {
        nesting--;
      }
    };

    const compile = function (value: any, options: any): any {
      if (!value) {
        return value;
      }
      const withImages = ('' + value).replace(/[{][{]([^} ]*)( [0-9]+)?[}][}]/g,
        (match: string, assetPath: string, count: string) => {
          const assetUrl = resolveAsset(options.data.root.assets, assetPath);
          const image = `<img src="${assetUrl}" ${options.hash['width'] ? 'width=' + options.hash['width'] : ''}/>`;
          const multiplier = parseInt(count);
          return !assetUrl ? '' : multiplier ? image.repeat(multiplier) : image;
        });
      return new Handlebars.SafeString(renderNested(withImages, options));
    }

    /**
     * {{compileImages card.description width=100}}
     * {{compile card.description width=100}}
     *
     * card.description: 'Convert two {{apple}} into one {{chip}}'
     * card.description: 'Convert {{apple 2}} into {{chip}}'
     * card.description: "Draw {{deck-lookup 'narrative' 'key' 'addiction-check-alcohol' 'Number'}}"
     */
    Handlebars.registerHelper('compileImages', compile);
    Handlebars.registerHelper('compile', compile);

    /***********************************
     * Control Helpers
     ***********************************/

    /**
     * {{#repeat 10}}
     *    <span>{{this}}</span>
     * {{/repeat}}
     */
    Handlebars.registerHelper('repeat', function (count, options) {
      var accum = '';
      for (var i = 0; i < count; i++)
        accum += options.fn(options.data.root);
      return accum;
    });

    /***********************************
     * Boolean Helpers
     ***********************************/

    /**
     * {{#if (and (eq card.type "mystic") (gt card.power 4))}}
     * {{/if}}
     */
    Handlebars.registerHelper('and', function (a, b) {
      return a && b;
    });

    /**
     * {{#if (and (eq card.type "mystic") (gt card.power 4))}}
     * {{/if}}
     */
    Handlebars.registerHelper('or', function (a, b) {
      return a || b;
    });

    /***********************************
     * Comparison Helpers
     ***********************************/

    /**
     * {{eq card.type 'mystic'}}
     */
    Handlebars.registerHelper('eq', function (a, b) {
      return a == b;
    });
    /**
     * {{gt card.type 'mystic'}}
     */
    Handlebars.registerHelper('gt', function (a, b) {
      return a > b;
    });
    /**
     * {{gte card.type 'mystic'}}
     */
    Handlebars.registerHelper('gte', function (a, b) {
      return a >= b;
    });
    /**
     * {{lt card.type 'mystic'}}
     */
    Handlebars.registerHelper('lt', function (a, b) {
      return a < b;
    });
    /**
     * {{lte card.type 'mystic'}}
     */
    Handlebars.registerHelper('lte', function (a, b) {
      return a <= b;
    });

    /***********************************
     * String Helpers
     ***********************************/

    /**
     * {{concat card.type '-experience'}}
     */
    Handlebars.registerHelper('concat', function (a, b) {
      return '' + a + b;
    });

    /**
     * {{join card.keywords ' / '}}
     * Joins a multi-select value (or any comma separated value, or an array) with the given
     * separator, which defaults to ', '. Use a triple stash for an html separator:
     * {{{join card.keywords '<br>'}}}
     */
    Handlebars.registerHelper('join', function (value, separator) {
      // handlebars always passes its own options object as the last argument
      const glue = typeof separator === 'string' ? separator : ', ';
      return MultiSelectUtils.split(value).join(glue);
    });

    /**
     * {{ranges card.levels}}                 '0, 1, 2, 3, 5' -> '0-3, 5'
     * {{ranges card.levels ' / '}}           '0, 1, 2, 3, 5' -> '0-3 / 5'
     * {{ranges card.levels ', ' ' to '}}     '0, 1, 2, 3, 5' -> '0 to 3, 5'
     * {{ranges card.levels max=5}}           '0, 1' -> '0-1'   (not '0+')
     * Like join, but runs of consecutive numbers are written as a range. Numbers are sorted and
     * repeats dropped; values that aren't numbers are kept, in the order given, after the numbers.
     * The run that reaches the highest checked number is written as 'N+' instead of 'N-M' --
     * since nothing higher is checked, it reads as "N and up". A lone top number (no run) is
     * still shown plain: '0, 1, 2, 5' -> '0-2, 5', not '0-2, 5+'.
     * Pass max= to name the highest value that exists at all, not just on this card. Then only a
     * run reaching that ceiling becomes 'N+', and a run that stops short stays a closed range --
     * so '0, 1' out of a possible 0-5 reads '0-1' rather than claiming "0 and up".
     */
    Handlebars.registerHelper('ranges', function (value, separator, rangeSeparator) {
      const glue = typeof separator === 'string' ? separator : ', ';
      const rangeGlue = typeof rangeSeparator === 'string' ? rangeSeparator : '-';
      const entries = MultiSelectUtils.split(value);
      const isNumber = (entry: string) => !isNaN(Number(entry));
      const numbers = [...new Set(entries.filter(isNumber).map(Number))].sort((a, b) => a - b);
      const hashMax = Number(arguments[arguments.length - 1]?.hash?.['max']);
      const highest = isNaN(hashMax) ? numbers[numbers.length - 1] : hashMax;
      const parts: string[] = [];
      for (let index = 0; index < numbers.length; index++) {
        const start = numbers[index];
        while (index + 1 < numbers.length && numbers[index + 1] === numbers[index] + 1) {
          index++;
        }
        const end = numbers[index];
        if (start === end) {
          parts.push('' + start);
        } else if (end === highest) {
          parts.push(start + '+');
        } else {
          parts.push(start + rangeGlue + end);
        }
      }
      return parts.concat(entries.filter(entry => !isNumber(entry))).join(glue);
    });

    /***********************************
     * Cross Deck Helpers
     ***********************************/

    /**
     * {{deck-lookup 'narrative' 'ID' card.trigger 'Number'}}
     * {{deck-lookup 'narrative' 'ID' card.trigger 'Number' pick='last'}}
     * {{deck-lookup 'narrative' 'ID' card.trigger 'Number' pick='random'}}
     * {{deck-lookup 'narrative' 'ID' card.trigger 'Number' pick=3}}
     * {{deck-lookup 'narrative' 'ID' card.trigger 'Number' pick='all' separator=' / '}}
     * {{deck-lookup 'narrative' 'ID' card.trigger 'Number' pick='count'}}
     * {{deck-lookup 'narrative' 'Name' 'sump' 'Number' match='contains'}}
     *
     * Reads a column of another deck: find the rows of <deck> whose <column> matches <value>,
     * then return their <return column>. Decks, columns and values are matched loosely -- case,
     * spaces and punctuation are ignored, so 'Drink First' finds 'drink-first'. Columns are named
     * as the deck's attributes name them, plus csv-index. A multi-select column matches when any
     * one of its values does.
     *
     * pick chooses between multiple matches: 'first' (the default), 'last', 'random', a 1 based
     * position within the matches, 'all' to join every match with separator (', ' by default), or
     * 'count' for how many matched. 'random' is seeded on the card doing the lookup, so it holds
     * still between the preview, the export and the print sheet, and every column looked up for
     * one card comes from the same row; pass seed= to pick a different row for the same card.
     *
     * match is 'exact' by default, or 'contains' or 'starts' for a partial name.
     *
     * Nothing matched, or no such deck or column, renders as nothing.
     */
    const deckLookup = function (deck: any, column: any, value: any, returnColumn: any, options: any) {
      // handlebars always passes its own options object as the last argument
      if (!options || !options.hash || typeof deck !== 'string' || typeof column !== 'string'
        || typeof returnColumn !== 'string') {
        return '';
      }
      const card = options.data?.root?.card;
      return cardLookupService.lookup({
        deck: deck,
        column: column,
        value: value,
        returnColumn: returnColumn,
        match: options.hash['match'],
        pick: options.hash['pick'],
        separator: options.hash['separator'],
        seed: options.hash['seed'] ?? [card?.id, card?.name].join('|')
      });
    };
    Handlebars.registerHelper('deck-lookup', deckLookup);
    Handlebars.registerHelper('deckLookup', deckLookup);

    /**
     * {{kebabcase 'Clear Orb'}}
     * {{kebab-case 'Clear Orb'}}
     */
    const kebabCase = function (a: any) {
      return StringUtils.toKebabCase(a);
    };
    Handlebars.registerHelper('kebabcase', kebabCase);
    Handlebars.registerHelper('kebab-case', kebabCase);

    /**
     * {{upercase 'Clear Orb'}}
     */
    Handlebars.registerHelper('uppercase', function (a) {
      return ('' + a).toUpperCase();
    });

    /**
     * {{lowercase 'Clear Orb'}}
     */
    Handlebars.registerHelper('lowercase', function (a) {
      return ('' + a).toLowerCase();
    });

    /**
     * {{padZeros card.id 4}}
     */
    Handlebars.registerHelper('padZeros', function (value, numZeros) {
      if (!value || !numZeros) {
        return ''.padStart(numZeros, '0');
      }
      return (value + '').padStart(numZeros, '0');
    });

    /***********************************
     * Math Helpers
     ***********************************/

    /**
     * {{add card.power 2}}
     */
    Handlebars.registerHelper('add', function (a, b) {
      return Number.parseFloat(a) + Number.parseFloat(b);
    });
    /**
     * {{sub card.power 2}}
     */
    Handlebars.registerHelper('sub', function (a, b) {
      return Number.parseFloat(a) - Number.parseFloat(b);
    });
    /**
     * {{multiply card.power 2}}
     */
    Handlebars.registerHelper('multiply', function (a, b) {
      return Number.parseFloat(a) * Number.parseFloat(b);
    });
    /**
     * {{divide card.power 2}}
     */
    Handlebars.registerHelper('divide', function (a, b) {
      return Number.parseFloat(a) / Number.parseFloat(b);
    });
    /**
     * {{ceil card.power 2}}
     */
    Handlebars.registerHelper('ceil', function (a) {
      return Math.ceil(a);
    });
    /**
     * {{floor card.power 2}}
     */
    Handlebars.registerHelper('floor', function (a) {
      return Math.floor(a);
    });
    /**
     * {{abs card.power 2}}
     */
    Handlebars.registerHelper('abs', function (a) {
      return Math.abs(a);
    });

  }

  transform(handlebars: string, assetUrls?: any): string {
    return this.sanitizeCss(this.executeHandlebars(handlebars, assetUrls));
  }

  private executeHandlebars(handlebars: string, assetUrls?: any): string {
    if (!handlebars) {
      return '';
    }
    
    let template = HandlebarsPipe.compiledTemplates.get(handlebars);
    if (!template) {
      if (HandlebarsPipe.compiledTemplates.size >= HandlebarsPipe.MAX_CACHE_SIZE) {
        HandlebarsPipe.compiledTemplates.clear();
      }
      template = Handlebars.compile(handlebars);
      HandlebarsPipe.compiledTemplates.set(handlebars, template);
    }


    try {
      return template({ assets: assetUrls });
    } catch (error) {
      return '';
    }
  }


  private sanitizeCss(css: string): string {
    if (!css) {
      return '';
    }
    return css.replace(/\!important/g, '');
  }

}
