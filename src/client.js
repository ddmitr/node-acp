
import Session from './session';
import Message, {HEADER_SIZE as MESSAGE_HEADER_SIZE} from './message';
import Property, {HEADER_SIZE as ELEMENT_HEADER_SIZE} from './property';
import CFLBinaryPList from './cflbinary';

export default class Client {
    /**
     * Creates an ACP Client.
     *
     * @param {string} host
     * @param {number} port
     * @param {string} password
     * @return {undefined}
     */
    constructor(host, port, password) {
        this.host = host;
        this.port = port;
        this.password = password;

        this.session = new Session(host, port, password);
    }

    /**
     * Connects to the ACP server.
     *
     * @param {number} timeout
     * @return {Promise}
     */
    connect(timeout) {
        return this.session.connect(timeout);
    }

    /**
     * Disconnects from the ACP server.
     *
     * @return {Promise}
     */
    disconnect() {
        return this.session.close();
    }

    /**
     * Sends a Message to the ACP server.
     *
     * @param {Message|Buffer|string} data
     * @return {Promise}
     */
    send(data) {
        return this.session.send(data);
    }

    /**
     * Receives data from the ACP server.
     *
     * @param {number} size
     * @return {Promise<string>}
     */
    receive(size) {
        return this.session.receive(size);
    }

    /**
     * Receives a message header from the ACP server.
     *
     * @return {Promise<string>}
     */
    receiveMessageHeader() {
        return this.receive(MESSAGE_HEADER_SIZE);
    }

    /**
     * Receives a property element header from the ACP server.
     *
     * @return {Promise<string>}
     */
    receivePropertyElementHeader() {
        return this.receive(ELEMENT_HEADER_SIZE);
    }

    /**
     * Gets properties from the AirPort device.
     *
     * Client: GetProp {...Property}
     * Server: GetProp
     * Server: ...Property
     *
     * @param {Array} props
     * @return {Array}
     */
    async getProperties(props) {
        let payload = '';

        for (let name of props) {
            payload += Property.composeRawElement(0, name instanceof Property ? name : new Property(name));
        }

        const request = Message.composeGetPropCommand(4, this.password, payload);
        await this.send(request);

        const reply = await this.receiveMessageHeader();
        const reply_header = await Message.parseRaw(reply);

        if (reply_header.error_code !== 0) {
            throw new Error('Error ' . reply_header.error_code);
        }

        const props_with_values = [];

        while (true) {
            const prop_header = await this.receivePropertyElementHeader();
            console.debug('Received property element header:', prop_header);
            const data = await Property.parseRawElementHeader(prop_header);
            console.debug(data);
            const {name, flags, size} = data;

            const value = await this.receive(size);

            if (flags & 1) {
                const error_code = Buffer.from(value, 'binary').readInt32BE(0);
                throw new Error('Error requesting value for property "' + name + '": ' + error_code);
            }

            const prop = new Property(name, value);

            if (typeof prop.name === 'undefined' && typeof prop.value === 'undefined') {
                break;
            }

            console.debug('Prop', prop);

            props_with_values.push(prop);
        }

        return props_with_values;
    }

    /**
     * Sets properties on the AirPort device.
     *
     * @param {Array} props
     * @return {undefined}
     */
    async setProperties(props) {
        let payload = '';

        for (let prop of props) {
            payload += Property.composeRawElement(0, prop);
        }

        const request = Message.composeSetPropCommand(0, this.password, payload);
        await this.send(request);

        const raw_reply = await this.receiveMessageHeader();
        const reply_header = await Message.parseRaw(raw_reply);

        if (reply_header.error_code !== 0) {
            console.log('set properties error code', reply_header.error_code);
            return;
        }

        const prop_header = await this.receivePropertyElementHeader();
        const {name, flags, size} = await Property.parseRawElementHeader(prop_header);

        const value = await this.receive(size);

        if (flags & 1) {
            const error_code = Buffer.from(value, 'binary').readUInt32BE(0);
            throw new Error('Error setting value for property "' + name + '": ' + error_code);
        }

        const prop = new Property(name, value);
        console.debug('Prop', prop);

        if (typeof prop.name === 'undefined' && typeof prop.value === 'undefined') {
            console.debug('found empty prop end marker');
        }
    }

    /**
     * Gets the supported features on the AirPort device.
     *
     * @return {Array}
     */
    async getFeatures() {
        await this.send(Message.composeFeatCommand(0));
        const reply_header = await Message.parseRaw(await this.receiveMessageHeader());
        const reply = await this.receive(reply_header.body_size);
        return CFLBinaryPList.parse(reply);
    }

    async flashPrimary(payload) {
        this.send(Message.composeFlashPrimaryCommand(0, this.password, payload));
        const reply_header = await Message.parseRaw(this.receiveMessageHeader());
        return await this.receive(reply_header.body_size);
    }

    async authenticate() {
        let payload = {
            state: 1,
            username: 'admin',
        };

        const message = Message.composeAuthCommand(4, this.password, CFLBinaryPList.compose(payload));
        await this.send(message);

        const response = await this.session.receiveMessage();
        const data = CFLBinaryPList.parse(response.body);

        if (response.error_code !== 0) {
            console.log('Authenticate error code', response.error_code);
            return;
        }

        return data;
    }
}
