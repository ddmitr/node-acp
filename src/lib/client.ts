
import Session, {SessionLock} from './session';
import Message, {HEADER_SIZE as MESSAGE_HEADER_SIZE} from './message';
import Property, {HEADER_SIZE as ELEMENT_HEADER_SIZE} from './property';
import {PropName} from './properties'; // eslint-disable-line no-unused-vars
import CFLBinaryPList from './cflbinary';
import {LogLevel, loglevel} from '..';

import crypto from 'crypto';

// eslint-disable-next-line no-unused-vars
import srp, {SrpParams} from 'fast-srp-hap';
import BigInteger from 'fast-srp-hap/lib/jsbn';

import adler32 from 'adler32';

interface PropSetResponse {
    name: PropName;
    flags: number;
    size: number;
    value: Buffer;
}

export default class Client {
    readonly host: string;
    readonly port: number;
    readonly password: string;

    private readonly session: Session;

    private authenticating: Promise<void> | null = null;

    /**
     * Creates an ACP Client.
     *
     * @param {string} host
     * @param {number} port
     * @param {string} password
     */
    constructor(host: string, port: number, password: string) {
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
    connect(timeout?: number) {
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

    get connected() {
        return !!this.session.socket;
    }

    get session_encrypted() {
        return this.session.encryption;
    }

    get local_address(): [string, number] {
        return [this.session.socket!.localAddress, this.session.socket!.localPort];
    }

    get remote_address(): [string, number] {
        return [this.session.socket!.remoteAddress!, this.session.socket!.remotePort!];
    }

    /**
     * Sends a Message to the ACP server.
     *
     * @param {Message} data
     * @return {Promise<Message>}
     */
    send(message: Message) {
        return this.session.queue(async session => {
            await session.send(message);
            return session.receiveMessageHeader();
        });
    }

    /**
     * Gets properties from the AirPort device.
     *
     * Client: GetProp {...Property}
     * Server: GetProp
     * Server: ...Property
     *
     * @param {Array} props
     * @return {Property[]}
     */
    async getProperties(props: (Property | PropName)[]) {
        return this.session.queue(async session => {
            let payload = '';

            for (let name of props) {
                payload += Property.composeRawElement(0, name instanceof Property ? name : new Property(name));
            }

            const request = Message.composeGetPropCommand(4, this.password, payload);
            await session.send(request);

            const reply = await session.receiveMessageHeader();
            const reply_header = await Message.parseRaw(reply);

            if (loglevel >= LogLevel.DEBUG) console.debug('Get prop response', reply_header);

            if (reply_header.error_code !== 0) {
                throw new Error('Error ' + reply_header.error_code);
            }

            const props_with_values: Property[] = [];

            while (true) {
                const prop_header = await session.receivePropertyElementHeader();
                if (loglevel >= LogLevel.DEBUG) console.debug('Received property element header:', prop_header);
                const data = await Property.unpackHeader(prop_header);
                if (loglevel >= LogLevel.DEBUG) console.debug(data);
                const {name, flags, size} = data;

                const value = await session.receive(size);

                if (flags & 1) {
                    const error_code = value.readInt32BE(0);
                    throw new Error('Error requesting value for property "' + name + '": ' + error_code + ' ' + value.toString('hex'));
                }

                const prop = new Property(name, value);

                if (typeof prop.name === 'undefined' && typeof prop.value === 'undefined') {
                    break;
                }

                if (loglevel >= LogLevel.DEBUG) console.debug('Prop', prop);

                props_with_values.push(prop);
            }

            return props_with_values;
        });
    }

    /**
     * Sets properties on the AirPort device.
     *
     * @param {Property[]} props
     */
    async setProperties(props: Property[]) {
        return this.session.queue(async session => {
            let payload = '';

            for (let prop of props) {
                payload += Property.composeRawElement(0, prop);
            }

            const request = Message.composeSetPropCommand(0, this.password, payload);
            await session.send(request);

            const raw_reply = await session.receiveMessageHeader();
            const reply_header = await Message.parseRaw(raw_reply);

            if (reply_header.error_code !== 0) {
                if (loglevel >= LogLevel.INFO) console.info('Set properties error code', reply_header.error_code);
                return;
            }

            const response: PropSetResponse[] = [];

            while (true) {
                const prop_header = await session.receivePropertyElementHeader();
                const {name, flags, size} = await Property.unpackHeader(prop_header);

                const value = await session.receive(size);

                console.log('set', name, flags, size, value);

                if (flags & 1) {
                    const error_code = value.readUInt32BE(0);
                    throw new Error('Error setting value for property "' + name + '": ' + error_code + ' ' + value.toString('hex'));
                }

                if (name as string === '\0\0\0\0') {
                    if (loglevel >= LogLevel.DEBUG) console.debug('Found empty prop end marker');
                    break;
                }

                response.push({name, flags, size, value});
            }

            return response;
        });
    }

    /**
     * Gets the supported features on the AirPort device.
     *
     * @return {Promise<Array>}
     */
    async getFeatures() {
        return this.session.queue(async session => {
            await session.send(Message.composeFeatCommand(0));
            const reply_header = await Message.parseRaw(await session.receiveMessageHeader());
            const reply = await session.receive(reply_header.body_size);
            return CFLBinaryPList.parse(reply);
        });
    }

    async getLogs() {
        const [prop] = await this.getProperties(['logm']) as Property<'logm'>[];
        return prop.format();
    }

    /**
     * Sends a reboot command.
     *
     * @return {Promise<void>}
     */
    reboot() {
        return this.setProperties([new Property('acRB', 0)]);
    }

    async flashPrimary(payload: Buffer) {
        return this.session.queue(async session => {
            await session.send(Message.composeFlashPrimaryCommand(0, this.password, payload));
            const reply_header = await Message.parseRaw(await session.receiveMessageHeader());
            return await session.receive(reply_header.body_size);
        });
    }

    async authenticate() {
        return this.session.queue(async session => {
            if (this.session.encryption) {
                throw new Error('Encryption is already enabled.');
            }

            if (this.authenticating) return this.authenticating;

            try {
                await (this.authenticating = this.authenticateStageOne(session));
            } finally {
                this.authenticating = null;
            }
        });
    }

    private async authenticateStageOne(session: SessionLock) {
        /**
         * Stage 1 (client)
         *
         * Request SRP params, the server's public key (B) and the user's salt.
         */

        const payload = {
            state: 1,
            username: 'admin',
        };

        if (loglevel >= LogLevel.DEBUG) console.debug('Authentication stage one data', payload);

        const message = Message.composeAuthCommand(4, CFLBinaryPList.compose(payload));
        await session.send(message);

        /**
         * Stage 2 (server)
         *
         * Return SRP params, the server's public key (B) and the user's salt.
         */

        const response = await session.receiveMessage();

        if (response.error_code !== 0) {
            throw new Error('Authenticate stage two error code ' + response.error_code);
        }

        const data = CFLBinaryPList.parse(response.body!);

        if (loglevel >= LogLevel.DEBUG) console.debug('Authentication stage two data', data);

        return this.authenticateStageThree(session, data);
    }

    private async authenticateStageThree(session: SessionLock, data: {
        salt: Buffer;
        generator: Buffer;
        publicKey: Buffer;
        modulus: Buffer;
    }) {
        /**
         * Stage 3 (client)
         *
         * Generate a public key (A) and use the password and salt to generate proof we know the password (M1),
         * then send it to the server.
         */

        // data === {
        //     salt: Buffer, // .length === 16
        //     generator: Buffer, // .toString('hex') === '02'
        //     publicKey: Buffer, // .length === 192
        //     modulus: Buffer, // === srp.params[1536].N
        // }

        const salt = data.salt; // salt.length === 16
        // eslint-disable-next-line no-unused-vars
        const B = data.publicKey; // B.length === 192 (not 384)

        const params: SrpParams = {
            // 1536
            N_length_bits: 1536,
            N: new BigInteger(data.modulus),
            g: new BigInteger(data.generator),
            hash: 'sha1',
        };

        const key = crypto.randomBytes(24); // .length === 192

        const srpc = new srp.Client(params, salt, Buffer.from('admin'), Buffer.from(this.password), key);
        srpc.setB(data.publicKey);

        const A = srpc.computeA(); // === key
        const M1 = srpc.computeM1(); // .length should === 20

        const iv = crypto.randomBytes(16);

        const payload = {
            iv,
            publicKey: A,
            state: 3,
            response: M1,
        };

        // payload === {
        //     iv: Buffer, // .length === 16
        //     publicKey: Buffer, // .length === 192
        //     state: Number, // === 3
        //     response: Buffer, // .length === 20
        // }

        if (loglevel >= LogLevel.DEBUG) console.debug('Authentication stage 3 data', payload);

        const request = Message.composeAuthCommand(4, CFLBinaryPList.compose(payload));
        await session.send(request);

        /**
         * Stage 4 (server)
         *
         * Use the client's public key (A) to verify the client's proof it knows the password (M1) and generate
         * proof the server knows the password (M2).
         */

        const response = await session.receiveMessage();

        if (response.error_code !== 0) {
            throw new Error('Authenticate stage 4 error code ' + response.error_code);
        }

        const data_2 = CFLBinaryPList.parse(response.body!);

        if (loglevel >= LogLevel.DEBUG) console.debug('Authentication stage 4 data', data_2);

        return this.authenticateStageFive(srpc, iv, data_2);
    }

    private async authenticateStageFive(srpc: srp.Client, client_iv: Buffer, data: {
        response: Buffer;
        iv: Buffer;
    }) {
        /**
         * Stage 5 (client)
         *
         * Verify the server's proof it knows the password (M2), and if valid enable session encryption.
         */

        // data === {
        //     response: Buffer, // .length === 20
        //     iv: Buffer, // .length === 16
        // }

        try {
            srpc.checkM2(data.response);
        } catch (err) {
            // Probably wrong password
            throw new Error('Error verifying response (M2)');
        }

        // We now have a key, client iv and server iv
        // Enable encryption
        const key = srpc.computeK();
        const server_iv = data.iv;

        if (loglevel >= LogLevel.DEBUG) console.debug('Enabling encryption...');
        this.session.enableEncryption(key, client_iv, server_iv);
    }
}
