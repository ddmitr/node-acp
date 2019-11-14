
import CFLBinaryPList from './cflbinary';
import acp_properties, {PropName, PropType, PropTypes} from './properties';

interface PropData<N extends PropName = any, T extends PropType = PropTypes[N]> {
    name: N;
    type: T;
    description: string;
    validator: ((value: Buffer, name: N) => boolean) | undefined;
}

interface HeaderData {
    name: PropName;
    flags: number;
    size: number;
}

export function generateACPProperties() {
    const props: PropData[] = [];

    for (let [name, prop] of Object.entries(acp_properties)) {
        const [type, description, validator] = prop;

        if (name.length !== 4) throw new Error('Bad name in ACP properties list: ' + name);

        const types = ['str', 'dec', 'hex', 'log', 'mac', 'cfb', 'bin'];
        if (!types.includes(type)) throw new Error('Bad type in ACP properties list for name: ' + name + ' - ' + type);

        if (!description) throw new Error('Missing description in ACP properties list for name: ' + name);

        props.push({name, type, description, validator});
    }

    return props;
}

export const props = generateACPProperties();

export const HEADER_SIZE = 12;

export type SupportedValues = {
    dec: Buffer | string | number;
    hex: Buffer | string | number;
    mac: Buffer | string;
    bin: Buffer | string;
    cfb: any;
    log: Buffer | string;
    str: Buffer | string;
};

const ValueInitialisers: {
    [T in keyof SupportedValues]: (value: Buffer | string | SupportedValues[T]) => Buffer;
} = {
    dec(value) {
        if (value instanceof Buffer) {
            return value;
        } else if (typeof value === 'number') {
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(value, 0);
            return buffer;
        } else if (typeof value === 'string') {
            return Buffer.from(value, 'binary');
        } else {
            throw new Error('Invalid number value: ' + value);
        }
    },
    hex(value) {
        if (value instanceof Buffer) {
            return value;
        } else if (typeof value === 'number') {
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(value, 0);
            return buffer;
        } else if (typeof value === 'string') {
            return Buffer.from(value, 'binary');
        } else {
            throw new Error('Invalid hex value: ' + value);
        }
    },
    mac(value) {
        if (value instanceof Buffer) return value;

        if (typeof value === 'string') {
            if (value.length === 6) return Buffer.from(value, 'binary');

            const mac_bytes = value.split(':');

            if (mac_bytes.length === 6) {
                return Buffer.from(mac_bytes.join(''), 'hex');
            }
        }

        throw new Error('Invalid mac value: ' + value);
    },
    bin(value) {
        if (value instanceof Buffer) {
            return value;
        } else if (typeof value === 'string') {
            return Buffer.from(value, 'binary');
        } else {
            throw new Error('Invalid bin value: ' + value);
        }
    },
    cfb(value) {
        if (value instanceof Buffer) {
            return value;
        } else if (typeof value === 'string') {
            return Buffer.from(value, 'binary');
        } else {
            throw new Error('Invalid cfb value: ' + value);
        }
    },
    log(value) {
        if (value instanceof Buffer) {
            return value;
        } else if (typeof value === 'string') {
            return Buffer.from(value, 'binary');
        } else {
            throw new Error('Invalid log value: ' + value);
        }
    },
    str(value) {
        if (value instanceof Buffer) {
            return value;
        } else if (typeof value === 'string') {
            return Buffer.from(value, 'binary');
        } else {
            throw new Error('Invalid str value: ' + value);
        }
    },
};

export type FormattedValues = {
    dec: number;
    hex: string;
    mac: string;
    bin: Buffer;
    cfb: any;
    log: string;
    str: string;
};

const ValueFormatters: {
    [T in keyof SupportedValues]: (value: Buffer) => FormattedValues[T];
} = {
    dec(value) {
        return value.readUIntBE(0, value.length);
    },
    hex(value) {
        return '0x' + value.toString('hex');
    },
    mac(value) {
        const mac_bytes: string[] = [];

        for (let i = 0; i < 6; i++) {
            mac_bytes.push(value.slice(i).toString('hex'));
        }

        return mac_bytes.join(':');
    },
    bin(value) {
        // return Buffer.from(value, 'binary').toString('hex');
        return value;
    },
    cfb(value) {
        return CFLBinaryPList.parse(value);
    },
    log(value) {
        return value.toString('binary').split('\x00').map(line => line.trim() + '\n').join('');
    },
    str(value) {
        return value.toString('utf-8');
    },
}

class Property<N extends PropName = any, T extends PropType = PropTypes[N]> {
    readonly name?: N;
    readonly value?: Buffer;

    /**
     * Creates a Property.
     *
     * @param {string} name
     * @param {string} value
     */
    constructor(name?: N | '\0\0\0\0', value?: Buffer | string | SupportedValues[T]) {
        if (name === '\x00\x00\x00\x00' && value === '\x00\x00\x00\x00') {
            name = undefined;
            value = undefined;
        }

        if (name && !this.constructor.getSupportedPropertyNames().includes(name)) {
            throw new Error('Invalid property name passed to Property constructor: ' + name);
        }

        if (value) {
            const prop_type = this.constructor.getPropertyInfoString(name, 'type');

            if (!prop_type || !ValueInitialisers[prop_type]) throw new Error(`Missing handler for ${prop_type} property type`);

            const v: Buffer = value = ValueInitialisers[prop_type](value);

            const validator = this.constructor.getPropertyInfoString(name, 'validator');
            if (validator && !validator(v, name as N)) {
                throw new Error('Invalid value passed to validator for property ' + name + ' - type: ' + typeof value);
            }
        }

        this.name = name as N | undefined;
        this.value = value as Buffer;
    }

    /**
     * Convert the property's value to a JavaScript built in type.
     *
     * @return {*}
     */
    format(): FormattedValues[T] | null {
        if (!this.name || !this.value) return null;

        const type = this.constructor.getPropertyInfoString(this.name, 'type');

        if (!type || !ValueFormatters[type]) throw new Error(`Missing format handler for ${type} property type`);

        return ValueFormatters[type](this.value);
    }

    toString() {
        return JSON.stringify(this.format());
    }

    /**
     * Returns the names of known properties.
     *
     * @return {string[]}
     */
    static getSupportedPropertyNames() {
        return props.map(prop => prop.name);
    }

    get info(): PropData {
        return props.find(p => p.name === this.name);
    }

    static getPropertyInfoString<T extends keyof PropData>(propName: string, key: T): PropData[T] {
        if (!propName) return;

        const prop = props.find(p => p.name === propName);

        if (!prop) {
            console.error('Property', propName, 'not supported');
            return;
        }

        if (!prop[key]) {
            console.error('Invalid property info key', key);
            return;
        }

        return prop[key];
    }

    /**
     * Parses an ACP property.
     *
     * @param {Buffer|string} data
     * @return {Property}
     */
    static parseRawElement(data: Buffer | string) {
        // eslint-disable-next-line no-unused-vars
        const {name, flags, size} = this.unpackHeader(data instanceof Buffer ? data.slice(0, HEADER_SIZE) :
            data.substr(0, HEADER_SIZE));

        // TODO: handle flags
        return new this(name as PropName, data instanceof Buffer ? data.slice(HEADER_SIZE) : data.substr(HEADER_SIZE));
    }

    /**
     * Composes an ACP property.
     *
     * @param {number} flags
     * @param {Property} property
     * @return {Buffer}
     */
    static composeRawElement(flags: number, property: Property) {
        const name = property.name ? property.name : '\x00\x00\x00\x00';
        const value = property.value instanceof Buffer ? property.value :
            typeof property.value === 'number' ? property.value :
            property.value ? Buffer.from(property.value, 'binary') :
            Buffer.from('\x00\x00\x00\x00', 'binary');

        if (typeof value === 'number') {
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(value, 0);

            return Buffer.concat([this.composeRawElementHeader(name, flags, 4), buffer]);
        } else if (value instanceof Buffer) {
            return Buffer.concat([this.composeRawElementHeader(name, flags, value.length), value]);
        } else {
            throw new Error('Unhandled property type for raw element composition');
        }
    }

    static composeRawElementHeader(name: PropName, flags: number, size: number) {
        try {
            return this.packHeader({name, flags, size});
        } catch (err) {
            console.error('Error packing property %s, flags %d, size %d - :', name, flags, size, err);
            throw err;
        }
    }

    /**
     * Packs an ACP property header.
     *
     * @param {object} header_data
     * @return {Buffer}
     */
    static packHeader(header_data: HeaderData) {
        const {name, flags, size} = header_data;
        const buffer = Buffer.alloc(12);

        buffer.write(name, 0, 4);
        buffer.writeUInt32BE(flags, 4);
        buffer.writeUInt32BE(size, 8);

        return buffer;
    }

    /**
     * Unpacks an ACP property header.
     *
     * @param {Buffer|string} header_data
     * @return {object}
     */
    static unpackHeader(header_data: Buffer | string): HeaderData {
        if (header_data.length !== HEADER_SIZE) {
            throw new Error('Header data must be 12 characters');
        }

        const buffer = header_data instanceof Buffer ? header_data : Buffer.from(header_data, 'binary');

        const name = buffer.slice(0, 4).toString() as PropName;
        const flags = buffer.readUInt32BE(4);
        const size = buffer.readUInt32BE(8);

        return {name, flags, size};
    }
}

interface Property<N extends PropName = any, T extends PropType = PropTypes[N]> {
    constructor: typeof Property;
}

export default Property;