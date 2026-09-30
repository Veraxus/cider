import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import StringUtils from '../utils/string-utils';
import MultiSelectUtils from '../utils/multi-select-utils';
import * as Handlebars from 'handlebars';

@Pipe({
  name: 'handlebars',
  standalone: false
})
export class HandlebarsPipe implements PipeTransform {
  private static compiledTemplates = new Map<string, Handlebars.TemplateDelegate>();
  private static readonly MAX_CACHE_SIZE = 500;



  constructor(domSanitizer: DomSanitizer) {
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

    const compile = function (value: any, options: any): any {
      if (!value) {
        return value;
      }
      return new Handlebars.SafeString(value.replace(/[{][{]([^} ]*)( [0-9]+)?[}][}]/g,
        (match: boolean, assetPath: string, count: string) => {
          const assetUrl = resolveAsset(options.data.root.assets, assetPath);
          const image = `<img src="${assetUrl}" ${options.hash['width'] ? 'width=' + options.hash['width'] : ''}/>`;
          const multiplier = parseInt(count);
          return !assetUrl ? '' : multiplier ? image.repeat(multiplier) : image;
        }));
    }

    /**
     * {{compileImages card.description width=100}}
     * {{compile card.description width=100}}
     * 
     * card.description: 'Convert two {{apple}} into one {{chip}}'
     * card.description: 'Convert {{apple 2}} into {{chip}}'
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
     * Like join, but runs of consecutive numbers are written as a range. Numbers are sorted and
     * repeats dropped; values that aren't numbers are kept, in the order given, after the numbers.
     */
    Handlebars.registerHelper('ranges', function (value, separator, rangeSeparator) {
      const glue = typeof separator === 'string' ? separator : ', ';
      const rangeGlue = typeof rangeSeparator === 'string' ? rangeSeparator : '-';
      const entries = MultiSelectUtils.split(value);
      const isNumber = (entry: string) => !isNaN(Number(entry));
      const numbers = [...new Set(entries.filter(isNumber).map(Number))].sort((a, b) => a - b);
      const parts: string[] = [];
      for (let index = 0; index < numbers.length; index++) {
        const start = numbers[index];
        while (index + 1 < numbers.length && numbers[index + 1] === numbers[index] + 1) {
          index++;
        }
        parts.push(start === numbers[index] ? '' + start : start + rangeGlue + numbers[index]);
      }
      return parts.concat(entries.filter(entry => !isNumber(entry))).join(glue);
    });

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
