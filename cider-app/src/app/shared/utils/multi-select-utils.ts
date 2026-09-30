/**
 * Multi-select attribute values are stored as a comma separated list, the same way a dropdown
 * stores its single value, so they export to the csv and render in a template without any
 * extra handling. Every editor that shows them goes through here, so they all agree.
 */
export default class MultiSelectUtils {
    static readonly SEPARATOR = ', ';

    /**
     * The selected options of a stored value
     */
    static split(value: any): string[] {
        if (Array.isArray(value)) {
            return value.map(entry => ('' + entry).trim()).filter(entry => entry.length > 0);
        }
        if (value === undefined || value === null || value === '') {
            return [];
        }
        return ('' + value).split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
    }

    /**
     * Stores the given options in the order the attribute defines them, so the value is stable no
     * matter which order they were ticked in. Values that are no longer an option are kept at the
     * end rather than silently dropped.
     */
    static join(values: Iterable<string>, optionValues: string[]): string {
        const selected = new Set(values);
        return optionValues.filter(value => selected.has(value))
            .concat([...selected].filter(value => !optionValues.includes(value)))
            .join(MultiSelectUtils.SEPARATOR);
    }

    /**
     * The stored value with one option ticked or unticked
     */
    static toggle(value: any, option: string, selected: boolean, optionValues: string[]): string {
        const values = new Set(MultiSelectUtils.split(value));
        if (selected) {
            values.add(option);
        } else {
            values.delete(option);
        }
        return MultiSelectUtils.join(values, optionValues);
    }
}
